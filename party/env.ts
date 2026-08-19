export type Env = {
  Main: DurableObjectNamespace;
  LobbyDirectory: DurableObjectNamespace;
  LEADERBOARD_DB?: D1Database;
  /** Password for /api/admin/* routes (set via wrangler secret or vars). */
  LEADERBOARD_ADMIN_PASSWORD?: string;
};
