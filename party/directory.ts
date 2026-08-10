import { DurableObject } from "cloudflare:workers";

export type LobbyEntry = {
  id: string;
  hostName: string;
  players: number;
  max: number;
  trackId: number;
  laps: number;
  phase: "lobby" | "racing";
  updatedAt: number;
};

const STORE_KEY = "lobbies";

/** Single global directory of open race lobbies. */
export class LobbyDirectory extends DurableObject {
  private async load(): Promise<Record<string, LobbyEntry>> {
    return (await this.ctx.storage.get<Record<string, LobbyEntry>>(STORE_KEY)) || {};
  }

  private async save(map: Record<string, LobbyEntry>) {
    await this.ctx.storage.put(STORE_KEY, map);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/" || path === "/list")) {
      const map = await this.load();
      const now = Date.now();
      const open = Object.values(map)
        .filter((e) => e.phase === "lobby" && e.players > 0 && e.players < e.max)
        // Drop stale entries (host crashed without unregister)
        .filter((e) => now - (e.updatedAt || 0) < 5 * 60 * 1000)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return Response.json({ lobbies: open });
    }

    if (request.method === "POST" && path === "/upsert") {
      let body: Partial<LobbyEntry>;
      try {
        body = (await request.json()) as Partial<LobbyEntry>;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const id = String(body.id || "").slice(0, 32);
      if (!id) return Response.json({ error: "missing_id" }, { status: 400 });
      const map = await this.load();
      const entry: LobbyEntry = {
        id,
        hostName: String(body.hostName || "HOST").slice(0, 16),
        players: Math.max(0, Math.min(6, Number(body.players) || 0)),
        max: Math.max(2, Math.min(6, Number(body.max) || 6)),
        trackId: Math.max(0, Number(body.trackId) || 0),
        laps: Math.max(1, Math.min(20, Number(body.laps) || 3)),
        phase: body.phase === "racing" ? "racing" : "lobby",
        updatedAt: Date.now(),
      };
      if (entry.phase === "racing" || entry.players <= 0) {
        delete map[id];
      } else {
        map[id] = entry;
      }
      await this.save(map);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && path === "/remove") {
      let body: { id?: string };
      try {
        body = (await request.json()) as { id?: string };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const id = String(body.id || "");
      const map = await this.load();
      delete map[id];
      await this.save(map);
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }
}
