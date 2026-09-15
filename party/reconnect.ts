/**
 * Online race reconnect — pure helpers (no DO / WebSocket).
 *
 * Lifecycle (race phase):
 *
 *   CONNECTED ──disconnect──► DISCONNECTED(grace)
 *        ▲                         │
 *        │                         ├── resume(valid token) ──► CONNECTED
 *        │                         ├── grace expired ──► FORFEITED (DNF, no resume)
 *        │                         └── race ends ──► LOBBY / GONE
 *   LOBBY leave ──► GONE (no mid-lobby resume)
 *
 * Identity: seatId (stable) + reconnectToken (secret). Never trust display name alone.
 */

export const RECONNECT_GRACE_MS = 45_000;
export const RESUME_HELLO_TIMEOUT_MS = 8_000;
export const RECONNECT_TOKEN_BYTES = 24;

export type ReconnectStatus =
  | "connected"
  | "disconnected"
  | "forfeited"
  | "gone";

export type SeatRecord = {
  seatId: string;
  reconnectToken: string;
  /** Current WebSocket connection id, or null while disconnected. */
  connId: string | null;
  name: string;
  ready: boolean;
  color: string;
  upgrades: unknown;
  deviceToken?: string;
  status: ReconnectStatus;
  disconnectedAt: number | null;
};

export function generateSeatId(randomBytes: (n: number) => Uint8Array = defaultRandom): string {
  const b = randomBytes(16);
  // UUID-ish without depending on crypto.randomUUID (wider runtime support)
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `s_${hex}`;
}

export function generateReconnectToken(randomBytes: (n: number) => Uint8Array = defaultRandom): string {
  const b = randomBytes(RECONNECT_TOKEN_BYTES);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
  }
  return out;
}

/** Constant-time-ish compare for equal-length hex tokens. */
export function tokensEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function createSeat(partial: {
  name?: string;
  color?: string;
  upgrades: unknown;
  connId: string;
  deviceToken?: string;
  randomBytes?: (n: number) => Uint8Array;
}): SeatRecord {
  const rnd = partial.randomBytes || defaultRandom;
  return {
    seatId: generateSeatId(rnd),
    reconnectToken: generateReconnectToken(rnd),
    connId: partial.connId,
    name: partial.name || "RACER",
    ready: false,
    color: partial.color || "#00f5ff",
    upgrades: partial.upgrades,
    deviceToken: partial.deviceToken,
    status: "connected",
    disconnectedAt: null,
  };
}

export function markSeatDisconnected(seat: SeatRecord, now: number): SeatRecord {
  return {
    ...seat,
    connId: null,
    status: "disconnected",
    disconnectedAt: now,
    ready: false,
  };
}

export function graceRemainingMs(seat: SeatRecord, now: number, graceMs = RECONNECT_GRACE_MS): number {
  if (seat.status !== "disconnected" || seat.disconnectedAt == null) return 0;
  return Math.max(0, graceMs - (now - seat.disconnectedAt));
}

export function isGraceExpired(seat: SeatRecord, now: number, graceMs = RECONNECT_GRACE_MS): boolean {
  return seat.status === "disconnected" && graceRemainingMs(seat, now, graceMs) <= 0;
}

export type ResumeResult =
  | { ok: true; seat: SeatRecord }
  | { ok: false; code: "invalid_token" | "expired" | "forfeited" | "not_racing" | "wrong_room"; message: string };

/**
 * Validate resume attempt. Does not mutate; caller rebinds connId.
 */
export function validateResume(
  seats: Iterable<SeatRecord>,
  opts: {
    token: string;
    seatId?: string;
    now: number;
    phase: "lobby" | "racing";
    graceMs?: number;
  }
): ResumeResult {
  if (opts.phase !== "racing") {
    return { ok: false, code: "not_racing", message: "No active race to resume." };
  }
  const token = String(opts.token || "");
  if (!token) {
    return { ok: false, code: "invalid_token", message: "Missing reconnect token." };
  }

  let match: SeatRecord | null = null;
  for (const s of seats) {
    if (opts.seatId && s.seatId !== opts.seatId) continue;
    if (tokensEqual(s.reconnectToken, token)) {
      match = s;
      break;
    }
  }
  if (!match) {
    return { ok: false, code: "invalid_token", message: "Invalid reconnect token." };
  }
  // If seatId provided and mismatched token owner — already filtered; if token matches another seat, reject hijack via seatId claim
  if (opts.seatId && match.seatId !== opts.seatId) {
    return { ok: false, code: "invalid_token", message: "Seat/token mismatch." };
  }
  if (match.status === "forfeited" || match.status === "gone") {
    return { ok: false, code: "forfeited", message: "Seat was forfeited." };
  }
  if (match.status === "disconnected" && isGraceExpired(match, opts.now, opts.graceMs)) {
    return { ok: false, code: "expired", message: "Reconnect grace period expired." };
  }
  if (match.status === "connected" && match.connId) {
    // Allow displace — treated as ok; caller closes old socket
  }
  return {
    ok: true,
    seat: {
      ...match,
      status: "connected",
      disconnectedAt: null,
    },
  };
}

export function forfeitSeat(seat: SeatRecord): SeatRecord {
  return {
    ...seat,
    connId: null,
    status: "forfeited",
    disconnectedAt: null,
    ready: false,
  };
}

/** Pick new lobby host: prefer connected seats, stable order. */
export function pickHostSeatId(
  seats: SeatRecord[],
  preferredOrder: string[] | null = null
): string | null {
  const connected = seats.filter((s) => s.status === "connected" && s.connId);
  if (!connected.length) return null;
  if (preferredOrder && preferredOrder.length) {
    for (const id of preferredOrder) {
      const hit = connected.find((s) => s.seatId === id);
      if (hit) return hit.seatId;
    }
  }
  return connected[0].seatId;
}

export function rosterPublic(seats: SeatRecord[]) {
  return seats
    .filter((s) => s.status === "connected" || s.status === "disconnected")
    .map((s) => ({
      id: s.seatId,
      name: s.name,
      ready: !!s.ready,
      color: s.color,
      disconnected: s.status === "disconnected",
    }));
}
