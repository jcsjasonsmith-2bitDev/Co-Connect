/* ================================================================================
   worker.js — Co-connect v2 · Message-board worker (Cloudflare Worker)
   ================================================================================
   Stateless edge worker: NO database, NO KV, NO persistent storage.

   The job board lives in the isolate's RAM and is explicitly GARBAGE COLLECTED:
     • client ACCEPTS a bid        → post leaves the board ("filled"), losers told
     • client REJECTS ALL bids     → post + all bids deleted, bidders told
     • client withdraws/disconnects→ their posts + bids GC'd, bidders told
     • contractor disconnects      → their bids GC'd, posters told
     • either party's session ends → session record GC'd, other party told
     • post TTL expires            → swept every 60 s (and lazily on mutations)

   WebRTC signaling (offer/answer/ICE) is relayed ONLY between the two peers of an
   accepted session — never broadcast. A tiny stateless chat relay (`chat`) exists
   as fallback transport if the direct data channel cannot be established; it
   stores nothing.
   ================================================================================ */

const WS_OPEN = 1;

const POST_TTL_MS = 12 * 60 * 60 * 1000;   // default post lifetime: 12 h
const MAX_TTL_MS = 24 * 60 * 60 * 1000;    // hard cap
const MIN_TTL_MS = 100;                    // floor (allows short-lived/test posts)
const SWEEP_MS = 60 * 1000;
const MAX_POSTS_PER_CLIENT = 5;
const MAX_TEXT_LEN = 4000;
const MAX_FIELD_LEN = 80;
const MAX_NOTE_LEN = 280;
const MAX_CHAT_LEN = 2000;

/** peerId -> { id, role, address, ws, posts:Set, bids:Map(postId→Set(bidId)), sessionId } */
const peers = new Map();
/** postId -> { id, clientId, clientAddress, type, description, duration, postedAt, expiresAt, bids:Map(bidId→bid) } */
const posts = new Map();
/** sessionId -> { id, clientId, contractorId, postId, startedAt } */
const sessions = new Map();

const gc = { posts: 0, bids: 0, sessions: 0 };

function log(...a) { console.log('[co-connect]', ...a); }

/* ------------------------------------------------------------------ helpers */

function send(ws, obj) {
  try { if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); } catch (_) {}
}
function sendTo(peerId, obj) {
  const p = peers.get(peerId);
  if (p) send(p.ws, obj);
}
function broadcast(obj) {
  for (const p of peers.values()) send(p.ws, obj);
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Serialize a post for the wire. Bidder identities are hidden from everyone
 *  except the poster (who needs bid ids to accept/reject). */
function postWire(post, viewerId) {
  const mine = post.clientId === viewerId;
  let i = 0;
  const bids = [...post.bids.values()].map((b) => {
    i++;
    if (mine) return { id: b.id, n: i, amount: b.amount, currency: b.currency, note: b.note, at: b.at };
    return { n: i, amount: b.amount, currency: b.currency, note: b.note, at: b.at, mine: b.contractorId === viewerId };
  });
  return {
    id: post.id,
    type: post.type,
    description: post.description,
    duration: post.duration,
    postedAt: post.postedAt,
    expiresAt: post.expiresAt,
    mine,
    bidCount: post.bids.size,
    bids,
  };
}

function boardFor(viewerId) {
  return [...posts.values()]
    .map((p) => postWire(p, viewerId))
    .sort((a, b) => b.postedAt - a.postedAt);
}

/* ------------------------------------------------------------- garbage GC */

/** Delete a post and everything attached to it, notifying affected peers. */
function removePost(postId, reason, exceptBidder) {
  const post = posts.get(postId);
  if (!post) return;
  posts.delete(postId);
  gc.posts++;
  gc.bids += post.bids.size;

  const owner = peers.get(post.clientId);
  if (owner) owner.posts.delete(postId);

  const bidderIds = [...post.bids.values()].map((b) => b.contractorId);
  for (const b of post.bids.values()) {
    const c = peers.get(b.contractorId);
    if (c) {
      const s = c.bids.get(postId);
      if (s) s.delete(b.id);
      if (c.bids.size === 0) c.bids.delete(postId);
    }
  }
  // Bidders care explicitly…
  for (const cid of bidderIds) {
    if (cid !== exceptBidder) sendTo(cid, { type: 'post-closed', postId, reason });
  }
  // …everyone gets the board update.
  broadcast({ type: 'post-removed', postId, reason });
  log(`GC post ${postId.slice(0, 8)} (${reason}) — ${bidderIds.length} bid(s) freed`);
}

function endSession(sessionId, reason) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  gc.sessions++;
  for (const pid of [s.clientId, s.contractorId]) {
    const p = peers.get(pid);
    if (p && p.sessionId === sessionId) p.sessionId = null;
  }
  const other = (msg) => { /* routed below */ void msg; };
  void other;
  sendTo(s.clientId, { type: 'session-ended', sessionId, reason });
  sendTo(s.contractorId, { type: 'session-ended', sessionId, reason });
  log(`GC session ${sessionId.slice(0, 8)} (${reason})`);
}

