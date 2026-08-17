/**
 * Compact binary protocol for KartBlitz online snapshots & inputs.
 * Layout is mirrored in online-codec.js for the browser.
 */

import { ONLINE_PROTOCOL } from "../sim/constants";

export const NET_MAGIC = 0x4b42; // "KB"
/** Keep equal to ONLINE_PROTOCOL — single version for wire + lobby handshake. */
export const NET_VERSION = ONLINE_PROTOCOL;
export const MSG_INPUT = 1;
export const MSG_STATE = 2;

export const PHASE_COUNTDOWN = 0;
export const PHASE_LAUNCH = 1;
export const PHASE_RACING = 2;
export const PHASE_FINISHED = 3;

const PHASE_TO_ID: Record<string, number> = {
  countdown: PHASE_COUNTDOWN,
  launch: PHASE_LAUNCH,
  racing: PHASE_RACING,
  finished: PHASE_FINISHED,
};

const ID_TO_PHASE = ["countdown", "launch", "racing", "finished"];

export type NetInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  ers: boolean;
  drs: boolean;
  steer: number;
  throttle: number;
  brake: number;
};

export type NetKart = {
  id: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  lap: number;
  finished: boolean;
  finishTime: number | null;
  tyreId: string;
  tyreWear: number;
  tyreTemp: number;
  ersCharge: number;
  ersActive: boolean;
  drsActive: boolean;
  drsAvailable: boolean;
  pitPhase: string | null;
  inPit: boolean;
  checkpointsBit: number;
  _nearestSplineIdx: number;
  bestLap: number | null;
  maxSpeed: number;
  disconnected: boolean;
};

export type NetState = {
  type: "state";
  t: number;
  tick: number;
  phase: string;
  countdownVal: number;
  raceTimer: number;
  launchRPM: number[];
  karts: NetKart[];
  full?: boolean;
  /** Per-slot last processed input seq (u16). */
  lastProcessedInput?: number[];
};

const TYRE_IDS = ["soft", "med", "hard", "ints", "wet"];

function tyreToId(id: string | undefined): number {
  const i = TYRE_IDS.indexOf(id || "med");
  return i >= 0 ? i : 1;
}

function tyreFromId(id: number): string {
  return TYRE_IDS[id] || "med";
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

function quantAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return Math.max(0, Math.min(65535, Math.round((x / (Math.PI * 2)) * 65535)));
}

function dequantAngle(u: number): number {
  return (u / 65535) * Math.PI * 2;
}

/** Encode guest input (~10 bytes). */
export function encodeInput(input: NetInput, t: number, seq = 0): ArrayBuffer {
  const buf = new ArrayBuffer(12);
  const v = new DataView(buf);
  v.setUint16(0, NET_MAGIC, true);
  v.setUint8(2, NET_VERSION);
  v.setUint8(3, MSG_INPUT);
  let flags = 0;
  if (input.up) flags |= 1;
  if (input.down) flags |= 2;
  if (input.left) flags |= 4;
  if (input.right) flags |= 8;
  if (input.ers) flags |= 16;
  if (input.drs) flags |= 32;
  v.setUint8(4, flags);
  v.setInt8(5, Math.max(-127, Math.min(127, Math.round((input.steer || 0) * 127))));
  v.setUint8(6, clampByte(Math.round((input.throttle || 0) * 255)));
  v.setUint8(7, clampByte(Math.round((input.brake || 0) * 255)));
  v.setUint16(8, seq & 0xffff, true);
  v.setUint16(10, Math.max(0, Math.min(65535, Math.round(t % 65536))), true);
  return buf;
}

export function decodeInput(buf: ArrayBuffer | ArrayBufferView): { input: NetInput; t: number; seq: number } | null {
  const v = viewOf(buf);
  if (v.byteLength < 12) return null;
  if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION || v.getUint8(3) !== MSG_INPUT) {
    return null;
  }
  const flags = v.getUint8(4);
  const steer = v.getInt8(5) / 127;
  const throttle = v.getUint8(6) / 255;
  const brake = v.getUint8(7) / 255;
  return {
    input: {
      up: !!(flags & 1),
      down: !!(flags & 2),
      left: !!(flags & 4),
      right: !!(flags & 8),
      ers: !!(flags & 16),
      drs: !!(flags & 32),
      steer,
      throttle,
      brake,
    },
    seq: v.getUint16(8, true),
    t: v.getUint16(10, true),
  };
}

