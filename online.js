/**
 * KartBlitz online multiplayer client (Cloudflare PartyServer WebSocket rooms).
 * Server-authoritative: all clients predict locally and interpolate remotes
 * from a 30 Hz binary snapshot stream (adaptive delay + short extrapolation).
 */
(function (global) {
  'use strict';

  var MAX_PLAYERS = 6;
  var INPUT_HZ = 30;
  var STATE_HZ = 30;
  var INTERP_MS_MIN = 60;
  var INTERP_MS = 80;
  var INTERP_MS_MAX = 200;
  var EXTRAP_MS_MAX = 50;
  var SNAP_BUF = 24;
  var LOCAL_BLEND_MIN = 40;
  var LOCAL_SNAP_ERR = 220;
  var PRODUCTION_HOST = 'kartblitz-online.kartblitz.workers.dev';
  var ONLINE_PROTOCOL = (global.OnlineSim && global.OnlineSim.ONLINE_PROTOCOL) || 3;
  var TRACK_BAKE_VERSION = (global.OnlineSim && global.OnlineSim.TRACK_BAKE_VERSION) || 2;
  var STEPS_PER_INPUT = (global.OnlineSim && global.OnlineSim.STEPS_PER_INPUT) || (60 / INPUT_HZ);
  var INPUT_HISTORY_MAX = 120;

  function netDebugEnabled() {
    try {
      return new URLSearchParams(location.search).get('netDebug') === '1';
    } catch (e) {
      return false;
    }
  }

  function defaultHost() {
    try {
      var q = new URLSearchParams(location.search).get('partyHost');
      if (q) return q.replace(/^https?:\/\//, '').replace(/\/$/, '');
    } catch (e) {}
    try {
      var stored = localStorage.getItem('kartblitz_party_host');
      if (stored) {
        stored = String(stored).replace(/^https?:\/\//, '').replace(/\/$/, '');
        var pageLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        var storedLocal = stored.indexOf('localhost') >= 0 || stored.indexOf('127.0.0.1') >= 0;
        if (storedLocal && !pageLocal) {
          try { localStorage.removeItem('kartblitz_party_host'); } catch (e3) {}
        } else if (stored) {
          return stored;
        }
      }
    } catch (e2) {}
    return PRODUCTION_HOST;
  }

  function httpBase(host) {
    var h = (host || defaultHost()).replace(/^https?:\/\//, '').replace(/\/$/, '');
    var secure = !(h.indexOf('localhost') >= 0 || h.indexOf('127.0.0.1') >= 0);
    return (secure ? 'https://' : 'http://') + h;
  }

  function fetchLobbies() {
    var url = httpBase(defaultHost()) + '/lobbies';
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Could not load lobbies (' + res.status + ')');
      return res.json();
    }).then(function (data) {
      return (data && data.lobbies) || [];
    });
  }

  function wsUrl(host, roomId) {
    var secure = !(host.indexOf('localhost') >= 0 || host.indexOf('127.0.0.1') >= 0);
    var proto = secure ? 'wss://' : 'ws://';
    return proto + host.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/parties/main/' + encodeURIComponent(roomId);
  }

  function makeRoomCode() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += alphabet.charAt((Math.random() * alphabet.length) | 0);
    return code;
  }

  function emptyInput() {
    return { up: false, down: false, left: false, right: false, ers: false, drs: false, steer: 0, throttle: 0, brake: 0 };
  }

  function OnlineSession() {
    this.host = defaultHost();
    this.roomId = null;
    this.ws = null;
    this.you = null;
    this.hostId = null;
    this.players = [];
    this.settings = { trackId: 0, laps: 3, weather: 'dry', collisionMode: 'collision', tyres: 'med' };
    this.phase = 'idle';
    this.order = [];
    this.localSlot = -1;
    this.remoteInputs = {};
    this.latestState = null;
    this.snapshots = [];
    this._guestPhase = null;
    this._clockOffset = 0;
    this._clockReady = false;
    this._lastTick = -1;
    this._lastHostT = -Infinity;
    this._interpDelay = INTERP_MS;
    this._jitterEma = 16;
    this._lastRecvAt = 0;
    this._extrapolating = false;
    this._extrapMs = 0;
    this._inputAcc = 0;
    this._inputSeq = 0;
    this._inputHistory = [];
    this._lastProcessedLocal = 0;
    this._bytesIn = 0;
    this._bytesOut = 0;
    this._bytesWindowStart = 0;
    this._bytesInRate = 0;
    this._bytesOutRate = 0;
    this._underruns = 0;
    this._lastCorrErr = 0;
    this._listeners = {};
    this._wantClose = false;
    this.statusText = '';
    this.lastError = '';
    this.authority = 'server';
    this.netDebug = netDebugEnabled();
  }

  OnlineSession.prototype.on = function (ev, fn) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  };

  OnlineSession.prototype.off = function (ev, fn) {
    var list = this._listeners[ev];
    if (!list) return;
    this._listeners[ev] = list.filter(function (f) { return f !== fn; });
  };

  OnlineSession.prototype.emit = function (ev, payload) {
    var list = this._listeners[ev] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error(e); }
    }
  };

  OnlineSession.prototype.isActive = function () {
    return this.phase === 'lobby' || this.phase === 'racing';
  };

  /** Lobby admin (settings / start), not physics authority. */
  OnlineSession.prototype.isHost = function () {
    return !!(this.you && this.hostId && this.you === this.hostId);
  };

  OnlineSession.prototype.connected = function () {
    return !!(this.ws && this.ws.readyState === 1);
  };

  OnlineSession.prototype.setHost = function (host) {
    this.host = (host || defaultHost()).replace(/^https?:\/\//, '').replace(/\/$/, '');
    try { localStorage.setItem('kartblitz_party_host', this.host); } catch (e) {}
  };

  OnlineSession.prototype.ensureHost = function () {
    this.host = defaultHost();
    return this.host;
  };

  OnlineSession.prototype._noteBytes = function (dir, n) {
    var now = performance.now();
    if (!this._bytesWindowStart) this._bytesWindowStart = now;
    if (dir === 'in') this._bytesIn += n;
    else this._bytesOut += n;
    var dt = now - this._bytesWindowStart;
    if (dt >= 1000) {
      this._bytesInRate = this._bytesIn / (dt / 1000);
      this._bytesOutRate = this._bytesOut / (dt / 1000);
      this._bytesIn = 0;
      this._bytesOut = 0;
      this._bytesWindowStart = now;
    }
  };

  OnlineSession.prototype.send = function (obj) {
    if (!this.connected()) return;
    try {
      var s = JSON.stringify(obj);
      this.ws.send(s);
      this._noteBytes('out', s.length);
    } catch (e) {}
  };

  OnlineSession.prototype.sendBinary = function (buf) {
    if (!this.connected() || !buf) return;
    try {
      this.ws.send(buf);
      this._noteBytes('out', buf.byteLength || 0);
    } catch (e) {}
  };

  OnlineSession.prototype.connect = function (roomId, meta) {
    var self = this;
    this.leave(true);
    this._wantClose = false;
    this.host = defaultHost();
    this.roomId = String(roomId || makeRoomCode()).toUpperCase();
    this.phase = 'lobby';
    this.statusText = 'Connecting…';
    this.lastError = '';
    this.remoteInputs = {};
    this._resetInterp();
    this.localSlot = -1;
    this.order = [];
    this.netDebug = netDebugEnabled();

    var url = wsUrl(this.host, this.roomId);
    var ws;
    try {
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      this.lastError = 'Could not open WebSocket to ' + url;
      this.phase = 'idle';
      this.emit('error', { message: this.lastError });
      this.emit('change');
      return Promise.reject(e);
    }
    this.ws = ws;

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        self.lastError = 'Connection timed out to ' + self.host + '. Clear localStorage kartblitz_party_host or open with ?partyHost=' + PRODUCTION_HOST;
        self.phase = 'idle';
        try { ws.close(); } catch (e2) {}
        self.emit('error', { message: self.lastError });
        self.emit('change');
        reject(new Error(self.lastError));
      }, 8000);

      ws.onopen = function () {
        self.statusText = 'Connected';
        var upgrades = typeof global.getOnlineUpgrades === 'function' ? global.getOnlineUpgrades() : null;
        self.send({
          type: 'hello',
          name: (meta && meta.name) || 'RACER',
          color: (meta && meta.color) || '#00f5ff',
          protocol: ONLINE_PROTOCOL,
          upgrades: upgrades
        });
        self.emit('change');
      };

      ws.onmessage = function (ev) {
        if (ev.data instanceof ArrayBuffer) {
          self._noteBytes('in', ev.data.byteLength || 0);
          self._handleBinary(ev.data);
          return;
        }
        var msg;
        try {
          msg = JSON.parse(ev.data);
          self._noteBytes('in', (ev.data && ev.data.length) || 0);
        } catch (e) { return; }
        self._handleMessage(msg);
        if (!settled && msg.type === 'welcome') {
          settled = true;
          clearTimeout(timer);
          resolve(self);
        }
        if (!settled && msg.type === 'error') {
          settled = true;
          clearTimeout(timer);
          reject(new Error(msg.message || 'Lobby error'));
        }
      };

      ws.onerror = function () {
        self.lastError = 'WebSocket error connecting to ' + url + '. Hard-refresh the page, or run: localStorage.removeItem("kartblitz_party_host")';
        self.emit('error', { message: self.lastError });
        self.emit('change');
      };

      ws.onclose = function () {
        clearTimeout(timer);
        if (self._wantClose) {
          self.phase = 'idle';
          self.emit('change');
          return;
        }
        var wasRacing = self.phase === 'racing';
        self.phase = 'idle';
        self.statusText = 'Disconnected';
        self.emit('disconnected', { wasRacing: wasRacing });
        self.emit('change');
        if (!settled) {
          settled = true;
          reject(new Error(self.lastError || 'Disconnected'));
        }
      };
    });
  };

  OnlineSession.prototype.hostLobby = function (meta) {
    return this.connect(makeRoomCode(), meta);
  };

  OnlineSession.prototype.joinLobby = function (code, meta) {
    var cleaned = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (cleaned.length < 4) return Promise.reject(new Error('Enter a valid room code'));
    return this.connect(cleaned, meta);
  };

  OnlineSession.prototype._resetInterp = function () {
    this.latestState = null;
    this.snapshots = [];
    this._guestPhase = null;
    this._clockOffset = 0;
    this._clockReady = false;
    this._lastTick = -1;
    this._lastHostT = -Infinity;
    this._interpDelay = INTERP_MS;
    this._jitterEma = 16;
    this._lastRecvAt = 0;
    this._extrapolating = false;
    this._extrapMs = 0;
    this._underruns = 0;
    this._lastCorrErr = 0;
    this._inputHistory = [];
    this._lastProcessedLocal = 0;
  };

  OnlineSession.prototype.leave = function (silent) {
    this._wantClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.phase = 'idle';
    this.roomId = null;
    this.you = null;
    this.hostId = null;
    this.players = [];
    this.order = [];
    this.localSlot = -1;
    this.remoteInputs = {};
    this._resetInterp();
    if (!silent) this.emit('change');
  };

  OnlineSession.prototype.setReady = function (ready) {
    var upgrades = typeof global.getOnlineUpgrades === 'function' ? global.getOnlineUpgrades() : null;
    this.send({ type: 'ready', ready: !!ready, upgrades: upgrades });
  };

  OnlineSession.prototype.updateSettings = function (settings) {
    if (!this.isHost()) return;
    this.settings = Object.assign({}, this.settings, settings || {});
    this.send({ type: 'lobbySettings', trackId: this.settings.trackId, laps: this.settings.laps, weather: this.settings.weather, collisionMode: this.settings.collisionMode, tyres: this.settings.tyres });
  };

  OnlineSession.prototype.startRace = function () {
    if (!this.isHost()) return;
    this.send({
      type: 'startRace',
      settings: this.settings,
      protocol: ONLINE_PROTOCOL
    });
  };

  OnlineSession.prototype.notifyRaceEnded = function () {
    if (!this.isHost()) return;
    this.send({ type: 'raceEnded' });
  };

  OnlineSession.prototype.returnLobby = function () {
    if (!this.isHost()) return;
    this.send({ type: 'returnLobby' });
  };

  OnlineSession.prototype.getNetDebug = function () {
    return {
      delay: Math.round(this._interpDelay || 0),
      jitter: Math.round(this._jitterEma || 0),
      extrapolating: !!this._extrapolating,
      extrapMs: Math.round(this._extrapMs || 0),
      bytesIn: Math.round(this._bytesInRate || 0),
      bytesOut: Math.round(this._bytesOutRate || 0),
      underruns: this._underruns || 0,
      corrErr: Math.round(this._lastCorrErr || 0),
      snaps: this.snapshots.length
    };
  };

  OnlineSession.prototype._handleBinary = function (buf) {
    var codec = global.OnlineCodec;
    if (!codec) return;
    var kind = codec.peekMsgType(buf);
    if (kind === codec.MSG_STATE) {
      var prev = this.latestState;
      var msg = codec.decodeState(buf, prev);
      if (!msg) return;
      this._ingestState(msg);
    }
  };

  OnlineSession.prototype._ingestState = function (msg) {
    var tick = typeof msg.tick === 'number' ? msg.tick : null;
    var hostT = typeof msg.t === 'number' ? msg.t : 0;
    if (tick != null) {
      if (tick <= this._lastTick) return;
      this._lastTick = tick;
    } else if (hostT <= this._lastHostT) {
      return;
    }
      this._lastHostT = hostT;
      msg.recvAt = Date.now();

      var expected = 1000 / STATE_HZ;
      if (this._lastRecvAt > 0) {
        var gap = msg.recvAt - this._lastRecvAt;
        var jitterSample = Math.abs(gap - expected);
        this._jitterEma += 0.12 * (jitterSample - this._jitterEma);
      }
      this._lastRecvAt = msg.recvAt;

      var sample = msg.recvAt - hostT;
    if (!this._clockReady) {
      this._clockOffset = sample;
      this._clockReady = true;
    } else {
      this._clockOffset += 0.05 * (sample - this._clockOffset);
    }

    var targetDelay = Math.max(INTERP_MS_MIN, Math.min(INTERP_MS_MAX, this._jitterEma * 2 + 40));
    // Pull toward target (faster decay than old design)
    this._interpDelay += (targetDelay - this._interpDelay) * 0.08;
    if (this._interpDelay < INTERP_MS_MIN) this._interpDelay = INTERP_MS_MIN;
    if (this._interpDelay > INTERP_MS_MAX) this._interpDelay = INTERP_MS_MAX;

    this.latestState = msg;
    this.snapshots.push(msg);
    if (this.snapshots.length > SNAP_BUF) this.snapshots.shift();
    this.emit('state', msg);
  };

  OnlineSession.prototype._handleMessage = function (msg) {
    var type = msg.type;
    if (type === 'welcome' || type === 'roster' || type === 'lobby') {
      var wasRacing = this.phase === 'racing';
      if (msg.you) this.you = msg.you;
      if (msg.hostId) this.hostId = msg.hostId;
      if (msg.players) this.players = msg.players;
      if (msg.settings) this.settings = msg.settings;
      // lobby messages always mean lobby even if phase omitted (legacy)
      if (type === 'lobby') this.phase = 'lobby';
      else if (msg.phase) this.phase = msg.phase === 'racing' ? 'racing' : 'lobby';
      if (msg.authority) this.authority = msg.authority;
      if (type === 'welcome') {
        if (msg.protocol != null && Number(msg.protocol) !== ONLINE_PROTOCOL) {
          this.lastError = 'Protocol mismatch (client ' + ONLINE_PROTOCOL + ' / server ' + msg.protocol + '). Redeploy Netlify + Worker together.';
          this.emit('error', { message: this.lastError, code: 'version_mismatch' });
          try { this.ws && this.ws.close(); } catch (e) {}
          return;
        }
        if (msg.trackBakeVersion != null && Number(msg.trackBakeVersion) !== TRACK_BAKE_VERSION) {
          this.lastError = 'Track bake mismatch. Run tracks:export, rebuild online-sim.js, redeploy.';
          this.emit('error', { message: this.lastError, code: 'bake_mismatch' });
          try { this.ws && this.ws.close(); } catch (e) {}
          return;
        }
      }
      this.statusText = 'In lobby';
      this.emit('roster', msg);
      this.emit('change');
      if (type === 'lobby' && wasRacing) this.emit('raceEnded', msg);
      return;
    }
    if (type === 'lobbySettings') {
      this.settings = msg.settings || this.settings;
      this.emit('settings', this.settings);
      this.emit('change');
      return;
    }
    if (type === 'playerLeft') {
      this.hostId = msg.hostId || this.hostId;
      this.players = msg.players || this.players;
      if (msg.id) delete this.remoteInputs[msg.id];
      this.emit('playerLeft', msg);
      this.emit('change');
      return;
    }
    if (type === 'hostMigrated') {
      // Legacy — server authority no longer migrates physics host mid-race
      this.hostId = msg.hostId || this.hostId;
      this.players = msg.players || this.players;
      this.emit('hostMigrated', msg);
      this.emit('change');
      return;
    }
    if (type === 'startRace') {
      this.phase = 'racing';
      this.settings = msg.settings || this.settings;
      this.order = msg.order || [];
      this.players = msg.players || this.players;
      this.hostId = msg.hostId || this.hostId;
      if (msg.authority) this.authority = msg.authority;
      this.localSlot = this.order.indexOf(this.you);
      this.remoteInputs = {};
      this._resetInterp();
      this.emit('startRace', msg);
      this.emit('change');
      return;
    }
    if (type === 'input') {
      if (msg.id && msg.id !== this.you) {
        this.remoteInputs[msg.id] = normalizeInput(msg.input);
      }
      return;
    }
    if (type === 'state') {
      // JSON fallback (legacy / debug)
      this._ingestState(msg);
      return;
    }
    if (type === 'raceAborted') {
      this.phase = 'lobby';
      this.hostId = msg.hostId || this.hostId;
      this.players = msg.players || this.players;
      this.order = [];
      this.localSlot = -1;
      this._resetInterp();
      this.emit('raceAborted', msg);
      this.emit('change');
      return;
    }
    if (type === 'raceEnded') {
      this.phase = 'lobby';
      this.players = msg.players || this.players;
      this.hostId = msg.hostId || this.hostId;
      this.order = [];
      this.localSlot = -1;
      this._resetInterp();
      this.emit('raceEnded', msg);
      this.emit('change');
      return;
    }
    if (type === 'error') {
      this.lastError = msg.message || 'Error';
      this.emit('error', msg);
      this.emit('change');
    }
  };

  function normalizeInput(inp) {
    inp = inp || {};
    return {
      up: !!inp.up,
      down: !!inp.down,
      left: !!inp.left,
      right: !!inp.right,
      ers: !!inp.ers,
      drs: !!inp.drs,
      steer: typeof inp.steer === 'number' ? inp.steer : (inp.left ? -1 : inp.right ? 1 : 0),
      throttle: typeof inp.throttle === 'number' ? inp.throttle : (inp.up ? 1 : 0),
      brake: typeof inp.brake === 'number' ? inp.brake : (inp.down ? 1 : 0)
    };
  }

  OnlineSession.prototype.getInputForConn = function (connId) {
    if (connId === this.you) {
      if (typeof global.getP1Input === 'function') return normalizeInput(global.getP1Input());
      return emptyInput();
    }
    return this.remoteInputs[connId] || emptyInput();
  };

  OnlineSession.prototype.makeKartInputFn = function (connId) {
    var self = this;
    return function () { return self.getInputForConn(connId); };
  };

  OnlineSession.prototype.getPredictInput = function () {
    var hist = this._inputHistory;
    if (hist && hist.length) return hist[hist.length - 1].input;
    return normalizeInput(typeof global.getP1Input === 'function' ? global.getP1Input() : emptyInput());
  };

  /** All clients send inputs; server owns physics. */
  OnlineSession.prototype.tickNet = function (dt) {
    if (this.phase !== 'racing' || !this.connected()) return;

    this._inputAcc += dt;
    var inputStep = 1 / INPUT_HZ;
    if (this._inputAcc >= inputStep) {
      this._inputAcc = this._inputAcc % inputStep;
      var inp = normalizeInput(typeof global.getP1Input === 'function' ? global.getP1Input() : emptyInput());
      this._inputSeq = (this._inputSeq + 1) & 0xffff;
      this._inputHistory.push({ seq: this._inputSeq, input: inp });
      if (this._inputHistory.length > INPUT_HISTORY_MAX) this._inputHistory.shift();
      var codec = global.OnlineCodec;
      if (codec && codec.encodeInput) {
        this.sendBinary(codec.encodeInput(inp, performance.now(), this._inputSeq));
      } else {
        this.send({ type: 'input', input: inp, t: performance.now(), seq: this._inputSeq });
      }
    }
    if (this._inputAcc > inputStep) this._inputAcc = 0;
  };

  function copyGameplayFields(k, s, isLocal) {
    if (typeof s.lap === 'number') k.lap = s.lap;
    if (s.finished != null) k.finished = !!s.finished;
    if (s.finishTime !== undefined) k.finishTime = s.finishTime;
    if (s.tyreId) k.tyreId = s.tyreId;
    if (!isLocal) {
      if (typeof s.tyreWear === 'number') k.tyreWear = s.tyreWear;
      if (typeof s.tyreTemp === 'number') k.tyreTemp = s.tyreTemp;
      if (typeof s.ersCharge === 'number') k.ersCharge = s.ersCharge;
      if (s.ersActive != null) k.ersActive = !!s.ersActive;
      if (s.drsActive != null) k.drsActive = !!s.drsActive;
      if (s.drsAvailable != null) k.drsAvailable = !!s.drsAvailable;
      if (s.pitPhase !== undefined) k.pitPhase = s.pitPhase;
      if (s.inPit != null) k.inPit = !!s.inPit;
    } else if (typeof s.ersCharge === 'number' && isFinite(s.ersCharge)) {
      var chargeErr = Math.abs((k.ersCharge || 0) - s.ersCharge);
      if (chargeErr > 0.25) k.ersCharge += (s.ersCharge - k.ersCharge) * 0.08;
    }
    if (typeof s.checkpointsBit === 'number') k.checkpointsBit = s.checkpointsBit;
    if (typeof s._nearestSplineIdx === 'number') k._nearestSplineIdx = s._nearestSplineIdx;
    if (s.bestLap != null) k.bestLap = s.bestLap;
    k._onlineDisconnected = !!s.disconnected;
    if (typeof s.maxSpeed === 'number' && isFinite(s.maxSpeed) && s.maxSpeed > 1) {
      k.maxSpeed = s.maxSpeed;
    }
  }

  function applyPose(k, s) {
    k.x = s.x;
    k.y = s.y;
    k.angle = s.angle;
    k.speed = s.speed;
  }

  function poseError(k, s) {
    var dx = (k.x || 0) - (s.x || 0);
    var dy = (k.y || 0) - (s.y || 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function finitePose(s) {
    return s && isFinite(s.x) && isFinite(s.y) && isFinite(s.angle) && isFinite(s.speed);
  }

  function lerp(a, b, u) {
    return a + (b - a) * u;
  }

  function lerpAngle(a, b, u) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * u;
  }

  function applyRaceMeta(race, snap, localIdx) {
    if (!snap) return;
    if (snap.phase) race.phase = snap.phase;
    if (typeof snap.countdownVal === 'number') race.countdownVal = snap.countdownVal;
    if (typeof snap.raceTimer === 'number') race.raceTimer = snap.raceTimer;
    var keepLocalRpm = race.phase === 'countdown' || race.phase === 'launch';
    if (Array.isArray(snap.launchRPM) && race.launchRPM) {
      for (var ri = 0; ri < snap.launchRPM.length; ri++) {
        if (keepLocalRpm && ri === localIdx) continue;
        race.launchRPM[ri] = snap.launchRPM[ri];
      }
    }
  }

  OnlineSession.prototype.interpolateRemoteKarts = function (race, now) {
    if (!race || !this.snapshots.length) return;
    var localIdx = this.localSlot >= 0 ? this.localSlot : 0;
    var delay = this._interpDelay || INTERP_MS;
    var renderHostT = now - (this._clockOffset || 0) - delay;
    var snaps = this.snapshots;
    var snapA = snaps[snaps.length - 1];
    var snapB = snapA;
    var u = 1;
    var latestT = snapB.t || 0;
    var oldestT = snaps[0].t || 0;
    var i;
    this._extrapolating = false;
    this._extrapMs = 0;

    if (renderHostT > latestT) {
      var late = renderHostT - latestT;
      this._underruns++;
      if (late <= EXTRAP_MS_MAX) {
        this._extrapolating = true;
        this._extrapMs = late;
        snapA = snapB;
        u = 1;
      } else {
        this._interpDelay = Math.min(INTERP_MS_MAX, delay + 6);
        snapA = snapB;
        u = 1;
      }
    } else {
      if (renderHostT <= oldestT) {
        snapA = snaps[0];
        snapB = snaps[0];
        u = 1;
      } else {
        for (i = 0; i < snaps.length - 1; i++) {
          var tA = snaps[i].t || 0;
          var tB = snaps[i + 1].t || 0;
          if (tA <= renderHostT && tB >= renderHostT) {
            snapA = snaps[i];
            snapB = snaps[i + 1];
            if (tB > tA) {
              u = (renderHostT - tA) / (tB - tA);
              if (u < 0) u = 0;
              if (u > 1) u = 1;
            }
            break;
          }
        }
      }
    }

    applyRaceMeta(race, snapB, localIdx);
    if (!snapB || !snapB.karts) return;
    var kartsA = (snapA && snapA.karts) || snapB.karts;
    var extrapSec = this._extrapolating ? (this._extrapMs / 1000) : 0;

    for (i = 0; i < snapB.karts.length; i++) {
      if (i === localIdx) continue;
      var k = race.karts[i];
      var sB = snapB.karts[i];
      var sA = kartsA[i] || sB;
      if (!k || !finitePose(sB)) continue;
      if (this._extrapolating && finitePose(sB)) {
        k.x = sB.x + Math.cos(sB.angle) * sB.speed * extrapSec;
        k.y = sB.y + Math.sin(sB.angle) * sB.speed * extrapSec;
        k.angle = sB.angle;
        k.speed = sB.speed;
      } else if (finitePose(sA) && u < 1) {
        k.x = lerp(sA.x, sB.x, u);
        k.y = lerp(sA.y, sB.y, u);
        k.speed = lerp(sA.speed, sB.speed, u);
        k.angle = lerpAngle(sA.angle, sB.angle, u);
      } else {
        applyPose(k, sB);
      }
      copyGameplayFields(k, sB, false);
    }
  };

  OnlineSession.prototype.reconcileLocalKart = function (race, dt) {
    if (!race) return;
    var snap = this.latestState;
    if (!snap || !snap.karts) return;
    var localIdx = this.localSlot >= 0 ? this.localSlot : 0;
    var k = race.karts[localIdx];
    var s = snap.karts[localIdx];
    if (!k || !finitePose(s)) return;

    var lastProc = 0;
    if (Array.isArray(snap.lastProcessedInput) && snap.lastProcessedInput[localIdx] != null) {
      lastProc = snap.lastProcessedInput[localIdx] | 0;
      this._lastProcessedLocal = lastProc;
      // Drop acked inputs
      this._inputHistory = this._inputHistory.filter(function (h) {
        var d = (h.seq - lastProc) & 0xffff;
        return d > 0 && d < 0x8000;
      });
    }

    copyGameplayFields(k, s, true);
    var Sim = global.OnlineSim;
    var justLaunched = this._guestPhase !== 'racing' && snap.phase === 'racing';

    // Authoritative pose + replay unacked inputs through shared sim when available
    if (Sim && Sim.stepKart && race._onlineLocalSim && snap.phase === 'racing' && !justLaunched) {
      Sim.applyNetPose(race._onlineLocalSim, s);
      if (typeof s.tyreTemp === 'number') race._onlineLocalSim.tyreTemp = s.tyreTemp;
      var track = race._onlineSimTrack || null;
      var collideOn = (race.collisionMode || 'collision') !== 'nocollision';
      var contactOn = collideOn;
      var remotes = [];
      var i;
      for (i = 0; i < race.karts.length; i++) {
        if (i === localIdx) continue;
        var rk = race.karts[i];
        if (!rk || !finitePose(rk)) continue;
        remotes.push({
          id: i,
          x: rk.x,
          y: rk.y,
          angle: rk.angle,
          speed: rk.speed,
          finished: !!rk.finished
        });
      }
      var cars = [race._onlineLocalSim].concat(remotes);
      var hist = this._inputHistory;
      var stepsPer = STEPS_PER_INPUT | 0;
      if (stepsPer < 1) stepsPer = 2;
      var dtStep = Sim.FIXED_DT || (1 / 60);
      for (i = 0; i < hist.length; i++) {
        for (var stepI = 0; stepI < stepsPer; stepI++) {
          Sim.stepKart(race._onlineLocalSim, hist[i].input, dtStep, track || race.track, cars, {
            contact: contactOn,
            resolveCollisions: collideOn,
            nowMs: race._onlineLocalSim.simTimeMs + dtStep * 1000
          });
        }
      }
      // Hard-apply corrected prediction to sim; soft-blend DISPLAY kart only (never write blend back into sim)
      var corrErr = poseError(k, race._onlineLocalSim);
      this._lastCorrErr = corrErr;
      if (corrErr > LOCAL_SNAP_ERR || !isFinite(k.x) || !isFinite(k.y)) {
        applyPose(k, race._onlineLocalSim);
      } else if (corrErr >= LOCAL_BLEND_MIN) {
        var omega = 10 + Math.min(14, corrErr / 35);
        var t = 1 - Math.exp(-omega * (dt || 1 / 60));
        t = Math.min(1, Math.max(0.08, t));
        k.x = lerp(k.x, race._onlineLocalSim.x, t);
        k.y = lerp(k.y, race._onlineLocalSim.y, t);
        k.speed = lerp(k.speed, race._onlineLocalSim.speed, t);
        k.angle = lerpAngle(k.angle, race._onlineLocalSim.angle, t);
      } else {
        applyPose(k, race._onlineLocalSim);
      }
      k.ersCharge = race._onlineLocalSim.ersCharge;
      k.ersActive = race._onlineLocalSim.ersActive;
      k.drsActive = race._onlineLocalSim.drsActive;
      k.tyreWear = race._onlineLocalSim.tyreWear;
      if (typeof race._onlineLocalSim.tyreTemp === 'number') k.tyreTemp = race._onlineLocalSim.tyreTemp;
      this._guestPhase = snap.phase || race.phase;
      return;
    }

    var err = (isFinite(k.x) && isFinite(k.y)) ? poseError(k, s) : Infinity;
    this._lastCorrErr = err;
    if (err > LOCAL_SNAP_ERR || !isFinite(k.x) || !isFinite(k.y) || justLaunched) {
      applyPose(k, s);
    } else if (err >= LOCAL_BLEND_MIN) {
      var omega = 8 + Math.min(12, err / 40);
      var t = 1 - Math.exp(-omega * (dt || 1 / 60));
      t = Math.min(1, Math.max(0.05, t));
      k.x = lerp(k.x, s.x, t);
      k.y = lerp(k.y, s.y, t);
      k.speed = lerp(k.speed, s.speed, t);
      k.angle = lerpAngle(k.angle, s.angle, t);
    }
    this._guestPhase = snap.phase || race.phase;
  };

  var session = new OnlineSession();

  global.OnlineNet = {
    session: session,
    MAX_PLAYERS: MAX_PLAYERS,
    PRODUCTION_HOST: PRODUCTION_HOST,
    INPUT_HZ: INPUT_HZ,
    STATE_HZ: STATE_HZ,
    ONLINE_PROTOCOL: ONLINE_PROTOCOL,
    TRACK_BAKE_VERSION: TRACK_BAKE_VERSION,
    makeRoomCode: makeRoomCode,
    defaultHost: defaultHost,
    fetchLobbies: fetchLobbies,
    emptyInput: emptyInput
  };
})(typeof window !== 'undefined' ? window : globalThis);
