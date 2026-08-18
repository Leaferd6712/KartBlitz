import { encodeState, type NetKart, type NetState } from "../party/netcodec";
import { resolveKartCollisions } from "./collision";
import { FIXED_DT, SIM_HZ, STATE_HZ } from "./constants";
import {
  createKart,
  emptyInput,
  stepKart,
  type BakedTrack,
  type SimInput,
  SimKart,
} from "./kart";
import { defaultUpgrades, sanitizeUpgrades, type UpgradeStats } from "./upgrades";

export type RacePlayer = {
  id: string;
  name: string;
  color: string;
  upgrades?: UpgradeStats;
};

export type OnlineRaceConfig = {
  track: BakedTrack;
  players: RacePlayer[];
  order: string[];
  laps: number;
  weather: string;
  collisionMode: string;
  tyres: string;
};

function gradeLaunch(rpm: number, optimal = 0.66) {
  const err = Math.abs(rpm - optimal);
  if (rpm > 0.88) return 24;
  if (rpm < 0.3) return 16;
  if (err <= 0.045) return 96;
  if (err <= 0.11) return 78;
  return Math.max(34, 90 - err * 120);
}

function gridSlots(track: BakedTrack, count: number) {
  if (track.gridSlots && track.gridSlots.length >= count) {
    return track.gridSlots.slice(0, count);
  }
  const slots = [];
  const sp = track.startPos;
  const ang = track.startAngle || 0;
  const backX = -Math.cos(ang);
  const backY = -Math.sin(ang);
  const perpX = -Math.sin(ang);
  const perpY = Math.cos(ang);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const lane = i % 2 === 0 ? -1 : 1;
    slots.push({
      x: sp.x + backX * 55 * row + perpX * 28 * lane,
      y: sp.y + backY * 55 * row + perpY * 28 * lane,
      a: ang,
    });
  }
  return slots;
}

export class OnlineRaceSim {
  track: BakedTrack;
  karts: SimKart[] = [];
  phase: "countdown" | "launch" | "racing" | "finished" = "countdown";
  countdownVal = 3;
  countdownTimer = 0;
  raceTimer = 0;
  launchRPM: number[] = [];
  launchOptimal = 0.66;
  collisionEnabled = true;
  weather = "dry";
  tyres = "med";
  lapCount = 3;
  simTimeMs = 0;
  tick = 0;
  order: string[] = [];
  inputs = new Map<string, SimInput>();
  /** Queued inputs (seq + payload); drained one-per-physics-step when present. */
  inputQueues = new Map<string, { seq: number; input: SimInput }[]>();
  /** Highest applied input seq per connection. */
  lastProcessedInput = new Map<string, number>();
  finishedEmitted = false;
  private _stateAcc = 0;
  private _prevNet: NetState | null = null;
  /** Wall clock at race construct — snapshot t = epoch + simTimeMs. */
  private _epochWall = Date.now();

  constructor(cfg: OnlineRaceConfig) {
    this.track = cfg.track;
    this.weather = cfg.weather || "dry";
    this.tyres = cfg.tyres || "med";
    this.lapCount = Math.max(1, cfg.laps || 3);
    this.collisionEnabled = cfg.collisionMode !== "nocollision";
    this.order = (cfg.order || []).slice();
    this._epochWall = Date.now();
    const players = cfg.players || [];
    const count = Math.max(2, Math.min(6, this.order.length || players.length || 2));
    const slots = gridSlots(this.track, count);

    for (let i = 0; i < count; i++) {
      const connId = this.order[i] || players[i]?.id || `slot${i}`;
      const plist =
        players.find((p) => p.id === connId) ||
        players[i] ||
        ({ id: connId, name: `P${i + 1}`, color: "#00f5ff" } as RacePlayer);
      const slot = slots[i] || slots[0];
      const self = this;
      const kart = createKart({
        id: i,
        x: slot.x,
        y: slot.y,
        angle: slot.a,
        color: plist.color || "#00f5ff",
        upgrades: sanitizeUpgrades(plist.upgrades || defaultUpgrades()),
        weather: this.weather,
        tyreId: this.tyres,
        totalLaps: this.lapCount,
        onlineConnId: connId,
        onlineName: plist.name || `P${i + 1}`,
        getInput: () => self.inputs.get(connId) || emptyInput(),
      });
      this.karts.push(kart);
      this.launchRPM[i] = 0;
      this.inputs.set(connId, emptyInput());
      this.inputQueues.set(connId, []);
      this.lastProcessedInput.set(connId, 0);
    }
  }

