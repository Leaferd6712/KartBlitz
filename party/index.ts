import { routePartykitRequest } from "partyserver";
import { KartBlitzRoom } from "./server";
import { LobbyDirectory } from "./directory";
import type { Env } from "./env";
import {
  addRandomAdminEntries,
  checkAdminPassword,
  deleteAdminEntry,
  getAdminLeaderboard,
  upsertAdminEntry,
} from "./leaderboard-admin";
import { exportLeaderboardBackup, getDeviceStatus, getLeaderboard, registerDevice, submitScore } from "./leaderboard";
import { ONLINE_PROTOCOL, TRACK_BAKE_VERSION } from "../sim/constants";
import { listTrackIds } from "../sim/tracks";

export { KartBlitzRoom, LobbyDirectory };
export type { Env };

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function adminPasswordFromRequest(request: Request): string | null {
  return request.headers.get("X-Admin-Password") || request.headers.get("x-admin-password");
}

function adminUnauthorized(): Response {
  return withCors(Response.json({ error: "unauthorized" }, { status: 401 }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/device-status") {
      if (!env.LEADERBOARD_DB) {
        return withCors(
          Response.json({ error: "leaderboard_unconfigured" }, { status: 503 })
        );
      }
      const res = await getDeviceStatus(env.LEADERBOARD_DB, url.searchParams.get("deviceToken"));
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res));
    }
    if (url.pathname === "/api/register-device") {
      if (!env.LEADERBOARD_DB) {
        return withCors(
          Response.json({ error: "leaderboard_unconfigured" }, { status: 503 })
        );
      }
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return withCors(Response.json({ error: "invalid_json" }, { status: 400 }));
      }
      const res = await registerDevice(env.LEADERBOARD_DB, body);
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res));
    }
    if (url.pathname === "/api/leaderboard") {
      if (!env.LEADERBOARD_DB) {
        return withCors(
          Response.json({ error: "leaderboard_unconfigured" }, { status: 503 })
        );
      }
      const res = await getLeaderboard(
        env.LEADERBOARD_DB,
        url.searchParams.get("mode"),
        url.searchParams.get("trackId") ?? url.searchParams.get("track_id")
      );
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res));
    }
    if (url.pathname === "/api/leaderboard-backup.txt" || url.pathname === "/api/leaderboard-backup") {
      if (!env.LEADERBOARD_DB) {
        return withCors(
          Response.json({ error: "leaderboard_unconfigured" }, { status: 503 })
        );
      }
      const backup = await exportLeaderboardBackup(env.LEADERBOARD_DB);
      return withCors(
        new Response(backup.text, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="kartblitz-leaderboard.txt"',
            "Cache-Control": "no-store",
          },
        })
      );
    }
    if (url.pathname === "/api/admin/leaderboard") {
      if (!env.LEADERBOARD_DB) {
        return withCors(Response.json({ error: "leaderboard_unconfigured" }, { status: 503 }));
      }
      if (!checkAdminPassword(env.LEADERBOARD_ADMIN_PASSWORD, adminPasswordFromRequest(request))) {
        return adminUnauthorized();
      }
      if (request.method !== "GET") {
        return withCors(Response.json({ error: "method_not_allowed" }, { status: 405 }));
      }
      const res = await getAdminLeaderboard(env.LEADERBOARD_DB);
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res.payload));
    }
    if (url.pathname === "/api/admin/entry") {
      if (!env.LEADERBOARD_DB) {
        return withCors(Response.json({ error: "leaderboard_unconfigured" }, { status: 503 }));
      }
      if (!checkAdminPassword(env.LEADERBOARD_ADMIN_PASSWORD, adminPasswordFromRequest(request))) {
        return adminUnauthorized();
      }
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return withCors(Response.json({ error: "invalid_json" }, { status: 400 }));
      }
      if (request.method === "PUT") {
        const res = await upsertAdminEntry(env.LEADERBOARD_DB, body);
        if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
        return withCors(Response.json({ ok: true }));
      }
      if (request.method === "DELETE") {
        const res = await deleteAdminEntry(env.LEADERBOARD_DB, body);
        if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
        return withCors(Response.json({ ok: true }));
      }
      return withCors(Response.json({ error: "method_not_allowed" }, { status: 405 }));
    }
    if (url.pathname === "/api/admin/random") {
      if (!env.LEADERBOARD_DB) {
        return withCors(Response.json({ error: "leaderboard_unconfigured" }, { status: 503 }));
      }
      if (!checkAdminPassword(env.LEADERBOARD_ADMIN_PASSWORD, adminPasswordFromRequest(request))) {
        return adminUnauthorized();
      }
      if (request.method !== "POST") {
        return withCors(Response.json({ error: "method_not_allowed" }, { status: 405 }));
      }
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return withCors(Response.json({ error: "invalid_json" }, { status: 400 }));
      }
      const res = await addRandomAdminEntries(env.LEADERBOARD_DB, body);
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res));
    }
    if (url.pathname === "/api/scores" || url.pathname === "/api/submit") {
      if (!env.LEADERBOARD_DB) {
        return withCors(
          Response.json({ error: "leaderboard_unconfigured" }, { status: 503 })
        );
      }
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return withCors(Response.json({ error: "invalid_json" }, { status: 400 }));
      }
      const res = await submitScore(env.LEADERBOARD_DB, body);
      if (!res.ok) return withCors(Response.json({ error: res.error }, { status: res.status }));
      return withCors(Response.json(res));
    }
    if (url.pathname === "/version" || url.pathname === "/version/") {
      return withCors(
        new Response(
          JSON.stringify({
            protocol: ONLINE_PROTOCOL,
            trackBakeVersion: TRACK_BAKE_VERSION,
            tracks: listTrackIds(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (url.pathname === "/lobbies" || url.pathname === "/lobbies/") {
      const id = env.LobbyDirectory.idFromName("global");
      const stub = env.LobbyDirectory.get(id);
      const res = await stub.fetch("https://directory/list");
      return withCors(res);
    }

    const party = await routePartykitRequest(request, env);
    if (party) return party;

    return withCors(
      new Response("KartBlitz online — GET /version, /lobbies, or /parties/main/<roomId>", { status: 200 })
    );
  },
};
