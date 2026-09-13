/**
 * Unit tests for race result builders and coin reward formulas.
 */
import assert from 'assert';
import {
  DIFF_MULT,
  aiPlaceBonus,
  buildTrialResult,
  buildAiResult,
  buildVersusResult,
  buildShootoutResult,
  buildOnlineResult,
  calculateRaceRewards,
} from '../rewards.mjs';

const track = { id: 0, name: 'TEST', targetLap: 30, coinMult: 1.0 };
const trackBoost = { id: 7, name: 'NEON', targetLap: 30, coinMult: 1.8 };

function assertPartsSum(reward) {
  const sum = reward.parts.reduce((s, p) => s + p.amount, 0);
  assert.strictEqual(sum, reward.base, 'parts should sum to base');
}

// ── Place bonus table ───────────────────────────────────
assert.strictEqual(aiPlaceBonus(1), 20);
assert.strictEqual(aiPlaceBonus(2), 12);
assert.strictEqual(aiPlaceBonus(3), 8);
assert.strictEqual(aiPlaceBonus(4), 4);
assert.strictEqual(aiPlaceBonus(5), 2);
assert.strictEqual(aiPlaceBonus(8), 2);
assert.strictEqual(aiPlaceBonus(null), 0);
assert.strictEqual(aiPlaceBonus(0), 0);

// ── Trial: laps + target, no finish bonus ───────────────
{
  const r = buildTrialResult({ trackId: 0, trackName: 'T', bestLap: 28, laps: 4 });
  assert.strictEqual(r.mode, 'trial');
  assert.strictEqual(r.finished, false);
  assert.ok(!('total' in r) || r.total == null);

  const reward = calculateRaceRewards(r, track);
  // 4*3 + 8 target = 20
  assert.strictEqual(reward.base, 20);
  assert.strictEqual(reward.total, 20);
  assertPartsSum(reward);
  assert.ok(reward.parts.every((p) => p.label !== 'Finish bonus'));
}

{
  // No target beat, no finish even if someone stuffed total on old payload
  const r = buildTrialResult({ trackId: 0, trackName: 'T', bestLap: 40, laps: 2 });
  const reward = calculateRaceRewards({ ...r, total: 99 }, track);
  assert.strictEqual(reward.base, 6); // laps only
  assert.strictEqual(reward.total, 6);
}

// ── AI: mode, place, finish, target, difficulty ─────────
{
  const r = buildAiResult({
    trackId: 0,
    trackName: 'T',
    bestLap: 28,
    total: 90,
    laps: 3,
    finished: true,
    position: 1,
    fieldSize: 6,
    aiDiff: 'medium',
  });
  assert.strictEqual(r.mode, 'ai');
  const reward = calculateRaceRewards(r, track);
  // 9 + 10 finish + 8 target + 20 place = 47; ×1.25 = 58.75 → 59
  assert.strictEqual(reward.base, 47);
  assert.strictEqual(reward.diffMult, DIFF_MULT.medium);
  assert.strictEqual(reward.total, Math.round(47 * 1.25));
  assert.ok(reward.parts.some((p) => p.label === 'Place P1'));
}

{
  const r = buildAiResult({
    trackId: 0,
    trackName: 'T',
    bestLap: 40,
    total: null,
    laps: 3,
    finished: false,
    position: 6,
    fieldSize: 6,
    aiDiff: 'easy',
  });
  const reward = calculateRaceRewards(r, track);
  // 9 + 2 place = 11; easy ×1
  assert.strictEqual(reward.base, 11);
  assert.strictEqual(reward.total, 11);
}

{
  const p1 = calculateRaceRewards(
    buildAiResult({
      trackId: 0, trackName: 'T', bestLap: 40, total: 90, laps: 3,
      finished: true, position: 1, fieldSize: 6, aiDiff: 'easy',
    }),
    track
  );
  const p8 = calculateRaceRewards(
    buildAiResult({
      trackId: 0, trackName: 'T', bestLap: 40, total: 90, laps: 3,
      finished: true, position: 8, fieldSize: 8, aiDiff: 'easy',
    }),
    track
  );
  assert.ok(p1.total > p8.total, 'P1 should earn more than P8');
}

// ── Versus: sum of both players' laps ───────────────────
{
  const r = buildVersusResult({
    trackId: 0,
    trackName: 'T',
    p1Best: 30,
    p2Best: 31,
    p1Total: 90,
    p2Total: 92,
    p1Laps: 3,
    p2Laps: 3,
    winner: 0,
  });
  assert.strictEqual(r.mode, 'versus');
  assert.strictEqual(r.laps, 6);
  assert.strictEqual(r.p1Laps, 3);
  assert.strictEqual(r.p2Laps, 3);
  const reward = calculateRaceRewards(r, track);
  // 6*2 + 8 = 20
  assert.strictEqual(reward.base, 20);
  assert.strictEqual(reward.total, 20);
}

{
  // Missing laps historically → 0 lap pay; builders always set laps
  const reward = calculateRaceRewards(
    { mode: 'versus', trackId: 0, laps: 0 },
    track
  );
  assert.strictEqual(reward.base, 8);
  assert.strictEqual(reward.total, 8);
}

{
  const reward = calculateRaceRewards(
    buildVersusResult({
      trackId: 7, trackName: 'N', p1Best: 1, p2Best: 1,
      p1Total: 10, p2Total: 10, p1Laps: 2, p2Laps: 1, winner: null,
    }),
    trackBoost
  );
  // (3*2)+8 = 14 × 1.8 = 25.2 → 25
  assert.strictEqual(reward.base, 14);
  assert.strictEqual(reward.total, Math.round(14 * 1.8));
}

// ── Shootout unchanged rates ────────────────────────────
{
  const win = calculateRaceRewards(
    buildShootoutResult({
      trackId: 0, trackName: 'T', bestLap: 25, aiLap: 26, aiDiff: 'hard', win: true,
    }),
    track
  );
  // 8+14+4 = 26 × 1.5 = 39
  assert.strictEqual(win.base, 26);
  assert.strictEqual(win.total, Math.round(26 * 1.5));

  const lose = calculateRaceRewards(
    buildShootoutResult({
      trackId: 0, trackName: 'T', bestLap: 28, aiLap: 26, aiDiff: 'easy', win: false,
    }),
    track
  );
  assert.strictEqual(lose.base, 12); // 8+4
  assert.strictEqual(lose.total, 12);
}

// ── Online: zero coins ──────────────────────────────────
{
  const r = buildOnlineResult({
    trackId: 0, trackName: 'T', bestLap: 20, total: 60, laps: 3, position: 1, fieldSize: 4,
  });
  assert.strictEqual(r.mode, 'online');
  assert.strictEqual(r.position, 1);
  const reward = calculateRaceRewards(r, track);
  assert.strictEqual(reward.total, 0);
  assert.strictEqual(reward.base, 0);
}

// ── Track mult only ─────────────────────────────────────
{
  const r = buildTrialResult({ trackId: 7, trackName: 'N', bestLap: 40, laps: 1 });
  const reward = calculateRaceRewards(r, trackBoost);
  assert.strictEqual(reward.base, 3);
  assert.strictEqual(reward.total, Math.round(3 * 1.8));
}

console.log('rewards.test.mjs: all assertions passed');
