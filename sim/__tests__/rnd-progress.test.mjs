/**
 * Tests for R&D session completion gating.
 */
import assert from 'assert';
import {
  isValidRnDCompletion,
  snapshotRaceForRnD,
} from '../rnd-progress.mjs';

// ── Zero-lap Time Trial exit ────────────────────────────
{
  const session = snapshotRaceForRnD({
    mode: 'trial',
    karts: [{ lapTimes: [], finished: false, finishTime: null }],
  });
  assert.strictEqual(session.completedLaps, 0);
  assert.strictEqual(isValidRnDCompletion(session), false);
  assert.strictEqual(
    isValidRnDCompletion({ mode: 'trial', completedLaps: 0 }),
    false
  );
}

// ── Valid Time Trial lap ────────────────────────────────
{
  const session = snapshotRaceForRnD({
    mode: 'trial',
    karts: [{ lapTimes: [32.5], finished: false, finishTime: null }],
  });
  assert.strictEqual(session.completedLaps, 1);
  assert.strictEqual(isValidRnDCompletion(session), true);
  assert.strictEqual(
    isValidRnDCompletion({ mode: 'trial', completedLaps: 3 }),
    true
  );
}

// ── Finished AI race ────────────────────────────────────
{
  const session = snapshotRaceForRnD({
    mode: 'ai',
    karts: [
      { lapTimes: [30, 31, 30.5], finished: true, finishTime: 91.5 },
      { lapTimes: [31, 31, 31], finished: true, finishTime: 93 },
    ],
  });
  assert.strictEqual(session.humanFinished, true);
  assert.strictEqual(isValidRnDCompletion(session), true);
}

// ── Abandoned AI race (quit / no finish) ─────────────────
{
  const session = snapshotRaceForRnD({
    mode: 'ai',
    karts: [
      { lapTimes: [30], finished: false, finishTime: null },
      { lapTimes: [], finished: false, finishTime: null },
    ],
  });
  assert.strictEqual(session.humanFinished, false);
  assert.strictEqual(isValidRnDCompletion(session), false);
}

// ── AI DNF (finished flag but no finish time) ───────────
{
  assert.strictEqual(
    isValidRnDCompletion({
      mode: 'ai',
      humanFinished: false,
      completedLaps: 2,
    }),
    false
  );
  const session = snapshotRaceForRnD({
    mode: 'ai',
    karts: [{ lapTimes: [30, 31], finished: true, finishTime: null }],
  });
  assert.strictEqual(session.humanFinished, false);
  assert.strictEqual(isValidRnDCompletion(session), false);
}

// ── Restart / empty session (no race) ───────────────────
{
  assert.strictEqual(isValidRnDCompletion(null), false);
  assert.strictEqual(isValidRnDCompletion(undefined), false);
  assert.strictEqual(snapshotRaceForRnD(null), null);
  assert.strictEqual(isValidRnDCompletion(snapshotRaceForRnD(null)), false);
}

// ── Versus: need at least one real finish ───────────────
{
  assert.strictEqual(
    isValidRnDCompletion({
      mode: 'versus',
      p1Finished: false,
      p2Finished: false,
    }),
    false
  );
  assert.strictEqual(
    isValidRnDCompletion({
      mode: 'versus',
      p1Finished: true,
      p2Finished: false,
    }),
    true
  );
  const abandoned = snapshotRaceForRnD({
    mode: 'versus',
    karts: [
      { lapTimes: [30], finished: false, finishTime: null },
      { lapTimes: [], finished: false, finishTime: null },
    ],
  });
  assert.strictEqual(isValidRnDCompletion(abandoned), false);
}

// ── Shootout: both laps required ────────────────────────
{
  assert.strictEqual(
    isValidRnDCompletion({
      mode: 'shootout',
      shootoutPlayerLap: 28.1,
      shootoutAiLap: null,
    }),
    false
  );
  assert.strictEqual(
    isValidRnDCompletion({
      mode: 'shootout',
      shootoutPlayerLap: 28.1,
      shootoutAiLap: 29.0,
    }),
    true
  );
}

// ── Online: local human must finish ─────────────────────
{
  assert.strictEqual(
    isValidRnDCompletion({ mode: 'online', humanFinished: false }),
    false
  );
  assert.strictEqual(
    isValidRnDCompletion({ mode: 'online', humanFinished: true }),
    true
  );
}

console.log('rnd-progress.test.mjs: all assertions passed');
