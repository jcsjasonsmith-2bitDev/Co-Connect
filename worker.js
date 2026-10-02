/* ================================================================================
   worker.js — Co-connect signaling relay (Cloudflare Worker)
   ================================================================================
   A strictly STATELESS edge worker. It holds an in-memory peer map ONLY for the
   lifetime of live WebSocket connections — no databases, no Durable Objects, no
   persistent storage, nothing written to disk. When the isolate is recycled, all
   state is gone by design (ephemeral marketplace).

   Responsibilities:
     1. Upgrade HTTP → WebSocket on GET /ws using the native WebSocketPair API.
     2. Track connected peers (id, role, address) while their sockets are open.
     3. Route signaling payloads between clients and contractors:
          join / offer / answer / ice / claim / reject / bye / ping
     4. Broadcast presence (peer-joined / peer-left) so lobbies stay live.

   NOTE: the peer map lives in the isolate serving each connection. This is the
   accepted trade-off of the zero-storage mandate; a globally-consistent roster
   would require persistent state, which is explicitly forbidden here.
   ================================================================================ */

const WS_OPEN = 1; // WebSocket.OPEN — hard-coded; Workers runtime exposes no enum.

/** peerId -> { id, role, address, ws } */
const peers = new Map();

/** Safe JSON send: never throw on a dead/half-closed socket. */
function send(ws, obj) {
  try {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  } catch (_) { /* socket died mid-write; cleanup() will reap it */ }
}

/** Broadcast to all peers, optionally skipping one id and/or filtering by role. */
function broadcast(obj, exceptId, roleFilter) {
  for (const p of peers.values()) {
    if (p.id === exceptId) continue;
    if (roleFilter && p.role !== roleFilter) continue;
    send(p.ws, obj);
  }
}

/** Roster snapshot sent on join (public fields only). */
function roster() {
  return [...peers.values()].map((p) => ({ id: p.id, role: p.role, address: p.address }));
}

function countRole(role) {
  let n = 0;
  for (const p of peers.values()) if (p.role === role) n++;
  return n;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    /* ------------------------------------------------------------------ */
    /* Non-WebSocket requests: tiny JSON health/status probe.              */
    /* ------------------------------------------------------------------ */
    if (url.pathname !== '/ws' || request.headers.get('upgrade') !== 'websocket') {
      if (url.pathname === '/ws') {
        return new Response('Expected a WebSocket upgrade on /ws', { status: 426 });
      }
      return new Response(
        JSON.stringify({
          app: 'co-connect-signaling',
          ok: true,
          stateless: true,
          endpoint: '/ws',
          online: { contractors: countRole('contractor'), clients: countRole('client') },
          ts: Date.now(),
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
      );
    }

    /* ------------------------------------------------------------------ */
    /* WebSocket upgrade via native WebSocketPair.                         */
    /* ------------------------------------------------------------------ */
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    /** @type {null | {id:string, role:string, address:string, ws:WebSocket}} */
    let me = null;

    const cleanup = () => {
      if (!me) return;
      peers.delete(me.id);
      broadcast({ type: 'peer-left', id: me.id, role: me.role }, null);
      me = null;
    };

    serverWs.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return; // non-JSON garbage — ignore, stay alive
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        /* ------------------------------------------------------------ */
        /* JOIN — register this socket with a role + wallet address.     */
        /* ------------------------------------------------------------ */
        case 'join': {
          if (me) return; // already joined on this socket
          const id = crypto.randomUUID();
          const role = msg.role === 'client' ? 'client' : 'contractor';
          const address = typeof msg.address === 'string' ? msg.address.slice(0, 64) : '';
          me = { id, role, address, ws: serverWs };
          peers.set(id, me);
          send(serverWs, { type: 'joined', id, role, peers: roster() });
          broadcast({ type: 'peer-joined', id, role, address }, id);
          break;
        }

        /* ------------------------------------------------------------ */
        /* OFFER — a CLIENT broadcasts its SDP offer to every            */
        /* connected contractor.                                         */
        /* ------------------------------------------------------------ */
        case 'offer': {
          if (!me || me.role !== 'client') return;
          broadcast(
            {
              type: 'offer',
              from: me.id,
              fromAddress: me.address,
              offerId: msg.offerId,
              sdp: msg.sdp,
              preview: msg.preview || null,
            },
            me.id,
            'contractor',
          );
          break;
        }

        /* ------------------------------------------------------------ */
        /* ANSWER — a CONTRACTOR returns its SDP answer to the client    */
        /* that broadcast the offer.                                     */
        /* ------------------------------------------------------------ */
        case 'answer': {
          if (!me || me.role !== 'contractor') return;
          const target = peers.get(msg.to);
          if (target) {
            send(target.ws, {
              type: 'answer',
              from: me.id,
              fromAddress: me.address,
              offerId: msg.offerId,
              sdp: msg.sdp,
            });
          }
          break;
        }

        /* ------------------------------------------------------------ */
        /* ICE — trickle candidates. `to:"*"` broadcasts (used by the    */
        /* client before a contractor has claimed the job); otherwise    */
        /* targeted point-to-point relay.                                */
        /* ------------------------------------------------------------ */
        case 'ice': {
          if (!me) return;
          const payload = { type: 'ice', from: me.id, offerId: msg.offerId, candidate: msg.candidate };
          if (msg.to === '*') broadcast(payload, me.id);
          else {
            const target = peers.get(msg.to);
            if (target) send(target.ws, payload);
          }
          break;
        }

        /* ------------------------------------------------------------ */
        /* CLAIM — the client locked the handshake with one contractor.  */
        /* Tell every OTHER contractor to stand down.                    */
        /* ------------------------------------------------------------ */
        case 'claim': {
          if (!me || me.role !== 'client') return;
          broadcast(
            { type: 'claimed', offerId: msg.offerId, winner: msg.winner, client: me.id },
            msg.winner,
            'contractor',
          );
          break;
        }

        /* ------------------------------------------------------------ */
        /* REJECT — polite teardown (job filled / contractor busy /      */
        /* invalid SDP).                                                 */
        /* ------------------------------------------------------------ */
        case 'reject': {
          if (!me) return;
          const target = peers.get(msg.to);
          if (target) {
            send(target.ws, { type: 'reject', from: me.id, offerId: msg.offerId, reason: msg.reason || '' });
          }
          break;
        }

        /* ------------------------------------------------------------ */
        /* BYE — session teardown notice relayed to the counterparty.    */
        /* ------------------------------------------------------------ */
        case 'bye': {
          if (!me) return;
          const target = peers.get(msg.to);
          if (target) send(target.ws, { type: 'bye', from: me.id, offerId: msg.offerId });
          break;
        }

        /* ------------------------------------------------------------ */
        /* PING — keep-alive so edge hops don't reap idle sockets.       */
        /* ------------------------------------------------------------ */
        case 'ping': {
          send(serverWs, { type: 'pong', ts: Date.now() });
          break;
        }

        case 'leave': {
          try { serverWs.close(1000, 'leaving'); } catch (_) {}
          break;
        }

        default:
          break; // unknown message types are silently ignored
      }
    });

    serverWs.addEventListener('close', cleanup);
    serverWs.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: clientWs });
  },
};
