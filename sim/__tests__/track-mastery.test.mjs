/**
 * Track mastery medal thresholds + reward persistence.
 */
import assert from 'assert';
import {
  deriveMedalLaps,
  medalForLap,
  applyLapToMastery,
  migrateMasteryFromBestLaps,
  masterySummary,
  MEDAL_FIRST_REWARDS,
  normalizeTrackMastery,
  nextMedalAfter,
} from '../track-mastery.mjs';

const track = {
  id: 0,
  name: 'SUNSET',
  targetLap: 42,
  medalLaps: deriveMedalLaps(42),
};

assert.strictEqual(track.medalLaps.gold, 42);
assert.ok(track.medalLaps.bronze > track.medalLaps.silver);
assert.ok(track.medalLaps.silver > track.medalLaps.gold);
assert.ok(track.medalLaps.gold > track.medalLaps.blitz);

// Boundaries: must be strictly under threshold
assert.strictEqual(medalForLap(track.medalLaps.bronze, track), null);
assert.strictEqual(medalForLap(track.medalLaps.bronze - 0.01, track), 'bronze');
assert.strictEqual(medalForLap(track.medalLaps.gold - 0.01, track), 'gold');
assert.strictEqual(medalForLap(track.medalLaps.blitz - 0.01, track), 'blitz');
assert.strictEqual(medalForLap(track.medalLaps.blitz, track), 'gold'); // under gold, not blitz

// Apply + first-time rewards once
{
  let state = normalizeTrackMastery(null);
  const first = applyLapToMastery(state, track, 40); // under silver? 42*1.08=45.4, 40 < gold 42 → gold
  assert.strictEqual(first.medal, 'gold');
  assert.ok(first.rewardCoins > 0);
  assert.ok(first.rewarded.includes('bronze'));
  assert.ok(first.rewarded.includes('silver'));
  assert.ok(first.rewarded.includes('gold'));
  assert.ok(!first.rewarded.includes('blitz'));

  const second = applyLapToMastery(first.mastery, track, 39.5);
  assert.strictEqual(second.rewardCoins, 0, 'no duplicate first-time rewards');
  assert.strictEqual(second.rewarded.length, 0);

  const blitz = applyLapToMastery(second.mastery, track, track.medalLaps.blitz - 0.1);
  assert.strictEqual(blitz.medal, 'blitz');
  assert.strictEqual(blitz.rewardCoins, MEDAL_FIRST_REWARDS.blitz);
  assert.deepStrictEqual(blitz.rewarded, ['blitz']);
}

// PB improves and next target
{
  let state = normalizeTrackMastery(null);
  const a = applyLapToMastery(state, track, 50); // bronze-ish: 42*1.18=49.6, 50 is slower than bronze
  assert.strictEqual(a.medal, null);
  const b = applyLapToMastery(a.mastery, track, 48);
  assert.strictEqual(b.medal, 'bronze');
  assert.ok(b.improved);
  assert.strictEqual(nextMedalAfter('bronze'), 'silver');
  assert.ok(b.nextTarget && b.nextTarget.id === 'silver');
}

// Migration marks claimed without intending duplicate payouts later
{
  const seeded = normalizeTrackMastery({
    tracks: { '0': { bestLap: 40, medal: null, claimed: {} } },
  });
  const migrated = migrateMasteryFromBestLaps(seeded, [track]);
  const entry = migrated.tracks['0'];
  assert.ok(entry.claimed.gold);
  const again = applyLapToMastery(migrated, track, 40);
  assert.strictEqual(again.rewardCoins, 0);
}

{
  const m = normalizeTrackMastery({
    tracks: {
      '0': { bestLap: 40, medal: 'gold', claimed: { bronze: true, silver: true, gold: true } },
      '1': { bestLap: 50, medal: 'bronze', claimed: { bronze: true } },
    },
  });
  const s = masterySummary(m, 8);
  assert.strictEqual(s.available, 32);
  assert.strictEqual(s.earned, 4);
}

console.log('track-mastery tests: OK');
