import {
  COAST_DECEL_PER_SEC,
  GLOBAL_ACCEL_MULT,
  getTyre,
  isWetWeather,
  normalizeWeatherId,
} from "./constants";
import { linesCross, splineTangent, type Vec2 } from "./math";
import { seedTyreTemp, updateTyres } from "./tyres";
import { computeBaseStats, defaultUpgrades, sanitizeUpgrades, type UpgradeStats } from "./upgrades";
import { resolveKartCollisions } from "./collision";

export type SimInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  ers: boolean;
  drs: boolean;
  steer: number;
  throttle: number;
  brake: number;
};

export type CpLine = { x1: number; y1: number; x2: number; y2: number };
export type DrsZone = { sIdx: number; eIdx: number };

export type BakedTrack = {
  id?: number;
  trackWidth: number;
  spline: Vec2[];
  cum: number[];
  totalLen: number;
  startPos: Vec2;
  startAngle: number;
  cpLines: CpLine[];
  drsZones: DrsZone[];
  gridSlots?: { x: number; y: number; a: number }[];
  surface?: { offTrackMult?: number };
};

export function emptyInput(): SimInput {
  return { up: false, down: false, left: false, right: false, ers: false, drs: false, steer: 0, throttle: 0, brake: 0 };
}

export type CreateKartOpts = {
  id: number;
  x: number;
  y: number;
  angle: number;
  color?: string;
  upgrades?: UpgradeStats;
  weather: string;
  tyreId: string;
  totalLaps?: number;
  onlineConnId?: string;
  onlineName?: string;
  getInput?: () => SimInput;
};

export class SimKart {
  id: number;
  x: number;
  y: number;
  angle: number;
  speed = 0;
  color: string;
  getInput: () => SimInput;
  upgrades: UpgradeStats;
  weather: string;

  maxSpeed = 200;
  accel = 100;
  brakeForce = 700;
  friction = 0.9915;
  turnRate = 2.22;
  grip = 0.78;
  offTrackMaxSpd = 80;
  offTrackAccel = 100;
  baseMaxSpeed = 200;
  baseTurnRate = 2.22;
  _baseAccel = 100;
  _baseBrakeForce = 700;
  _baseGrip = 0.78;

  isOffTrack = false;
  lap = 0;
  checkpointsBit = 0;
  nextCp = 1;
  lapTimes: number[] = [];
  lapStart: number | null = null;
  bestLap = Infinity;
  finished = false;
  finishTime: number | null = null;
  finishOrder: number | null = null;
  totalLaps = 3;
  prevX: number;
  prevY: number;

  tyreId = "med";
  tyreWear = 0;
  tyreTemp = 55;
  tyreWrongWeather = false;
  inPit = false;
  pitPhase: string | null = null;

  ersCharge = 1.0;
  ersActive = false;
  _ersPrevKey = false;
  _ersPower = 0;
  _ersStraightTimer = 0;

  drsAvailable = true;
  drsActive = false;
  drsInZone = false;
  _nearestSplineIdx = 0;

  _throttleAssist = 0;
  _brakeAssist = 0;
  _penaltyTimer = 0;
  _isCompletelyOff = false;
  _onlineDisconnected = false;
  onlineConnId = "";
  onlineName = "";
  simTimeMs = 0;

  constructor(opts: CreateKartOpts) {
    this.id = opts.id;
    this.x = opts.x;
    this.y = opts.y;
    this.angle = opts.angle;
    this.color = opts.color || "#00f5ff";
    this.getInput = opts.getInput || (() => emptyInput());
    this.prevX = opts.x;
    this.prevY = opts.y;
    this.upgrades = sanitizeUpgrades(opts.upgrades || defaultUpgrades());
    this.weather = opts.weather;
    this.tyreId = opts.tyreId || "med";
    this.totalLaps = opts.totalLaps != null ? opts.totalLaps : 3;
    this.onlineConnId = opts.onlineConnId || "";
    this.onlineName = opts.onlineName || "";
    this.applySetup(opts.weather, opts.tyreId || "med");
  }

