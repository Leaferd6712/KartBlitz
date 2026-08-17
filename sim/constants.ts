export const GAME_SPEED_MULT = 0.75;
export const GLOBAL_ACCEL_MULT = 0.45;
export const COAST_DECEL_PER_SEC = 25;
export const SIM_HZ = 60;
export const STATE_HZ = 30;
export const FIXED_DT = 1 / SIM_HZ;
/** Bump when wire format or bake layout changes. */
export const ONLINE_PROTOCOL = 3;
export const TRACK_BAKE_VERSION = 2;
export const INPUT_HZ = 30;
/** Physics steps to apply per networked input sample (SIM_HZ / INPUT_HZ). */
export const STEPS_PER_INPUT = SIM_HZ / INPUT_HZ;

export type TyreDef = {
  id: string;
  gripBonus: number;
  speedBonus: number;
  dryOnly?: boolean;
  dryPenalty?: boolean;
  wetOnly?: boolean;
  lifespan: number;
  idealMin?: number;
  idealMax?: number;
  heatRate?: number;
  coolRate?: number;
};

export const TYRE_DEFS: TyreDef[] = [
  { id: "soft", gripBonus: 0.14, speedBonus: 28, dryOnly: true, lifespan: 14, idealMin: 86, idealMax: 108, heatRate: 1.12, coolRate: 0.95 },
  { id: "med", gripBonus: 0.05, speedBonus: 10, dryOnly: true, lifespan: 28, idealMin: 82, idealMax: 103, heatRate: 1.05, coolRate: 1.0 },
  { id: "hard", gripBonus: -0.04, speedBonus: -12, dryOnly: true, lifespan: 55, idealMin: 78, idealMax: 102, heatRate: 0.95, coolRate: 1.05 },
  { id: "ints", gripBonus: 0.08, speedBonus: -5, dryPenalty: true, lifespan: 40, idealMin: 66, idealMax: 92, heatRate: 1.0, coolRate: 1.05 },
  { id: "wet", gripBonus: 0.22, speedBonus: -20, wetOnly: true, dryPenalty: true, lifespan: 40, idealMin: 52, idealMax: 82, heatRate: 0.92, coolRate: 1.08 },
];

export type WeatherDef = {
  id: string;
  gripMult: number;
  speedPen: number;
  ambientTemp?: number;
};

export const WEATHER_DEFS: WeatherDef[] = [
  { id: "dry", gripMult: 1.0, speedPen: 0, ambientTemp: 28 },
  { id: "drizzle", gripMult: 0.92, speedPen: 0.04, ambientTemp: 22 },
  { id: "wet", gripMult: 0.82, speedPen: 0.08, ambientTemp: 18 },
  { id: "storm", gripMult: 0.72, speedPen: 0.12, ambientTemp: 16 },
];

export function normalizeWeatherId(w: string): string {
  const id = String(w || "dry").toLowerCase();
  if (WEATHER_DEFS.some((x) => x.id === id)) return id;
  return "dry";
}

export function isWetWeather(w: string): boolean {
  const id = normalizeWeatherId(w);
  return id === "drizzle" || id === "wet" || id === "storm";
}

export function getTyre(id: string): TyreDef {
  return TYRE_DEFS.find((t) => t.id === id) || TYRE_DEFS[1];
}

export function getWeather(id: string): WeatherDef {
  return WEATHER_DEFS.find((w) => w.id === normalizeWeatherId(id)) || WEATHER_DEFS[0];
}
