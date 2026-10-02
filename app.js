/* ================================================================================
   app.js — Co-connect frontend
   ================================================================================
   Strictly Vanilla ES6+. No frameworks, no CDNs, no <script src="https://…">.

   Pillars (all native browser APIs):
     • Web3 identity  → window.ethereum (eth_requestAccounts / eth_chainId)
     • P2P transport  → RTCPeerConnection + RTCDataChannel
     • Signaling      → native WebSocket to a stateless Cloudflare Worker
     • SDP            → RTCSessionDescription offer/answer relayed by the worker

   Flow:
     CLIENT:     wallet → join WS → build job → SDP offer broadcast to all
                 contractors → first valid SDP answer locks the handshake →
                 RTCDataChannel opens → job JSON + chat travel RAM-to-RAM.
     CONTRACTOR: wallet → join WS → wait in lobby → auto-answer broadcasts →
                 first accepted answer wins → data channel delivers the job.
   ================================================================================ */
'use strict';

(() => {
  /* ======================================================================
     0 · CONFIG & TINY UTILITIES
     ====================================================================== */

  const DEFAULT_SIGNAL_URL = 'wss://co-connect-signal.example.workers.dev/ws';
  const LS_WS_KEY = 'coconnect.ws';
  const ANSWER_TIMEOUT_MS = 30000;   // client gives up waiting for answers
  const CHANNEL_TIMEOUT_MS = 20000;  // contractor gives up waiting for the DC
  const PING_INTERVAL_MS = 25000;    // WS keep-alive cadence

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const $ = (sel) => document.querySelector(sel);

  function signalUrl() {
    try {
      const q = new URLSearchParams(location.search).get('ws');
      if (q) return q;
      return localStorage.getItem(LS_WS_KEY) || DEFAULT_SIGNAL_URL;
    } catch (_) {
      return DEFAULT_SIGNAL_URL;
    }
  }

  function uuid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

  const CHAIN_NAMES = {
    '0x1': 'Ethereum', '0xaa36a7': 'Sepolia', '0x4268': 'Holesky',
    '0x89': 'Polygon', '0x13882': 'Amoy', '0x2105': 'Base', '0x14a34': 'Base Sepolia',
    '0xa4b1': 'Arbitrum', '0xa': 'OP Mainnet', '0x38': 'BNB Chain',
    '0xe708': 'Linea', '0xa86a': 'Avalanche', '0x82750': 'Scroll', '0x144': 'zkSync',
  };
  const chainName = (hexId) => (hexId ? CHAIN_NAMES[hexId] || `chain ${parseInt(hexId, 16)}` : '');

  /* ------------------------------------------------------------ logging */

  function slog(tag, msg, cls) {
    const body = $('#log-body');
    if (!body) return;
    const line = document.createElement('div');
    line.className = `log-line ${cls || ''}`;
    const t = document.createElement('span');
    t.className = 'lt';
    t.textContent = new Date().toLocaleTimeString();
    const k = document.createElement('span');
    k.className = `lk lk-${tag}`;
    k.textContent = tag;
    const m = document.createElement('span');
    m.textContent = msg;
    line.append(t, k, m);
    body.appendChild(line);
    while (body.children.length > 400) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }

  function toast(msg, kind = 'info', ms = 4200) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  /* ---------------------------------------------------------- identicon */

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** Deterministic 5×5 mirrored identicon drawn on a <canvas>. Zero deps. */
  function drawIdenticon(canvas, seed) {
    if (!canvas) return;
    const s = seed || 'anon';
    const h1 = fnv(s);
    const h2 = fnv(`${s}::co-connect`);
    const hue = h1 % 360;
    const size = 5;
    const cell = canvas.width / size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `hsl(${hue} 45% 14%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `hsl(${hue} 80% 60%)`;
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < size; y++) {
        const bit = (h2 >>> (y * 3 + x)) & 1;
        if (!bit) continue;
        ctx.fillRect(x * cell, y * cell, cell, cell);
        ctx.fillRect((size - 1 - x) * cell, y * cell, cell, cell);
      }
    }
  }

  /* ======================================================================
     1 · WALLET — native window.ethereum identity
     ====================================================================== */

  const Wallet = {
    address: null,
    chainId: null,
    guest: false,
    connected: false,

    get hasProvider() {
      return typeof window.ethereum !== 'undefined' && !!window.ethereum;
    },

    async connect() {
      if (!this.hasProvider) throw new Error('no-provider');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) throw new Error('no-accounts');
      this.address = accounts[0];
      try {
        this.chainId = await window.ethereum.request({ method: 'eth_chainId' });
      } catch (_) {
        this.chainId = null;
      }
      this.guest = false;
      this.connected = true;
      this._bindOnce();
      slog('app', `wallet connected: ${short(this.address)}`, 'good');
      return this.address;
    },

    connectGuest() {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      this.address = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      this.chainId = null;
      this.guest = true;
      this.connected = true;
      slog('app', `guest identity minted: ${short(this.address)}`, 'good');
      return this.address;
    },

    _bound: false,
    _bindOnce() {
      if (this._bound || !this.hasProvider || !window.ethereum.on) return;
      this._bound = true;
      window.ethereum.on('accountsChanged', (accounts) => {
        if (!accounts || !accounts.length) {
          toast('Wallet disconnected.', 'warn');
          this.connected = false;
          UI.renderWallet();
          return;
        }
        this.address = accounts[0];
        toast(`Identity switched to ${short(this.address)}`, 'warn');
        slog('app', `accountsChanged → ${short(this.address)}`);
        UI.renderWallet();
      });
      window.ethereum.on('chainChanged', (chainId) => {
        this.chainId = chainId;
        UI.renderWallet();
      });
    },
  };

  /* ======================================================================
     2 · SIGNALING — native WebSocket client for the edge worker
     ====================================================================== */

  class Signaling {
    constructor() {
      this.ws = null;
      this.id = null;
      this.role = null;
      this.address = null;
      this.handlers = new Map();
      this.shouldReconnect = false;
      this.retryDelay = 1000;
      this.pingTimer = null;
      this.online = false;
    }

    on(event, cb) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(cb);
    }

    once(event, cb) {
      const wrapper = (data) => {
        const list = this.handlers.get(event);
        if (list) {
          const i = list.indexOf(wrapper);
          if (i !== -1) list.splice(i, 1);
        }
        cb(data);
      };
      this.on(event, wrapper);
    }

    emit(event, data) {
      for (const cb of this.handlers.get(event) || []) {
        try { cb(data); } catch (e) { console.error('[co-connect] handler error', e); }
      }
    }

    /** Connect + join as a role. Resolves on the worker's `joined` reply. */
    connect(role, address) {
      this.role = role;
      this.address = address;
      this.shouldReconnect = true;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Signaling join timed out — check the endpoint URL.'));
        }, 10000);
        const onJoined = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
        this.once('joined', onJoined);
        this._open(() => {
          clearTimeout(timer);
          reject(new Error('Could not open the signaling WebSocket.'));
        });
      });
    }

    _open(onFail) {
      const url = signalUrl();
      slog('net', `dial ${url}`);
      UI.setPill('#pill-signal', 'warn');
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        slog('net', `socket construct failed: ${e.message}`, 'bad');
        if (onFail) onFail();
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.online = true;
        this.retryDelay = 1000;
        slog('net', 'socket open — joining', 'good');
        this.send({ type: 'join', role: this.role, address: this.address });
        this._startPing();
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'joined') this.id = msg.id;
        this.emit(msg.type, msg);
        this.emit('message', msg);
      };

      ws.onclose = () => {
        this.online = false;
        this._stopPing();
        UI.setPill('#pill-signal', 'err');
        slog('net', 'socket closed', 'bad');
        this.emit('disconnected');
        this._scheduleReconnect();
      };

      ws.onerror = () => {
        slog('net', 'socket error', 'bad');
        if (!this.online && onFail) onFail();
      };
    }

    _scheduleReconnect() {
      if (!this.shouldReconnect || !this.role) return;
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
      slog('net', `reconnecting in ${delay / 1000}s…`);
      setTimeout(() => {
        if (this.shouldReconnect && this.role && !this.online) this._open(null);
      }, delay);
    }

    _startPing() {
      this._stopPing();
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
    }
    _stopPing() {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    send(obj) {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
      } catch (e) {
        slog('net', `send failed: ${e.message}`, 'bad');
      }
    }

    close() {
      this.shouldReconnect = false;
      this.role = null;
      this._stopPing();
      try { if (this.ws) this.ws.close(1000, 'leaving'); } catch (_) {}
      this.online = false;
      UI.setPill('#pill-signal', 'off');
    }
  }

  const Signal = new Signaling();

  /* ======================================================================
     3 · APP STATE
     ====================================================================== */

  const state = {
    role: null,            // 'client' | 'contractor'
    session: null,         // active ClientSession | ContractorSession
    peers: new Map(),      // peerId -> { id, role, address }
    openForWork: true,
  };

  /* ======================================================================
     4 · SESSIONS — WebRTC peer connections
     ====================================================================== */

  /** Shared data-channel wiring for both roles. */
  function wireDataChannel(s) {
    const dc = s.dc;
    dc.onopen = () => {
      clearTimeout(s.channelTimer);
      s.phase = 'channel';
      slog('rtc', 'data channel OPEN — P2P locked', 'good');
      UI.setPill('#pill-p2p', 'ok');
      UI.sessionChannelOpen(s);
      dcSend(s, { t: 'hello', address: Wallet.address, role: state.role, guest: Wallet.guest });
      if (s.kind === 'client') {
        // Procedural execution: the full job payload now travels peer-to-peer.
        dcSend(s, { t: 'job', job: s.job });
        UI.sysChat(s, `Job payload transmitted directly to ${short(s.peerAddress)} — nothing touched a server.`);
      } else {
        UI.sysChat(s, `Secure channel open with ${short(s.peerAddress)}. Job payload incoming…`);
      }
      UI.update(s);
    };
    dc.onmessage = (ev) => handleInband(s, ev.data);
    dc.onclose = () => {
      if (s.status !== 'ended') teardown(s, 'Channel closed', 'The peer closed the data channel. Everything exchanged is already gone.');
    };
    dc.onerror = (e) => slog('rtc', `data channel error: ${e.message || 'unknown'}`, 'bad');
  }

  function dcSend(s, obj) {
    try {
      if (s.dc && s.dc.readyState === 'open') {
        s.dc.send(JSON.stringify(obj));
        return true;
      }
    } catch (e) {
      slog('rtc', `dc send failed: ${e.message}`, 'bad');
    }
    return false;
  }

  /* ------------------------------------------------------------ CLIENT */

  class ClientSession {
    constructor(job) {
      this.kind = 'client';
      this.offerId = uuid();
      this.job = job;
      this.status = 'handshaking';      // handshaking | active | ended
      this.phase = 'broadcasting';      // broadcasting | locked | channel | agreed | delivered | complete
      this.winnerId = null;
      this.peerAddress = null;
      this.rating = 5;
      this.iceBuf = new Map();          // contractorId -> candidates[] (pre-lock)
      this.pc = new RTCPeerConnection(RTC_CONFIG);

      this.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        // Before a contractor claims the job, candidates are broadcast to all
        // contractors; afterwards they are targeted at the winner only.
        Signal.send({
          type: 'ice',
          to: this.winnerId || '*',
          offerId: this.offerId,
          candidate: e.candidate.toJSON(),
        });
      };

      this.pc.onconnectionstatechange = () => {
        const cs = this.pc.connectionState;
        slog('rtc', `client pc: ${cs}`);
        if (cs === 'connected') UI.setPill('#pill-p2p', 'ok');
        if ((cs === 'failed' || cs === 'closed') && this.status !== 'ended') {
          teardown(this, 'Connection failed', 'The direct peer connection could not be established (restrictive NAT/firewall?). Try again — both peers must reach a STUN server.');
        }
      };

      this.dc = this.pc.createDataChannel('co-connect', { ordered: true });
      wireDataChannel(this);
    }

    /** Create the SDP offer and broadcast it to every contractor in the lobby. */
    async broadcast() {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      Signal.send({
        type: 'offer',
        offerId: this.offerId,
        sdp: this.pc.localDescription.toJSON(),
        preview: { title: this.job.title, reward: this.job.reward, currency: this.job.currency },
      });
      slog('rtc', `offer ${this.offerId.slice(0, 8)} broadcast to lobby`, 'good');
      this.answerTimer = setTimeout(() => {
        if (this.status !== 'ended' && !this.winnerId) UI.noAnswers(this);
      }, ANSWER_TIMEOUT_MS);
    }

    /** A contractor answered. First valid answer locks the handshake. */
    async onAnswer(msg) {
      if (this.status === 'ended' || this.winnerId) {
        Signal.send({ type: 'reject', to: msg.from, offerId: this.offerId, reason: 'filled' });
        slog('rtc', `late answer from ${short(msg.fromAddress)} — rejected`, 'bad');
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } catch (e) {
        slog('rtc', `invalid answer: ${e.message}`, 'bad');
        Signal.send({ type: 'reject', to: msg.from, offerId: this.offerId, reason: 'invalid' });
        return;
      }
      clearTimeout(this.answerTimer);
      this.winnerId = msg.from;
      this.peerAddress = msg.fromAddress;
      this.phase = 'locked';
      slog('rtc', `LOCKED with contractor ${short(msg.fromAddress)}`, 'good');
      Signal.send({ type: 'claim', offerId: this.offerId, winner: msg.from });
      // Flush any ICE candidates the winner trickled before we locked.
      for (const c of this.iceBuf.get(msg.from) || []) {
        this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
      this.iceBuf.clear();
      UI.update(this);
    }

    onIce(msg) {
      if (this.status === 'ended') return;
      if (this.winnerId && msg.from === this.winnerId) {
        this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch((e) => slog('rtc', `ice: ${e.message}`, 'bad'));
      } else if (!this.winnerId) {
        if (!this.iceBuf.has(msg.from)) this.iceBuf.set(msg.from, []);
        this.iceBuf.get(msg.from).push(msg.candidate);
      }
    }

    onReject(msg) {
      slog('rtc', `contractor ${short(msg.from)} rejected: ${msg.reason || 'unspecified'}`);
    }

    close() {
      clearTimeout(this.answerTimer);
      try { this.dc && this.dc.close(); } catch (_) {}
      try { this.pc.close(); } catch (_) {}
    }
  }

  /* -------------------------------------------------------- CONTRACTOR */

  class ContractorSession {
    constructor(offerMsg) {
      this.kind = 'contractor';
      this.offerId = offerMsg.offerId;
      this.clientId = offerMsg.from;
      this.peerAddress = offerMsg.fromAddress;
      this.preview = offerMsg.preview;
      this.job = null;
      this.status = 'handshaking';
      this.phase = 'offer';             // offer | channel | job | agreed | delivered | complete
      this.iceBuf = [];
      this.dc = null;
      this.pc = new RTCPeerConnection(RTC_CONFIG);

      this.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        Signal.send({ type: 'ice', to: this.clientId, offerId: this.offerId, candidate: e.candidate.toJSON() });
      };

      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        wireDataChannel(this);
      };

      this.pc.onconnectionstatechange = () => {
        const cs = this.pc.connectionState;
        slog('rtc', `contractor pc: ${cs}`);
        if (cs === 'connected') UI.setPill('#pill-p2p', 'ok');
        if ((cs === 'failed' || cs === 'closed') && this.status !== 'ended') {
          teardown(this, 'Connection failed', 'The direct peer connection collapsed before the handshake completed.');
        }
      };
    }

    /** Auto-answer: per spec, contractors return a valid SDP answer automatically. */
    async answer(offerMsg) {
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(offerMsg.sdp));
        for (const c of this.iceBuf) {
          this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        this.iceBuf = [];
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        Signal.send({ type: 'answer', to: this.clientId, offerId: this.offerId, sdp: this.pc.localDescription.toJSON() });
        slog('rtc', `answer sent to client ${short(this.peerAddress)}`, 'good');
      } catch (e) {
        slog('rtc', `answer failed: ${e.message}`, 'bad');
        Signal.send({ type: 'reject', to: this.clientId, offerId: this.offerId, reason: 'answer-failed' });
        if (state.session === this) teardown(this, 'Handshake failed', `Could not answer the offer: ${e.message}`);
      }
      // If the data channel never opens, stand down quietly.
      this.channelTimer = setTimeout(() => {
        if (this.status !== 'ended' && (!this.dc || this.dc.readyState !== 'open')) {
          teardown(this, 'Handshake timed out', 'The client never opened the data channel — they likely locked with a different contractor or dropped offline.');
        }
      }, CHANNEL_TIMEOUT_MS);
    }

    onIce(msg) {
      if (this.status === 'ended') return;
      if (this.pc.remoteDescription) {
        this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch((e) => slog('rtc', `ice: ${e.message}`, 'bad'));
      } else {
        this.iceBuf.push(msg.candidate);
      }
    }

    close() {
      clearTimeout(this.channelTimer);
      try { this.dc && this.dc.close(); } catch (_) {}
      try { this.pc.close(); } catch (_) {}
    }
  }

  /* ======================================================================
     5 · IN-BAND PROTOCOL — JSON messages over the RTCDataChannel
     ====================================================================== */

  function handleInband(s, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'hello': {
        if (m.address) s.peerAddress = m.address;
        UI.peerIdentity(s, m);
        break;
      }

      case 'job': {
        if (s.kind !== 'contractor') return;
        s.job = m.job;
        s.phase = 'job';
        slog('app', 'job payload received P2P', 'good');
        UI.jobReceived(s);
        break;
      }

      case 'job-accept': {
        if (s.kind !== 'client') return;
        s.phase = 'agreed';
        UI.sysChat(s, `✓ ${short(s.peerAddress)} ACCEPTED the job. Terms are set — deliverables travel this channel.`);
        UI.update(s);
        break;
      }

      case 'job-decline': {
        UI.sysChat(s, `✗ ${short(s.peerAddress)} declined the job${m.reason ? ` — ${m.reason}` : ''}.`);
        setTimeout(() => {
          if (s.status !== 'ended') teardown(s, 'Job declined', 'The contractor declined this job. Broadcast again to reach the rest of the lobby.');
        }, 1800);
        break;
      }

      case 'chat': {
        UI.chat(s, String(m.text || ''), false);
        break;
      }

      case 'delivered': {
        if (s.kind !== 'client') return;
        s.phase = 'delivered';
        UI.sysChat(s, `📦 ${short(s.peerAddress)} marked the job DELIVERED. Review the work, then mark it complete.`);
        UI.update(s);
        break;
      }

      case 'complete': {
        if (s.kind !== 'contractor') return;
        s.phase = 'complete';
        UI.sysChat(s, `✔ Client marked the job COMPLETE${m.rating ? ` and rated you ${m.rating}/5` : ''}. Settlement happens directly between you two.`);
        UI.update(s);
        setTimeout(() => {
          if (s.status !== 'ended') teardown(s, 'Job complete', 'The marketplace did its job. This channel, its chat and the payload now evaporate.');
        }, 3200);
        break;
      }

      case 'bye': {
        if (s.status !== 'ended') teardown(s, 'Peer left', 'The other party ended the session. Nothing was stored anywhere.');
        break;
      }

      default:
        break;
    }
  }

  /** Graceful teardown of a session and transition to the summary card. */
  function teardown(s, headline, sub) {
    if (s.status === 'ended') return;
    s.status = 'ended';
    dcSend(s, { t: 'bye' });
    if (s.kind === 'client' && s.winnerId) {
      Signal.send({ type: 'bye', to: s.winnerId, offerId: s.offerId });
    } else if (s.kind === 'contractor') {
      Signal.send({ type: 'bye', to: s.clientId, offerId: s.offerId });
    }
    s.close();
    if (state.session === s) state.session = null;
    UI.setPill('#pill-p2p', 'off');
    UI.sessionEnded(s, headline, sub);
    slog('app', `session ended: ${headline}`);
  }

  /* ======================================================================
     6 · UI — DOM rendering
     ====================================================================== */

  const UI = {
    setPill(sel, mode) {
      const el = $(sel);
      if (!el) return;
      el.classList.remove('ok', 'warn', 'err');
      if (mode && mode !== 'off') el.classList.add(mode);
    },

    show(viewId) {
      for (const v of ['#view-onboard', '#view-client', '#view-contractor', '#view-session']) {
        $(v).classList.toggle('hidden', v !== viewId);
      }
    },

    /* -------------------------------------------------------- wallet */

    renderWallet() {
      const btnWallet = $('#btn-wallet');
      const btnConnect = $('#btn-connect');
      const chip = $('#wallet-chip');
      const hint = $('#wallet-hint');
      const btnGuest = $('#btn-guest');

      if (Wallet.connected) {
        btnWallet.classList.add('hidden');
        btnConnect.disabled = true;
        btnConnect.textContent = Wallet.guest ? 'Guest identity active' : 'Wallet connected';
        chip.classList.remove('hidden');
        drawIdenticon($('#chip-icon'), Wallet.address);
        $('#chip-addr').textContent = short(Wallet.address);
        $('#chip-chain').textContent = Wallet.guest ? 'guest' : chainName(Wallet.chainId);
        this.setPill('#pill-wallet', Wallet.guest ? 'warn' : 'ok');
        $('#role-client').disabled = false;
        $('#role-contractor').disabled = false;
        btnGuest.classList.add('hidden');
      } else {
        btnWallet.classList.remove('hidden');
        btnConnect.disabled = false;
        btnConnect.textContent = 'Connect Wallet';
        chip.classList.add('hidden');
        this.setPill('#pill-wallet', Wallet.hasProvider ? 'warn' : 'err');
        $('#role-client').disabled = true;
        $('#role-contractor').disabled = true;
        btnGuest.classList.remove('hidden');
        btnGuest.textContent = Wallet.hasProvider
          ? 'skip wallet — enter as guest instead'
          : 'no wallet detected — enter as guest instead';
        if (!Wallet.hasProvider) {
          hint.innerHTML = 'No <code>window.ethereum</code> provider found in this browser. Install a wallet extension, or continue with an ephemeral guest identity.';
        }
      }
    },

    /* ------------------------------------------------------- presence */

    refreshPresence() {
      let contractors = 0;
      let clients = 0;
      for (const p of state.peers.values()) {
        if (p.role === 'contractor') contractors++;
        else clients++;
      }
      const sc = $('#stat-contractors');
      if (sc) sc.textContent = contractors;
      const sl = $('#stat-clients');
      if (sl) sl.textContent = clients;
      const note = $('#client-lobby-note');
      if (note) {
        note.textContent = contractors > 0
          ? `${contractors} contractor${contractors === 1 ? '' : 's'} in the lobby right now.`
          : 'The lobby is empty — broadcast anyway and any contractor who joins will see your offer… (offers are ephemeral; keep this tab open).';
      }
      const hint = $('#broadcast-hint');
      if (hint && contractors === 0) {
        hint.innerHTML = '<strong>No contractors online.</strong> Your offer still goes out; the first contractor to answer locks the channel.';
      }
      return contractors;
    },

    /* -------------------------------------------------- role views */

    enterRole(role) {
      state.role = role;
      UI.setPill('#pill-signal', 'warn');
      Signal.connect(role, Wallet.address)
        .then((msg) => {
          state.peers = new Map((msg.peers || []).map((p) => [p.id, p]));
          UI.setPill('#pill-signal', 'ok');
          slog('net', `joined as ${role} (${short(msg.id)})`, 'good');
          UI.refreshPresence();
          UI.show(role === 'client' ? '#view-client' : '#view-contractor');
        })
        .catch((e) => {
          UI.setPill('#pill-signal', 'err');
          toast(`Signaling failed: ${e.message}`, 'err', 7000);
          slog('net', `join failed: ${e.message}`, 'bad');
          Signal.close(); // stop the reconnect loop; user fixes the endpoint and retries
          state.role = null;
          UI.show('#view-onboard');
        });
    },

    leaveRole() {
      if (state.session && state.session.status !== 'ended') {
        teardown(state.session, 'Session ended', 'You left the marketplace.');
      }
      Signal.close();
      state.role = null;
      state.peers.clear();
      UI.refreshPresence();
      UI.show('#view-onboard');
    },

    /* --------------------------------------------------------- session */

    enterSession(s) {
      state.session = s;
      UI.show('#view-session');
      $('#summary-card').classList.add('hidden');
      $('#chat').innerHTML = '';
      $('#job-card').classList.add('hidden');
      $('#composer').classList.add('hidden');
      drawIdenticon($('#peer-icon'), s.peerAddress || 'anon');
      $('#peer-addr').textContent = short(s.peerAddress || '—');
      $('#peer-role').textContent = s.kind === 'client' ? 'contractor' : 'client';
      const pill = $('#session-status');
      pill.textContent = 'handshaking';
      pill.className = 'status-pill';
      UI.buildTimeline(s);
      UI.update(s);
      if (s.kind === 'client') {
        UI.sysChat(s, `Broadcasting “${s.job.title}” to every contractor in the lobby…`);
      } else if (s.preview) {
        UI.sysChat(s, `Incoming broadcast: “${s.preview.title}” (${s.preview.currency} ${s.preview.reward}). Auto-answering…`);
      }
    },

    timelineSteps(s) {
      return s.kind === 'client'
        ? ['Wallet', 'Signal', 'Broadcast', 'Match', 'Channel', 'Agree']
        : ['Signal', 'Offer', 'Channel', 'Job', 'Agree'];
    },

    buildTimeline(s) {
      const ol = $('#timeline');
      ol.innerHTML = '';
      for (const label of UI.timelineSteps(s)) {
        const li = document.createElement('li');
        li.textContent = label;
        ol.appendChild(li);
      }
    },

    update(s) {
      if (!s || state.session !== s) return;
      const steps = $('#timeline').children;
      let done = 0;
      if (s.kind === 'client') {
        done = { broadcasting: 2, locked: 3, channel: 4, agreed: 5, delivered: 5, complete: 6 }[s.phase] ?? 0;
      } else {
        done = { offer: 1, channel: 2, job: 3, agreed: 4, delivered: 4, complete: 5 }[s.phase] ?? 0;
      }
      for (let i = 0; i < steps.length; i++) {
        steps[i].classList.toggle('done', i < done);
        steps[i].classList.toggle('doing', i === done && s.status !== 'ended');
      }
      UI.renderActions(s);
    },

    sessionChannelOpen(s) {
      if (state.session !== s) return;
      $('#composer').classList.remove('hidden');
      const pill = $('#session-status');
      pill.textContent = 'P2P live';
      pill.className = 'status-pill live';
      UI.update(s);
    },

    peerIdentity(s, hello) {
      if (state.session !== s) return;
      drawIdenticon($('#peer-icon'), s.peerAddress);
      $('#peer-addr').textContent = short(s.peerAddress);
      const label = hello.role === 'client' ? 'client' : hello.role === 'contractor' ? 'contractor' : 'peer';
      $('#peer-role').textContent = `${label}${hello.guest ? ' · guest' : ''}`;
      UI.sysChat(s, `Identity on channel: ${short(s.peerAddress)} (${label}).`);
    },

    jobReceived(s) {
      UI.renderJobCard(s.job, s.peerAddress);
      UI.update(s);
    },

    renderJobCard(job, poster) {
      const card = $('#job-card');
      card.classList.remove('hidden');
      $('#job-title').textContent = job.title;
      $('#job-reward').textContent = `${job.currency} ${Number(job.reward).toLocaleString()}`;
      $('#job-desc').textContent = job.description;
      const chips = $('#job-skills');
      chips.innerHTML = '';
      for (const sk of job.skills || []) {
        const c = document.createElement('span');
        c.className = 'chip-skill';
        c.textContent = sk;
        chips.appendChild(c);
      }
      const due = new Date(job.deadline);
      $('#job-meta').textContent =
        `Posted by ${short(poster || job.postedBy)} · ${new Date(job.postedAt).toLocaleString()} · due ${due.toLocaleString()}`;
    },

    /* ----------------------------------------------------------- chat */

    sysChat(s, text) {
      if (state.session !== s) return;
      const box = $('#chat');
      const el = document.createElement('div');
      el.className = 'msg sys';
      el.textContent = text;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },

    chat(s, text, mine) {
      if (state.session !== s) return;
      const box = $('#chat');
      const el = document.createElement('div');
      el.className = `msg ${mine ? 'me' : 'them'}`;
      if (!mine) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = short(s.peerAddress);
        el.appendChild(who);
      }
      el.appendChild(document.createTextNode(text));
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },

    sendChat() {
      const s = state.session;
      if (!s || s.status === 'ended') return;
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      if (!dcSend(s, { t: 'chat', text, ts: Date.now() })) {
        toast('Channel is not open.', 'warn');
        return;
      }
      input.value = '';
      UI.chat(s, text, true);
    },

    /* -------------------------------------------------------- actions */

    renderActions(s) {
      const card = $('#action-card');
      const row = $('#action-row');
      row.innerHTML = '';
      if (!s || s.status === 'ended') {
        card.classList.add('hidden');
        return;
      }
      const btn = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = `btn ${cls}`;
        b.textContent = label;
        b.onclick = fn;
        row.appendChild(b);
        return b;
      };
      const note = (text) => {
        const n = document.createElement('span');
        n.className = 'action-note';
        n.textContent = text;
        row.appendChild(n);
      };

      if (s.kind === 'client') {
        switch (s.phase) {
          case 'broadcasting':
            note('Waiting for a contractor to answer…');
            break;
          case 'locked':
            note('Contractor matched — opening encrypted channel…');
            break;
          case 'channel':
            note('Waiting for the contractor to review the job…');
            break;
          case 'agreed':
            note('Agreed. The contractor is working — coordinate here.');
            break;
          case 'delivered': {
            note('Rate the work:');
            const sel = document.createElement('select');
            for (let i = 5; i >= 1; i--) {
              const o = document.createElement('option');
              o.value = String(i);
              o.textContent = '★'.repeat(i);
              sel.appendChild(o);
            }
            row.appendChild(sel);
            btn('Mark complete', 'btn-teal', () => {
              s.phase = 'complete';
              dcSend(s, { t: 'complete', rating: Number(sel.value) });
              UI.sysChat(s, `You marked the job complete (${sel.value}/5). Settlement is between you two.`);
              UI.update(s);
              setTimeout(() => {
                if (s.status !== 'ended') teardown(s, 'Job complete', 'Delivered, rated and settled peer-to-peer. The channel now evaporates.');
              }, 2600);
            });
            break;
          }
          case 'complete':
            note('Complete ✓');
            break;
        }
      } else {
        switch (s.phase) {
          case 'offer':
            note('Handshaking with the client…');
            break;
          case 'channel':
            note('Channel open — waiting for the job payload…');
            break;
          case 'job': {
            btn('Accept job', 'btn-teal', () => {
              s.phase = 'agreed';
              dcSend(s, { t: 'job-accept' });
              UI.sysChat(s, 'You accepted the job. Deliver, then mark it delivered below.');
              UI.update(s);
            });
            btn('Decline', 'btn-danger', () => {
              dcSend(s, { t: 'job-decline', reason: '' });
              setTimeout(() => {
                if (s.status !== 'ended') teardown(s, 'Job declined', 'You passed on this one. Back to the lobby.');
              }, 900);
            });
            break;
          }
          case 'agreed':
            btn('Mark delivered', 'btn-primary', () => {
              s.phase = 'delivered';
              dcSend(s, { t: 'delivered' });
              UI.sysChat(s, 'Marked delivered. Waiting for the client to confirm & rate…');
              UI.update(s);
            });
            break;
          case 'delivered':
            note('Delivered — awaiting client confirmation…');
            break;
          case 'complete':
            note('Complete ✓');
            break;
        }
      }
      card.classList.toggle('hidden', row.children.length === 0);
    },

    /* ------------------------------------------------------- fallbacks */

    noAnswers(s) {
      if (state.session !== s || s.status === 'ended') return;
      UI.sysChat(s, 'No contractor answered within 30s. The lobby may be empty — you can end and re-broadcast.');
      const pill = $('#session-status');
      pill.textContent = 'no answer';
      pill.className = 'status-pill dead';
    },

    sessionEnded(s, headline, sub) {
      if (!state.session || state.session === s) state.session = null;
      UI.setPill('#pill-p2p', 'off');
      const pill = $('#session-status');
      if (pill) {
        pill.textContent = 'ended';
        pill.className = 'status-pill dead';
      }
      $('#composer').classList.add('hidden');
      $('#action-card').classList.add('hidden');
      const card = $('#summary-card');
      card.classList.remove('hidden');
      $('#summary-title').textContent = headline;
      $('#summary-sub').textContent = sub;
      const cta = $('#btn-summary-cta');
      cta.textContent = s.kind === 'client' ? 'Post another job' : 'Back to the lobby';
      cta.onclick = () => {
        card.classList.add('hidden');
        UI.show(s.kind === 'client' ? '#view-client' : '#view-contractor');
        UI.refreshPresence();
      };
    },
  };

  /* ======================================================================
     7 · SIGNALING EVENT ROUTING
     ====================================================================== */

  Signal.on('joined', (msg) => {
    state.peers = new Map((msg.peers || []).map((p) => [p.id, p]));
    UI.setPill('#pill-signal', 'ok');
    UI.refreshPresence();
  });

  Signal.on('peer-joined', (msg) => {
    state.peers.set(msg.id, { id: msg.id, role: msg.role, address: msg.address });
    slog('net', `peer joined: ${msg.role} ${short(msg.address)}`);
    UI.refreshPresence();
  });

  Signal.on('peer-left', (msg) => {
    const gone = state.peers.get(msg.id);
    state.peers.delete(msg.id);
    if (gone) slog('net', `peer left: ${gone.role} ${short(gone.address)}`);
    UI.refreshPresence();
  });

  /* CLIENT ← SDP answer from a contractor. */
  Signal.on('answer', (msg) => {
    const s = state.session;
    if (s && s.kind === 'client' && s.offerId === msg.offerId && s.status !== 'ended') {
      s.onAnswer(msg);
    }
  });

  /* CONTRACTOR ← SDP offer broadcast from a client. */
  Signal.on('offer', (msg) => {
    if (state.role !== 'contractor') return;
    if (!state.openForWork) {
      Signal.send({ type: 'reject', to: msg.from, offerId: msg.offerId, reason: 'closed' });
      slog('app', 'offer ignored — not open for work');
      return;
    }
    const busy = state.session && state.session.status !== 'ended';
    if (busy) {
      Signal.send({ type: 'reject', to: msg.from, offerId: msg.offerId, reason: 'busy' });
      slog('app', 'offer rejected — already in a session');
      return;
    }
    const s = new ContractorSession(msg);
    UI.enterSession(s);
    s.answer(msg); // auto-answer per the protocol spec
  });

  /* ICE trickle relay. */
  Signal.on('ice', (msg) => {
    const s = state.session;
    if (!s || s.status === 'ended') return;
    if (s.kind === 'client') {
      if (s.offerId === msg.offerId) s.onIce(msg);
    } else if (s.offerId === msg.offerId && msg.from === s.clientId) {
      s.onIce(msg);
    }
  });

  /* CONTRACTOR ← client locked with someone else (or filled the job). */
  Signal.on('claimed', (msg) => {
    const s = state.session;
    if (s && s.kind === 'contractor' && s.offerId === msg.offerId && msg.winner !== Signal.id) {
      teardown(s, 'Too slow', 'Another contractor locked this job first. Back to the lobby.');
    }
  });

  Signal.on('reject', (msg) => {
    const s = state.session;
    if (!s || s.status === 'ended') return;
    if (s.kind === 'client' && s.offerId === msg.offerId) {
      s.onReject(msg);
    } else if (s.kind === 'contractor' && s.offerId === msg.offerId && msg.from === s.clientId) {
      teardown(s, 'Client rejected the handshake', msg.reason ? `Reason: ${msg.reason}` : 'The client chose another path.');
    }
  });

  Signal.on('bye', (msg) => {
    const s = state.session;
    if (!s || s.status === 'ended') return;
    const counterparty = s.kind === 'client' ? s.winnerId : s.clientId;
    if (msg.from === counterparty && (!msg.offerId || msg.offerId === s.offerId)) {
      teardown(s, 'Peer left', 'The other party ended the session. Nothing was stored anywhere.');
    }
  });

  Signal.on('disconnected', () => {
    const s = state.session;
    if (s && s.status === 'ended') return;
    if (s && s.status === 'handshaking') {
      teardown(s, 'Signaling lost', 'The relay connection dropped mid-handshake. Reconnecting automatically — re-broadcast if needed.');
    } else if (s) {
      UI.sysChat(s, '⚠ Signaling relay dropped. Your direct P2P channel (if open) survives without it.');
    }
  });

  /* ======================================================================
     8 · STATIC UI WIRING
     ====================================================================== */

  document.addEventListener('DOMContentLoaded', () => {
    $('#ws-url').value = signalUrl();
    UI.renderWallet();
    UI.setPill('#pill-p2p', 'off');

    /* ---- wallet buttons ---- */
    const doConnect = async () => {
      const btn = $('#btn-connect');
      try {
        btn.disabled = true;
        if (Wallet.hasProvider) {
          await Wallet.connect();
          toast(`Wallet connected: ${short(Wallet.address)}`, 'ok');
        } else {
          Wallet.connectGuest();
          toast('Entered with an ephemeral guest identity.', 'warn');
        }
        UI.renderWallet();
      } catch (e) {
        btn.disabled = false;
        const msg = e && e.code === 4001
          ? 'Connection request rejected in the wallet.'
          : `Wallet connection failed: ${e.message || e}`;
        toast(msg, 'err');
        slog('app', msg, 'bad');
        UI.renderWallet();
      }
    };
    $('#btn-connect').onclick = doConnect;
    $('#btn-wallet').onclick = doConnect;
    $('#btn-guest').onclick = () => {
      Wallet.connectGuest();
      toast('Entered with an ephemeral guest identity.', 'warn');
      UI.renderWallet();
    };

    /* ---- role selection ---- */
    $('#role-client').onclick = () => Wallet.connected && UI.enterRole('client');
    $('#role-contractor').onclick = () => Wallet.connected && UI.enterRole('contractor');
    $('#btn-client-back').onclick = () => UI.leaveRole();
    $('#btn-contractor-back').onclick = () => UI.leaveRole();

    /* ---- contractor lobby ---- */
    $('#toggle-open').onchange = (e) => {
      state.openForWork = e.target.checked;
      const pulse = document.querySelector('#listening .pulse');
      const txt = $('#listening-text');
      if (state.openForWork) {
        pulse.classList.remove('off');
        txt.textContent = 'Listening for broadcasts…';
        slog('app', 'contractor open for work');
      } else {
        pulse.classList.add('off');
        txt.textContent = 'Closed — incoming broadcasts will be refused.';
        slog('app', 'contractor closed for work');
      }
    };

    /* ---- client: broadcast a job ---- */
    $('#job-form').onsubmit = async (e) => {
      e.preventDefault();
      if (state.session && state.session.status !== 'ended') {
        toast('Finish or end the current session first.', 'warn');
        return;
      }
      const now = Date.now();
      const amount = Number($('#f-deadline').value) || 1;
      const unit = $('#f-deadline-unit').value;
      const job = {
        id: uuid(),
        title: $('#f-title').value.trim(),
        description: $('#f-desc').value.trim(),
        reward: Number($('#f-reward').value),
        currency: $('#f-currency').value,
        skills: $('#f-skills').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12),
        deadline: new Date(now + amount * (unit === 'hours' ? 3600000 : 86400000)).toISOString(),
        postedBy: Wallet.address,
        postedAt: new Date(now).toISOString(),
        protocol: 'co-connect/1',
      };
      if (!job.title || !job.description) return;
      const contractors = UI.refreshPresence();
      if (contractors === 0) {
        slog('app', 'broadcasting into an empty lobby', 'bad');
      }
      const s = new ClientSession(job);
      UI.enterSession(s);
      try {
        await s.broadcast();
      } catch (err) {
        teardown(s, 'Broadcast failed', err.message);
      }
    };

    /* ---- session controls ---- */
    $('#btn-end').onclick = () => {
      const s = state.session;
      if (s && s.status !== 'ended') teardown(s, 'Session ended', 'You ended the session. Both browsers forget it ever happened.');
    };
    $('#btn-send').onclick = () => UI.sendChat();
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        UI.sendChat();
      }
    });

    /* ---- signaling endpoint config ---- */
    $('#btn-ws-save').onclick = () => {
      const url = $('#ws-url').value.trim();
      if (!/^wss?:\/\/.+/.test(url)) {
        toast('Enter a valid ws:// or wss:// URL.', 'err');
        return;
      }
      try { localStorage.setItem(LS_WS_KEY, url); } catch (_) {}
      toast('Signaling endpoint saved.', 'ok');
      slog('net', `endpoint set → ${url}`);
      if (state.role) {
        const role = state.role;
        Signal.close();
        UI.enterRole(role);
      }
    };

    /* ---- housekeeping ---- */
    window.addEventListener('beforeunload', () => {
      const s = state.session;
      if (s && s.status !== 'ended') {
        dcSend(s, { t: 'bye' });
        const peer = s.kind === 'client' ? s.winnerId : s.clientId;
        if (peer) Signal.send({ type: 'bye', to: peer, offerId: s.offerId });
      }
    });

    slog('app', 'co-connect booted — zero dependencies, all native APIs');
  });
})();
