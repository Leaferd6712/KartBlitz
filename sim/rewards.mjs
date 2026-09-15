/**
 * Pure race-result builders and coin reward calculator for KartBlitz.
 * Racing is the primary progression path; ads are a small optional boost.
 *
 * Target pacing (approx, AI medium on 1.0× track):
 *   first upgrade (~160)     ~1–2 solid races
 *   early branch (~700)      ~25–40 min racing
 *   first paid unlock (200)  shortly after early upgrades
 *   mid-tree (~2k)           a few hours mixed play
 *   full programme (~3915)   many sessions — not ad-farmable
 */

export const DIFF_MULT = {
  ultraeasy: 0.8,
  easy: 1.0,
  medium: 1.2,
  hard: 1.45,
  extreme: 1.75,
};

/** Place bonus for AI races (1-based). Soft floor so weaker finishes still pay. */
export function aiPlaceBonus(position) {
  if (!Number.isFinite(position) || position < 1) return 0;
  if (position === 1) return 50;
  if (position === 2) return 32;
  if (position === 3) return 20;
  if (position === 4) return 12;
  return 6;
}

/** Rewarded ad economy — optional boost, not the main path. */
export const AD_REWARD_COINS = 18;
export const AD_COOLDOWN_MS = 210000; // 3.5 minutes

/** Trial soft-cap: full pay for first N laps, then reduced (anti-farm). */
export const TRIAL_FULL_LAP_PAY = 6;
export const TRIAL_LAP_FULL = 10;
export const TRIAL_LAP_REDUCED = 4;
export const TRIAL_SESSION_BASE = 15;
export const PB_IMPROVE_BONUS = 28;

function numOrNull(v) {
  return v == null || !Number.isFinite(v) ? null : v;
}

