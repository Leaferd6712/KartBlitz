# Online reconnect lifecycle

KartBlitz online races keep **server simulation authoritative** while a client is briefly offline. Players resume with a **seat id + reconnect token**, never by display name alone.

## Identifiers

| Field | Role |
|--------|------|
| `seatId` | Stable participant id (grid / `onlineConnId` / client `you`) |
| `reconnectToken` | Secret issued in `welcome`; required to resume |
| `connId` | Ephemeral WebSocket id; rebound on resume |

Unrelated sockets that join a room mid-race without a valid token still receive `error: racing` (no new racers).

## State machine

```
LOBBY
  │ join → seat created (CONNECTED), token issued
  │ leave → GONE (no grace)
  │ startRace → RACING

RACING / CONNECTED
  │ socket drop → DISCONNECTED (grace = 45s)
  │              kart frozen via markDisconnected(seatId)
  │              host migrates if needed → hostMigrated
  │
  ├─ resume(token) within grace → CONNECTED
  │     clearDisconnected(seatId)
  │     welcome{resumed} + resumeRace + full snapshot
  │
  ├─ grace expired → FORFEITED (DNF), playerLeft{grace_expired}
  │
  └─ race finishes (all done / only disconnected remain)
        → record win once (_winRecorded)
        → raceEnded → LOBBY
        → purge disconnected/forfeited seats
```

### Client phases

`lobby` → `racing` → (`reconnecting` on drop) → `racing` on success → `idle` on permanent failure.

While `reconnecting`, the race UI stays up with a **RECONNECTING…** banner; teardown only happens on permanent disconnect (grace / forfeit / auth failure).

## Message summary

| Message | When |
|---------|------|
| `welcome` (+ `reconnectToken`, `seatId`) | Join or successful resume |
| `resumeRequired` | Mid-race socket opened; client must hello with token |
| `resumeRace` | Resume payload (order/settings) + full binary state |
| `playerDisconnected` | Soft leave during race (grace active) |
| `playerResumed` | Seat live again |
| `hostMigrated` | Lobby admin seat changed after host drop |
| `playerLeft` | Permanent leave (lobby, or grace expired) |
| `error` `racing` / `expired` / `forfeited` / `invalid_token` | Reject resume / join |

## Behaviour matrix

| Situation | Behaviour |
|-----------|-----------|
| Reconnect succeeds | Same seat, sim continues, inputs resume, no race restart |
| Grace expires | Seat forfeited (DNF), cannot resume |
| Race finishes while DC | Win recorded from seat `deviceToken` if winner; DC seats DNF’d; `raceEnded` |
| Host disconnects | Admin `hostId` → next **connected** seat; physics stays on DO |
| Multiple reconnect attempts | Same token; new socket displaces old; invalid token rejected |
| New unrelated joiner mid-race | Rejected (`racing`) |
| Duplicate rewards | `_winRecorded` gate — at most one `recordOnlineWin` per race |

## Files

- `party/reconnect.ts` — tokens, grace, validateResume
- `party/server.ts` — seats, pending resume, host migrate, win once
- `sim/raceOnline.ts` — `markDisconnected` / `clearDisconnected` / `forfeitDisconnected` / finish gate
- `online.js` — auto reconnect loop + UI events
