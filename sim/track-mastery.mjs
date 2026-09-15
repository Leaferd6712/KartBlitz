/**
 * Time Trial track mastery — Bronze / Silver / Gold / Blitz.
 * Thresholds live on track.medalLaps (seconds). Gold mirrors legacy targetLap.
 */

export const MEDAL_ORDER = Object.freeze(['bronze', 'silver', 'gold', 'blitz']);

export const MEDAL_LABELS = Object.freeze({
  bronze: 'BRONZE',
  silver: 'SILVER',
  gold: 'GOLD',
  blitz: 'BLITZ',
});

/** First-time coin rewards per medal tier (economy-tuned). */
export const MEDAL_FIRST_REWARDS = Object.freeze({
  bronze: 45,
  silver: 75,
  gold: 120,
  blitz: 200,
});

/**
 * Derive four targets from a legacy gold/par lap (seconds).
 * Preserves gold === targetLap.
 */
export function deriveMedalLaps(goldSeconds) {
  const gold = Number(goldSeconds);
  if (!Number.isFinite(gold) || gold <= 0) {
    return { bronze: 0, silver: 0, gold: 0, blitz: 0 };
  }
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    bronze: round1(gold * 1.18),
    silver: round1(gold * 1.08),
    gold: round1(gold),
    blitz: round1(gold * 0.92),
  };
}

/** Ensure track-like object has medalLaps; never mutates unknown shapes badly. */
export function ensureTrackMedalLaps(track) {
  if (!track || typeof track !== 'object') return deriveMedalLaps(0);
  if (track.medalLaps && Number.isFinite(track.medalLaps.gold)) {
    return {
      bronze: Number(track.medalLaps.bronze),
      silver: Number(track.medalLaps.silver),
      gold: Number(track.medalLaps.gold),
      blitz: Number(track.medalLaps.blitz),
    };
  }
  const gold = Number.isFinite(track.targetLap) ? track.targetLap : 0;
  return deriveMedalLaps(gold);
}

export function medalRank(id) {
  const i = MEDAL_ORDER.indexOf(id);
  return i < 0 ? -1 : i;
}

export function betterMedal(a, b) {
  return medalRank(a) >= medalRank(b) ? a : b;
}

/**
 * Highest medal earned for a lap time (strictly under threshold).
 * @returns {'bronze'|'silver'|'gold'|'blitz'|null}
 */
export function medalForLap(bestLap, track) {
  if (!Number.isFinite(bestLap) || bestLap <= 0 || bestLap >= Infinity) return null;
  const m = ensureTrackMedalLaps(track);
  let earned = null;
  for (const id of MEDAL_ORDER) {
    const t = m[id];
    if (Number.isFinite(t) && bestLap < t) earned = id;
  }
  return earned;
}

export function nextMedalAfter(currentMedal) {
  if (!currentMedal) return 'bronze';
  const i = medalRank(currentMedal);
  if (i < 0 || i >= MEDAL_ORDER.length - 1) return null;
  return MEDAL_ORDER[i + 1];
}

export function createEmptyTrackMastery() {
  return { tracks: {} };
}

export function normalizeTrackMastery(raw) {
  const base = createEmptyTrackMastery();
  if (!raw || typeof raw !== 'object') return base;
  const tracks = {};
  const src = raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : raw;
  // If raw is flat id->row without .tracks, avoid treating meta keys as tracks.
  const keys = raw.tracks && typeof raw.tracks === 'object' ? Object.keys(raw.tracks) : Object.keys(raw).filter((k) => k !== '_migratedMedals');
  for (const key of keys) {
    const id = String(key);
    const row = (raw.tracks && raw.tracks[id]) != null ? raw.tracks[id] : src[id];
    if (!row || typeof row !== 'object') continue;
    if (row.bronze != null && row.gold != null && row.bestLap == null) continue; // skip medalLaps mistaken
    const bestLap = Number(row.bestLap);
    const medal = MEDAL_ORDER.includes(row.medal) ? row.medal : null;
    const claimed = {};
    const c = row.claimed && typeof row.claimed === 'object' ? row.claimed : {};
    for (const mid of MEDAL_ORDER) {
      if (c[mid]) claimed[mid] = true;
    }
    tracks[id] = {
      bestLap: Number.isFinite(bestLap) && bestLap > 0 ? bestLap : null,
      medal,
      claimed,
    };
  }
  return {
    tracks,
    _migratedMedals: !!raw._migratedMedals,
  };
}

export function getTrackMasteryEntry(mastery, trackId) {
  const m = normalizeTrackMastery(mastery);
  const id = String(trackId);
  return m.tracks[id] || { bestLap: null, medal: null, claimed: {} };
}

/**
 * Apply a new session best lap: update PB, medal, and list newly claimable first-time rewards.
 * Does not mutate claimed until claimMedalRewards is called (or claimNow=true).
 */
