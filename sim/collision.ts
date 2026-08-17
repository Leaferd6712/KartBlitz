export type CollisionBody = {
  id: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  finished?: boolean;
};

/** Circle-circle kart contact (same rules as prior SimKart.update). */
export function resolveKartCollisions(karts: CollisionBody[], contactEnabled: boolean, maxSpdFallback = 200): void {
  if (!contactEnabled || !karts || karts.length < 2) return;
  const KART_R = 18;
  for (let i = 0; i < karts.length; i++) {
    const a = karts[i];
    if (a.finished) continue;
    for (let j = i + 1; j < karts.length; j++) {
      const b = karts[j];
      if (b.finished) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist < KART_R * 2 && dist > 0.1) {
        const pen = KART_R * 2 - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        const pushShare = 0.52;
        a.x += nx * pen * pushShare;
        a.y += ny * pen * pushShare;
        b.x -= nx * pen * pushShare;
        b.y -= ny * pen * pushShare;
        const relVx = a.speed * Math.cos(a.angle) - b.speed * Math.cos(b.angle);
        const relVy = a.speed * Math.sin(a.angle) - b.speed * Math.sin(b.angle);
        const relVn = relVx * nx + relVy * ny;
        if (relVn < 0) {
          const impulse = relVn * 0.7;
          a.speed -= impulse * (Math.cos(a.angle) * nx + Math.sin(a.angle) * ny);
          b.speed += impulse * (Math.cos(b.angle) * nx + Math.sin(b.angle) * ny);
          const cap = maxSpdFallback * 0.15;
          a.speed = Math.max(a.speed, -cap);
          b.speed = Math.max(b.speed, -cap);
        }
      }
    }
  }
}
