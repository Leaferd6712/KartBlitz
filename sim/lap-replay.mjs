/** Time-based replay helpers. Rendering never advances race physics or awards rewards. */
export function sampleLap(samples, time) {
  if (!samples?.length) return null;
  const t = Math.max(samples[0].t, Math.min(Number(time) || 0, samples.at(-1).t));
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (samples[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const a = samples[lo], b = samples[Math.min(lo + 1, samples.length - 1)];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const angle = Math.atan2(Math.sin(b.a - a.a), Math.cos(b.a - a.a));
  return { ...a, t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
    a: a.a + angle * f, speed: a.speed + (b.speed - a.speed) * f };
}

/** Project a click onto the recorded path, returning its corresponding replay time. */
export function nearestLapTime(samples, x, y) {
  let best = Infinity, time = samples[0]?.t || 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const distance = (x - a.x - dx * f) ** 2 + (y - a.y - dy * f) ** 2;
    if (distance < best) { best = distance; time = a.t + (b.t - a.t) * f; }
  }
  return time;
}

export function replayBounds(track, samples) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of [...(track.spline || []), ...samples]) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const pad = Math.max(60, (track.trackWidth || 160) * .65);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) };
}
