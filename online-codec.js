/**
 * Browser mirror of party/netcodec.ts — keep layouts in sync.
 */
(function (global) {
  'use strict';

  var NET_MAGIC = 0x4b42;
  var NET_VERSION = 4;
  var MSG_INPUT = 1;
  var MSG_STATE = 2;
  var PHASE_TO_ID = { countdown: 0, launch: 1, racing: 2, finished: 3 };
  var ID_TO_PHASE = ['countdown', 'launch', 'racing', 'finished'];
  var TYRE_IDS = ['soft', 'med', 'hard', 'ints', 'wet'];

  function tyreToId(id) {
    var i = TYRE_IDS.indexOf(id || 'med');
    return i >= 0 ? i : 1;
  }
  function tyreFromId(id) {
    return TYRE_IDS[id] || 'med';
  }
  function clampByte(n) {
    return Math.max(0, Math.min(255, n | 0));
  }
  function quantAngle(a) {
    var x = a % (Math.PI * 2);
    if (x < 0) x += Math.PI * 2;
    return Math.max(0, Math.min(65535, Math.round((x / (Math.PI * 2)) * 65535)));
  }
  function dequantAngle(u) {
    return (u / 65535) * Math.PI * 2;
  }
  function viewOf(buf) {
    if (buf instanceof ArrayBuffer) return new DataView(buf);
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function encodeInput(input, t, seq) {
    input = input || {};
    var buf = new ArrayBuffer(12);
    var v = new DataView(buf);
    v.setUint16(0, NET_MAGIC, true);
    v.setUint8(2, NET_VERSION);
    v.setUint8(3, MSG_INPUT);
    var flags = 0;
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
    v.setUint16(8, (seq || 0) & 0xffff, true);
    v.setUint16(10, Math.max(0, Math.min(65535, Math.round((t || 0) % 65536))), true);
    return buf;
  }

  function decodeInput(buf) {
    var v = viewOf(buf);
    if (v.byteLength < 12) return null;
    if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION || v.getUint8(3) !== MSG_INPUT) return null;
    var flags = v.getUint8(4);
    return {
      input: {
        up: !!(flags & 1),
        down: !!(flags & 2),
        left: !!(flags & 4),
        right: !!(flags & 8),
        ers: !!(flags & 16),
        drs: !!(flags & 32),
        steer: v.getInt8(5) / 127,
        throttle: v.getUint8(6) / 255,
        brake: v.getUint8(7) / 255
      },
      seq: v.getUint16(8, true),
      t: v.getUint16(10, true)
    };
  }

  function encodeState(state, prev) {
    var karts = state.karts || [];
    var n = Math.min(6, karts.length);
    var full = !prev || !!state.full || (state.tick & 15) === 0;
    var buf = new ArrayBuffer(24 + 6 + 12 + n * 56 + 8);
    var v = new DataView(buf);
    var o = 0;
    v.setUint16(o, NET_MAGIC, true); o += 2;
    v.setUint8(o++, NET_VERSION);
    v.setUint8(o++, MSG_STATE);
    v.setUint32(o, state.tick >>> 0, true); o += 4;
    v.setFloat64(o, state.t, true); o += 8;
    v.setUint8(o++, full ? 1 : 0);
    v.setUint8(o++, PHASE_TO_ID[state.phase] != null ? PHASE_TO_ID[state.phase] : 2);
    v.setUint8(o++, clampByte(state.countdownVal | 0));
    v.setUint8(o++, n);
    v.setFloat32(o, state.raceTimer || 0, true); o += 4;
    var i;
    for (i = 0; i < 6; i++) {
      var rpm = (state.launchRPM && state.launchRPM[i]) || 0;
      v.setUint8(o++, clampByte(Math.round(rpm * 255)));
    }
    for (i = 0; i < 6; i++) {
      var seq = (state.lastProcessedInput && state.lastProcessedInput[i]) || 0;
      v.setUint16(o, seq & 0xffff, true); o += 2;
    }
    for (i = 0; i < n; i++) {
      var k = karts[i];
      var pk = prev && prev.karts && prev.karts[i];
      var mask = 0x07;
      if (!full && pk) {
        mask = 0x01;
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
        ) mask |= 0x02;
        if (!!k.finished !== !!pk.finished || k.finishTime !== pk.finishTime || k.finishOrder !== pk.finishOrder) mask |= 0x04;
      }
      v.setUint8(o++, mask);
      var flags = 0;
      if (k.ersActive) flags |= 1;
      if (k.drsActive) flags |= 2;
      if (k.drsAvailable) flags |= 4;
      if (k.finished) flags |= 8;
      if (k.inPit) flags |= 16;
      if (k.disconnected) flags |= 32;
      v.setUint8(o++, flags);
      v.setInt32(o, Math.round(k.x * 100), true); o += 4;
      v.setInt32(o, Math.round(k.y * 100), true); o += 4;
      v.setUint16(o, quantAngle(k.angle || 0), true); o += 2;
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((k.speed || 0) * 10))), true); o += 2;
      if (mask & 0x02) {
        v.setUint8(o++, clampByte(k.lap || 0));
        v.setUint8(o++, tyreToId(k.tyreId));
        v.setUint8(o++, clampByte(Math.round((k.tyreWear || 0) * 255)));
        v.setUint8(o++, clampByte(Math.round(k.tyreTemp || 0)));
        v.setUint8(o++, clampByte(Math.round((k.ersCharge || 0) * 255)));
        v.setUint16(o, (k.checkpointsBit || 0) & 0xffff, true); o += 2;
        v.setUint16(o, (k._nearestSplineIdx || 0) & 0xffff, true); o += 2;
        v.setUint16(o, Math.max(0, Math.min(65535, Math.round(k.maxSpeed || 0))), true); o += 2;
        var best = k.bestLap != null && isFinite(k.bestLap) ? k.bestLap : 0;
        v.setFloat32(o, best, true); o += 4;
        v.setUint8(o++, k.bestLap != null && isFinite(k.bestLap) ? 1 : 0);
      }
      if (mask & 0x04) {
        v.setFloat32(o, k.finishTime == null ? -1 : k.finishTime, true); o += 4;
        v.setUint8(o++, k.finishOrder == null ? 0 : Math.min(255, k.finishOrder | 0));
      }
    }
    return buf.slice(0, o);
  }

  function decodeState(buf, prev) {
    var v = viewOf(buf);
    if (v.byteLength < 24) return null;
    if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION || v.getUint8(3) !== MSG_STATE) return null;
    var o = 4;
    var tick = v.getUint32(o, true); o += 4;
    var t = v.getFloat64(o, true); o += 8;
    var hdrFlags = v.getUint8(o++);
    var phase = ID_TO_PHASE[v.getUint8(o++)] || 'racing';
    var countdownVal = v.getUint8(o++);
    var n = v.getUint8(o++);
    var raceTimer = v.getFloat32(o, true); o += 4;
    var launchRPM = [];
    var i;
    for (i = 0; i < 6; i++) launchRPM.push(v.getUint8(o++) / 255);
    var lastProcessedInput = [];
    for (i = 0; i < 6; i++) {
      lastProcessedInput.push(v.getUint16(o, true));
      o += 2;
    }
    var karts = [];
    for (i = 0; i < n; i++) {
      var pk = (prev && prev.karts && prev.karts[i]) || null;
      var mask = v.getUint8(o++);
      var flags = v.getUint8(o++);
      var x = v.getInt32(o, true) / 100; o += 4;
      var y = v.getInt32(o, true) / 100; o += 4;
      var angle = dequantAngle(v.getUint16(o, true)); o += 2;
      var speed = v.getInt16(o, true) / 10; o += 2;
      var lap = pk ? pk.lap : 0;
      var tyreId = pk ? pk.tyreId : 'med';
      var tyreWear = pk ? pk.tyreWear : 0;
      var tyreTemp = pk ? pk.tyreTemp : 55;
      var ersCharge = pk ? pk.ersCharge : 1;
      var checkpointsBit = pk ? pk.checkpointsBit : 0;
      var nearest = pk ? pk._nearestSplineIdx : 0;
      var maxSpeed = pk ? pk.maxSpeed : 0;
      var bestLap = pk ? pk.bestLap : null;
      var finishTime = pk ? pk.finishTime : null;
      var finishOrder = pk ? pk.finishOrder : null;
      if (mask & 0x02) {
        lap = v.getUint8(o++);
        tyreId = tyreFromId(v.getUint8(o++));
        tyreWear = v.getUint8(o++) / 255;
        tyreTemp = v.getUint8(o++);
        ersCharge = v.getUint8(o++) / 255;
        checkpointsBit = v.getUint16(o, true); o += 2;
        nearest = v.getUint16(o, true); o += 2;
        maxSpeed = v.getUint16(o, true); o += 2;
        var best = v.getFloat32(o, true); o += 4;
        var hasBest = v.getUint8(o++);
        bestLap = hasBest ? best : null;
      }
      if (mask & 0x04) {
        var ft = v.getFloat32(o, true); o += 4;
        finishTime = ft < 0 ? null : ft;
        var fo = v.getUint8(o++);
        finishOrder = fo > 0 ? fo : null;
      }
      karts.push({
        id: i, x: x, y: y, angle: angle, speed: speed, lap: lap,
        finished: !!(flags & 8), finishTime: finishTime, finishOrder: finishOrder, tyreId: tyreId, tyreWear: tyreWear,
        tyreTemp: tyreTemp,
        ersCharge: ersCharge, ersActive: !!(flags & 1), drsActive: !!(flags & 2),
        drsAvailable: !!(flags & 4), pitPhase: null, inPit: !!(flags & 16),
        checkpointsBit: checkpointsBit, _nearestSplineIdx: nearest, bestLap: bestLap,
        maxSpeed: maxSpeed, disconnected: !!(flags & 32)
      });
    }
    return {
      type: 'state', t: t, tick: tick, phase: phase, countdownVal: countdownVal,
      raceTimer: raceTimer, launchRPM: launchRPM.slice(0, Math.max(n, 2)), karts: karts,
      full: !!(hdrFlags & 1),
      lastProcessedInput: lastProcessedInput.slice(0, n)
    };
  }

  function peekMsgType(buf) {
    try {
      var v = viewOf(buf);
      if (v.byteLength < 4) return 0;
      if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION) return 0;
      return v.getUint8(3);
    } catch (e) {
      return 0;
    }
  }

  global.OnlineCodec = {
    NET_MAGIC: NET_MAGIC,
    NET_VERSION: NET_VERSION,
    MSG_INPUT: MSG_INPUT,
    MSG_STATE: MSG_STATE,
    encodeInput: encodeInput,
    decodeInput: decodeInput,
    encodeState: encodeState,
    decodeState: decodeState,
    peekMsgType: peekMsgType
  };
})(typeof window !== 'undefined' ? window : globalThis);
