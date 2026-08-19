# KartBlitz leaderboard seed files

These text files are optional "fake data" helpers for local development / testing.

## `online-wins.txt`

Used by the in-game "ONLINE WINS" leaderboard.

### Format

- One entry per line
- Whitespace-separated fields

```
USERNAME WINS
```

### Rules

- `USERNAME` is 3-12 characters, A-Z and 0-9 only (anything else is stripped).
- `WINS` must be a non-negative integer.
- Lines starting with `#` are ignored.

### Behavior

- The game merges this seed file with real cloud data (if available).
- If the same `USERNAME` appears in both places, the higher win total is used for display.

