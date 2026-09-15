/**
 * Pure guards for validated trial-run lifecycle (no D1 / physics imports).
 * Used by completeTrialRun and abuse tests.
 */

export type RunStatusRow = {
  run_id: string;
  device_token: string;
  mode: string;
  status: string;
  expires_at: number;
  rules_version: number;
  track_bake_version: number;
  verified_best_lap: number | null;
  consume_count: number;
  max_consumes: number;
};

export function classifyTrialRunCompletion(
  run: RunStatusRow | null,
  deviceToken: string,
  now: number,
  expectedRulesVersion: number,
  expectedBakeVersion: number
):
  | { ok: true; idempotent?: false }
  | {
      ok: true;
      idempotent: true;
      bestLap: number;
    }
  | { ok: false; error: string; status: number; markExpired?: boolean } {
  if (!run) return { ok: false, error: "unknown_run", status: 404 };
  if (run.device_token !== deviceToken) {
    return { ok: false, error: "run_device_mismatch", status: 403 };
  }
  if (run.mode !== "trial") return { ok: false, error: "invalid_mode", status: 400 };

  if (run.status === "consumed" || run.status === "completed") {
    const prev = Number(run.verified_best_lap);
    if (Number.isFinite(prev) && prev > 0) {
      return { ok: true, idempotent: true, bestLap: prev };
    }
    return { ok: false, error: "run_already_consumed", status: 409 };
  }

  if (run.status !== "open") {
    return { ok: false, error: "run_not_open", status: 409 };
  }
  if (now > Number(run.expires_at)) {
    return { ok: false, error: "run_expired", status: 410, markExpired: true };
  }
  if (Number(run.rules_version) !== expectedRulesVersion) {
    return { ok: false, error: "rules_version_mismatch", status: 409 };
  }
  if (Number(run.track_bake_version) !== expectedBakeVersion) {
    return { ok: false, error: "track_bake_version_mismatch", status: 409 };
  }
  if (Number(run.consume_count) >= Number(run.max_consumes || 1)) {
    return { ok: false, error: "run_consume_limit", status: 409 };
  }
  return { ok: true };
}
