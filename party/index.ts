import { routePartykitRequest } from "partyserver";
import { KartBlitzRoom } from "./server";
import { LobbyDirectory } from "./directory";
import type { Env } from "./env";

export { KartBlitzRoom, LobbyDirectory };
export type { Env };

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname === "/lobbies" || url.pathname === "/lobbies/") {
      const id = env.LobbyDirectory.idFromName("global");
      const stub = env.LobbyDirectory.get(id);
      const res = await stub.fetch("https://directory/list");
      return withCors(res);
    }

    const party = await routePartykitRequest(request, env);
    if (party) return party;

    return withCors(
      new Response("KartBlitz online — GET /lobbies or /parties/main/<roomId>", { status: 200 })
    );
  },
};
