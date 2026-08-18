import { getTyre, getWeather, normalizeWeatherId, type TyreDef } from "./constants";

export function ambientTemp(weather: string): number {
  const wx = getWeather(weather);
  return wx.ambientTemp != null ? wx.ambientTemp : 28;
}

export function tyreTempGripMult(temp: number, tyreDef: TyreDef): number {
  const lo = tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  const hi = tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if (temp >= lo - 2 && temp <= hi + 2) return 1.0;
  if (temp < lo) {
    const depth = Math.min(1, (lo - temp) / 34);
    return Math.max(0.9, 1 - depth * 0.1);
  }
  const over = temp - hi;
  if (over <= 16) return Math.max(0.95, 1 - (over / 16) * 0.05);
  return Math.max(0.88, 0.95 - ((over - 16) / 24) * 0.07);
}

export function tyreTempWearMult(temp: number, tyreDef: TyreDef): number {
  const hi = tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if (temp <= hi) return 1.0;
  const over = temp - hi;
  if (over <= 12) return 1.0 + (over / 12) * 0.12;
  return 1.12 + Math.min(0.28, ((over - 12) / 20) * 0.28);
}

export function tyreTempBrakeMult(temp: number, tyreDef: TyreDef): number {
  const lo = tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  const hi = tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if (temp < lo) {
    const depth = Math.min(1, (lo - temp) / 28);
    return Math.max(0.9, 1 - depth * 0.1);
  }
  if (temp > hi + 12) {
    const over = Math.min(1, (temp - (hi + 12)) / 20);
    return Math.max(0.88, 1 - over * 0.12);
  }
  return 1.0;
}

export function tyreTempTractMult(temp: number, tyreDef: TyreDef): number {
  return tyreTempGripMult(temp, tyreDef);
}

/** Deterministic simplified tyre thermal + wear tick. */
export function updateTyres(
  state: {
    tyreId: string;
    tyreWear: number;
    tyreTemp: number;
    tyreWrongWeather: boolean;
    weather: string;
  },
  dt: number,
  speed: number,
  maxSpeed: number,
  throttleInput: number,
  brakeInput: number,
  steering: boolean
): { wear: number; temp: number; gripMult: number; brakeMult: number; tractMult: number } {
  const tDef = getTyre(state.tyreId);
  let wear = state.tyreWear;
  let temp = state.tyreTemp;
  const amb = ambientTemp(state.weather);
  if (!Number.isFinite(temp)) temp = amb + 8;

  const spdAbs = Math.abs(speed);
  const spdRatio = spdAbs / Math.max(1, maxSpeed);

  if (!state.tyreWrongWeather) {
    const heatScale = (tDef.heatRate != null ? tDef.heatRate : 1) * 0.72;
    const coolScale = (tDef.coolRate != null ? tDef.coolRate : 1) * 0.78;
    let heat = 0;
    let cool = 0;
    if (brakeInput > 0.12 && spdAbs > 35) heat += brakeInput * (0.28 + spdRatio * 0.7) * 3.1;
    if (steering && spdRatio > 0.25) heat += spdRatio * 1.2;
    if (throttleInput > 0.12 && spdAbs > 18) heat += throttleInput * (0.18 + spdRatio * 0.42) * 1.45;
    if (!steering && spdRatio > 0.45) cool += 3.2 + spdRatio * 1.7;
    else if (!steering) cool += 1.8;
    if (throttleInput < 0.08 && brakeInput < 0.08) cool += 2.6;
    const net = (heat * heatScale - cool * coolScale) * dt;
    const ambPull = (amb - temp) * 0.04 * coolScale * dt;
    temp = Math.max(40, Math.min(128, temp + net + ambPull));

    const distTick = spdAbs * dt;
    const wearRate = 1 / (tDef.lifespan * 4200);
    wear = Math.min(1, wear + distTick * wearRate * tyreTempWearMult(temp, tDef));
  }

  return {
    wear,
    temp,
    gripMult: tyreTempGripMult(temp, tDef),
    brakeMult: tyreTempBrakeMult(temp, tDef),
    tractMult: tyreTempTractMult(temp, tDef),
  };
}

export function seedTyreTemp(weather: string, tyreId: string): number {
  const tyre = getTyre(tyreId);
  const amb = ambientTemp(normalizeWeatherId(weather));
  const idealLo = tyre.idealMin != null ? tyre.idealMin : 85;
  return Math.min(idealLo - 3, amb + 18);
}