export function applyLapToMastery(mastery, track, bestLap, opts = {}) {
  const claimNow = opts.claimNow !== false;
  const m = normalizeTrackMastery(mastery);
  const id = String(track && track.id != null ? track.id : opts.trackId);
  const prev = m.tracks[id] || { bestLap: null, medal: null, claimed: {} };
  const prevBest = prev.bestLap;
  const improved =
    Number.isFinite(bestLap) && bestLap > 0 && bestLap < Infinity
    && (prevBest == null || bestLap < prevBest);

  let nextBest = prevBest;
  if (improved) nextBest = bestLap;
  else if (nextBest == null && Number.isFinite(bestLap) && bestLap < Infinity) nextBest = bestLap;

  const lapForMedal = nextBest != null ? nextBest : bestLap;
  const earnedMedal = medalForLap(lapForMedal, track);
  const nextMedal = earnedMedal
    ? (prev.medal ? betterMedal(prev.medal, earnedMedal) : earnedMedal)
    : prev.medal;

  const newlyEarned = [];
  for (const mid of MEDAL_ORDER) {
    if (earnedMedal && medalRank(earnedMedal) >= medalRank(mid)) {
      if (!prev.claimed[mid]) newlyEarned.push(mid);
    }
  }

  const claimed = { ...prev.claimed };
  let rewardCoins = 0;
  const rewarded = [];
  if (claimNow) {
    for (const mid of newlyEarned) {
      claimed[mid] = true;
      rewardCoins += MEDAL_FIRST_REWARDS[mid] || 0;
      rewarded.push(mid);
    }
  }

  m.tracks[id] = {
    bestLap: nextBest,
    medal: nextMedal,
    claimed,
  };

  return {
    mastery: { ...m, _migratedMedals: !!mastery._migratedMedals || !!m._migratedMedals },
    improved: !!improved,
    previousBest: prevBest,
    bestLap: nextBest,
    medal: nextMedal,
    newlyEarned,
    rewarded,
    rewardCoins,
    nextTarget: (() => {
      const n = nextMedalAfter(nextMedal);
      if (!n) return null;
      const laps = ensureTrackMedalLaps(track);
      return { id: n, time: laps[n], label: MEDAL_LABELS[n] };
    })(),
  };
}

/** Migrate stored PB into medals without paying rewards twice (marks claimed). */
export function migrateMasteryFromBestLaps(mastery, tracks) {
  let m = normalizeTrackMastery(mastery);
  const list = Array.isArray(tracks) ? tracks : [];
  for (const track of list) {
    if (!track || track.id == null) continue;
    const entry = getTrackMasteryEntry(m, track.id);
    if (entry.bestLap == null) continue;
    const result = applyLapToMastery(m, track, entry.bestLap, { claimNow: true });
    for (const mid of MEDAL_ORDER) {
      const row = result.mastery.tracks[String(track.id)];
      if (row.medal && medalRank(row.medal) >= medalRank(mid)) {
        row.claimed[mid] = true;
      }
    }
    m = result.mastery;
  }
  m._migratedMedals = true;
  return m;
}

export function masterySummary(mastery, trackCount) {
  const m = normalizeTrackMastery(mastery);
  let earned = 0;
  const available = Math.max(0, Math.floor(Number(trackCount) || 0)) * MEDAL_ORDER.length;
  for (const id of Object.keys(m.tracks)) {
    const row = m.tracks[id];
    for (const mid of MEDAL_ORDER) {
      if (row.claimed && row.claimed[mid]) earned += 1;
      else if (row.medal && medalRank(row.medal) >= medalRank(mid)) earned += 1;
    }
  }
  // Prefer claimed count; if medal set but claimed empty (edge), count medal tiers
  earned = 0;
  for (const id of Object.keys(m.tracks)) {
    const row = m.tracks[id];
    for (const mid of MEDAL_ORDER) {
      if (row.claimed && row.claimed[mid]) earned += 1;
    }
  }
  return { earned, available, label: `${earned} / ${available}` };
}

export function formatMedalGap(bestLap, nextTime) {
  if (!Number.isFinite(bestLap) || !Number.isFinite(nextTime)) return null;
  return bestLap - nextTime;
}

export default {
  MEDAL_ORDER,
  MEDAL_LABELS,
  MEDAL_FIRST_REWARDS,
  deriveMedalLaps,
  ensureTrackMedalLaps,
  medalRank,
  betterMedal,
  medalForLap,
  nextMedalAfter,
  createEmptyTrackMastery,
  normalizeTrackMastery,
  getTrackMasteryEntry,
  applyLapToMastery,
  migrateMasteryFromBestLaps,
  masterySummary,
  formatMedalGap,
};
