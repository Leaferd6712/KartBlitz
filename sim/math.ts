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

/** Local bend strength at a spline index (same cross-product style as AI curvature). */
export function localSplineCurvature(spl: Vec2[], idx: number, span = 5): number {
  const n = spl.length;
  if (!spl || n < 8) return 0;
  const i = ((idx % n) + n) % n;
  const a = spl[(i - span + n) % n];
  const b = spl[i];
  const c = spl[(i + span) % n];
  const dx1 = b.x - a.x;
  const dy1 = b.y - a.y;
  const dx2 = c.x - b.x;
  const dy2 = c.y - b.y;
  const l1 = Math.hypot(dx1, dy1) || 1;
  const l2 = Math.hypot(dx2, dy2) || 1;
  return Math.abs((dx1 / l1) * (dy2 / l2) - (dy1 / l1) * (dx2 / l2));
}

export type CornerCutKart = {
  speed: number;
  _cornerCutLatched?: boolean;
};

/**
 * When off asphalt near a corner: one facing-preserving speed snap, then hard drag.
 * Removes cut advantage without spinning the kart around.
 */
export function applyCornerCutSlowdown(
  kart: CornerCutKart,
  opts: { offTrack: boolean; curvature: number; dt: number }
): { snapped: boolean; active: boolean } {
  const CORNER_THRESH = 0.10;
  const MIN_SNAP_SPEED = 90;
  const HOLD_CAP = 125;
  const dt = Math.max(0, opts.dt || 0);
  const active =
    !!opts.offTrack &&
    (opts.curvature || 0) >= CORNER_THRESH &&
    Math.abs(kart.speed) > 35;

  if (!active) {
    kart._cornerCutLatched = false;
    return { snapped: false, active: false };
  }

  let snapped = false;
  if (!kart._cornerCutLatched && Math.abs(kart.speed) >= MIN_SNAP_SPEED) {
    kart.speed *= 0.55;
    kart._cornerCutLatched = true;
    snapped = true;
  }

  // Sustained scrub while still cutting — heavier than normal grass drag
  kart.speed *= Math.pow(0.935, dt * 60);
  if (Math.abs(kart.speed) > HOLD_CAP) {
    const over = Math.abs(kart.speed) - HOLD_CAP;
    const sign = kart.speed >= 0 ? 1 : -1;
    kart.speed -= sign * Math.min(over, Math.max(over * 3.4 * dt, 24 * dt));
  }
  return { snapped, active: true };
}