  applySetup(weather: string, tyreId: string) {
    this.weather = weather;
    this.tyreId = tyreId;
    const stats = computeBaseStats(this.upgrades, weather, tyreId);
    this.maxSpeed = stats.maxSpeed;
    this.accel = stats.accel;
    this.brakeForce = stats.brakeForce;
    this.turnRate = stats.turnRate;
    this.grip = stats.grip;
    this.offTrackMaxSpd = stats.offTrackMaxSpd;
    this.offTrackAccel = stats.offTrackAccel;
    this._baseGrip = stats.grip;
    this._baseAccel = stats.accel;
    this._baseBrakeForce = stats.brakeForce;
    this.baseMaxSpeed = stats.maxSpeed;
    this.baseTurnRate = stats.turnRate;
    const tyre = getTyre(tyreId);
    this.tyreWrongWeather =
      (normalizeWeatherId(weather) === "dry" && !!tyre.dryPenalty) ||
      (isWetWeather(weather) && !!tyre.dryOnly);
    this.tyreTemp = seedTyreTemp(weather, tyreId);
    this.tyreWear = 0;
  }

  /** @deprecated use stepKart */
  update(dt: number, track: BakedTrack, otherKarts: SimKart[], contactEnabled: boolean, nowMs: number) {
    stepKart(this, this.getInput() || emptyInput(), dt, track, otherKarts, {
      contact: contactEnabled,
      nowMs,
    });
  }

