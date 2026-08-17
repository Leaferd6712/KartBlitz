import { GAME_SPEED_MULT, GLOBAL_ACCEL_MULT, getTyre, getWeather, isWetWeather, normalizeWeatherId } from "./constants";

/** Compact upgrade blob sent on hello/ready and used by createKart. */
export type UpgradeStats = {
  speed: number;
  accel: number;
  handling: number;
  braking: number;
  traction: number;
  speedMult: number;
  turnMult: number;
  brakeMult: number;
  tractBonus: number;
};

export function defaultUpgrades(): UpgradeStats {
  return {
    speed: 0,
    accel: 0,
    handling: 0,
    braking: 0,
    traction: 0,
    speedMult: 1,
    turnMult: 1,
    brakeMult: 1,
    tractBonus: 0,
  };
}

export function sanitizeUpgrades(raw: unknown): UpgradeStats {
  const d = defaultUpgrades();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const num = (k: keyof UpgradeStats, lo: number, hi: number) => {
    const v = typeof o[k] === "number" ? (o[k] as number) : d[k];
    return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : d[k]));
  };
  return {
    speed: num("speed", 0, 80),
    accel: num("accel", 0, 80),
    handling: num("handling", 0, 80),
    braking: num("braking", 0, 80),
    traction: num("traction", 0, 80),
    speedMult: num("speedMult", 0.7, 1.35),
    turnMult: num("turnMult", 0.7, 1.35),
    brakeMult: num("brakeMult", 0.7, 1.5),
    tractBonus: num("tractBonus", 0, 40),
  };
}

export type KartBaseStats = {
  maxSpeed: number;
  accel: number;
  brakeForce: number;
  turnRate: number;
  grip: number;
  offTrackMaxSpd: number;
  offTrackAccel: number;
};

/** Mirror of applyUpgradesToKart + weather tyre mapping (pure). */
export function computeBaseStats(upgrades: UpgradeStats, weather: string, tyreId: string): KartBaseStats {
  const u = sanitizeUpgrades(upgrades);
  let maxSpeed = (469 + u.speed) * u.speedMult * GAME_SPEED_MULT;
  let accel = (304 + u.accel) * GLOBAL_ACCEL_MULT;
  let brakeForce = (620 + u.braking) * (u.brakeMult || 1);
  let turnRate = (2.22 + u.handling * 0.85) * u.turnMult;
  const offTrackMaxSpd = Math.max(30, 80 + u.traction + u.tractBonus) * GAME_SPEED_MULT;
  const offTrackAccel = 165 * GLOBAL_ACCEL_MULT;
  let grip = Math.max(0.55, Math.min(1.15, 0.78 + u.tractBonus * 0.004 + u.traction * 0.0015));

  const wx = getWeather(weather);
  const tyre = getTyre(tyreId);
  const wet = isWetWeather(weather);
  const dry = normalizeWeatherId(weather) === "dry";

  if (dry && tyre.dryPenalty) {
    maxSpeed *= 0.38;
    turnRate *= 0.45;
    grip = Math.min(grip, 0.42);
  } else if (wet && tyre.dryOnly) {
    maxSpeed *= 0.42;
    turnRate *= 0.4;
    grip = Math.min(grip, 0.38);
  } else {
    const g = wx.gripMult + tyre.gripBonus;
    maxSpeed = Math.max(100, maxSpeed * (1 - wx.speedPen) + tyre.speedBonus);
    turnRate *= g;
    grip = Math.max(0.35, Math.min(1.15, grip * (0.82 + g * 0.22)));
  }

  return { maxSpeed, accel, brakeForce, turnRate, grip, offTrackMaxSpd, offTrackAccel };
}