/** TTL sweep — runs on a timer and lazily on board mutations. */
function sweep() {
  const now = Date.now();
  let n = 0;
  for (const post of [...posts.values()]) {
    if (post.expiresAt <= now) {
      removePost(post.id, 'expired');
      n++;
    }
  }
  if (n) log(`GC sweep: ${n} expired post(s) collected`);
}

const sweepTimer = setInterval(sweep, SWEEP_MS);
// In Node (test harness) don't hold the event loop open; Workers ignore unref.
if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();

/* ---------------------------------------------------------------- handler */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/ws' || request.headers.get('upgrade') !== 'websocket') {
      if (url.pathname === '/ws') return new Response('Expected a WebSocket upgrade on /ws', { status: 426 });
      return new Response(
        JSON.stringify({
          app: 'co-connect-board',
          ok: true,
          stateless: true,
          endpoint: '/ws',
          board: { posts: posts.size, sessions: sessions.size, peers: peers.size },
          gc,
          ts: Date.now(),
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
      );
    }

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    /** @type {null | {id:string, role:string, address:string, ws:any, posts:Set<string>, bids:Map<string,Set<string>>, sessionId:string|null}} */
    let me = null;

    const cleanup = () => {
      if (!me) return;
      peers.delete(me.id);
      // GC every post this client owned.
      for (const postId of [...me.posts]) removePost(postId, 'withdrawn');
      // GC every bid this contractor placed.
      for (const [postId, bidIds] of [...me.bids]) {
        const post = posts.get(postId);
        if (!post) continue;
        let changed = false;
        for (const bidId of bidIds) {
          if (post.bids.delete(bidId)) {
            gc.bids++;
            changed = true;
            sendTo(post.clientId, { type: 'bid-withdrawn', postId, bidId });
          }
        }
        if (changed) broadcast({ type: 'post-updated', postId, bidCount: post.bids.size });
      }
      // GC any live session.
      if (me.sessionId) endSession(me.sessionId, 'peer-disconnected');
      log(`peer gone (${me.role}) — GC totals: posts=${gc.posts} bids=${gc.bids} sessions=${gc.sessions}`);
      me = null;
    };

    serverWs.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        /* -------------------------------------------------------- JOIN */
        case 'join': {
          if (me) return;
          sweep(); // lazy GC on every join
          const id = crypto.randomUUID();
          me = {
            id,
            role: msg.role === 'client' ? 'client' : 'contractor',
            address: str(msg.address, 64),
            ws: serverWs,
            posts: new Set(),
            bids: new Map(),
            sessionId: null,
          };
          peers.set(id, me);
          send(serverWs, {
            type: 'joined',
            id,
            role: me.role,
            board: boardFor(id),
            stats: { posts: posts.size, peers: peers.size },
          });
          log(`${me.role} joined (${id.slice(0, 8)}) — board: ${posts.size} post(s)`);
          break;
        }

        /* -------------------------------------------------- POST A JOB */
        case 'post-job': {
          if (!me || me.role !== 'client') return;
          sweep();
          if (me.posts.size >= MAX_POSTS_PER_CLIENT) {
            send(serverWs, { type: 'error', code: 'too-many-posts', message: `Max ${MAX_POSTS_PER_CLIENT} open posts at a time.` });
            return;
          }
          const industry = str(msg.industry, MAX_FIELD_LEN);
          const field = str(msg.field, MAX_FIELD_LEN);
          const profession = str(msg.profession, MAX_FIELD_LEN);
          const description = str(msg.description, MAX_TEXT_LEN);
          if (!industry || !profession || !description) {
            send(serverWs, { type: 'error', code: 'bad-post', message: 'Industry, profession and description are required.' });
            return;
          }
          const now = Date.now();
          const ttl = num(msg.ttl) ? Math.min(Math.max(msg.ttl, MIN_TTL_MS), MAX_TTL_MS) : POST_TTL_MS;
          const post = {
            id: crypto.randomUUID(),
            clientId: me.id,
            clientAddress: me.address,
            type: { industry, field, profession },
            description,
            duration: str(msg.duration, 120) || 'Not specified',
            postedAt: now,
            expiresAt: now + ttl,
            bids: new Map(),
          };
          posts.set(post.id, post);
          me.posts.add(post.id);
          send(serverWs, { type: 'posted', post: postWire(post, me.id) });
          broadcast({ type: 'post-new', post: postWire(post, '') });
          log(`post ${post.id.slice(0, 8)} created by ${me.address.slice(0, 10)} (ttl ${Math.round(ttl / 60000)}m)`);
          break;
        }

        /* ------------------------------------------------------- BID */
        case 'bid': {
          if (!me || me.role !== 'contractor') return;
          const post = posts.get(str(msg.postId, 64));
          if (!post) {
            send(serverWs, { type: 'error', code: 'no-post', message: 'That post no longer exists.' });
            return;
          }
          const amount = num(msg.amount);
          if (!amount) {
            send(serverWs, { type: 'error', code: 'bad-bid', message: 'Bid amount must be a positive number.' });
            return;
          }
          const currency = str(msg.currency, 8) || 'ZAR';
          const note = str(msg.note, MAX_NOTE_LEN);
          let bid = [...post.bids.values()].find((b) => b.contractorId === me.id);
          let updated = false;
          if (bid) {
            bid.amount = amount; bid.currency = currency; bid.note = note; bid.at = Date.now();
            updated = true;
          } else {
            bid = { id: crypto.randomUUID(), contractorId: me.id, contractorAddress: me.address, amount, currency, note, at: Date.now() };
            post.bids.set(bid.id, bid);
            if (!me.bids.has(post.id)) me.bids.set(post.id, new Set());
            me.bids.get(post.id).add(bid.id);
          }
          send(serverWs, { type: 'bid-ok', postId: post.id, bidId: bid.id, amount, currency, updated });
          sendTo(post.clientId, {
            type: 'bid-new',
            postId: post.id,
            updated,
            bid: { id: bid.id, amount, currency, note, at: bid.at },
          });
          broadcast({ type: 'post-updated', postId: post.id, bidCount: post.bids.size });
          log(`bid ${bid.id.slice(0, 8)} ${updated ? 'updated' : 'placed'} on ${post.id.slice(0, 8)}: ${amount} ${currency}`);
          break;
        }

        /* ------------------------------------------------ WITHDRAW BID */
        case 'withdraw-bid': {
          if (!me || me.role !== 'contractor') return;
          const post = posts.get(str(msg.postId, 64));
          if (!post) return;
          const bidId = str(msg.bidId, 64);
          const mine = me.bids.get(post.id);
          if (!mine || !mine.has(bidId) || !post.bids.delete(bidId)) return;
          mine.delete(bidId);
          gc.bids++;
          sendTo(post.clientId, { type: 'bid-withdrawn', postId: post.id, bidId });
          broadcast({ type: 'post-updated', postId: post.id, bidCount: post.bids.size });
          log(`bid ${bidId.slice(0, 8)} withdrawn from ${post.id.slice(0, 8)}`);
          break;
        }

        /* ------------------------------------------------- ACCEPT BID */
        case 'accept': {
          if (!me || me.role !== 'client') return;
          const post = posts.get(str(msg.postId, 64));
          if (!post || post.clientId !== me.id) return;
          const bid = post.bids.get(str(msg.bidId, 64));
          if (!bid) {
            send(serverWs, { type: 'error', code: 'no-bid', message: 'That bid no longer exists.' });
            return;
          }
          if (me.sessionId) {
            send(serverWs, { type: 'error', code: 'busy', message: 'Close your current session first.' });
            return;
          }
          const winner = peers.get(bid.contractorId);
          if (!winner) {
            send(serverWs, { type: 'error', code: 'bidder-gone', message: 'That contractor disconnected — pick another bid.' });
            post.bids.delete(bid.id);
            gc.bids++;
            broadcast({ type: 'post-updated', postId: post.id, bidCount: post.bids.size });
            return;
          }
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { id: sessionId, clientId: me.id, contractorId: winner.id, postId: post.id, startedAt: Date.now() });
          me.sessionId = sessionId;
          winner.sessionId = sessionId;
          // Winner gets the deal + the client's identity (info exchange begins).
          send(winner.ws, {
            type: 'bid-accepted',
            sessionId,
            postId: post.id,
            client: { address: post.clientAddress },
            job: { type: post.type, description: post.description, duration: post.duration, postedAt: post.postedAt },
            reward: { amount: bid.amount, currency: bid.currency },
          });
          // Poster gets confirmation + the winning contractor's identity.
          send(serverWs, { type: 'accepted', sessionId, postId: post.id, contractor: { address: bid.contractorAddress } });
          // Post leaves the board; losing bidders are told.
          removePost(post.id, 'filled', bid.contractorId);
          log(`session ${sessionId.slice(0, 8)} formed: ${me.address.slice(0, 10)} ↔ ${bid.contractorAddress.slice(0, 10)}`);
          break;
        }

        /* ----------------------------------------------- REJECT ALL */
        case 'reject-all': {
          if (!me || me.role !== 'client') return;
          const post = posts.get(str(msg.postId, 64));
          if (!post || post.clientId !== me.id) return;
          removePost(post.id, 'rejected');
          break;
        }

        /* --------------------------------------------- WITHDRAW POST */
        case 'withdraw-post': {
          if (!me || me.role !== 'client') return;
          const post = posts.get(str(msg.postId, 64));
          if (!post || post.clientId !== me.id) return;
          removePost(post.id, 'withdrawn');
          break;
        }

        /* ------------------------------ WebRTC signaling (session-scoped, 1:1) */
        case 'offer':
        case 'answer':
        case 'ice': {
          if (!me || !me.sessionId) return;
          const s = sessions.get(me.sessionId);
          if (!s || str(msg.sessionId, 64) !== s.id) return;
          const otherId = me.id === s.clientId ? s.contractorId : s.clientId;
          const out = { type: msg.type, sessionId: s.id, from: me.id };
          if (msg.type === 'ice') out.candidate = msg.candidate;
          else out.sdp = msg.sdp;
          sendTo(otherId, out);
          break;
        }

        /* ------------------------- chat relay (fallback transport; stores nothing) */
        case 'chat': {
          if (!me || !me.sessionId) return;
          const s = sessions.get(me.sessionId);
          if (!s || str(msg.sessionId, 64) !== s.id) return;
          const otherId = me.id === s.clientId ? s.contractorId : s.clientId;
          sendTo(otherId, { type: 'chat', sessionId: s.id, text: str(msg.text, MAX_CHAT_LEN), relayed: true });
          break;
        }

        /* --------------------------------------- explicit session teardown */
        case 'bye': {
          if (!me || !me.sessionId) return;
          const s = sessions.get(me.sessionId);
          if (!s || str(msg.sessionId, 64) !== s.id) return;
          const otherId = me.id === s.clientId ? s.contractorId : s.clientId;
          sendTo(otherId, { type: 'bye', sessionId: s.id, from: me.id });
          break;
        }

        case 'end-session': {
          if (!me || !me.sessionId) return;
          const s = sessions.get(me.sessionId);
          if (!s || str(msg.sessionId, 64) !== s.id) return;
          endSession(s.id, 'closed-by-peer');
          break;
        }

        /* --------------------------------------------- keep-alive / misc */
        case 'ping':
          send(serverWs, { type: 'pong', ts: Date.now() });
          break;

        case 'leave':
          try { serverWs.close(1000, 'leaving'); } catch (_) {}
          break;

        default:
          break;
      }
    });

    serverWs.addEventListener('close', cleanup);
    serverWs.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: clientWs });
  },
};