/**
 * Encode authoritative state. When prev is set, omit cold fields that did not change
 * (still sends hot pose every packet). full=true forces cold fields.
 */
export function encodeState(state: NetState, prev: NetState | null = null): ArrayBuffer {
  const karts = state.karts || [];
  const n = Math.min(6, karts.length);
  const full = !prev || !!state.full || (state.tick & 15) === 0;
  // header + launchRPM + lastProcessed + per kart
  const buf = new ArrayBuffer(24 + 6 + 12 + n * 56 + 8);
  const v = new DataView(buf);
  let o = 0;
  v.setUint16(o, NET_MAGIC, true);
  o += 2;
  v.setUint8(o++, NET_VERSION);
  v.setUint8(o++, MSG_STATE);
  v.setUint32(o, state.tick >>> 0, true);
  o += 4;
  v.setFloat64(o, state.t, true);
  o += 8;
  let hdrFlags = full ? 1 : 0;
  v.setUint8(o++, hdrFlags);
  v.setUint8(o++, PHASE_TO_ID[state.phase] ?? PHASE_RACING);
  v.setUint8(o++, clampByte(state.countdownVal | 0));
  v.setUint8(o++, n);
  v.setFloat32(o, state.raceTimer || 0, true);
  o += 4;

  // launch RPM packed as bytes
  for (let i = 0; i < 6; i++) {
    const rpm = (state.launchRPM && state.launchRPM[i]) || 0;
    v.setUint8(o++, clampByte(Math.round(rpm * 255)));
  }
  // last processed input seq per slot
  for (let i = 0; i < 6; i++) {
    const seq = (state.lastProcessedInput && state.lastProcessedInput[i]) || 0;
    v.setUint16(o, seq & 0xffff, true);
    o += 2;
  }

  for (let i = 0; i < n; i++) {
    const k = karts[i];
    const pk = prev && prev.karts && prev.karts[i];
    let mask = 0xff; // hot always
    // bit0 pose, bit1 gameplay cold, bit2 finish, bit3 tyre, bit4 flags-extra
    if (!full && pk) {
      mask = 0x01; // pose
      if (
        k.lap !== pk.lap ||
        k.checkpointsBit !== pk.checkpointsBit ||
        k._nearestSplineIdx !== pk._nearestSplineIdx ||
        Math.abs((k.ersCharge || 0) - (pk.ersCharge || 0)) > 0.02 ||
        Math.abs((k.tyreWear || 0) - (pk.tyreWear || 0)) > 0.01 ||
        Math.abs((k.tyreTemp || 0) - (pk.tyreTemp || 0)) > 1.5 ||
        k.tyreId !== pk.tyreId ||
        !!k.finished !== !!pk.finished ||
        k.bestLap !== pk.bestLap ||
        Math.abs((k.maxSpeed || 0) - (pk.maxSpeed || 0)) > 1
      ) {
        mask |= 0x02;
      }
      if (!!k.finished !== !!pk.finished || k.finishTime !== pk.finishTime) mask |= 0x04;
    } else {
      mask = 0x07;
    }
    v.setUint8(o++, mask);
    let flags = 0;
    if (k.ersActive) flags |= 1;
    if (k.drsActive) flags |= 2;
    if (k.drsAvailable) flags |= 4;
    if (k.finished) flags |= 8;
    if (k.inPit) flags |= 16;
    if (k.disconnected) flags |= 32;
    v.setUint8(o++, flags);
    v.setInt32(o, Math.round(k.x * 100), true);
    o += 4;
    v.setInt32(o, Math.round(k.y * 100), true);
    o += 4;
    v.setUint16(o, quantAngle(k.angle || 0), true);
    o += 2;
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((k.speed || 0) * 10))), true);
    o += 2;

    if (mask & 0x02) {
      v.setUint8(o++, clampByte(k.lap || 0));
      v.setUint8(o++, tyreToId(k.tyreId));
      v.setUint8(o++, clampByte(Math.round((k.tyreWear || 0) * 255)));
      v.setUint8(o++, clampByte(Math.round(k.tyreTemp || 0)));
      v.setUint8(o++, clampByte(Math.round((k.ersCharge || 0) * 255)));
      v.setUint16(o, (k.checkpointsBit || 0) & 0xffff, true);
      o += 2;
      v.setUint16(o, (k._nearestSplineIdx || 0) & 0xffff, true);
      o += 2;
      v.setUint16(o, Math.max(0, Math.min(65535, Math.round(k.maxSpeed || 0))), true);
      o += 2;
      const best = k.bestLap != null && isFinite(k.bestLap) ? k.bestLap : 0;
      v.setFloat32(o, best, true);
      o += 4;
      const hasBest = k.bestLap != null && isFinite(k.bestLap) ? 1 : 0;
      v.setUint8(o++, hasBest);
    }
    if (mask & 0x04) {
      v.setFloat32(o, k.finishTime == null ? -1 : k.finishTime, true);
      o += 4;
    }
  }

  return buf.slice(0, o);
}

