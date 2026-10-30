/** Actual player-lap capture, shared by the browser and authoritative online server. */
const STATE_FIELDS = ['x','y','angle','speed','prevX','prevY','lap','nextCp','checkpointsBit','tyreId','tyreWear','tyreTemp','grip','maxSpeed','accel','brakeForce','turnRate','ersCharge','ersActive','_ersPower','_ersToggled','drsActive','drsAvailable','_drsToggled','_throttleAssist','_brakeAssist','_nearestSplineIdx','_penaltyTimer','_pitExiting','_onPitLane','inPit','pitPhase'];
function state(kart) {
  return Object.fromEntries(STATE_FIELDS.filter(key => kart[key] !== undefined).map(key => [key, kart[key]]));
}
function controls(input = {}) {
  const steer = Number.isFinite(input.steer) ? input.steer : (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const throttle = Number.isFinite(input.throttle) ? input.throttle : input.up ? 1 : 0;
  const brake = Number.isFinite(input.brake) ? input.brake : input.down ? 1 : 0;
  return [Math.max(-1, Math.min(1, steer)), Math.max(0, Math.min(1, throttle)), Math.max(0, Math.min(1, brake)), +!!input.ers, +!!input.drs];
}
function frame(k, time, input) {
  const [steer, throttle, brake, ers, drs] = controls(input);
  const flags = (throttle > .35 ? 1 : 0) | (brake > .35 ? 2 : 0) | (steer < -.25 ? 4 : 0) | (steer > .25 ? 8 : 0) | (ers ? 16 : 0) | (drs ? 32 : 0);
  return [Math.round(time), Math.round(k.x * 10), Math.round(k.y * 10), Math.round(k.angle * 1000), Math.round(k.speed * 10), flags, +!!k.isOffTrack, Math.round((k.ersCharge || 0) * 1000), +!!k.drsInZone, Math.round((k.grip || 1) * 1000), steer, throttle, brake];
}

export class PlayerLapRecorder {
  constructor() { this.active = null; this.count = null; this.stage = null; this.sequence = 0; }
  /** Returns one completed recording, or null. `time` and kart.lapStart use milliseconds. */
  observe({ kart, input = {}, time, stage = 'race', opponents = [] }) {
    const count = kart.lapTimes?.length || 0;
    if (this.stage !== stage || (this.count !== null && count < this.count)) {
      this.active = null; this.completedStart = null; this.count = count; this.stage = stage;
    }
    let completed = null;
    if (this.active && count > this.count) {
      const lapTime = Number(kart.lapTimes[count - 1]);
      if (Number.isFinite(lapTime) && lapTime > 0) {
        const a = this.active;
        a.frames.push(frame(kart, lapTime * 1000, input));
        completed = { lapIndex: ++this.sequence, stage, lapTime, lapKind: a.kind,
          frames: a.frames, sampleRateHz: a.sampleRate, initialState: a.initialState,
          controlEvents: a.controlEvents, stateCheckpoints: a.states, traffic: a.traffic,
          inputEncoding: 'timestamped-analog-controls-v1',
          frameFields: ['timeMs','x10','y10','angle1000','speed10','digitalFlags','offTrack','ers1000','drsInZone','grip1000','steer','throttle','brake'] };
      }
      this.completedStart = this.active.start;
      this.active = null;
    }
    this.count = count;
    if (kart.finished || kart._shootoutStowed || kart._qualiWaiting || kart.lapStart == null) return completed;
    if (this.completedStart === kart.lapStart) return completed;
    if (!this.active) {
      this.active = { start: kart.lapStart, frames: [frame(kart, 0, input)], sampleRate: 60,
        initialState: state(kart), controlEvents: [[0, ...controls(input)]], lastControls: JSON.stringify(controls(input)),
        states: [[0, state(kart)]], traffic: [], nextTraffic: 0, nextState: 1000,
        kind: count === 0 ? (kart._lapKind || (stage === 'qualifying' ? 'outlap' : 'standing')) : 'flying' };
    }
    const a = this.active, t = Math.max(0, time - a.start);
    const currentControls = controls(input), key = JSON.stringify(currentControls);
    if (key !== a.lastControls) { a.controlEvents.push([Math.round(t), ...currentControls]); a.lastControls = key; }
    if (t >= a.nextState) { a.states.push([Math.round(t), state(kart)]); a.nextState = t + 1000; }
    if (t >= a.nextTraffic) {
      if (opponents.length) a.traffic.push([Math.round(t), opponents.map(k => [k.id, k.x, k.y, k.angle, k.speed])]);
      a.nextTraffic = t + 100;
    }
    if (t - a.frames.at(-1)[0] >= 1000 / a.sampleRate - .5) {
      if (a.frames.length >= 12000) { a.frames = a.frames.filter((_, i) => i % 2 === 0); a.sampleRate /= 2; }
      a.frames.push(frame(kart, t, input));
    }
    return completed;
  }
}
