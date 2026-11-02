export type Env = {
  Main: DurableObjectNamespace;
  LobbyDirectory: DurableObjectNamespace;
  LEADERBOARD_DB?: D1Database;
  /** Password for /api/admin/* routes (set via wrangler secret or vars). */
  LEADERBOARD_ADMIN_PASSWORD?: string;
  /** Fine-grained GitHub PAT, only this repo, Contents read/write. Never sent to clients. */
  TRACK_PUBLISH_GITHUB_TOKEN?: string;
};
