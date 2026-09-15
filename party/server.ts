import { Server, type Connection, type ConnectionContext } from "partyserver";
import type { Env } from "./env";
import { getDeviceByToken, recordOnlineWin } from "./leaderboard";
import { decodeInput, MSG_INPUT, NET_MAGIC, NET_VERSION } from "./netcodec";
import {
  createSeat,
  forfeitSeat,
  graceRemainingMs,
  isGraceExpired,
  markSeatDisconnected,
  pickHostSeatId,
  RECONNECT_GRACE_MS,
  RESUME_HELLO_TIMEOUT_MS,
  rosterPublic,
  validateResume,
  type SeatRecord,
} from "./reconnect";
import {
  FIXED_DT,
  loadTrackBake,
  ONLINE_PROTOCOL,
  OnlineRaceSim,
  TRACK_BAKE_VERSION,
  type BakedTrack,
  type SimInput,
  type UpgradeStats,
} from "../sim";
import {
  defaultUpgrades,
  resolveOnlineUpgrades,
  TRUST_CLIENT_PROGRESSION_UPGRADES,
} from "../sim/upgrades";

const MAX_PLAYERS = 6;
const SIM_STEP_MS = Math.round(FIXED_DT * 1000);
const MAX_CATCHUP_STEPS = 12;

type LobbySettings = {
  trackId: number;
  laps: number;
  weather: string;
  collisionMode: string;
  tyres: string;
};

type RoomPhase = "lobby" | "racing";

type PendingResume = {
  at: number;
};

function json(data: unknown) {
  return JSON.stringify(data);
}

/** PartyServer inherits DurableObject ctx/env at runtime; typings omit them. */
function doCtx(room: KartBlitzRoom): DurableObjectState {
  return (room as unknown as { ctx: DurableObjectState }).ctx;
}

function doEnv(room: KartBlitzRoom): Env {
  return (room as unknown as { env: Env }).env;
}

function isBinary(msg: string | ArrayBuffer): msg is ArrayBuffer {
  return typeof msg !== "string";
}

function peekBinaryType(buf: ArrayBuffer): number {
  if (buf.byteLength < 4) return 0;
  const v = new DataView(buf);
  if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION) return 0;
  return v.getUint8(3);
}

/** One Durable Object room per lobby. Binding name Main → /parties/main/<room>. */
export class KartBlitzRoom extends Server<Env> {
  /** Stable seats keyed by seatId (not WebSocket id). */
  seats = new Map<string, SeatRecord>();
  /** Live connection → seatId. */
  connSeats = new Map<string, string>();
  /** Racing sockets waiting for hello+token. */
  pendingResume = new Map<string, PendingResume>();

  /** Lobby admin seatId (settings / start / return) — not the physics host. */
  hostId: string | null = null;
  phase: RoomPhase = "lobby";
  settings: LobbySettings = {
    trackId: 0,
    laps: 3,
    weather: "dry",
    collisionMode: "collision",
    tyres: "med",
  };

  raceSim: OnlineRaceSim | null = null;
  /** Grid order of seatIds at race start. */
  raceOrder: string[] = [];
  private _alarmScheduled = false;
  private _lastSimWall = 0;
  private _simAccMs = 0;
  private _raceEndTimer = 0;
  /** Prevent duplicate online-win DB writes for one race. */
  private _winRecorded = false;

  onConnect(conn: Connection, _ctx: ConnectionContext) {
    if (this.phase === "racing") {
      // Do not create a new seat — wait for resume hello with reconnect token.
      const connectedCount = this.connectedSeatCount();
      if (connectedCount >= MAX_PLAYERS) {
        conn.send(json({ type: "error", code: "full", message: "Lobby is full (max 6)." }));
        conn.close(4000, "full");
        return;
      }
      this.pendingResume.set(conn.id, { at: Date.now() });
      conn.send(
        json({
          type: "resumeRequired",
          roomId: this.name,
          phase: "racing",
          graceMs: RECONNECT_GRACE_MS,
          protocol: ONLINE_PROTOCOL,
          trackBakeVersion: TRACK_BAKE_VERSION,
        })
      );
      return;
    }

    if (this.seats.size >= MAX_PLAYERS) {
      conn.send(json({ type: "error", code: "full", message: "Lobby is full (max 6)." }));
      conn.close(4000, "full");
      return;
    }

    const seat = createSeat({
      connId: conn.id,
      upgrades: defaultUpgrades(),
    });
    this.seats.set(seat.seatId, seat);
    this.connSeats.set(conn.id, seat.seatId);
    if (!this.hostId) this.hostId = seat.seatId;

    this.sendWelcome(conn, seat, { resumed: false });
    this.broadcastRoster(seat.seatId);
    void this.syncDirectory();
  }

