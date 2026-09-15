/**
 * Time Trial leaderboard verification via shared-sim input replay.
 * Lap times on the board come from this path — never from a client-claimed number alone.
 */
import { FIXED_DT, TRACK_BAKE_VERSION } from "./constants";
import {
  createKart,
  emptyInput,
  stepKart,
  type BakedTrack,
  type SimInput,
} from "./kart";
import { competitiveStandardUpgrades } from "./upgrades";

/** Bump when TT competitive rules / stock config / validation contract changes. */
export const LEADERBOARD_RULES_VERSION = 1;

/** Max physics steps accepted in one run (~12 minutes at 60 Hz). */
export const TRIAL_RUN_MAX_STEPS = 60 * 60 * 12;

/** How long an issued runId remains completable. */
export const TRIAL_RUN_TTL_MS = 30 * 60 * 1000;

/** Defense-in-depth floor: mean speed above this world-units/sec is rejected. */
export const TRIAL_MAX_MEAN_SPEED = 640;

export type TrialCarConfig = "stock";

export type TrialRunSpec = {
  trackId: number;
  mode: "trial";
  rulesVersion: number;
  trackBakeVersion: number;
  weather: string;
  tyres: string;
  carConfig: TrialCarConfig;
};

export function trialRunSpec(trackId: number): TrialRunSpec {
  return {
    trackId: Math.floor(trackId),
    mode: "trial",
    rulesVersion: LEADERBOARD_RULES_VERSION,
    trackBakeVersion: TRACK_BAKE_VERSION,
    weather: "dry",
    tyres: "med",
    carConfig: "stock",
  };
}

export function packInputFlags(inp: SimInput): number {
  let b = 0;
  if (inp.up || (inp.throttle || 0) > 0.35) b |= 1;
  if (inp.down || (inp.brake || 0) > 0.35) b |= 2;
  if (inp.left || (inp.steer || 0) < -0.25) b |= 4;
  if (inp.right || (inp.steer || 0) > 0.25) b |= 8;
  if (inp.ers) b |= 16;
  if (inp.drs) b |= 32;
  return b & 0xff;
}

export function unpackInputFlags(byte: number): SimInput {
  const b = byte & 0xff;
  const up = !!(b & 1);
  const down = !!(b & 2);
  const left = !!(b & 4);
  const right = !!(b & 8);
  return {
    up,
    down,
    left,
    right,
    ers: !!(b & 16),
    drs: !!(b & 32),
    steer: left && !right ? -1 : right && !left ? 1 : 0,
    throttle: up ? 1 : 0,
    brake: down ? 1 : 0,
  };
}

export function encodeTrialInputs(inputs: SimInput[]): Uint8Array {
  const out = new Uint8Array(inputs.length);
  for (let i = 0; i < inputs.length; i++) out[i] = packInputFlags(inputs[i] || emptyInput());
  return out;
}

export function decodeTrialInputsBase64(b64: string): Uint8Array | null {
  try {
    const raw = String(b64 || "").trim();
    if (!raw || raw.length > TRIAL_RUN_MAX_STEPS * 2) return null;
    let bin = "";
    if (typeof atob === "function") {
      bin = atob(raw);
    } else if (typeof Buffer !== "undefined") {
      bin = Buffer.from(raw, "base64").toString("binary");
    } else {
      return null;
    }
    if (bin.length > TRIAL_RUN_MAX_STEPS) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  } catch {
    return null;
  }
}

export function minPlausibleLapSec(track: BakedTrack): number {
  const len = Number(track.totalLen) || 0;
  if (!(len > 0)) return 8;
  return len / TRIAL_MAX_MEAN_SPEED;
}

export type TrialVerifyOk = {
  ok: true;
  bestLap: number;
  lapTimes: number[];
  steps: number;
  rulesVersion: number;
  trackBakeVersion: number;
};

export type TrialVerifyErr = {
  ok: false;
  error: string;
};

/**
 * Replay packed digital inputs at FIXED_DT with stock competitive stats.
 * Returns the best completed lap from shared physics — the only trusted time.
 */
export function verifyTrialReplay(
  track: BakedTrack,
  packedInputs: Uint8Array,
  opts?: { weather?: string; tyres?: string }
): TrialVerifyOk | TrialVerifyErr {
  if (!track || !Array.isArray(track.spline) || track.spline.length < 16) {
    return { ok: false, error: "invalid_track" };
  }
  if (!packedInputs || !(packedInputs instanceof Uint8Array) || packedInputs.length < 30) {
    return { ok: false, error: "inputs_too_short" };
  }
  if (packedInputs.length > TRIAL_RUN_MAX_STEPS) {
    return { ok: false, error: "inputs_too_long" };
  }

  const weather = opts?.weather || "dry";
  const tyres = opts?.tyres || "med";
  const sp = track.startPos || { x: 0, y: 0 };
  const kart = createKart({
    id: 0,
    x: sp.x,
    y: sp.y,
    angle: track.startAngle || 0,
    color: "#00f5ff",
    upgrades: competitiveStandardUpgrades(),
    weather,
    tyreId: tyres,
    totalLaps: 99,
    onlineConnId: "trial",
    onlineName: "TRIAL",
    getInput: () => emptyInput(),
  });

  const floor = minPlausibleLapSec(track);
  let nowMs = 0;
  for (let i = 0; i < packedInputs.length; i++) {
    const inp = unpackInputFlags(packedInputs[i]);
    nowMs += FIXED_DT * 1000;
    stepKart(kart, inp, FIXED_DT, track, [], {
      contact: false,
      resolveCollisions: false,
      nowMs,
    });
  }

  if (!kart.lapTimes.length) {
    return { ok: false, error: "no_lap_completed" };
  }

  const bestLap = Math.min(...kart.lapTimes.filter((t) => Number.isFinite(t) && t > 0));
  if (!Number.isFinite(bestLap) || !(bestLap > 0)) {
    return { ok: false, error: "invalid_verified_lap" };
  }
  if (bestLap < floor) {
    return { ok: false, error: "implausible_lap" };
  }
  if (bestLap > 3600) {
    return { ok: false, error: "invalid_verified_lap" };
  }

  return {
    ok: true,
    bestLap,
    lapTimes: kart.lapTimes.slice(),
    steps: packedInputs.length,
    rulesVersion: LEADERBOARD_RULES_VERSION,
    trackBakeVersion: TRACK_BAKE_VERSION,
  };
}
