/**
 * Browser entry — bundled to online-sim.js as global OnlineSim.
 */
export {
  ONLINE_PROTOCOL,
  TRACK_BAKE_VERSION,
  FIXED_DT,
  SIM_HZ,
  STATE_HZ,
  INPUT_HZ,
  STEPS_PER_INPUT,
  GAME_SPEED_MULT,
} from "./constants";
export { defaultUpgrades, sanitizeUpgrades, computeBaseStats, type UpgradeStats } from "./upgrades";
export {
  createKart,
  stepKart,
  emptyInput,
  applyNetPose,
  cloneKartPose,
  copyKartState,
  SimKart,
  type SimInput,
  type BakedTrack,
  type CreateKartOpts,
} from "./kart";
export { resolveKartCollisions } from "./collision";
export { OnlineRaceSim, type OnlineRaceConfig, type RacePlayer } from "./raceOnline";
export { loadTrackBake, listTrackIds } from "./tracks";