  onClose(conn: Connection) {
    const pending = this.pendingResume.get(conn.id);
    if (pending) {
      this.pendingResume.delete(conn.id);
      return;
    }

    const seatId = this.connSeats.get(conn.id);
    if (!seatId) return;
    const seat = this.seats.get(seatId);
    if (!seat || seat.connId !== conn.id) {
      this.connSeats.delete(conn.id);
      return;
    }

    this.connSeats.delete(conn.id);
    const wasHost = this.hostId === seatId;
    const now = Date.now();

    if (this.phase === "racing") {
      const next = markSeatDisconnected(seat, now);
      this.seats.set(seatId, next);
      if (this.raceSim) this.raceSim.markDisconnected(seatId);

      if (wasHost) {
        this.hostId = pickHostSeatId([...this.seats.values()], this.raceOrder);
      }

      this.broadcast(
        json({
          type: "playerDisconnected",
          id: seatId,
          hostId: this.hostId,
          players: this.roster(),
          phase: this.phase,
          graceMs: RECONNECT_GRACE_MS,
          graceRemainingMs: graceRemainingMs(next, now),
        })
      );
      if (wasHost) {
        this.broadcast(
          json({
            type: "hostMigrated",
            hostId: this.hostId,
            disconnectedId: seatId,
            players: this.roster(),
            phase: this.phase,
          })
        );
      }
      void this.syncDirectory();
      return;
    }

    // Lobby: permanent leave
    this.seats.delete(seatId);
    if (this.seats.size === 0) {
      this.hostId = null;
      this.phase = "lobby";
      this.stopSim();
      this.resetSettings();
      void this.syncDirectory(true);
      return;
    }
    if (wasHost) {
      this.hostId = pickHostSeatId([...this.seats.values()]);
    }
    this.broadcast(
      json({
        type: "playerLeft",
        id: seatId,
        hostId: this.hostId,
        players: this.roster(),
        phase: this.phase,
      })
    );
    void this.syncDirectory();
  }

