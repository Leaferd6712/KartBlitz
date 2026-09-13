/**
 * Pure R&D session-completion rules for KartBlitz.
 * Results screens may still show without advancing research.
 */

/**
 * @typedef {object} RnDSessionSnapshot
 * @property {string} mode
 * @property {number} [completedLaps] - human / primary completed laps (trial)
 * @property {boolean} [humanFinished] - finished with a real finish time (not DNF)
 * @property {boolean} [p1Finished]
 * @property {boolean} [p2Finished]
 * @property {number|null} [shootoutPlayerLap]
 * @property {number|null} [shootoutAiLap]
 */

function isRealFinish(finished, finishTime) {
  return !!finished && finishTime != null && Number.isFinite(finishTime);
}

function finiteLap(v) {
  return v != null && Number.isFinite(v) && v > 0 && v < Infinity;
}

/**
 * Whether this race session should advance R&D progress.
 * Does not decide whether to show the results UI.
 *
 * @param {RnDSessionSnapshot|null|undefined} session
 * @returns {boolean}
 */
export function isValidRnDCompletion(session) {
  if (!session || !session.mode) return false;
  switch (session.mode) {
    case 'trial':
      return (Number(session.completedLaps) || 0) >= 1;
    case 'ai':
    case 'online':
      return !!session.humanFinished;
    case 'versus':
      return !!(session.p1Finished || session.p2Finished);
    case 'shootout':
      return finiteLap(session.shootoutPlayerLap) && finiteLap(session.shootoutAiLap);
    default:
      return false;
  }
}

/**
 * Build a plain snapshot from a Race-like object (browser Race instance).
 * Safe to call with null.
 *
 * @param {object|null|undefined} race
 * @param {{ localIndex?: number }} [opts]
 * @returns {RnDSessionSnapshot|null}
 */
export function snapshotRaceForRnD(race, opts) {
  if (!race || !race.mode) return null;
  const mode = race.mode;
  const karts = race.karts || [];
  const options = opts || {};

  if (mode === 'trial') {
    const k = karts[0];
    return {
      mode: 'trial',
      completedLaps: k && Array.isArray(k.lapTimes) ? k.lapTimes.length : 0,
    };
  }

  if (mode === 'ai') {
    const k = karts[0];
    return {
      mode: 'ai',
      completedLaps: k && Array.isArray(k.lapTimes) ? k.lapTimes.length : 0,
      humanFinished: !!(k && isRealFinish(k.finished, k.finishTime)),
    };
  }

  if (mode === 'online') {
    const idx = Number.isFinite(options.localIndex)
      ? options.localIndex
      : typeof race._onlineLocalIndex === 'number'
        ? race._onlineLocalIndex
        : 0;
    const k = karts[idx] || karts[0];
    return {
      mode: 'online',
      completedLaps: k && Array.isArray(k.lapTimes) ? k.lapTimes.length : 0,
      humanFinished: !!(k && isRealFinish(k.finished, k.finishTime)),
    };
  }

  if (mode === 'versus') {
    const k1 = karts[0];
    const k2 = karts[1];
    return {
      mode: 'versus',
      p1Finished: !!(k1 && isRealFinish(k1.finished, k1.finishTime)),
      p2Finished: !!(k2 && isRealFinish(k2.finished, k2.finishTime)),
      completedLaps:
        (k1 && Array.isArray(k1.lapTimes) ? k1.lapTimes.length : 0) +
        (k2 && Array.isArray(k2.lapTimes) ? k2.lapTimes.length : 0),
    };
  }

  if (mode === 'shootout') {
    return {
      mode: 'shootout',
      shootoutPlayerLap:
        race.shootoutPlayerLap == null ? null : race.shootoutPlayerLap,
      shootoutAiLap: race.shootoutAiLap == null ? null : race.shootoutAiLap,
    };
  }

  return { mode };
}