function safeLaps(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function buildTrialResult({
  trackId,
  trackName,
  bestLap,
  laps,
  pbImproved,
  medalRewards,
  cleanRace,
}) {
  return {
    mode: 'trial',
    trackId,
    trackName,
    bestLap: bestLap == null ? Infinity : bestLap,
    laps: safeLaps(laps),
    finished: false,
    pbImproved: !!pbImproved,
    medalRewards: Array.isArray(medalRewards) ? medalRewards.slice() : [],
    cleanRace: !!cleanRace,
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
  pbImproved,
  cleanRace,
  medalRewards,
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
    pbImproved: !!pbImproved,
    cleanRace: !!cleanRace,
    medalRewards: Array.isArray(medalRewards) ? medalRewards.slice() : [],
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

function trialLapPay(laps) {
  const n = safeLaps(laps);
  if (n <= 0) return { amount: 0, label: null };
  const full = Math.min(n, TRIAL_FULL_LAP_PAY);
  const extra = Math.max(0, n - TRIAL_FULL_LAP_PAY);
  const amount = full * TRIAL_LAP_FULL + extra * TRIAL_LAP_REDUCED;
  const label = extra > 0
    ? `${full} laps × ${TRIAL_LAP_FULL} + ${extra} × ${TRIAL_LAP_REDUCED}`
    : `${n} lap${n === 1 ? '' : 's'} × ${TRIAL_LAP_FULL}`;
  return { amount, label };
}

/**
 * @returns {{
 *   total: number,
 *   parts: { label: string, amount: number, group?: string }[],
 *   base: number,
 *   mult: number,
 *   diffMult: number,
 *   groups: { race: number, medals: number, bonus: number }
 * }}
 */
export function calculateRaceRewards(result, track) {
  const parts = [];
  const groups = { race: 0, medals: 0, bonus: 0 };
  const coinMult = track && Number.isFinite(track.coinMult) ? track.coinMult : 1.0;
  const diffMult =
    result && result.aiDiff && DIFF_MULT[result.aiDiff] != null
      ? DIFF_MULT[result.aiDiff]
      : 1.0;

  if (!result || result.mode === 'online') {
    return { total: 0, parts: [], base: 0, mult: coinMult, diffMult, groups };
  }

  let base = 0;
  const mode = result.mode;

  const push = (label, amount, group = 'race') => {
    if (!amount) return;
    parts.push({ label, amount, group });
    base += amount;
    groups[group] = (groups[group] || 0) + amount;
  };

  if (mode === 'trial') {
    const lapPay = trialLapPay(result.laps);
    if (lapPay.amount > 0) push(lapPay.label, lapPay.amount, 'race');
    if (safeLaps(result.laps) >= 1) push('Session bonus', TRIAL_SESSION_BASE, 'race');
    if (result.pbImproved) push('Personal best', PB_IMPROVE_BONUS, 'bonus');
    if (result.cleanRace) push('Clean racing', 12, 'bonus');
    if (Array.isArray(result.medalRewards)) {
      for (const mr of result.medalRewards) {
        if (!mr || !mr.amount) continue;
        push(mr.label || 'Medal', mr.amount, 'medals');
      }
    }
  } else if (mode === 'ai') {
    const laps = safeLaps(result.laps);
    if (laps > 0) push(`${laps} lap${laps === 1 ? '' : 's'} × 8`, laps * 8, 'race');
    if (result.finished) push('Finish bonus', 28, 'race');
    const place = aiPlaceBonus(result.position);
    if (place > 0) push(`Place P${result.position}`, place, 'race');
    if (result.pbImproved) push('Personal best', PB_IMPROVE_BONUS, 'bonus');
    if (result.cleanRace) push('Clean racing', 15, 'bonus');
    if (Array.isArray(result.medalRewards)) {
      for (const mr of result.medalRewards) {
        if (!mr || !mr.amount) continue;
        push(mr.label || 'Medal', mr.amount, 'medals');
      }
    }
  } else if (mode === 'shootout') {
    push('Participation', 18, 'race');
    if (result.win) push('Win bonus', 40, 'race');
    if (Number.isFinite(result.bestLap) && result.bestLap < Infinity) {
      push('Valid lap', 12, 'race');
    }
  } else if (mode === 'versus') {
    const laps = safeLaps(result.laps);
    if (laps > 0) push(`${laps} lap${laps === 1 ? '' : 's'} × 5`, laps * 5, 'race');
    push('Participation', 18, 'race');
    if (result.winner === 0 || result.winner === 1) {
      push('Winner bonus', 20, 'bonus');
    }
  } else {
    return { total: 0, parts: [], base: 0, mult: coinMult, diffMult, groups };
  }

  // Track/difficulty multipliers apply to race+bonus groups, not first-time medal grants.
  const scalable = groups.race + groups.bonus;
  const scaled = Math.round(scalable * coinMult * diffMult);
  const total = scaled + groups.medals;
  return { total, parts, base, mult: coinMult, diffMult, groups };
}

/**
 * Format reward breakdown with separate source groups.
 */
export function formatRewardBreakdown(reward) {
  if (!reward || !reward.total) return '';
  const byGroup = { race: [], bonus: [], medals: [] };
  for (const p of reward.parts || []) {
    if (!p.amount) continue;
    const g = byGroup[p.group] ? p.group : 'race';
    byGroup[g].push(p);
  }

  const sections = [];
  const renderGroup = (title, list) => {
    if (!list.length) return;
    const lines = list.map(
      (p) =>
        `<div class="coins-part"><span>${escapeHtml(p.label)}</span><span>+${p.amount}</span></div>`
    );
    sections.push(
      `<div class="coins-group"><div class="coins-group-title">${escapeHtml(title)}</div>${lines.join('')}</div>`
    );
  };

  renderGroup('RACE', byGroup.race);
  renderGroup('BONUSES', byGroup.bonus);
  renderGroup('MEDALS', byGroup.medals);

  if (reward.mult !== 1 || reward.diffMult !== 1) {
    const bits = [];
    if (reward.mult !== 1) bits.push(`track ×${reward.mult}`);
    if (reward.diffMult !== 1) bits.push(`difficulty ×${reward.diffMult}`);
    sections.push(
      `<div class="coins-part coins-mult"><span>${escapeHtml(bits.join(' · '))} on race/bonus</span><span></span></div>`
    );
  }
  sections.push(`<div class="coins-earn">COINS +${reward.total} COINS EARNED!</div>`);
  return `<div class="coins-breakdown">${sections.join('')}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  DIFF_MULT,
  aiPlaceBonus,
  AD_REWARD_COINS,
  AD_COOLDOWN_MS,
  TRIAL_FULL_LAP_PAY,
  TRIAL_LAP_FULL,
  TRIAL_LAP_REDUCED,
  TRIAL_SESSION_BASE,
  PB_IMPROVE_BONUS,
  buildTrialResult,
  buildAiResult,
  buildVersusResult,
  buildShootoutResult,
  buildOnlineResult,
  calculateRaceRewards,
  formatRewardBreakdown,
};