  onMessage(sender: Connection, message: string | ArrayBuffer) {
    if (isBinary(message)) {
      this.handleBinary(sender, message);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(msg.type || "");

    // Pending resume sockets may only send hello / resume
    if (this.pendingResume.has(sender.id)) {
      if (type === "hello" || type === "resume") {
        void this.handleResumeHello(sender, msg);
      }
      return;
    }

    const seat = this.seatForConn(sender.id);
    if (!seat && type !== "hello") return;

    switch (type) {
      case "hello": {
        if (!seat) return;
        if (msg.protocol != null && Number(msg.protocol) !== ONLINE_PROTOCOL) {
          sender.send(
            json({
              type: "error",
              code: "version_mismatch",
              message: "Client/server protocol mismatch. Hard-refresh and redeploy assets.",
              protocol: ONLINE_PROTOCOL,
            })
          );
          try {
            sender.close(1000, "version_mismatch");
          } catch {
            /* ignore */
          }
          return;
        }
        // Mid-race hello on an already-bound seat is a profile refresh only
        void this.applyHelloProfile(sender, seat, msg);
        break;
      }
      case "ready": {
        if (!seat || this.phase !== "lobby") return;
        seat.ready = !!msg.ready;
        seat.upgrades = resolveOnlineUpgrades(msg.upgrades);
        this.seats.set(seat.seatId, seat);
        this.broadcastRoster();
        break;
      }
      case "lobbySettings": {
        if (!seat || seat.seatId !== this.hostId || this.phase !== "lobby") return;
        this.settings = {
          trackId: clampInt(msg.trackId, 0, 64, this.settings.trackId),
          laps: clampInt(msg.laps, 1, 20, this.settings.laps),
          weather: String(msg.weather || this.settings.weather).slice(0, 16),
          collisionMode: String(msg.collisionMode || this.settings.collisionMode).slice(0, 24),
          tyres: String(msg.tyres || this.settings.tyres).slice(0, 12),
        };
        this.broadcast(json({ type: "lobbySettings", settings: this.settings }));
        void this.syncDirectory();
        break;
      }
      case "startRace": {
        if (!seat || seat.seatId !== this.hostId || this.phase !== "lobby") return;
        if (msg.protocol != null && Number(msg.protocol) !== ONLINE_PROTOCOL) {
          sender.send(
            json({
              type: "error",
              code: "version_mismatch",
              message: "Client/server protocol mismatch. Update the game files.",
              protocol: ONLINE_PROTOCOL,
            })
          );
          return;
        }
        const live = [...this.seats.values()].filter((s) => s.status === "connected");
        const readyCount = live.filter((p) => p.ready).length;
        if (live.length < 2 || readyCount < 2) {
          sender.send(
            json({
              type: "error",
              code: "not_ready",
              message: "Need at least 2 ready players to start.",
            })
          );
          return;
        }
        if (msg.settings && typeof msg.settings === "object") {
          const s = msg.settings as Record<string, unknown>;
          this.settings = {
            trackId: clampInt(s.trackId, 0, 64, this.settings.trackId),
            laps: clampInt(s.laps, 1, 20, this.settings.laps),
            weather: String(s.weather || this.settings.weather).slice(0, 16),
            collisionMode: String(s.collisionMode || this.settings.collisionMode).slice(0, 24),
            tyres: String(s.tyres || this.settings.tyres).slice(0, 12),
          };
        }

        let track = loadTrackBake(this.settings.trackId);
        if (!track && msg.trackBake) {
          track = sanitizeTrackBake(msg.trackBake);
        }
        if (!track) {
          sender.send(
            json({
              type: "error",
              code: "no_track",
              message: "Unknown trackId " + this.settings.trackId + ". Run npm run tracks:export and redeploy Worker.",
            })
          );
          return;
        }

        const order = live.map((p) => p.seatId);
        this.raceOrder = order.slice();
        this.phase = "racing";
        this._raceEndTimer = 0;
        this._winRecorded = false;
        const equalCars = live.map((p) => ({
          id: p.seatId,
          name: p.name,
          color: p.color,
          upgrades: resolveOnlineUpgrades(p.upgrades as UpgradeStats),
        }));
        this.raceSim = new OnlineRaceSim({
          track,
          players: equalCars,
          order,
          laps: this.settings.laps,
          weather: this.settings.weather,
          collisionMode: this.settings.collisionMode,
          tyres: this.settings.tyres,
        });
        this._lastSimWall = Date.now();
        this._simAccMs = 0;

        this.broadcast(
          json({
            type: "startRace",
            settings: this.settings,
            order,
            players: equalCars,
            hostId: this.hostId,
            authority: "server",
            protocol: ONLINE_PROTOCOL,
            trackBakeVersion: TRACK_BAKE_VERSION,
            equalPerformance: !TRUST_CLIENT_PROGRESSION_UPGRADES,
            reconnectGraceMs: RECONNECT_GRACE_MS,
          })
        );
        const boot = this.raceSim.buildStatePacket(true);
        this.broadcast(boot);
        void this.scheduleAlarm(Date.now() + SIM_STEP_MS);
        void this.syncDirectory(true);
        break;
      }
      case "input": {
        if (this.phase !== "racing" || !this.raceSim || !seat) return;
        this.raceSim.setInput(seat.seatId, normalizeInput(msg.input), typeof msg.seq === "number" ? msg.seq : undefined);
        break;
      }
      case "raceEnded": {
        if (!seat || seat.seatId !== this.hostId) return;
        this.endRaceToLobby();
        break;
      }
      case "returnLobby": {
        if (!seat || seat.seatId !== this.hostId) return;
        this.endRaceToLobby();
        break;
      }
      default:
        break;
    }
  }

  handleBinary(sender: Connection, buf: ArrayBuffer) {
    const kind = peekBinaryType(buf);
    if (kind === MSG_INPUT) {
      if (this.phase !== "racing" || !this.raceSim) return;
      const seat = this.seatForConn(sender.id);
      if (!seat || seat.status !== "connected") return;
      const decoded = decodeInput(buf);
      if (!decoded) return;
      this.raceSim.setInput(seat.seatId, decoded.input as SimInput, decoded.seq);
    }
  }

  async onAlarm() {
    this._alarmScheduled = false;
    if (this.phase !== "racing" || !this.raceSim) return;

    const now = Date.now();
    this.sweepPendingResume(now);
    this.expireGraceSeats(now);

    let elapsed = now - (this._lastSimWall || now);
    this._lastSimWall = now;
    elapsed = Math.min(250, Math.max(0, elapsed));
    this._simAccMs += elapsed;

    let steps = 0;
    while (this._simAccMs >= SIM_STEP_MS && steps < MAX_CATCHUP_STEPS) {
      this._simAccMs -= SIM_STEP_MS;
      steps++;
      const packet = this.raceSim.step(FIXED_DT);
      if (packet) this.broadcast(packet);
    }
    if (this._simAccMs > SIM_STEP_MS * MAX_CATCHUP_STEPS) {
      this._simAccMs = SIM_STEP_MS * MAX_CATCHUP_STEPS;
    }

    if (this.raceSim.isFinished()) {
      this._raceEndTimer += elapsed;
      if (this._raceEndTimer > 2800) {
        await this.recordWinnerOnce();
        this.broadcast(
          json({
            type: "raceEnded",
            hostId: this.hostId,
            players: this.roster(),
          })
        );
        this.stopSim();
        this.phase = "lobby";
        this.purgeForfeitedAndDisconnected();
        for (const p of this.seats.values()) p.ready = false;
        void this.syncDirectory();
        return;
      }
    }

    await this.scheduleAlarm(Date.now() + SIM_STEP_MS);
  }

  private async recordWinnerOnce() {
    if (this._winRecorded || !this.raceSim) return;
    this._winRecorded = true;
    const env = doEnv(this);
    if (!env.LEADERBOARD_DB) return;
    try {
      const winnerKart = this.raceSim.karts
        .filter((k) => k.finished && k.finishTime != null)
        .slice()
        .sort((a, b) => {
          const ao = a.finishOrder ?? Number.POSITIVE_INFINITY;
          const bo = b.finishOrder ?? Number.POSITIVE_INFINITY;
          if (ao !== bo) return ao - bo;
          const at = a.finishTime ?? Number.POSITIVE_INFINITY;
          const bt = b.finishTime ?? Number.POSITIVE_INFINITY;
          if (at !== bt) return at - bt;
          return (a.id ?? 0) - (b.id ?? 0);
        })[0];

      const winnerSeat = winnerKart ? this.seats.get(winnerKart.onlineConnId) : undefined;
      const deviceToken = winnerSeat?.deviceToken;
      if (deviceToken) {
        void recordOnlineWin(env.LEADERBOARD_DB, deviceToken);
      }
    } catch (e) {
      console.error("recordOnlineWin failed", e);
    }
  }

  private expireGraceSeats(now: number) {
    let changed = false;
    for (const [seatId, seat] of this.seats) {
      if (seat.status !== "disconnected") continue;
      if (!isGraceExpired(seat, now)) continue;
      const forfeited = forfeitSeat(seat);
      this.seats.set(seatId, forfeited);
      if (this.raceSim) this.raceSim.forfeitDisconnected(seatId);
      changed = true;
      this.broadcast(
        json({
          type: "playerLeft",
          id: seatId,
          hostId: this.hostId,
          players: this.roster(),
          phase: this.phase,
          reason: "grace_expired",
        })
      );
    }
    if (changed) void this.syncDirectory();
  }

  private purgeForfeitedAndDisconnected() {
    for (const [seatId, seat] of [...this.seats.entries()]) {
      if (seat.status === "forfeited" || seat.status === "disconnected") {
        this.seats.delete(seatId);
        if (seat.connId) this.connSeats.delete(seat.connId);
      }
    }
    if (this.hostId && !this.seats.has(this.hostId)) {
      this.hostId = pickHostSeatId([...this.seats.values()], this.raceOrder);
    }
    this.raceOrder = [];
  }

  private async handleResumeHello(sender: Connection, msg: Record<string, unknown>) {
    if (msg.protocol != null && Number(msg.protocol) !== ONLINE_PROTOCOL) {
      this.failPendingResume(sender, "version_mismatch", "Client/server protocol mismatch.");
      return;
    }

    const token = String(msg.reconnectToken || msg.token || "");
    const seatIdHint = msg.seatId != null ? String(msg.seatId) : undefined;
    const result = validateResume(this.seats.values(), {
      token,
      seatId: seatIdHint,
      now: Date.now(),
      phase: this.phase,
    });

    if (!result.ok) {
      // Unrelated joiner during race — same UX as before
      const code = result.code === "expired" || result.code === "forfeited" ? result.code : "racing";
      this.failPendingResume(
        sender,
        code === "racing" ? "racing" : code,
        result.code === "invalid_token"
          ? "Race already in progress."
          : result.message
      );
      return;
    }

    this.pendingResume.delete(sender.id);

    const seat = result.seat;
    // Displace any stale connection still bound to this seat
    if (seat.connId && seat.connId !== sender.id) {
      this.connSeats.delete(seat.connId);
      try {
        for (const c of this.getConnections()) {
          if (c.id === seat.connId) {
            c.send(json({ type: "error", code: "displaced", message: "Reconnected from another client." }));
            c.close(4002, "displaced");
          }
        }
      } catch {
        /* ignore */
      }
    }

    seat.connId = sender.id;
    seat.status = "connected";
    seat.disconnectedAt = null;
    this.seats.set(seat.seatId, seat);
    this.connSeats.set(sender.id, seat.seatId);

    if (this.raceSim) this.raceSim.clearDisconnected(seat.seatId);

    // Profile refresh (name/color/token) without changing seatId
    await this.applyHelloProfile(sender, seat, msg, { skipRoster: true });

    this.sendWelcome(sender, seat, {
      resumed: true,
      order: this.raceOrder.slice(),
      players: this.racePlayersPayload(),
    });

    this.broadcast(
      json({
        type: "playerResumed",
        id: seat.seatId,
        hostId: this.hostId,
        players: this.roster(),
        phase: this.phase,
      })
    );

    if (this.raceSim) {
      sender.send(
        json({
          type: "resumeRace",
          settings: this.settings,
          order: this.raceOrder.slice(),
          players: this.racePlayersPayload(),
          hostId: this.hostId,
          authority: "server",
          protocol: ONLINE_PROTOCOL,
          trackBakeVersion: TRACK_BAKE_VERSION,
          equalPerformance: !TRUST_CLIENT_PROGRESSION_UPGRADES,
          reconnectGraceMs: RECONNECT_GRACE_MS,
          you: seat.seatId,
        })
      );
      sender.send(this.raceSim.buildStatePacket(true));
    }
    void this.syncDirectory();
  }

  private failPendingResume(conn: Connection, code: string, message: string) {
    this.pendingResume.delete(conn.id);
    try {
      conn.send(json({ type: "error", code, message }));
      conn.close(code === "racing" ? 4001 : 4003, code);
    } catch {
      /* ignore */
    }
  }

  private sweepPendingResume(now: number) {
    for (const [connId, pending] of [...this.pendingResume.entries()]) {
      if (now - pending.at < RESUME_HELLO_TIMEOUT_MS) continue;
      this.pendingResume.delete(connId);
      try {
        for (const c of this.getConnections()) {
          if (c.id === connId) {
            c.send(json({ type: "error", code: "resume_timeout", message: "Reconnect hello timed out." }));
            c.close(4003, "resume_timeout");
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private sendWelcome(
    conn: Connection,
    seat: SeatRecord,
    extra: { resumed: boolean; order?: string[]; players?: unknown }
  ) {
    conn.send(
      json({
        type: "welcome",
        you: seat.seatId,
        seatId: seat.seatId,
        reconnectToken: seat.reconnectToken,
        hostId: this.hostId,
        roomId: this.name,
        settings: this.settings,
        phase: this.phase,
        players: this.roster(),
        authority: "server",
        protocol: ONLINE_PROTOCOL,
        trackBakeVersion: TRACK_BAKE_VERSION,
        reconnectGraceMs: RECONNECT_GRACE_MS,
        resumed: !!extra.resumed,
        order: extra.order,
        racePlayers: extra.players,
      })
    );
  }

  private racePlayersPayload() {
    return this.raceOrder.map((id) => {
      const s = this.seats.get(id);
      return {
        id,
        name: s?.name || "RACER",
        color: s?.color || "#00f5ff",
        upgrades: resolveOnlineUpgrades(s?.upgrades as UpgradeStats),
        disconnected: s?.status === "disconnected" || s?.status === "forfeited",
      };
    });
  }

  private connectedSeatCount() {
    let n = 0;
    for (const s of this.seats.values()) {
      if (s.status === "connected" && s.connId) n++;
    }
    return n;
  }

  private seatForConn(connId: string): SeatRecord | null {
    const seatId = this.connSeats.get(connId);
    if (!seatId) return null;
    return this.seats.get(seatId) || null;
  }

  async scheduleAlarm(when: number) {
    try {
      await doCtx(this).storage.setAlarm(when);
      this._alarmScheduled = true;
    } catch (e) {
      console.error("setAlarm failed", e);
    }
  }

  stopSim() {
    this.raceSim = null;
    this._simAccMs = 0;
    this._raceEndTimer = 0;
    this._alarmScheduled = false;
    this._winRecorded = false;
    try {
      void doCtx(this).storage.deleteAlarm();
    } catch {
      /* ignore */
    }
  }

  endRaceToLobby() {
    this.stopSim();
    this.phase = "lobby";
    this.purgeForfeitedAndDisconnected();
    for (const p of this.seats.values()) p.ready = false;
    this.broadcast(
      json({
        type: "raceEnded",
        hostId: this.hostId,
        players: this.roster(),
      })
    );
    this.broadcast(
      json({
        type: "lobby",
        phase: "lobby",
        hostId: this.hostId,
        settings: this.settings,
        players: this.roster(),
      })
    );
    void this.syncDirectory();
  }

  roster() {
    return rosterPublic([...this.seats.values()]);
  }

  broadcastRoster(exceptSeatId?: string) {
    const payload = json({
      type: "roster",
      hostId: this.hostId,
      players: this.roster(),
      settings: this.settings,
      phase: this.phase,
      authority: "server",
    });
    if (exceptSeatId) {
      const exceptConn = this.seats.get(exceptSeatId)?.connId;
      if (exceptConn) this.broadcast(payload, [exceptConn]);
      else this.broadcast(payload);
    } else {
      this.broadcast(payload);
    }
  }

  resetSettings() {
    this.settings = {
      trackId: 0,
      laps: 3,
      weather: "dry",
      collisionMode: "collision",
      tyres: "med",
    };
  }

  async syncDirectory(forceRemove = false) {
    try {
      const env = doEnv(this);
      const dirId = env.LobbyDirectory.idFromName("global");
      const stub = env.LobbyDirectory.get(dirId);
      const hostPlayer = this.hostId ? this.seats.get(this.hostId) : null;
      const liveCount = [...this.seats.values()].filter(
        (s) => s.status === "connected" || s.status === "disconnected"
      ).length;
      const remove =
        forceRemove ||
        liveCount === 0 ||
        this.phase === "racing" ||
        this.connectedSeatCount() >= MAX_PLAYERS;

      if (remove) {
        await stub.fetch("https://directory/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: this.name }),
        });
        return;
      }

      await stub.fetch("https://directory/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: this.name,
          hostName: hostPlayer?.name || "HOST",
          players: this.connectedSeatCount(),
          max: MAX_PLAYERS,
          trackId: this.settings.trackId,
          laps: this.settings.laps,
          phase: this.phase,
        }),
      });
    } catch (e) {
      console.error("syncDirectory failed", e);
    }
  }

  private async applyHelloProfile(
    sender: Connection,
    seat: SeatRecord,
    msg: Record<string, unknown>,
    opts: { skipRoster?: boolean } = {}
  ) {
    const color = String(msg.color || "#00f5ff").slice(0, 16);
    const deviceToken = String(msg.deviceToken || "");
    if (deviceToken) seat.deviceToken = deviceToken;
    let name =
      String(msg.name || "RACER")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 12) || "RACER";

    try {
      const env = doEnv(this);
      if (env.LEADERBOARD_DB && deviceToken) {
        const device = await getDeviceByToken(env.LEADERBOARD_DB, deviceToken);
        if (device?.username) {
          name =
            String(device.username)
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 12) || name;
        }
      }
    } catch (e) {
      console.error("applyHelloProfile device lookup failed", e);
    }

    seat.name = name;
    seat.color = color;
    seat.upgrades = resolveOnlineUpgrades(msg.upgrades);
    this.seats.set(seat.seatId, seat);
    sender.send(
      json({
        type: "identity",
        name: seat.name,
        seatId: seat.seatId,
        equalPerformance: !TRUST_CLIENT_PROGRESSION_UPGRADES,
      })
    );
    if (!opts.skipRoster) {
      this.broadcastRoster();
      void this.syncDirectory();
    }
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeInput(inp: unknown): SimInput {
  const i = (inp || {}) as Record<string, unknown>;
  return {
    up: !!i.up,
    down: !!i.down,
    left: !!i.left,
    right: !!i.right,
    ers: !!i.ers,
    drs: !!i.drs,
    steer: typeof i.steer === "number" ? i.steer : i.left ? -1 : i.right ? 1 : 0,
    throttle: typeof i.throttle === "number" ? i.throttle : i.up ? 1 : 0,
    brake: typeof i.brake === "number" ? i.brake : i.down ? 1 : 0,
  };
}

function sanitizeTrackBake(raw: unknown): BakedTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const spline = t.spline;
  const cpLines = t.cpLines;
  const startPos = t.startPos as { x?: number; y?: number } | undefined;
  if (!Array.isArray(spline) || spline.length < 16) return null;
  if (!Array.isArray(cpLines) || cpLines.length < 1) return null;
  if (!startPos || !Number.isFinite(startPos.x) || !Number.isFinite(startPos.y)) return null;

  const cleanSpline = spline
    .slice(0, 4000)
    .map((p) => {
      const pt = p as { x?: number; y?: number };
      return { x: Number(pt.x) || 0, y: Number(pt.y) || 0 };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (cleanSpline.length < 16) return null;

  const cum =
    Array.isArray(t.cum) && t.cum.length === cleanSpline.length
      ? (t.cum as number[]).map((n) => Number(n) || 0)
      : buildCum(cleanSpline);

  return {
    id: typeof t.id === "number" ? t.id : 0,
    trackWidth: Math.max(40, Math.min(400, Number(t.trackWidth) || 160)),
    spline: cleanSpline,
    cum,
    totalLen: Number(t.totalLen) || cum[cum.length - 1] || 1,
    startPos: { x: startPos.x!, y: startPos.y! },
    startAngle: Number(t.startAngle) || 0,
    cpLines: (cpLines as Record<string, number>[]).slice(0, 32).map((c) => ({
      x1: Number(c.x1) || 0,
      y1: Number(c.y1) || 0,
      x2: Number(c.x2) || 0,
      y2: Number(c.y2) || 0,
    })),
    drsZones: Array.isArray(t.drsZones)
      ? (t.drsZones as { sIdx?: number; eIdx?: number }[]).slice(0, 16).map((z) => ({
          sIdx: Number(z.sIdx) || 0,
          eIdx: Number(z.eIdx) || 0,
        }))
      : [],
    gridSlots: Array.isArray(t.gridSlots)
      ? (t.gridSlots as { x?: number; y?: number; a?: number }[]).slice(0, 6).map((s) => ({
          x: Number(s.x) || startPos.x!,
          y: Number(s.y) || startPos.y!,
          a: Number(s.a) || Number(t.startAngle) || 0,
        }))
      : undefined,
    surface: t.surface && typeof t.surface === "object"
      ? { offTrackMult: Number((t.surface as { offTrackMult?: number }).offTrackMult) || 1 }
      : { offTrackMult: 1 },
  };
}

function buildCum(spl: { x: number; y: number }[]): number[] {
  const cum = [0];
  for (let i = 1; i < spl.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(spl[i].x - spl[i - 1].x, spl[i].y - spl[i - 1].y));
  }
  return cum;
}