  onTrack(td: BakedTrack): boolean {
    const hw = td.trackWidth / 2 + 55;
    const spl = td.spline;
    const n = spl.length;
    const curIdx = this._nearestSplineIdx || 0;
    let bestDist = Infinity;
    let bestIdx = curIdx;
    for (let d = -8; d <= 80; d++) {
      const idx = ((curIdx + d) % n + n) % n;
      const dist = Math.hypot(this.x - spl[idx].x, this.y - spl[idx].y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    this._nearestSplineIdx = bestIdx;
    return bestDist < hw;
  }

  inDrsZone(td: BakedTrack): boolean {
    if (!td.drsZones || !td.drsZones.length) return false;
    const idx = this._nearestSplineIdx;
    for (const z of td.drsZones) {
      if (z.sIdx <= z.eIdx) {
        if (idx >= z.sIdx && idx <= z.eIdx) return true;
      } else if (idx >= z.sIdx || idx <= z.eIdx) return true;
    }
    return false;
  }

  handleOffTrackPenalty(dt: number, track: BakedTrack) {
    if (this.finished) return;
    const strictHw = track.trackWidth / 2 + 10;
    const nearP = track.spline[this._nearestSplineIdx || 0];
    this._isCompletelyOff = Math.hypot(this.x - nearP.x, this.y - nearP.y) >= strictHw;
    if (this._isCompletelyOff) {
      this.speed *= Math.pow(0.978, dt * 60);
      const offCap = 100;
      if (Math.abs(this.speed) > offCap) {
        const over = Math.abs(this.speed) - offCap;
        this.speed -= Math.sign(this.speed) * Math.min(over, Math.max(over * 2.6 * dt, 18 * dt));
      }
      this._penaltyTimer += dt;
      if (this._penaltyTimer >= 3.0) {
        const spl = track.spline;
        const ni = this._nearestSplineIdx || 0;
        this.x = spl[ni].x;
        this.y = spl[ni].y;
        const tang = splineTangent(spl, ni);
        this.angle = Math.atan2(tang.y, tang.x);
        this.speed = 0;
        this._penaltyTimer = 0;
        this._isCompletelyOff = false;
      }
    } else {
      this._penaltyTimer = 0;
      this._isCompletelyOff = false;
    }
  }

  checkCheckpoints(td: BakedTrack, nowMs: number) {
    const cps = td.cpLines || [];
    const numCps = cps.length;
    if (!numCps) return;
    for (let i = 0; i < numCps; i++) {
      const cp = cps[i];
      const crossedMain = linesCross(this.prevX, this.prevY, this.x, this.y, cp.x1, cp.y1, cp.x2, cp.y2);
      if (!crossedMain) continue;

      if (i === 0) {
        const allInterDone = this.nextCp >= numCps;
        if (allInterDone && this.lap >= 0) {
          if (this.lap === 0 && this.lapStart === null) {
            this.lapStart = nowMs;
            this.checkpointsBit = 1;
            this.nextCp = 1;
          } else if (this.lapStart !== null) {
            const lapTime = (nowMs - this.lapStart) / 1000;
            this.lapTimes.push(lapTime);
            if (lapTime < this.bestLap) this.bestLap = lapTime;
            this.lap++;
            if (Number.isFinite(this.totalLaps) && this.lap >= this.totalLaps) {
              this.finished = true;
              this.finishTime = this.lapTimes.reduce((a, b) => a + b, 0);
            } else {
              this.lapStart = nowMs;
              this.checkpointsBit = 1;
              this.nextCp = 1;
            }
          }
        } else if (this.lapStart === null) {
          this.lapStart = nowMs;
          this.checkpointsBit = 1;
          this.nextCp = 1;
        }
      } else if (i === this.nextCp) {
        this.checkpointsBit |= 1 << i;
        this.nextCp = i + 1;
      }
    }
  }
}

export function createKart(opts: CreateKartOpts): SimKart {
  return new SimKart(opts);
}

export type StepFlags = {
  contact?: boolean;
  nowMs?: number;
  /** If false, skip pairwise collision (caller already resolved). Default true. */
  resolveCollisions?: boolean;
};

/**
 * Single shared physics step used by DO authority and client prediction.
 */
export function stepKart(
  kart: SimKart,
  inp: SimInput,
  dt: number,
  track: BakedTrack,
  otherKarts: SimKart[],
  flags: StepFlags = {}
): SimKart {
  if (kart.finished) return kart;
  const nowMs = flags.nowMs != null ? flags.nowMs : kart.simTimeMs;
  kart.simTimeMs = nowMs;
  inp = inp || emptyInput();

  const surfMult = track.surface && track.surface.offTrackMult != null ? track.surface.offTrackMult : 1;
  const applyOff = kart.isOffTrack;
  const maxSpd = applyOff ? kart.offTrackMaxSpd * surfMult : kart.maxSpeed;
  const acc = applyOff ? kart.offTrackAccel * surfMult : kart.accel;

  let spdLimit = maxSpd;
  if (!kart.isOffTrack && otherKarts) {
    let bestWake = 0;
    for (const other of otherKarts) {
      if (other === kart || other.finished) continue;
      const dx = other.x - kart.x;
      const dy = other.y - kart.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 600 && dist > 20) {
        const dot = Math.cos(kart.angle) * dx + Math.sin(kart.angle) * dy;
        if (dot > 0) {
          const lat = Math.abs(-Math.sin(kart.angle) * dx + Math.cos(kart.angle) * dy);
          const wakeWidth = 18 + dist * 0.22;
          if (lat < wakeWidth) {
            const wakeStrength = Math.max(0, (1 - dist / 600) * (1 - lat / wakeWidth));
            if (wakeStrength > bestWake) bestWake = wakeStrength;
          }
        }
      }
    }
    if (bestWake > 0.08) spdLimit = kart.maxSpeed * (1.04 + bestWake * 0.12);
  }

  const hasAnalogDrive = typeof inp.throttle === "number" || typeof inp.brake === "number";
  let throttleTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.throttle || 0)) : inp.up ? 1 : 0;
  const brakeTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.brake || 0)) : inp.down ? 1 : 0;
  const opposingDrive = !hasAnalogDrive && inp.up && inp.down;
  if (opposingDrive) throttleTarget = 0;
  kart._throttleAssist += (throttleTarget - kart._throttleAssist) * (inp.up && !opposingDrive ? 0.22 : 0.34);
  if (opposingDrive) kart._throttleAssist *= 0.4;
  kart._brakeAssist += (brakeTarget - kart._brakeAssist) * (inp.down ? 0.16 : 0.11);
  const throttleInput = Math.max(0, Math.min(1, kart._throttleAssist));
  const brakeInput = Math.max(0, Math.min(1, kart._brakeAssist));

  if (flags.resolveCollisions !== false && flags.contact !== false) {
    resolveKartCollisions(otherKarts, true, maxSpd);
  }

  kart.ersActive = !!inp.ers && kart.ersCharge > 0 && !kart.isOffTrack;
  kart._ersPrevKey = !!inp.ers;
  const ersSpdAbs = Math.abs(kart.speed);
  const ersSpdRatio = ersSpdAbs / Math.max(1, kart.maxSpeed || kart.baseMaxSpeed || 1);
  const hasAnalogSteer = typeof inp.steer === "number";
  const ersSteering = hasAnalogSteer ? Math.abs(inp.steer) > 0.12 : !!(inp.left || inp.right);

  if (kart.ersActive) {
    kart.ersCharge = Math.max(0, kart.ersCharge - (1 / 5) * dt);
    if (kart.ersCharge <= 0) kart.ersActive = false;
    kart._ersPower = 1;
    kart._ersStraightTimer = 0;
  } else {
    kart._ersPower = Math.max(0, (kart._ersPower || 0) - (1 / 1.15) * dt);
    let regen = 0;
    if (brakeInput > 0.05 && ersSpdAbs > 18) {
      regen += (0.057 * brakeInput + 0.126 * brakeInput * brakeInput) * (0.45 + ersSpdRatio * 0.55);
    } else if (throttleInput < 0.08 && brakeInput < 0.05 && ersSpdAbs > 12) {
      regen += (throttleInput < 0.02 ? 0.065 : 0.048) * (0.35 + ersSpdRatio * 0.65);
    }
    if (!ersSteering && throttleInput > 0.55 && ersSpdRatio > 0.58 && brakeInput < 0.05) {
      kart._ersStraightTimer = (kart._ersStraightTimer || 0) + dt;
    } else {
      kart._ersStraightTimer = Math.max(0, (kart._ersStraightTimer || 0) - dt * 2);
    }
    if (kart._ersStraightTimer > 1.0) {
      regen += 0.021 + Math.min(0.017, (kart._ersStraightTimer - 1.0) * 0.008);
    }
    if (regen > 0) kart.ersCharge = Math.min(1, kart.ersCharge + regen * dt);
  }

  const drsInZone = kart.inDrsZone(track);
  kart.drsInZone = drsInZone;
  kart.drsActive = !!inp.drs && drsInZone && kart.drsAvailable && !kart.isOffTrack;

  const ersPower = Math.max(0, Math.min(1, kart._ersPower || 0));
  if (ersPower > 0.001) spdLimit *= 1 + 0.25 * ersPower;
  if (kart.drsActive) spdLimit *= 1.15;
  if (kart.tyreWear >= 1.0) spdLimit = Math.min(spdLimit, 125);

  const ersAccMult = 1 + 0.14 * ersPower;
  if (throttleInput > 0.02 && brakeInput <= 0.02) {
    kart.speed += acc * throttleInput * dt * ersAccMult;
  } else if (brakeInput > 0.02) {
    if (kart.speed > 0) kart.speed -= kart.brakeForce * brakeInput * dt;
    else kart.speed -= acc * 0.5 * dt;
  } else if (applyOff) {
    kart.speed *= Math.pow(0.96, dt * 60);
    if (Math.abs(kart.speed) < 0.5) kart.speed = 0;
  } else {
    const coastStep = COAST_DECEL_PER_SEC * dt;
    if (kart.speed > 0) kart.speed = Math.max(0, kart.speed - coastStep);
    else if (kart.speed < 0) kart.speed = Math.min(0, kart.speed + coastStep);
    if (Math.abs(kart.speed) < 0.5) kart.speed = 0;
  }

  if (kart.speed > spdLimit) {
    const over = kart.speed - spdLimit;
    kart.speed -= Math.min(over, Math.max(over * 2.2 * dt, 10 * dt));
  }
  kart.speed = Math.max(-maxSpd * 0.3, kart.speed);

  const steering = hasAnalogSteer ? Math.abs(inp.steer) > 0.05 : !!(inp.left || inp.right);
  if (Math.abs(kart.speed) > 4) {
    const speedRatio = Math.abs(kart.speed) / Math.max(1, kart.maxSpeed);
    const grip = Math.max(0.35, Math.min(1.25, kart.grip == null ? 1 : kart.grip));
    const gripFactor = Math.max(0.24, (1.0 - Math.pow(speedRatio, 1.1) * 0.68) * grip);
    const maxYawRate = kart.turnRate * gripFactor;
    const dir = kart.speed >= 0 ? 1 : -1;
    let wantYaw = 0;
    if (hasAnalogSteer) {
      wantYaw = kart.turnRate * dt * dir * Math.max(-1, Math.min(1, inp.steer));
    } else {
      if (inp.left) wantYaw -= kart.turnRate * dt * dir;
      if (inp.right) wantYaw += kart.turnRate * dt * dir;
    }
    const maxYaw = maxYawRate * dt;
    kart.angle += Math.max(-maxYaw, Math.min(maxYaw, wantYaw));
    if (Math.abs(wantYaw) > maxYaw * 1.15 && speedRatio > 0.58) {
      const scrub = 0.003 + (speedRatio - 0.58) * 0.012;
      kart.speed *= Math.pow(1 - scrub, dt * 60);
    }
  }

  const tyreTick = updateTyres(
    {
      tyreId: kart.tyreId,
      tyreWear: kart.tyreWear,
      tyreTemp: kart.tyreTemp,
      tyreWrongWeather: kart.tyreWrongWeather,
      weather: kart.weather,
    },
    dt,
    kart.speed,
    kart.baseMaxSpeed,
    throttleInput,
    brakeInput,
    steering
  );
  kart.tyreWear = tyreTick.wear;
  kart.tyreTemp = tyreTick.temp;
  const wear = kart.tyreWear;
  kart.maxSpeed = kart.baseMaxSpeed * (1 - wear * 0.35);
  kart.turnRate = kart.baseTurnRate * (1 - wear * 0.25) * (0.92 + tyreTick.gripMult * 0.08);
  kart.accel = (kart._baseAccel || 304 * GLOBAL_ACCEL_MULT) * (1 - wear * 0.18) * tyreTick.tractMult;
  kart.brakeForce = (kart._baseBrakeForce || 700) * tyreTick.brakeMult;
  kart.grip = kart._baseGrip * (1 - wear * 0.4) * tyreTick.gripMult;

  kart.prevX = kart.x;
  kart.prevY = kart.y;
  kart.x += Math.cos(kart.angle) * kart.speed * dt;
  kart.y += Math.sin(kart.angle) * kart.speed * dt;

  kart.isOffTrack = !kart.onTrack(track);
  kart.handleOffTrackPenalty(dt, track);
  kart.checkCheckpoints(track, nowMs);
  return kart;
}

