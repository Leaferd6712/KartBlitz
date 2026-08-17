/** Pure math helpers for online sim (from KartBlitz.html). */

export type Vec2 = { x: number; y: number };

export function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

export function buildSpline(wps: Vec2[], steps = 25): Vec2[] {
  const pts: Vec2[] = [];
  const n = wps.length;
  for (let i = 0; i < n; i++) {
    const p0 = wps[(i - 1 + n) % n];
    const p1 = wps[i];
    const p2 = wps[(i + 1) % n];
    const p3 = wps[(i + 2) % n];
    for (let s = 0; s < steps; s++) pts.push(catmullRom(p0, p1, p2, p3, s / steps));
  }
  return pts;
}

export function splineTangent(spl: Vec2[], idx: number): Vec2 {
  const n = spl.length;
  const a = spl[(idx - 1 + n) % n];
  const b = spl[(idx + 1) % n];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function linesCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  function cross(o: Vec2, a: Vec2, b: Vec2) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }
  const A = { x: ax, y: ay };
  const B = { x: bx, y: by };
  const C = { x: cx, y: cy };
  const D = { x: dx, y: dy };
  return cross(A, B, C) * cross(A, B, D) < 0 && cross(C, D, A) * cross(C, D, B) < 0;
}
