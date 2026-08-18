import type { BakedTrack } from "./kart";
import { TRACK_BAKE_VERSION } from "./constants";

// Populated by scripts/export-track-bakes.mjs → sim/tracks/bakes.json
import bakesJson from "./tracks/bakes.json";

type BakeFile = {
  version: number;
  tracks: Record<string, BakedTrack>;
};

const catalog = bakesJson as BakeFile;

export function listTrackIds(): number[] {
  return Object.keys(catalog.tracks || {})
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export function loadTrackBake(trackId: number): BakedTrack | null {
  if (!catalog || catalog.version !== TRACK_BAKE_VERSION) return null;
  const t = catalog.tracks[String(trackId)];
  if (!t || !Array.isArray(t.spline) || t.spline.length < 16) return null;
  return t;
}