export function cloneKartPose(src: SimKart): SimKart {
  const k = createKart({
    id: src.id,
    x: src.x,
    y: src.y,
    angle: src.angle,
    color: src.color,
    upgrades: src.upgrades,
    weather: src.weather,
    tyreId: src.tyreId,
    totalLaps: src.totalLaps,
    onlineConnId: src.onlineConnId,
    onlineName: src.onlineName,
  });
  copyKartState(k, src);
  return k;
}

export function copyKartState(dst: SimKart, src: SimKart) {
  dst.x = src.x;
  dst.y = src.y;
  dst.angle = src.angle;
  dst.speed = src.speed;
  dst.lap = src.lap;
  dst.checkpointsBit = src.checkpointsBit;
  dst.nextCp = src.nextCp;
  dst.lapStart = src.lapStart;
  dst.lapTimes = src.lapTimes.slice();
  dst.bestLap = src.bestLap;
  dst.finished = src.finished;
  dst.finishTime = src.finishTime;
  dst.finishOrder = src.finishOrder;
  dst.tyreWear = src.tyreWear;
  dst.tyreTemp = src.tyreTemp;
  dst.ersCharge = src.ersCharge;
  dst.ersActive = src.ersActive;
  dst._ersPower = src._ersPower;
  dst.drsActive = src.drsActive;
  dst.drsAvailable = src.drsAvailable;
  dst._nearestSplineIdx = src._nearestSplineIdx;
  dst.isOffTrack = src.isOffTrack;
  dst.prevX = src.prevX;
  dst.prevY = src.prevY;
  dst._throttleAssist = src._throttleAssist;
  dst._brakeAssist = src._brakeAssist;
  dst._penaltyTimer = src._penaltyTimer;
  dst.maxSpeed = src.maxSpeed;
  dst.accel = src.accel;
  dst.turnRate = src.turnRate;
  dst.grip = src.grip;
  dst.brakeForce = src.brakeForce;
  dst.baseMaxSpeed = src.baseMaxSpeed;
  dst.baseTurnRate = src.baseTurnRate;
  dst._baseAccel = src._baseAccel;
  dst._baseBrakeForce = src._baseBrakeForce;
  dst._baseGrip = src._baseGrip;
  dst.simTimeMs = src.simTimeMs;
}

