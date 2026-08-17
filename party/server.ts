import { Server, type Connection, type ConnectionContext } from "partyserver";
import type { Env } from "./env";
import { decodeInput, MSG_INPUT, NET_MAGIC, NET_VERSION } from "./netcodec";
import {
  FIXED_DT,
  loadTrackBake,
  ONLINE_PROTOCOL,
  OnlineRaceSim,
  sanitizeUpgrades,
  TRACK_BAKE_VERSION,
  type BakedTrack,
  type SimInput,
  type UpgradeStats,
} from "../sim";
import { defaultUpgrades } from "../sim/upgrades";

const MAX_PLAYERS = 6;
const SIM_STEP_MS = Math.round(FIXED_DT * 1000);
const MAX_CATCHUP_STEPS = 12;

type Player = {
  id: string;
  name: string;
  ready: boolean;
  color: string;
  upgrades: UpgradeStats;
};

type LobbySettings = {
  trackId: number;
  laps: number;
  weather: string;
  collisionMode: string;
  tyres: string;
};

type RoomPhase = "lobby" | "racing";

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
  players = new Map<string, Player>();
  /** Lobby admin (settings / start / return) — not the physics host. */
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
  private _alarmScheduled = false;
  private _lastSimWall = 0;
  private _simAccMs = 0;
  private _raceEndTimer = 0;

  onConnect(conn: Connection, _ctx: ConnectionContext) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send(json({ type: "error", code: "full", message: "Lobby is full (max 6)." }));
      conn.close(4000, "full");
      return;
    }
    if (this.phase === "racing") {
      conn.send(json({ type: "error", code: "racing", message: "Race already in progress." }));
      conn.close(4001, "racing");
      return;
    }

    const player: Player = {
      id: conn.id,
      name: "RACER",
      ready: false,
      color: "#00f5ff",
      upgrades: defaultUpgrades(),
    };
    this.players.set(conn.id, player);
    if (!this.hostId) this.hostId = conn.id;

    conn.send(
      json({
        type: "welcome",
        you: conn.id,
        hostId: this.hostId,
        roomId: this.name,
        settings: this.settings,
        phase: this.phase,
        players: this.roster(),
        authority: "server",
        protocol: ONLINE_PROTOCOL,
        trackBakeVersion: TRACK_BAKE_VERSION,
      })
    );
    this.broadcastRoster(conn.id);
    void this.syncDirectory();
  }

  onClose(conn: Connection) {
    if (!this.players.has(conn.id)) return;

    const wasHost = this.hostId === conn.id;
    this.players.delete(conn.id);

    if (this.players.size === 0) {
      this.hostId = null;
      this.phase = "lobby";
      this.stopSim();
      this.resetSettings();
      void this.syncDirectory(true);
      return;
    }

    if (this.phase === "racing") {
      if (this.raceSim) this.raceSim.markDisconnected(conn.id);
      if (wasHost) {
        this.hostId = this.roster()[0]?.id ?? null;
      }
      this.broadcast(
        json({
          type: "playerLeft",
          id: conn.id,
          hostId: this.hostId,
          players: this.roster(),
          phase: this.phase,
        })
      );
      void this.syncDirectory();
      return;
    }

    if (wasHost) {
      this.hostId = this.roster()[0]?.id ?? null;
    }

    this.broadcast(
      json({
        type: "playerLeft",
        id: conn.id,
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
    const player = this.players.get(sender.id);
    if (!player && type !== "hello") return;

    switch (type) {
      case "hello": {
        if (!player) return;
        const name =
          String(msg.name || "RACER")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 12) || "RACER";
        const color = String(msg.color || "#00f5ff").slice(0, 16);
        player.name = name;
        player.color = color;
        if (msg.upgrades) player.upgrades = sanitizeUpgrades(msg.upgrades);
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
        this.broadcastRoster();
        void this.syncDirectory();
        break;
      }
      case "ready": {
        if (!player || this.phase !== "lobby") return;
        player.ready = !!msg.ready;
        if (msg.upgrades) player.upgrades = sanitizeUpgrades(msg.upgrades);
        this.broadcastRoster();
        break;
      }
      case "lobbySettings": {
        if (sender.id !== this.hostId || this.phase !== "lobby") return;
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
        if (sender.id !== this.hostId || this.phase !== "lobby") return;
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
        const readyCount = [...this.players.values()].filter((p) => p.ready).length;
        if (this.players.size < 2 || readyCount < 2) {
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

        const order = this.roster().map((p) => p.id);
        this.phase = "racing";
        this._raceEndTimer = 0;
        this.raceSim = new OnlineRaceSim({
          track,
          players: this.roster().map((p) => ({
            id: p.id,
            name: p.name,
            color: p.color,
            upgrades: p.upgrades,
          })),
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
            players: this.roster(),
            hostId: this.hostId,
            authority: "server",
            protocol: ONLINE_PROTOCOL,
            trackBakeVersion: TRACK_BAKE_VERSION,
          })
        );
        const boot = this.raceSim.buildStatePacket(true);
        this.broadcast(boot);
        void this.scheduleAlarm(Date.now() + SIM_STEP_MS);
        void this.syncDirectory(true);
        break;
      }
      case "input": {
        // JSON fallback input
        if (this.phase !== "racing" || !this.raceSim) return;
        this.raceSim.setInput(sender.id, normalizeInput(msg.input), typeof msg.seq === "number" ? msg.seq : undefined);
        break;
      }
      case "raceEnded": {
        if (sender.id !== this.hostId) return;
        this.endRaceToLobby();
        break;
      }
      case "returnLobby": {
        if (sender.id !== this.hostId) return;
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
      const decoded = decodeInput(buf);
      if (!decoded) return;
      this.raceSim.setInput(sender.id, decoded.input as SimInput, decoded.seq);
    }
  }

  async onAlarm() {
    this._alarmScheduled = false;
    if (this.phase !== "racing" || !this.raceSim) return;

    const now = Date.now();
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
    // Cap backlog so a long stall does not spiral, but do not discard mid-step remainder
    if (this._simAccMs > SIM_STEP_MS * MAX_CATCHUP_STEPS) {
      this._simAccMs = SIM_STEP_MS * MAX_CATCHUP_STEPS;
    }

    if (this.raceSim.isFinished()) {
      this._raceEndTimer += elapsed;
      if (this._raceEndTimer > 2800) {
        this.broadcast(
          json({
            type: "raceEnded",
            hostId: this.hostId,
            players: this.roster(),
          })
        );
        this.stopSim();
        this.phase = "lobby";
        for (const p of this.players.values()) p.ready = false;
        void this.syncDirectory();
        return;
      }
    }

    await this.scheduleAlarm(Date.now() + SIM_STEP_MS);
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
    try {
      void doCtx(this).storage.deleteAlarm();
    } catch {
      /* ignore */
    }
  }

  endRaceToLobby() {
    this.stopSim();
    this.phase = "lobby";
    for (const p of this.players.values()) p.ready = false;
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

  roster(): Player[] {
    return [...this.players.values()];
  }

  broadcastRoster(exceptId?: string) {
    const payload = json({
      type: "roster",
      hostId: this.hostId,
      players: this.roster(),
      settings: this.settings,
      phase: this.phase,
      authority: "server",
    });
    if (exceptId) this.broadcast(payload, [exceptId]);
    else this.broadcast(payload);
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
      const hostPlayer = this.hostId ? this.players.get(this.hostId) : null;
      const remove =
        forceRemove ||
        this.players.size === 0 ||
        this.phase === "racing" ||
        this.players.size >= MAX_PLAYERS;

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
          players: this.players.size,
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
