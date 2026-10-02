/* ================================================================================
   app.js — Co-connect v2 · Message-board frontend
   ================================================================================
   Strictly Vanilla ES6+. No frameworks, no CDNs, no external scripts.

   Model:
     1. CLIENT posts a job to the board (template: job type + scope + time).
     2. CONTRACTORS bid the payment they want for job completion.
     3. CLIENT accepts ONE bid  → post is garbage collected off the board and a
        direct chat opens between the two (WebRTC data channel, with an
        automatic stateless relay fallback if P2P can't be established).
        CLIENT rejects ALL     → post + bids garbage collected, bidders told.
     4. If either party disconnects, the worker garbage collects everything
        they owned and tells the other side.

   Native APIs only: window.ethereum (identity), WebSocket (board),
   RTCPeerConnection/RTCDataChannel (direct chat).
   ================================================================================ */
'use strict';

(() => {
  /* ======================================================================
     0 · CONFIG & UTILITIES
     ====================================================================== */

  const DEFAULT_SIGNAL_URL = 'wss://co-connect-signal.example.workers.dev/ws';
  const LS_WS_KEY = 'coconnect.ws';
  const DIRECT_LINK_TIMEOUT_MS = 15000; // after this, chat falls back to relay
  const PING_INTERVAL_MS = 25000;
  const CURRENCIES = ['ZAR', 'USD', 'EUR', 'GBP', 'USDC', 'ETH'];

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function signalUrl() {
    try {
      const q = new URLSearchParams(location.search).get('ws');
      if (q) return q;
      return localStorage.getItem(LS_WS_KEY) || DEFAULT_SIGNAL_URL;
    } catch (_) {
      return DEFAULT_SIGNAL_URL;
    }
  }

  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

  function ago(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  const CHAIN_NAMES = {
    '0x1': 'Ethereum', '0xaa36a7': 'Sepolia', '0x89': 'Polygon', '0x2105': 'Base',
    '0xa4b1': 'Arbitrum', '0xa': 'OP Mainnet', '0x38': 'BNB Chain',
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
        if (!((h2 >>> (y * 3 + x)) & 1)) continue;
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
        UI.renderWallet();
      });
      window.ethereum.on('chainChanged', (chainId) => {
        this.chainId = chainId;
        UI.renderWallet();
      });
    },
  };

  /* ======================================================================
     2 · NET — native WebSocket client for the board worker
     ====================================================================== */

  class Net {
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

    connect(role, address) {
      this.role = role;
      this.address = address;
      this.shouldReconnect = true;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Board join timed out — check the endpoint URL.')), 10000);
        this.once('joined', (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        this._open(() => {
          clearTimeout(timer);
          reject(new Error('Could not open the board WebSocket.'));
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
        slog('net', 'socket open — joining board', 'good');
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

  const net = new Net();

  /* ======================================================================
     3 · STATE
     ====================================================================== */

  const state = {
    role: null,                       // 'client' | 'contractor'
    posts: new Map(),                 // postId -> wire post
    myBids: new Map(),                // postId -> { bidId, amount, currency }
    session: null,                    // active Session
  };

  /* ======================================================================
     4 · SESSION — direct chat (WebRTC with stateless relay fallback)
     ====================================================================== */

  class Session {
    /**
     * @param {string} id       sessionId from the worker
     * @param {'client'|'contractor'} role  this side
     * @param {string} peer     counterparty wallet address
     * @param {object} job      job summary { type, description, duration, postedAt }
     */
    constructor(id, role, peer, job, reward) {
      this.id = id;
      this.role = role;
      this.peer = peer;
      this.job = job;
      this.reward = reward || null;   // { amount, currency } of the accepted bid
      this.mode = 'connecting';       // connecting | direct | relay
      this.ended = false;
      this.pc = null;
      this.dc = null;
      this.iceBuf = [];
      this.fallbackTimer = null;
    }

    /* -------------------------------------------------- client side (initiator) */

    async startAsClient() {
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.pc.onicecandidate = (e) => {
        if (e.candidate) net.send({ type: 'ice', sessionId: this.id, candidate: e.candidate.toJSON() });
      };
      this.dc = this.pc.createDataChannel('co-connect', { ordered: true });
      this._wireDC();
      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        net.send({ type: 'offer', sessionId: this.id, sdp: this.pc.localDescription.toJSON() });
        slog('rtc', 'offer sent', 'good');
      } catch (e) {
        slog('rtc', `offer failed: ${e.message}`, 'bad');
        this._armFallback();
      }
      this._armFallback();
    }

    /* ---------------------------------------------- contractor side (responder) */

    async onOffer(sdp) {
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.pc.onicecandidate = (e) => {
        if (e.candidate) net.send({ type: 'ice', sessionId: this.id, candidate: e.candidate.toJSON() });
      };
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this._wireDC();
      };
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const c of this.iceBuf) this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        this.iceBuf = [];
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        net.send({ type: 'answer', sessionId: this.id, sdp: this.pc.localDescription.toJSON() });
        slog('rtc', 'answer sent', 'good');
      } catch (e) {
        slog('rtc', `answer failed: ${e.message}`, 'bad');
      }
      this._armFallback();
    }

    async onAnswer(sdp) {
      if (!this.pc) return;
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        for (const c of this.iceBuf) this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        this.iceBuf = [];
      } catch (e) {
        slog('rtc', `bad answer: ${e.message}`, 'bad');
      }
    }

    onIce(candidate) {
      if (this.pc && this.pc.remoteDescription) {
        this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      } else {
        this.iceBuf.push(candidate);
      }
    }

    /* ------------------------------------------------------------- data channel */

    _wireDC() {
      const dc = this.dc;
      dc.onopen = () => {
        clearTimeout(this.fallbackTimer);
        this.mode = 'direct';
        UI.setPill('#pill-p2p', 'ok');
        slog('rtc', 'data channel OPEN — direct chat live', 'good');
        UI.linkState(this, 'direct');
      };
      dc.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m && m.t === 'chat') UI.chat(m.text, false);
      };
      dc.onclose = () => {
        if (!this.ended && this.mode === 'direct') {
          // direct link died mid-chat — fall back to relay seamlessly
          this.mode = 'relay';
          UI.linkState(this, 'relay');
        }
      };
      dc.onerror = () => {};
    }

    _armFallback() {
      if (this.fallbackTimer) return;
      this.fallbackTimer = setTimeout(() => {
        if (this.ended || this.mode === 'direct') return;
        this.mode = 'relay';
        slog('rtc', 'direct link unavailable — using relayed chat (still nothing stored)', 'bad');
        UI.linkState(this, 'relay');
      }, DIRECT_LINK_TIMEOUT_MS);
    }

    /* ------------------------------------------------------------------- chat */

    sendChat(text) {
      if (this.mode === 'direct' && this.dc && this.dc.readyState === 'open') {
        this.dc.send(JSON.stringify({ t: 'chat', text }));
      } else {
        net.send({ type: 'chat', sessionId: this.id, text });
      }
    }

    /* -------------------------------------------------------------------- end */

    end(notifyPeer) {
      if (this.ended) return;
      this.ended = true;
      clearTimeout(this.fallbackTimer);
      if (notifyPeer) {
        try {
          if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify({ t: 'bye' }));
        } catch (_) {}
        net.send({ type: 'bye', sessionId: this.id });
        net.send({ type: 'end-session', sessionId: this.id });
      }
      try { if (this.dc) this.dc.close(); } catch (_) {}
      try { if (this.pc) this.pc.close(); } catch (_) {}
      if (state.session === this) state.session = null;
      UI.setPill('#pill-p2p', 'off');
    }
  }

  /* ======================================================================
     5 · UI
     ====================================================================== */

  const UI = {
    setPill(sel, mode) {
      const el = $(sel);
      if (!el) return;
      el.classList.remove('ok', 'warn', 'err');
      if (mode && mode !== 'off') el.classList.add(mode);
    },

    show(viewId) {
      for (const v of ['#view-onboard', '#view-board', '#view-session']) {
        $(v).classList.toggle('hidden', v !== viewId);
      }
    },

    /* --------------------------------------------------------- wallet */

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

    /* --------------------------------------------------- enter/leave board */

    enterRole(role) {
      state.role = role;
      state.posts.clear();
      state.myBids.clear();
      UI.setPill('#pill-signal', 'warn');
      net.connect(role, Wallet.address)
        .then((msg) => {
          UI.setPill('#pill-signal', 'ok');
          slog('net', `joined board as ${role} (${short(msg.id)})`, 'good');
          for (const p of msg.board || []) state.posts.set(p.id, p);
          $('#post-card').classList.toggle('hidden', role !== 'client');
          $('#btn-end').textContent = role === 'client' ? 'Close chat & end session' : 'Close chat';
          UI.renderBoard();
          UI.show('#view-board');
        })
        .catch((e) => {
          UI.setPill('#pill-signal', 'err');
          toast(`Board connection failed: ${e.message}`, 'err', 7000);
          slog('net', `join failed: ${e.message}`, 'bad');
          net.close();
          state.role = null;
          UI.show('#view-onboard');
        });
    },

    leaveRole() {
      if (state.session) {
        state.session.end(true);
        toast('Chat closed — the session was garbage collected.', 'info');
      }
      net.close();
      state.role = null;
      state.posts.clear();
      state.myBids.clear();
      UI.show('#view-onboard');
    },

    /* ----------------------------------------------------------- the board */

    renderBoard() {
      const wrap = $('#posts');
      const posts = [...state.posts.values()].sort((a, b) => b.postedAt - a.postedAt);
      $('#board-count').textContent = `${posts.length} post${posts.length === 1 ? '' : 's'}`;
      $('#empty-board').classList.toggle('hidden', posts.length > 0);
      $('#empty-text').innerHTML = state.role === 'client'
        ? 'The board is empty — be the first to post a job.'
        : 'No open jobs right now. Posts appear here the moment a client posts one.';

      wrap.innerHTML = '';
      for (const p of posts) wrap.appendChild(UI.postCard(p));
    },

    postCard(p) {
      const card = document.createElement('article');
      card.className = `card post-card${p.mine ? ' mine' : ''}`;
      card.dataset.post = p.id;

      const typeBits = [p.type.industry, p.type.field, p.type.profession].filter(Boolean).map(esc).join(' <span class="sep">›</span> ');

      let bidsHtml = '';
      if (p.mine) {
        // CLIENT view of own post: full bid list with accept buttons.
        if (p.bids.length) {
          bidsHtml = `<ul class="bid-list">${p.bids.map((b) => `
            <li>
              <span class="bid-n">#${b.n}</span>
              <span class="bid-amt">${esc(b.currency)} ${Number(b.amount).toLocaleString()}</span>
              ${b.note ? `<span class="bid-note">“${esc(b.note)}”</span>` : ''}
              <span class="bid-age">${ago(b.at)}</span>
              <button class="btn btn-teal btn-sm" data-action="accept" data-bid="${esc(b.id)}">Accept</button>
            </li>`).join('')}</ul>`;
        } else {
          bidsHtml = '<p class="muted small">No bids yet — contractors on the board can see this post now.</p>';
        }
        bidsHtml += `
          <div class="post-controls">
            <button class="btn btn-danger btn-sm" data-action="reject-all"${p.bids.length ? '' : ' disabled'}>Reject all</button>
            <button class="btn btn-ghost btn-sm" data-action="withdraw-post">Withdraw post</button>
          </div>`;
      } else if (state.role === 'contractor') {
        // CONTRACTOR view: anonymous bid list + bid form.
        const my = state.myBids.get(p.id);
        const bidRows = p.bids.map((b) => `
          <li class="${b.mine ? 'my-bid' : ''}">
            <span class="bid-n">#${b.n}${b.mine ? ' · you' : ''}</span>
            <span class="bid-amt">${esc(b.currency)} ${Number(b.amount).toLocaleString()}</span>
            ${b.note ? `<span class="bid-note">“${esc(b.note)}”</span>` : ''}
          </li>`).join('');
        const curOpts = CURRENCIES.map((c) => `<option${(my ? my.currency === c : c === 'ZAR') ? ' selected' : ''}>${c}</option>`).join('');
        bidsHtml = `
          ${p.bids.length ? `<ul class="bid-list compact">${bidRows}</ul>` : '<p class="muted small">No bids yet — first mover advantage.</p>'}
          ${my ? `
            <div class="your-bid">
              <span>Your bid: <strong>${esc(my.currency)} ${Number(my.amount).toLocaleString()}</strong></span>
              <button class="btn btn-ghost btn-sm" data-action="withdraw-bid">Withdraw</button>
            </div>` : ''}
          <details class="bid-form" ${my ? '' : ''}>
            <summary>${my ? 'Change your bid' : 'Place a bid'}</summary>
            <form data-bid-form>
              <label>Payment wanted for job completion
                <span class="bid-inputs">
                  <input type="number" name="amount" min="0" step="any" required placeholder="2500" value="${my ? my.amount : ''}" />
                  <select name="currency">${curOpts}</select>
                </span>
              </label>
              <label>Note <span class="muted">(optional, ≤280 chars)</span>
                <input type="text" name="note" maxlength="280" placeholder="e.g. available from Monday, fixed price" />
              </label>
              <button type="submit" class="btn btn-primary btn-sm">${my ? 'Update bid' : 'Send bid'}</button>
            </form>
          </details>`;
      } else {
        bidsHtml = `<p class="muted small">${p.bidCount} bid${p.bidCount === 1 ? '' : 's'} so far. Only the client can see and accept them.</p>`;
      }

      card.innerHTML = `
        <header class="post-head">
          <div class="post-type">${typeBits}</div>
          <div class="post-badges">
            ${p.mine ? '<span class="badge you">your post</span>' : ''}
            <span class="badge">${p.bidCount} bid${p.bidCount === 1 ? '' : 's'}</span>
          </div>
        </header>
        <p class="post-desc">${esc(p.description)}</p>
        <div class="post-meta">
          <span>&#9201; ${esc(p.duration)}</span>
          <span>posted ${ago(p.postedAt)}</span>
        </div>
        <div class="post-bids">${bidsHtml}</div>`;
      return card;
    },

    /* --------------------------------------------------------- board events */

    flashPost(postId) {
      const el = document.querySelector(`.post-card[data-post="${postId}"]`);
      if (el) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
    },

    /* --------------------------------------------------------------- chat */

    enterSession(session) {
      state.session = session;
      UI.show('#view-session');
      $('#chat').innerHTML = '';
      drawIdenticon($('#peer-icon'), session.peer);
      $('#peer-addr').textContent = short(session.peer);
      $('#peer-role').textContent = session.role === 'client' ? 'contractor (accepted your bid selection)' : 'client (accepted your bid)';
      $('#session-status').textContent = 'connecting';
      $('#session-status').className = 'status-pill';
      const j = session.job || {};
      $('#job-title').textContent = j.type ? [j.type.industry, j.type.field, j.type.profession].filter(Boolean).join(' › ') : 'Job';
      $('#job-type').innerHTML = j.type ? [j.type.industry, j.type.field, j.type.profession].filter(Boolean).map((t) => `<span class="chip-skill">${esc(t)}</span>`).join('') : '';
      $('#job-desc').textContent = j.description || '';
      $('#job-meta').textContent = j.duration ? `Time: ${j.duration}` : '';
      $('#job-reward').textContent = session.reward
        ? `Agreed: ${session.reward.currency} ${Number(session.reward.amount).toLocaleString()}`
        : '';
      UI.linkState(session, 'connecting');
      if (session.role === 'client') {
        UI.sysChat('Bid accepted — you hold this chat open. Closing it ends the session and everything in it is forgotten.');
      } else {
        UI.sysChat('Your bid was accepted! Establishing a direct chat with the client…');
      }
    },

    linkState(session, mode) {
      if (state.session !== session) return;
      const dot = $('#link-dot');
      const label = $('#link-label');
      const pill = $('#session-status');
      dot.className = 'link-dot';
      if (mode === 'direct') {
        dot.classList.add('on');
        label.textContent = 'Direct browser-to-browser channel — encrypted, nothing stored.';
        pill.textContent = 'direct';
        pill.className = 'status-pill live';
      } else if (mode === 'relay') {
        dot.classList.add('relay');
        label.textContent = 'Relayed chat — direct link unavailable; messages bounce through the edge without being stored.';
        pill.textContent = 'relay';
        pill.className = 'status-pill live';
      } else {
        label.textContent = 'Opening direct link…';
        pill.textContent = 'connecting';
        pill.className = 'status-pill';
      }
    },

    sysChat(text) {
      const box = $('#chat');
      const el = document.createElement('div');
      el.className = 'msg sys';
      el.textContent = text;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },

    chat(text, mine) {
      if (!state.session) return;
      const box = $('#chat');
      const el = document.createElement('div');
      el.className = `msg ${mine ? 'me' : 'them'}`;
      el.textContent = text;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    },

    sendChat() {
      const s = state.session;
      if (!s || s.ended) return;
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      s.sendChat(text);
      input.value = '';
      UI.chat(text, true);
    },

    endSessionView(headline) {
      const s = state.session;
      if (s) s.end(false);
      toast(headline, 'warn');
      $('#post-card').classList.toggle('hidden', state.role !== 'client');
      UI.renderBoard();
      UI.show('#view-board');
    },
  };

  /* ======================================================================
     6 · BOARD EVENT ROUTING
     ====================================================================== */

  net.on('joined', (msg) => {
    state.posts.clear();
    for (const p of msg.board || []) state.posts.set(p.id, p);
    UI.setPill('#pill-signal', 'ok');
    UI.renderBoard();
  });

  net.on('posted', (msg) => {
    state.posts.set(msg.post.id, msg.post);
    toast('Job posted to the board.', 'ok');
    slog('app', `posted ${msg.post.id.slice(0, 8)}`, 'good');
    UI.renderBoard();
  });

  net.on('post-new', (msg) => {
    state.posts.set(msg.post.id, msg.post);
    slog('app', `new post ${msg.post.id.slice(0, 8)}: ${msg.post.type.profession}`);
    UI.renderBoard();
    UI.flashPost(msg.post.id);
  });

  net.on('post-updated', (msg) => {
    const p = state.posts.get(msg.postId);
    if (!p) return;
    p.bidCount = msg.bidCount;
    if (!p.mine) {
      // anonymous counts only; contractor list refreshes on bid-ok/bid-withdrawn
      p.bids = p.bids.slice(0, msg.bidCount);
    }
    UI.renderBoard();
  });

  net.on('post-removed', (msg) => {
    const had = state.posts.delete(msg.postId);
    state.myBids.delete(msg.postId);
    if (had && state.role === 'contractor') {
      const why = { filled: 'filled by the client', rejected: 'rejected by the client', withdrawn: 'withdrawn by the client', expired: 'expired' }[msg.reason] || 'removed';
      slog('app', `post ${msg.postId.slice(0, 8)} gone: ${why}`);
    }
    UI.renderBoard();
  });

  net.on('post-closed', (msg) => {
    // A post you bid on closed without you.
    state.posts.delete(msg.postId);
    state.myBids.delete(msg.postId);
    const why = { filled: 'The client accepted another contractor.', rejected: 'The client rejected all bids.', withdrawn: 'The client withdrew the post.' }[msg.reason] || 'Post closed.';
    toast(why, 'warn');
    slog('app', `post ${msg.postId.slice(0, 8)} closed for you: ${msg.reason}`);
    UI.renderBoard();
  });

  net.on('bid-new', (msg) => {
    const p = state.posts.get(msg.postId);
    if (!p || !p.mine) return;
    if (msg.updated) {
      const i = p.bids.findIndex((b) => b.id === msg.bid.id);
      if (i !== -1) p.bids[i] = { ...p.bids[i], ...msg.bid };
    } else {
      p.bids.push({ ...msg.bid, n: p.bids.length + 1 });
    }
    p.bidCount = p.bids.length;
    toast(`New bid on “${p.type.profession}”: ${msg.bid.currency} ${Number(msg.bid.amount).toLocaleString()}`, 'ok');
    slog('app', `bid on ${msg.postId.slice(0, 8)}: ${msg.bid.amount} ${msg.bid.currency}${msg.updated ? ' (updated)' : ''}`);
    UI.renderBoard();
    UI.flashPost(msg.postId);
  });

  net.on('bid-withdrawn', (msg) => {
    const p = state.posts.get(msg.postId);
    if (!p || !p.mine) return;
    p.bids = p.bids.filter((b) => b.id !== msg.bidId).map((b, i) => ({ ...b, n: i + 1 }));
    p.bidCount = p.bids.length;
    slog('app', `bid withdrawn on ${msg.postId.slice(0, 8)}`);
    UI.renderBoard();
  });

  net.on('bid-ok', (msg) => {
    state.myBids.set(msg.postId, { bidId: msg.bidId, amount: msg.amount, currency: msg.currency });
    toast(msg.updated ? 'Bid updated.' : 'Bid placed — the client sees it instantly.', 'ok');
    slog('app', `bid ok on ${msg.postId.slice(0, 8)}: ${msg.amount} ${msg.currency}`, 'good');
    // reflect own bid in the anonymous list
    const p = state.posts.get(msg.postId);
    if (p && !p.mine) {
      const found = p.bids.find((b) => b.mine);
      if (found) {
        found.amount = msg.amount; found.currency = msg.currency;
      } else {
        p.bids.push({ n: p.bids.length + 1, amount: msg.amount, currency: msg.currency, note: '', at: Date.now(), mine: true });
      }
    }
    UI.renderBoard();
  });

  net.on('error', (msg) => {
    toast(msg.message || 'The board rejected that action.', 'err');
    slog('app', `board error: ${msg.code || 'unknown'}`, 'bad');
  });

  /* ------------------------------------------------ acceptance → session */

  net.on('accepted', (msg) => {
    // CLIENT side: our accept was confirmed.
    const p = state.posts.get(msg.postId);
    const job = p ? { type: p.type, description: p.description, duration: p.duration, postedAt: p.postedAt } : null;
    state.posts.delete(msg.postId);
    const s = new Session(msg.sessionId, 'client', msg.contractor.address, job, state.pendingReward);
    state.pendingReward = null;
    UI.enterSession(s);
    UI.renderBoard();
    s.startAsClient();
  });

  net.on('bid-accepted', (msg) => {
    // CONTRACTOR side: we won the job.
    state.myBids.delete(msg.postId);
    const s = new Session(msg.sessionId, 'contractor', msg.client.address, msg.job, msg.reward);
    UI.enterSession(s);
    UI.renderBoard();
  });

  /* ------------------------------------------------ session signaling */

  net.on('offer', (msg) => {
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id && s.role === 'contractor') s.onOffer(msg.sdp);
  });

  net.on('answer', (msg) => {
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id && s.role === 'client') s.onAnswer(msg.sdp);
  });

  net.on('ice', (msg) => {
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id) s.onIce(msg.candidate);
  });

  net.on('chat', (msg) => {
    // relayed chat (fallback transport)
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id) UI.chat(msg.text, false);
  });

  net.on('bye', (msg) => {
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id) {
      UI.endSessionView('The other party closed the chat. Session garbage collected.');
    }
  });

  net.on('session-ended', (msg) => {
    const s = state.session;
    if (s && !s.ended && msg.sessionId === s.id) {
      const why = msg.reason === 'peer-disconnected'
        ? 'Your match disconnected. The session was garbage collected — nothing was stored.'
        : 'The session ended and was garbage collected.';
      UI.endSessionView(why);
    }
  });

  net.on('disconnected', () => {
    const s = state.session;
    if (s && !s.ended) {
      UI.sysChat('⚠ Board connection dropped. Reconnecting — an open direct chat link survives without it.');
    }
  });

  /* ======================================================================
     7 · STATIC UI WIRING
     ====================================================================== */

  document.addEventListener('DOMContentLoaded', () => {
    $('#ws-url').value = signalUrl();
    UI.renderWallet();
    UI.setPill('#pill-p2p', 'off');

    /* ---- wallet ---- */
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

    /* ---- roles ---- */
    $('#role-client').onclick = () => Wallet.connected && UI.enterRole('client');
    $('#role-contractor').onclick = () => Wallet.connected && UI.enterRole('contractor');
    $('#btn-board-back').onclick = () => UI.leaveRole();

    /* ---- client: post a job ---- */
    $('#post-form').onsubmit = (e) => {
      e.preventDefault();
      net.send({
        type: 'post-job',
        industry: $('#f-industry').value.trim(),
        field: $('#f-field').value.trim(),
        profession: $('#f-profession').value.trim(),
        description: $('#f-scope').value.trim(),
        duration: $('#f-duration').value.trim(),
      });
      e.target.reset();
    };

    /* ---- board actions (event delegation) ---- */
    $('#posts').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const card = btn.closest('.post-card');
      const postId = card && card.dataset.post;
      if (!postId) return;
      const action = btn.dataset.action;

      if (action === 'accept') {
        if (!confirm('Accept this bid and open a direct chat? The post leaves the board and other bidders are told.')) return;
        const p = state.posts.get(postId);
        const bid = p && p.bids.find((b) => b.id === btn.dataset.bid);
        state.pendingReward = bid ? { amount: bid.amount, currency: bid.currency } : null;
        net.send({ type: 'accept', postId, bidId: btn.dataset.bid });
      } else if (action === 'reject-all') {
        if (!confirm('Reject ALL bids? The post and every bid are garbage collected and bidders are notified.')) return;
        net.send({ type: 'reject-all', postId });
      } else if (action === 'withdraw-post') {
        if (!confirm('Withdraw this post? It and its bids are garbage collected immediately.')) return;
        net.send({ type: 'withdraw-post', postId });
      } else if (action === 'withdraw-bid') {
        const my = state.myBids.get(postId);
        if (my) {
          net.send({ type: 'withdraw-bid', postId, bidId: my.bidId });
          state.myBids.delete(postId);
          const p = state.posts.get(postId);
          if (p) p.bids = p.bids.filter((b) => !b.mine).map((b, i) => ({ ...b, n: i + 1 }));
          UI.renderBoard();
        }
      }
    });

    /* ---- contractor: bid form ---- */
    $('#posts').addEventListener('submit', (e) => {
      const form = e.target.closest('[data-bid-form]');
      if (!form) return;
      e.preventDefault();
      const card = form.closest('.post-card');
      const postId = card && card.dataset.post;
      if (!postId) return;
      const fd = new FormData(form);
      net.send({
        type: 'bid',
        postId,
        amount: Number(fd.get('amount')),
        currency: String(fd.get('currency') || 'ZAR'),
        note: String(fd.get('note') || '').trim(),
      });
      form.closest('details').open = false;
    });

    /* ---- refresh ---- */
    $('#btn-refresh').onclick = () => {
      const role = state.role;
      if (!role) return;
      net.close();
      UI.enterRole(role);
    };

    /* ---- session controls ---- */
    $('#btn-end').onclick = () => {
      const s = state.session;
      if (s && !s.ended) {
        s.end(true);
        toast(state.role === 'client'
          ? 'Chat closed — the session was garbage collected on the edge.'
          : 'Chat closed — the client was notified.', 'info');
        $('#post-card').classList.toggle('hidden', state.role !== 'client');
        UI.renderBoard();
        UI.show('#view-board');
      }
    };
    $('#btn-send').onclick = () => UI.sendChat();
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        UI.sendChat();
      }
    });

    /* ---- endpoint config ---- */
    $('#btn-ws-save').onclick = () => {
      const url = $('#ws-url').value.trim();
      if (!/^wss?:\/\/.+/.test(url)) {
        toast('Enter a valid ws:// or wss:// URL.', 'err');
        return;
      }
      try { localStorage.setItem(LS_WS_KEY, url); } catch (_) {}
      toast('Board endpoint saved.', 'ok');
      slog('net', `endpoint set → ${url}`);
      if (state.role) {
        const role = state.role;
        net.close();
        UI.enterRole(role);
      }
    };

    /* ---- housekeeping ---- */
    window.addEventListener('beforeunload', () => {
      const s = state.session;
      if (s && !s.ended) {
        try {
          if (s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'bye' }));
        } catch (_) {}
        net.send({ type: 'bye', sessionId: s.id });
        net.send({ type: 'end-session', sessionId: s.id });
      }
      net.send({ type: 'leave' });
    });

    slog('app', 'co-connect v2 booted — board model, zero dependencies');
  });
})();