export function applyNetPose(kart: SimKart, snap: {
  x: number; y: number; angle: number; speed: number;
  lap?: number; finished?: boolean; finishTime?: number | null; finishOrder?: number | null;
  tyreWear?: number; tyreTemp?: number; ersCharge?: number; ersActive?: boolean;
  drsActive?: boolean; drsAvailable?: boolean;
  checkpointsBit?: number; _nearestSplineIdx?: number;
  bestLap?: number | null; maxSpeed?: number; disconnected?: boolean;
}) {
  kart.x = snap.x;
  kart.y = snap.y;
  kart.angle = snap.angle;
  kart.speed = snap.speed;
  if (typeof snap.lap === "number") kart.lap = snap.lap;
  if (snap.finished != null) kart.finished = !!snap.finished;
  if (snap.finishTime !== undefined) kart.finishTime = snap.finishTime;
  if (snap.finishOrder !== undefined) kart.finishOrder = snap.finishOrder;
  if (typeof snap.tyreWear === "number") kart.tyreWear = snap.tyreWear;
  if (typeof snap.tyreTemp === "number") kart.tyreTemp = snap.tyreTemp;
  if (typeof snap.ersCharge === "number") kart.ersCharge = snap.ersCharge;
  if (snap.ersActive != null) kart.ersActive = !!snap.ersActive;
  if (snap.drsActive != null) kart.drsActive = !!snap.drsActive;
  if (snap.drsAvailable != null) kart.drsAvailable = !!snap.drsAvailable;
  if (typeof snap.checkpointsBit === "number") kart.checkpointsBit = snap.checkpointsBit;
  if (typeof snap._nearestSplineIdx === "number") kart._nearestSplineIdx = snap._nearestSplineIdx;
  if (snap.bestLap != null) kart.bestLap = snap.bestLap;
  if (typeof snap.maxSpeed === "number" && snap.maxSpeed > 1) kart.maxSpeed = snap.maxSpeed;
  kart._onlineDisconnected = !!snap.disconnected;
}
