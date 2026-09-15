/**
 * Speed-feel tuners: visual/audio mapping only — never mutates vehicle physics.
 */
import assert from "assert";
import {
  SPEED_FEEL,
  speedRatio,
  targetZoom,
  shakeAmp,
  streakIntensity,
  sprayIntensity,
  camLookNudge,
  engineVoice,
  isPeripheral,
  pickPeripheralPoint,
  createSlot,
  resetSlot,
  tickDynamics,
  tickStreaks,
  countActiveStreaks,
} from "../speed-feel.mjs";

{
  const kart = { speed: 180, maxSpeed: 360, accel: 99 };
  const r = speedRatio(kart.speed, kart.maxSpeed);
  assert.ok(Math.abs(r - 0.5) < 1e-9);
  assert.strictEqual(kart.speed, 180);
  assert.strictEqual(kart.maxSpeed, 360);
  assert.strictEqual(kart.accel, 99);
  console.log("ok speedRatio does not mutate physics");
}

{
  const rest = targetZoom(0, false);
  const mid = targetZoom(0.55, false);
  const high = targetZoom(1, false);
  assert.ok(Math.abs(rest - SPEED_FEEL.fov.baseZoom) < 0.002, `rest zoom ${rest}`);
  assert.ok(high < rest, `FOV should widen (zoom out) with speed: rest=${rest} high=${high}`);
  assert.ok(mid < rest && mid > high, `mid zoom should sit between rest and high: ${mid}`);
  assert.strictEqual(targetZoom(1, true), SPEED_FEEL.fov.baseZoom);
  console.log("ok FOV zoom mapping");
}

{
  assert.strictEqual(shakeAmp(0.5, true, 1), 0);
  const hi = shakeAmp(1.05, true, 1);
  assert.ok(hi > 0 && hi <= SPEED_FEEL.shake.maxPx + 1e-6, `shake ${hi}`);
  assert.strictEqual(shakeAmp(1.2, false, 1), 0);
  assert.ok(shakeAmp(1.05, true, 0.6) < hi);
  console.log("ok restrained shake");
}

{
  assert.ok(streakIntensity(0.1, false) < 0.01);
  assert.ok(streakIntensity(1, false) > 0.9);
  assert.strictEqual(streakIntensity(1, true), 0);
  assert.strictEqual(sprayIntensity(1, true), 0);
  assert.ok(sprayIntensity(0.9, false) > 0.5);
  console.log("ok streak/spray intensity + reduced motion");
}

{
  assert.ok(camLookNudge(true, false, false) > 0);
  assert.ok(camLookNudge(false, true, false) < 0);
  assert.strictEqual(camLookNudge(true, false, true), 0);
  console.log("ok accel/brake camera nudge signs");
}

{
  const idle = engineVoice({ speedRatio: 0, throttle: false, braking: false });
  const mid = engineVoice({ speedRatio: 0.5, throttle: true, braking: false });
  const red = engineVoice({ speedRatio: 1, throttle: true, braking: false });
  assert.ok(red.hz > idle.hz * 1.8, `pitch span idle=${idle.hz} red=${red.hz}`);
  assert.ok(red.filter > idle.filter);
  assert.ok(mid.hz > idle.hz);
  assert.ok(red.hz <= SPEED_FEEL.engine.maxHz);
  console.log("ok engine pitch progression");
}

{
  const w = 800, h = 450;
  assert.strictEqual(isPeripheral(w / 2, h / 2, w, h, 0.56), false);
  assert.strictEqual(isPeripheral(4, 4, w, h, 0.56), true);
  let rngI = 0;
  const seq = [0.01, 0.02, 0.5, 0.5, 0.99, 0.01];
  const rng = () => seq[rngI++ % seq.length];
  for (let i = 0; i < 12; i++) {
    const p = pickPeripheralPoint(w, h, 0.56, rng);
    assert.ok(isPeripheral(p.x, p.y, w, h, 0.56), `point ${p.x},${p.y} not peripheral`);
  }
  console.log("ok peripheral streak spawn");
}

{
  const slot = createSlot();
  const kart = { speed: 0, maxSpeed: 300 };
  tickDynamics(slot, { dt: 1 / 60, speed: kart.speed, maxSpeed: kart.maxSpeed, reducedMotion: false, shakeAllowed: true });
  assert.strictEqual(kart.speed, 0);
  tickDynamics(slot, {
    dt: 1 / 60,
    speed: 280,
    maxSpeed: 300,
    throttle: true,
    brake: false,
    reducedMotion: false,
    shakeAllowed: true,
    shakeMul: 1,
  });
  assert.ok(slot.lookNudge > 0);
  for (let i = 0; i < 45; i++) {
    tickStreaks(slot, {
      dt: 1 / 60,
      speed: 280,
      maxSpeed: 300,
      angle: 0.3,
      viewW: 1280,
      viewH: 720,
      reducedMotion: false,
      trailLines: 10,
      speedLineAlpha: 0.45,
      rng: () => (i * 0.17) % 1,
    });
  }
  const n = countActiveStreaks(slot);
  assert.ok(n > 0 && n <= SPEED_FEEL.streaks.poolSize, `streaks ${n}`);
  resetSlot(slot);
  assert.strictEqual(countActiveStreaks(slot), 0);
  assert.ok(Math.abs(slot.zoom - SPEED_FEEL.fov.baseZoom) < 0.02);
  assert.strictEqual(slot.shakeX, 0);
  console.log("ok slot tick + reset + pool cap");
}

{
  const slot = createSlot();
  tickDynamics(slot, { dt: 0.2, speed: 400, maxSpeed: 300, reducedMotion: true, shakeAllowed: false });
  assert.ok(Math.abs(slot.zoom - SPEED_FEEL.fov.baseZoom) < 0.05);
  tickStreaks(slot, {
    dt: 0.2, speed: 400, maxSpeed: 300, viewW: 800, viewH: 450, reducedMotion: true, trailLines: 10,
  });
  assert.strictEqual(countActiveStreaks(slot), 0);
  console.log("ok reduced-motion freezes FOV and kills streaks");
}

console.log("speed-feel tests: OK");
