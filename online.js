/**
 * KartBlitz online multiplayer client (Cloudflare PartyServer WebSocket rooms).
 * Shared sim: all peers run physics from broadcast inputs.
 * Host sends 10 Hz corrections; guests apply only on new snapshots.
 */
(function (global) {
  'use strict';

  var MAX_PLAYERS = 6;
  var INPUT_HZ = 60;
  var STATE_HZ = 10;
  var LOCAL_SNAP_ERR = 180;
  var REMOTE_SNAP_ERR = 120;
  var PRODUCTION_HOST = 'kartblitz-online.kartblitz.workers.dev';

  /**
   * Default to the deployed Worker everywhere.
   * Overrides: ?partyHost=... or localStorage kartblitz_party_host
   * Local wrangler: open game with ?partyHost=127.0.0.1:8787
   */
  function defaultHost() {
    try {
      var q = new URLSearchParams(location.search).get('partyHost');
      if (q) return q.replace(/^https?:\/\//, '').replace(/\/$/, '');
    } catch (e) {}
    try {
      var stored = localStorage.getItem('kartblitz_party_host');
      if (stored) {
        stored = String(stored).replace(/^https?:\/\//, '').replace(/\/$/, '');
        // Ignore stale local/dev hosts when playing on a real site (Netlify etc.)
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
    this.phase = 'idle'; // idle|lobby|racing
    this.order = [];
    this.localSlot = -1;
    this.remoteInputs = {};
    this.latestState = null;
    this.prevState = null;
    this._stateDirty = false;
    this._inputAcc = 0;
    this._stateAcc = 0;
    this._listeners = {};
    this._wantClose = false;
    this.statusText = '';
    this.lastError = '';
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

  /** Ensure session uses the correct default host before connecting. */
  OnlineSession.prototype.ensureHost = function () {
    this.host = defaultHost();
    return this.host;
  };

  OnlineSession.prototype.send = function (obj) {
    if (!this.connected()) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
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
    this.latestState = null;
    this.prevState = null;
    this._stateDirty = false;
    this.localSlot = -1;
    this.order = [];

    var url = wsUrl(this.host, this.roomId);
    var ws;
    try {
      ws = new WebSocket(url);
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
        self.send({
          type: 'hello',
          name: (meta && meta.name) || 'RACER',
          color: (meta && meta.color) || '#00f5ff'
        });
        self.emit('change');
      };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
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
    this.latestState = null;
    this.prevState = null;
    this._stateDirty = false;
    if (!silent) this.emit('change');
  };

  OnlineSession.prototype.setReady = function (ready) {
    this.send({ type: 'ready', ready: !!ready });
  };

  OnlineSession.prototype.updateSettings = function (settings) {
    if (!this.isHost()) return;
    this.settings = Object.assign({}, this.settings, settings || {});
    this.send({ type: 'lobbySettings', trackId: this.settings.trackId, laps: this.settings.laps, weather: this.settings.weather, collisionMode: this.settings.collisionMode, tyres: this.settings.tyres });
  };

  OnlineSession.prototype.startRace = function () {
    if (!this.isHost()) return;
    this.send({ type: 'startRace', settings: this.settings });
  };

  OnlineSession.prototype.notifyRaceEnded = function () {
    if (!this.isHost()) return;
    this.send({ type: 'raceEnded' });
  };

  OnlineSession.prototype.returnLobby = function () {
    if (!this.isHost()) return;
    this.send({ type: 'returnLobby' });
  };

  OnlineSession.prototype._handleMessage = function (msg) {
    var type = msg.type;
    if (type === 'welcome' || type === 'roster' || type === 'lobby') {
      if (msg.you) this.you = msg.you;
      if (msg.hostId) this.hostId = msg.hostId;
      if (msg.players) this.players = msg.players;
      if (msg.settings) this.settings = msg.settings;
      if (msg.phase) this.phase = msg.phase === 'racing' ? 'racing' : 'lobby';
      this.statusText = 'In lobby';
      this.emit('roster', msg);
      this.emit('change');
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
      this.hostId = msg.hostId || this.hostId;
      this.players = msg.players || this.players;
      if (msg.disconnectedId) delete this.remoteInputs[msg.disconnectedId];
      this.phase = 'racing';
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
      this.localSlot = this.order.indexOf(this.you);
      this.remoteInputs = {};
      this.latestState = null;
      this.prevState = null;
      this._stateDirty = false;
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
      if (this.isHost()) return;
      this.prevState = this.latestState;
      this.latestState = msg;
      this._stateDirty = true;
      this.emit('state', msg);
      return;
    }
    if (type === 'raceAborted') {
      this.phase = 'lobby';
      this.hostId = msg.hostId || this.hostId;
      this.players = msg.players || this.players;
      this.order = [];
      this.localSlot = -1;
      this.latestState = null;
      this.prevState = null;
      this._stateDirty = false;
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
      this.latestState = null;
      this.prevState = null;
      this._stateDirty = false;
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

  OnlineSession.prototype.tickNet = function (dt, race, forceState) {
    if (this.phase !== 'racing' || !this.connected()) return;

    this._inputAcc += dt;
    var inputStep = 1 / INPUT_HZ;
    if (this._inputAcc >= inputStep) {
      this._inputAcc = this._inputAcc % inputStep;
      this.send({
        type: 'input',
        input: normalizeInput(typeof global.getP1Input === 'function' ? global.getP1Input() : emptyInput()),
        t: performance.now()
      });
    }
    if (this._inputAcc > inputStep) this._inputAcc = 0;

    if (this.isHost() && race) {
      this._stateAcc += dt;
      var stateStep = 1 / STATE_HZ;
      if (forceState || this._stateAcc >= stateStep) {
        this._stateAcc = forceState ? 0 : this._stateAcc % stateStep;
        this.send({
          type: 'state',
          t: performance.now(),
          phase: race.phase,
          countdownVal: race.countdownVal,
          raceTimer: race.raceTimer,
          launchRPM: (race.launchRPM || []).map(function (v) { return round3(v || 0); }),
          karts: (race.karts || []).map(serializeKart)
        });
      }
    }
  };

  function serializeKart(k) {
    return {
      id: k.id,
      x: round3(k.x),
      y: round3(k.y),
      angle: round3(k.angle),
      speed: round3(k.speed),
      lap: k.lap || 0,
      finished: !!k.finished,
      finishTime: k.finishTime == null ? null : round3(k.finishTime),
      tyreId: k.tyreId || 'med',
      tyreWear: round3(k.tyreWear || 0),
      ersCharge: round3(k.ersCharge || 0),
      ersActive: !!k.ersActive,
      drsActive: !!k.drsActive,
      drsAvailable: !!k.drsAvailable,
      pitPhase: k.pitPhase || null,
      inPit: !!k.inPit,
      checkpointsBit: k.checkpointsBit || 0,
      _nearestSplineIdx: k._nearestSplineIdx || 0,
      bestLap: k.bestLap < Infinity ? round3(k.bestLap) : null,
      maxSpeed: round3(k.maxSpeed || 0),
      disconnected: !!k._onlineDisconnected
    };
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function copyGameplayFields(k, s, isLocal) {
    k.lap = s.lap;
    k.finished = !!s.finished;
    k.finishTime = s.finishTime;
    k.tyreId = s.tyreId || k.tyreId;
    k.tyreWear = s.tyreWear;
    k.ersCharge = s.ersCharge;
    if (!isLocal) {
      k.ersActive = !!s.ersActive;
      k.drsActive = !!s.drsActive;
      k.drsAvailable = !!s.drsAvailable;
      k.pitPhase = s.pitPhase;
      k.inPit = !!s.inPit;
    }
    k.checkpointsBit = s.checkpointsBit || 0;
    k._nearestSplineIdx = s._nearestSplineIdx || 0;
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

  OnlineSession.prototype.applyStateToRace = function (race, dt) {
    if (!this._stateDirty) return;
    this._stateDirty = false;
    var snap = this.latestState;
    if (!race || !snap || !snap.karts) return;

    if (snap.phase && snap.phase !== race.phase) {
      race.phase = snap.phase;
      if (typeof snap.countdownVal === 'number') race.countdownVal = snap.countdownVal;
      if (typeof snap.raceTimer === 'number') race.raceTimer = snap.raceTimer;
    } else if (snap.phase === 'finished' || race.phase === 'finished') {
      if (typeof snap.raceTimer === 'number') race.raceTimer = snap.raceTimer;
    }

    var localIdx = this.localSlot >= 0 ? this.localSlot : 0;
    var keepLocalRpm = race.phase === 'countdown' || race.phase === 'launch';
    if (Array.isArray(snap.launchRPM) && race.launchRPM) {
      for (var ri = 0; ri < snap.launchRPM.length; ri++) {
        if (keepLocalRpm && ri === localIdx) continue;
        race.launchRPM[ri] = snap.launchRPM[ri];
      }
    }

    for (var i = 0; i < snap.karts.length; i++) {
      var s = snap.karts[i];
      var k = race.karts[i];
      if (!k || !s || !finitePose(s)) continue;
      var isLocal = i === localIdx;
      var err = (isFinite(k.x) && isFinite(k.y)) ? poseError(k, s) : Infinity;
      var snapPose = err > (isLocal ? LOCAL_SNAP_ERR : REMOTE_SNAP_ERR);
      if (snapPose) applyPose(k, s);
      copyGameplayFields(k, s, isLocal);
    }
  };

  var session = new OnlineSession();

  global.OnlineNet = {
    session: session,
    MAX_PLAYERS: MAX_PLAYERS,
    PRODUCTION_HOST: PRODUCTION_HOST,
    makeRoomCode: makeRoomCode,
    defaultHost: defaultHost,
    fetchLobbies: fetchLobbies,
    emptyInput: emptyInput
  };
})(typeof window !== 'undefined' ? window : globalThis);
