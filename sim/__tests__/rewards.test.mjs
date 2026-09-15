/**
 * Unit tests for rebalanced race reward formulas.
 */
import assert from 'assert';
import {
  DIFF_MULT,
  aiPlaceBonus,
  AD_REWARD_COINS,
  AD_COOLDOWN_MS,
  buildTrialResult,
  buildAiResult,
  buildVersusResult,
  buildShootoutResult,
  buildOnlineResult,
  calculateRaceRewards,
  formatRewardBreakdown,
  TRIAL_LAP_FULL,
  TRIAL_SESSION_BASE,
  PB_IMPROVE_BONUS,
} from '../rewards.mjs';

const track = { id: 0, name: 'TEST', targetLap: 30, coinMult: 1.0, medalLaps: { bronze: 35, silver: 32, gold: 30, blitz: 28 } };
const trackBoost = { id: 7, name: 'NEON', targetLap: 30, coinMult: 1.8 };

assert.ok(AD_REWARD_COINS < 40, 'ads must not dominate');
assert.ok(AD_COOLDOWN_MS >= 180000, 'ad cooldown at least 3 minutes');

assert.strictEqual(aiPlaceBonus(1), 50);
assert.strictEqual(aiPlaceBonus(5), 6);

// Trial: laps + session, soft-cap, PB, medals separated
{
  const r = buildTrialResult({
    trackId: 0, trackName: 'T', bestLap: 28, laps: 4,
    pbImproved: true,
    medalRewards: [{ label: 'Bronze medal', amount: 45 }],
  });
  const reward = calculateRaceRewards(r, track);
  // 4*10 + 15 session + 28 PB = 83 race/bonus; medals 45 not multiplied
  assert.strictEqual(reward.groups.medals, 45);
  assert.strictEqual(reward.groups.bonus, PB_IMPROVE_BONUS);
  assert.ok(reward.groups.race >= 4 * TRIAL_LAP_FULL + TRIAL_SESSION_BASE);
  assert.strictEqual(reward.total, Math.round((reward.groups.race + reward.groups.bonus) * 1) + 45);
  assert.ok(formatRewardBreakdown(reward).includes('MEDALS'));
  assert.ok(formatRewardBreakdown(reward).includes('RACE'));
}

// Trial soft-cap after 6 laps
{
  const r6 = calculateRaceRewards(
    buildTrialResult({ trackId: 0, trackName: 'T', bestLap: 40, laps: 6 }),
    track
  );
  const r10 = calculateRaceRewards(
    buildTrialResult({ trackId: 0, trackName: 'T', bestLap: 40, laps: 10 }),
    track
  );
  // Extra 4 laps pay reduced rate — not 4 * full
  assert.ok(r10.groups.race - r6.groups.race < 4 * TRIAL_LAP_FULL);
  assert.ok(r10.groups.race > r6.groups.race);
}

// AI place + finish + difficulty
{
  const reward = calculateRaceRewards(
    buildAiResult({
      trackId: 0, trackName: 'T', bestLap: 28, total: 90, laps: 3,
      finished: true, position: 1, fieldSize: 6, aiDiff: 'medium',
    }),
    track
  );
  // 24 + 28 + 50 = 102 × 1.2 = 122.4 → 122
  assert.strictEqual(reward.base, 102);
  assert.strictEqual(reward.diffMult, DIFF_MULT.medium);
  assert.strictEqual(reward.total, Math.round(102 * 1.2));
}

{
  const p1 = calculateRaceRewards(
    buildAiResult({
      trackId: 0, trackName: 'T', bestLap: 40, total: 90, laps: 3,
      finished: true, position: 1, fieldSize: 6, aiDiff: 'easy',
    }),
    track
  );
  const last = calculateRaceRewards(
    buildAiResult({
      trackId: 0, trackName: 'T', bestLap: 40, total: 90, laps: 3,
      finished: true, position: 8, fieldSize: 8, aiDiff: 'easy',
    }),
    track
  );
  assert.ok(p1.total > last.total);
  assert.ok(last.total > 40, 'weaker finishers still earn meaningful coins');
}

// Versus winner bonus
{
  const reward = calculateRaceRewards(
    buildVersusResult({
      trackId: 0, trackName: 'T', p1Best: 30, p2Best: 31,
      p1Total: 90, p2Total: 92, p1Laps: 3, p2Laps: 3, winner: 0,
    }),
    track
  );
  // 6*5 + 18 + 20 = 68
  assert.strictEqual(reward.base, 68);
  assert.strictEqual(reward.total, 68);
}

// Shootout
{
  const win = calculateRaceRewards(
    buildShootoutResult({
      trackId: 0, trackName: 'T', bestLap: 25, aiLap: 26, aiDiff: 'hard', win: true,
    }),
    track
  );
  // 18+40+12 = 70 × 1.45
  assert.strictEqual(win.base, 70);
  assert.strictEqual(win.total, Math.round(70 * DIFF_MULT.hard));
}

// Online zero
{
  const reward = calculateRaceRewards(
    buildOnlineResult({
      trackId: 0, trackName: 'T', bestLap: 20, total: 60, laps: 3, position: 1, fieldSize: 4,
    }),
    track
  );
  assert.strictEqual(reward.total, 0);
}

// Track mult does not inflate medal grants
{
  const reward = calculateRaceRewards(
    buildTrialResult({
      trackId: 7, trackName: 'N', bestLap: 28, laps: 2,
      medalRewards: [{ label: 'Gold medal', amount: 120 }],
    }),
    trackBoost
  );
  assert.strictEqual(reward.groups.medals, 120);
  const scalable = reward.groups.race + reward.groups.bonus;
  assert.strictEqual(reward.total, Math.round(scalable * 1.8) + 120);
}

console.log('rewards.test.mjs: all assertions passed');
