import { Server, type Connection, type ConnectionContext } from "partyserver";
import type { Env } from "./env";

const MAX_PLAYERS = 6;
const HOST_STALE_MS = 4000;

type Player = {
  id: string;
  name: string;
  ready: boolean;
  color: string;
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

/** One Durable Object room per lobby. Binding name Main → /parties/main/<room>. */
export class KartBlitzRoom extends Server<Env> {
  players = new Map<string, Player>();
  hostId: string | null = null;
  phase: RoomPhase = "lobby";
  lastStateAt = 0;
  settings: LobbySettings = {
    trackId: 0,
    laps: 3,
    weather: "dry",
    collisionMode: "collision",
    tyres: "med",
  };

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
      this.lastStateAt = 0;
      this.resetSettings();
      void this.syncDirectory(true);
      return;
    }

    if (this.phase === "racing") {
      if (wasHost) {
        this.migrateHost(conn.id);
        return;
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
    if (typeof message !== "string") return;
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
        this.broadcastRoster();
        void this.syncDirectory();
        break;
      }
      case "ready": {
        if (!player || this.phase !== "lobby") return;
        player.ready = !!msg.ready;
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
        this.phase = "racing";
        this.lastStateAt = Date.now();
        const order = this.roster().map((p) => p.id);
        this.broadcast(
          json({
            type: "startRace",
            settings: this.settings,
            order,
            players: this.roster(),
            hostId: this.hostId,
          })
        );
        void this.syncDirectory(true);
        break;
      }
      case "input": {
        if (this.phase !== "racing") return;
        this.maybeMigrateStaleHost();
        if (this.phase !== "racing") return;
        this.broadcast(
          json({
            type: "input",
            id: sender.id,
            input: msg.input || {},
            t: msg.t || 0,
          }),
          [sender.id]
        );
        break;
      }
      case "state": {
        if (this.phase !== "racing" || sender.id !== this.hostId) return;
        this.lastStateAt = Date.now();
        this.broadcast(
          json({
            type: "state",
            t: msg.t || 0,
            phase: msg.phase,
            countdownVal: msg.countdownVal,
            raceTimer: msg.raceTimer,
            launchRPM: msg.launchRPM,
            karts: msg.karts,
            hostId: this.hostId,
          }),
          [sender.id]
        );
        break;
      }
      case "raceEnded": {
        if (sender.id !== this.hostId) return;
        this.phase = "lobby";
        for (const p of this.players.values()) p.ready = false;
        this.broadcast(
          json({
            type: "raceEnded",
            hostId: this.hostId,
            players: this.roster(),
          })
        );
        void this.syncDirectory();
        break;
      }
      case "returnLobby": {
        if (sender.id !== this.hostId) return;
        this.phase = "lobby";
        for (const p of this.players.values()) p.ready = false;
        this.broadcast(
          json({
            type: "lobby",
            hostId: this.hostId,
            settings: this.settings,
            players: this.roster(),
          })
        );
        void this.syncDirectory();
        break;
      }
      default:
        break;
    }
  }

  roster(): Player[] {
    return [...this.players.values()];
  }

  maybeMigrateStaleHost() {
    if (this.phase !== "racing" || !this.hostId) return;
    const hostConn = [...this.getConnections()].find((c) => c.id === this.hostId);
    const stale = !hostConn || (this.lastStateAt > 0 && Date.now() - this.lastStateAt > HOST_STALE_MS);
    if (!stale) return;
    const oldId = this.hostId;
    if (this.players.has(oldId)) this.players.delete(oldId);
    if (hostConn) {
      try {
        hostConn.close(4002, "stale_host");
      } catch {
        /* ignore */
      }
    }
    this.migrateHost(oldId);
  }

  migrateHost(disconnectedId: string | null) {
    if (this.players.size === 0) {
      this.hostId = null;
      this.phase = "lobby";
      this.lastStateAt = 0;
      this.resetSettings();
      void this.syncDirectory(true);
      return;
    }

    this.hostId = this.roster()[0]?.id ?? null;
    this.lastStateAt = Date.now();
    if (!this.hostId) {
      this.phase = "lobby";
      void this.syncDirectory(true);
      return;
    }

    this.broadcast(
      json({
        type: "hostMigrated",
        hostId: this.hostId,
        players: this.roster(),
        disconnectedId: disconnectedId || null,
        phase: this.phase,
      })
    );
    void this.syncDirectory(this.phase === "racing");
  }

  broadcastRoster(exceptId?: string) {
    const payload = json({
      type: "roster",
      hostId: this.hostId,
      players: this.roster(),
      settings: this.settings,
      phase: this.phase,
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

  /** Publish or remove this room from the global open-lobby list. */
  async syncDirectory(forceRemove = false) {
    try {
      const dirId = this.env.LobbyDirectory.idFromName("global");
      const stub = this.env.LobbyDirectory.get(dirId);
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