  setInput(connId: string, input: SimInput, seq?: number) {
    const normalized = { ...emptyInput(), ...input };
    if (typeof seq === "number" && Number.isFinite(seq)) {
      const q = this.inputQueues.get(connId) || [];
      const s = seq & 0xffff;
      const last = q.length ? q[q.length - 1].seq : this.lastProcessedInput.get(connId) || 0;
      // Accept if newer (u16 wrap) or queue empty
      const newer = ((s - last) & 0xffff) < 0x8000 || q.length === 0;
      if (newer || s === last) {
        if (s === last && q.length) q[q.length - 1] = { seq: s, input: normalized };
        else q.push({ seq: s, input: normalized });
        while (q.length > 48) q.shift();
        this.inputQueues.set(connId, q);
      }
      return;
    }
    this.inputs.set(connId, normalized);
  }

  /** Apply at most one queued input before a physics step; ack that seq. */
  private drainInputQueues() {
    for (const connId of this.inputs.keys()) {
      const q = this.inputQueues.get(connId);
      if (q && q.length > 0) {
        const next = q.shift()!;
        this.inputs.set(connId, next.input);
        this.lastProcessedInput.set(connId, next.seq);
      }
    }
  }

  markDisconnected(connId: string) {
    const k = this.karts.find((x) => x.onlineConnId === connId);
    if (k) {
      k._onlineDisconnected = true;
      this.inputs.set(connId, emptyInput());
      this.inputQueues.set(connId, []);
    }
  }

  step(dt = FIXED_DT): ArrayBuffer | null {
    this.drainInputQueues();
    this.simTimeMs += dt * 1000;
    this.tick++;

    if (this.phase === "countdown") {
      this.countdownTimer += dt;
      this.karts.forEach((k, i) => {
        const inp = this.inputs.get(k.onlineConnId) || emptyInput();
        let rpm = this.launchRPM[i] || 0;
        if (inp.up || (inp.throttle || 0) > 0.2) rpm += 1.15 * dt;
        else rpm -= 0.55 * dt;
        if (inp.down || (inp.brake || 0) > 0.2) rpm -= 0.75 * dt;
        this.launchRPM[i] = Math.max(0, Math.min(1, rpm));
      });
      if (this.countdownTimer >= 1) {
        this.countdownTimer -= 1;
        this.countdownVal--;
        if (this.countdownVal <= 0) this.applyLaunch();
      }
    } else if (this.phase === "racing") {
      this.raceTimer += dt;
      for (const k of this.karts) {
        k.drsAvailable = true;
        if (!k._onlineDisconnected) {
          stepKart(k, this.inputs.get(k.onlineConnId) || emptyInput(), dt, this.track, this.karts, {
            contact: false,
            resolveCollisions: false,
            nowMs: this.simTimeMs,
          });
        }
      }
      resolveKartCollisions(this.karts, this.collisionEnabled);
      if (this.karts.every((k) => k.finished)) {
        this.phase = "finished";
      }
    } else if (this.phase === "finished") {
      this.raceTimer += dt;
    }

    this._stateAcc += dt;
    const stateStep = 1 / STATE_HZ;
    if (this._stateAcc >= stateStep) {
      this._stateAcc %= stateStep;
      return this.buildStatePacket(false);
    }
    return null;
  }

  applyLaunch() {
    this.karts.forEach((k, i) => {
      k.speed = gradeLaunch(this.launchRPM[i] || 0, this.launchOptimal);
    });
    this.phase = "racing";
  }

  lastProcessedBySlot(): number[] {
    return this.karts.map((k) => this.lastProcessedInput.get(k.onlineConnId) || 0);
  }

  buildStatePacket(forceFull: boolean): ArrayBuffer {
    const net: NetState = {
      type: "state",
      t: this._epochWall + this.simTimeMs,
      tick: this.tick,
      phase: this.phase,
      countdownVal: this.countdownVal,
      raceTimer: this.raceTimer,
      launchRPM: this.launchRPM.slice(),
      karts: this.karts.map((k) => this.serializeKart(k)),
      full: forceFull,
      lastProcessedInput: this.lastProcessedBySlot(),
    };
    const buf = encodeState(net, forceFull ? null : this._prevNet);
    this._prevNet = net;
    return buf;
  }

  serializeKart(k: SimKart): NetKart {
    return {
      id: k.id,
      x: k.x,
      y: k.y,
      angle: k.angle,
      speed: k.speed,
      lap: k.lap || 0,
      finished: !!k.finished,
      finishTime: k.finishTime == null ? null : k.finishTime,
      tyreId: k.tyreId || "med",
      tyreWear: k.tyreWear || 0,
      tyreTemp: k.tyreTemp || 0,
      ersCharge: k.ersCharge || 0,
      ersActive: !!k.ersActive,
      drsActive: !!k.drsActive,
      drsAvailable: !!k.drsAvailable,
      pitPhase: null,
      inPit: false,
      checkpointsBit: k.checkpointsBit || 0,
      _nearestSplineIdx: k._nearestSplineIdx || 0,
      bestLap: k.bestLap < Infinity ? k.bestLap : null,
      maxSpeed: k.maxSpeed || 0,
      disconnected: !!k._onlineDisconnected,
    };
  }

  isFinished(): boolean {
    return this.phase === "finished";
  }
}

export { SIM_HZ, FIXED_DT };