export function decodeState(buf: ArrayBuffer | ArrayBufferView, prev: NetState | null = null): NetState | null {
  const v = viewOf(buf);
  if (v.byteLength < 24) return null;
  if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION || v.getUint8(3) !== MSG_STATE) {
    return null;
  }
  let o = 4;
  const tick = v.getUint32(o, true);
  o += 4;
  const t = v.getFloat64(o, true);
  o += 8;
  const hdrFlags = v.getUint8(o++);
  const phase = ID_TO_PHASE[v.getUint8(o++)] || "racing";
  const countdownVal = v.getUint8(o++);
  const n = v.getUint8(o++);
  const raceTimer = v.getFloat32(o, true);
  o += 4;
  const launchRPM: number[] = [];
  for (let i = 0; i < 6; i++) launchRPM.push(v.getUint8(o++) / 255);
  const lastProcessedInput: number[] = [];
  for (let i = 0; i < 6; i++) {
    lastProcessedInput.push(v.getUint16(o, true));
    o += 2;
  }

  const karts: NetKart[] = [];
  for (let i = 0; i < n; i++) {
    const pk = (prev && prev.karts && prev.karts[i]) || null;
    const mask = v.getUint8(o++);
    const flags = v.getUint8(o++);
    const x = v.getInt32(o, true) / 100;
    o += 4;
    const y = v.getInt32(o, true) / 100;
    o += 4;
    const angle = dequantAngle(v.getUint16(o, true));
    o += 2;
    const speed = v.getInt16(o, true) / 10;
    o += 2;

    let lap = pk ? pk.lap : 0;
    let tyreId = pk ? pk.tyreId : "med";
    let tyreWear = pk ? pk.tyreWear : 0;
    let tyreTemp = pk ? pk.tyreTemp : 55;
    let ersCharge = pk ? pk.ersCharge : 1;
    let checkpointsBit = pk ? pk.checkpointsBit : 0;
    let nearest = pk ? pk._nearestSplineIdx : 0;
    let maxSpeed = pk ? pk.maxSpeed : 0;
    let bestLap: number | null = pk ? pk.bestLap : null;
    let finishTime: number | null = pk ? pk.finishTime : null;

    if (mask & 0x02) {
      lap = v.getUint8(o++);
      tyreId = tyreFromId(v.getUint8(o++));
      tyreWear = v.getUint8(o++) / 255;
      tyreTemp = v.getUint8(o++);
      ersCharge = v.getUint8(o++) / 255;
      checkpointsBit = v.getUint16(o, true);
      o += 2;
      nearest = v.getUint16(o, true);
      o += 2;
      maxSpeed = v.getUint16(o, true);
      o += 2;
      const best = v.getFloat32(o, true);
      o += 4;
      const hasBest = v.getUint8(o++);
      bestLap = hasBest ? best : null;
    }
    if (mask & 0x04) {
      const ft = v.getFloat32(o, true);
      o += 4;
      finishTime = ft < 0 ? null : ft;
    }

    karts.push({
      id: i,
      x,
      y,
      angle,
      speed,
      lap,
      finished: !!(flags & 8),
      finishTime,
      tyreId,
      tyreWear,
      tyreTemp,
      ersCharge,
      ersActive: !!(flags & 1),
      drsActive: !!(flags & 2),
      drsAvailable: !!(flags & 4),
      pitPhase: null,
      inPit: !!(flags & 16),
      checkpointsBit,
      _nearestSplineIdx: nearest,
      bestLap,
      maxSpeed,
      disconnected: !!(flags & 32),
    });
  }

  return {
    type: "state",
    t,
    tick,
    phase,
    countdownVal,
    raceTimer,
    launchRPM: launchRPM.slice(0, Math.max(n, 2)),
    karts,
    full: !!(hdrFlags & 1),
    lastProcessedInput: lastProcessedInput.slice(0, n),
  };
}

export function isBinaryNetMessage(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data as ArrayBufferView);
}

function viewOf(buf: ArrayBuffer | ArrayBufferView): DataView {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}
