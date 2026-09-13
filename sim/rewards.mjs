/**
 * Pure race-result builders and coin reward calculator for KartBlitz.
 * Source of truth for offline reward formulas — keep index.html in sync via window.KartBlitzRewards.
 */

export const DIFF_MULT = {
  ultraeasy: 0.75,
  easy: 1.0,
  medium: 1.25,
  hard: 1.5,
  extreme: 2.0,
};

/** Place bonus for AI races (1-based position). */
export function aiPlaceBonus(position) {
  if (!Number.isFinite(position) || position < 1) return 0;
  if (position === 1) return 20;
  if (position === 2) return 12;
  if (position === 3) return 8;
  if (position === 4) return 4;
  return 2;
}

function numOrNull(v) {
  return v == null || !Number.isFinite(v) ? null : v;
}

function safeLaps(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function buildTrialResult({ trackId, trackName, bestLap, laps }) {
  return {
    mode: 'trial',
    trackId,
    trackName,
    bestLap: bestLap == null ? Infinity : bestLap,
    laps: safeLaps(laps),
    finished: false,
  };
}

export function buildAiResult({
  trackId,
  trackName,
  bestLap,
  total,
  laps,
  finished,
  position,
  fieldSize,
  aiDiff,
}) {
  return {
    mode: 'ai',
    trackId,
    trackName,
    bestLap: bestLap == null ? Infinity : bestLap,
    total: numOrNull(total),
    laps: safeLaps(laps),
    finished: !!finished,
    position: Number.isFinite(position) ? position : null,
    fieldSize: Number.isFinite(fieldSize) ? fieldSize : null,
    aiDiff: aiDiff || null,
  };
}

export function buildVersusResult({
  trackId,
  trackName,
  p1Best,
  p2Best,
  p1Total,
  p2Total,
  p1Laps,
  p2Laps,
  winner,
}) {
  const a = safeLaps(p1Laps);
  const b = safeLaps(p2Laps);
  return {
    mode: 'versus',
    trackId,
    trackName,
    p1Best: p1Best == null ? Infinity : p1Best,
    p2Best: p2Best == null ? Infinity : p2Best,
    p1Total: numOrNull(p1Total),
    p2Total: numOrNull(p2Total),
    p1Laps: a,
    p2Laps: b,
    laps: a + b,
    winner: winner === 0 || winner === 1 ? winner : null,
  };
}

export function buildShootoutResult({
  trackId,
  trackName,
  bestLap,
  aiLap,
  aiDiff,
  win,
}) {
  const lap = bestLap == null ? Infinity : bestLap;
  return {
    mode: 'shootout',
    trackId,
    trackName,
    bestLap: lap,
    aiLap: aiLap == null ? Infinity : aiLap,
    aiDiff: aiDiff || null,
    win: !!win,
    laps: 1,
    total: Number.isFinite(lap) ? lap : null,
  };
}

export function buildOnlineResult({
  trackId,
  trackName,
  bestLap,
  total,
  laps,
  position,
  fieldSize,
}) {
  return {
    mode: 'online',
    trackId,
    trackName,
    bestLap: bestLap == null ? Infinity : bestLap,
    total: numOrNull(total),
    laps: safeLaps(laps),
    position: Number.isFinite(position) ? position : null,
    fieldSize: Number.isFinite(fieldSize) ? fieldSize : null,
  };
}

/**
 * @param {object} result - typed result from builders
 * @param {{ targetLap?: number, coinMult?: number } | null} track
 * @returns {{ total: number, parts: { label: string, amount: number }[], base: number, mult: number, diffMult: number }}
 */
export function calculateRaceRewards(result, track) {
  const parts = [];
  const coinMult = track && Number.isFinite(track.coinMult) ? track.coinMult : 1.0;
  const diffMult =
    result && result.aiDiff && DIFF_MULT[result.aiDiff] != null
      ? DIFF_MULT[result.aiDiff]
      : 1.0;

  if (!result || result.mode === 'online') {
    return { total: 0, parts: [], base: 0, mult: coinMult, diffMult };
  }

  let base = 0;
  const mode = result.mode;

  if (mode === 'trial') {
    const laps = safeLaps(result.laps);
    if (laps > 0) {
      const amt = laps * 3;
      parts.push({ label: `${laps} lap${laps === 1 ? '' : 's'} × 3`, amount: amt });
      base += amt;
    }
    if (track && Number.isFinite(result.bestLap) && result.bestLap < track.targetLap) {
      parts.push({ label: 'Beat target lap', amount: 8 });
      base += 8;
    }
  } else if (mode === 'ai') {
    const laps = safeLaps(result.laps);
    if (laps > 0) {
      const amt = laps * 3;
      parts.push({ label: `${laps} lap${laps === 1 ? '' : 's'} × 3`, amount: amt });
      base += amt;
    }
    if (result.finished) {
      parts.push({ label: 'Finish bonus', amount: 10 });
      base += 10;
    }
    if (track && Number.isFinite(result.bestLap) && result.bestLap < track.targetLap) {
      parts.push({ label: 'Beat target lap', amount: 8 });
      base += 8;
    }
    const place = aiPlaceBonus(result.position);
    if (place > 0) {
      parts.push({ label: `Place P${result.position}`, amount: place });
      base += place;
    }
  } else if (mode === 'shootout') {
    parts.push({ label: 'Participation', amount: 8 });
    base += 8;
    if (result.win) {
      parts.push({ label: 'Win bonus', amount: 14 });
      base += 14;
    }
    if (Number.isFinite(result.bestLap) && result.bestLap < Infinity) {
      parts.push({ label: 'Valid lap', amount: 4 });
      base += 4;
    }
  } else if (mode === 'versus') {
    const laps = safeLaps(result.laps);
    if (laps > 0) {
      const amt = laps * 2;
      parts.push({ label: `${laps} lap${laps === 1 ? '' : 's'} × 2`, amount: amt });
      base += amt;
    }
    parts.push({ label: 'Participation', amount: 8 });
    base += 8;
  } else {
    // Unknown mode: no coins
    return { total: 0, parts: [], base: 0, mult: coinMult, diffMult };
  }

  const total = Math.round(base * coinMult * diffMult);
  return { total, parts, base, mult: coinMult, diffMult };
}

/**
 * Format reward breakdown HTML lines (base parts + multipliers + total).
 */
export function formatRewardBreakdown(reward) {
  if (!reward || !reward.total) return '';
  const lines = (reward.parts || [])
    .filter((p) => p.amount)
    .map(
      (p) =>
        `<div class="coins-part"><span>${escapeHtml(p.label)}</span><span>+${p.amount}</span></div>`
    );
  if (reward.mult !== 1 || reward.diffMult !== 1) {
    const bits = [];
    if (reward.mult !== 1) bits.push(`track ×${reward.mult}`);
    if (reward.diffMult !== 1) bits.push(`difficulty ×${reward.diffMult}`);
    lines.push(
      `<div class="coins-part coins-mult"><span>${escapeHtml(bits.join(' · '))}</span><span></span></div>`
    );
  }
  lines.push(
    `<div class="coins-earn">COINS +${reward.total} COINS EARNED!</div>`
  );
  return `<div class="coins-breakdown">${lines.join('')}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
