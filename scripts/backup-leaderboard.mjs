import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(ROOT, "backups/leaderboard.txt");
const DB_NAME = "kartblitz-leaderboard";
const DEFAULT_BACKUP_URL = "https://kartblitz-online.kartblitz.workers.dev/api/leaderboard-backup.txt";

function isoFromEpoch(value) {
  const ms = Number(value) || 0;
  if (!ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

function formatLapTime(sec) {
  if (sec == null || !Number.isFinite(sec) || !(sec >= 0)) return "-";
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m + ":" + s;
}

function pad(value, width) {
  return String(value ?? "").padEnd(width, " ");
}

function formatLeaderboardBackupText(payload) {
  const lines = [
    "KartBlitz Leaderboard Backup",
    "Generated (UTC): " + payload.generatedAt,
    "Registered devices: " + payload.deviceCount,
    "Saved scores: " + payload.scoreCount,
    "Saved online wins: " + payload.onlineWinCount,
    "",
    "This file is a full snapshot of cloud leaderboard records (usernames and times).",
    "Device tokens are omitted so the file is safe to keep in git.",
    "Use this if D1 data is lost and you need to refer back to previous records.",
    "",
    "------------------------------------------------------------------------------",
    "REGISTERED USERNAMES",
    "------------------------------------------------------------------------------",
  ];

  if (!payload.devices.length) {
    lines.push("No registered devices yet.");
  } else {
    lines.push(pad("USERNAME", 16) + pad("REGISTERED (UTC)", 26) + "LAST SEEN (UTC)");
    for (const device of payload.devices) {
      lines.push(pad(device.username, 16) + pad(device.registeredAt, 26) + device.lastSeenAt);
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "SCORES (best lap first within each mode/track)",
    "------------------------------------------------------------------------------"
  );

  if (!payload.scores.length) {
    lines.push("No scores saved yet.");
  } else {
    lines.push(
      pad("MODE", 10) +
        pad("TRACK", 8) +
        pad("TRACK NAME", 24) +
        pad("USERNAME", 14) +
        pad("BEST LAP", 12) +
        pad("TOTAL", 12) +
        pad("WINNER", 10) +
        "CREATED (UTC)"
    );
    for (const score of payload.scores) {
      lines.push(
        pad(score.mode, 10) +
          pad(score.trackId, 8) +
          pad(score.trackName || "-", 24) +
          pad(score.username, 14) +
          pad(score.bestLapText, 12) +
          pad(score.totalText || "-", 12) +
          pad(score.winner || "-", 10) +
          score.createdAt
      );
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "ONLINE WINS (wins desc)",
    "------------------------------------------------------------------------------"
  );

  if (!payload.onlineWins.length) {
    lines.push("No online wins saved yet.");
  } else {
    lines.push(pad("USERNAME", 16) + pad("WINS", 12) + "UPDATED (UTC)");
    for (const win of payload.onlineWins) {
      lines.push(pad(win.username, 16) + pad(win.winsText, 12) + win.updatedAt);
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "MACHINE-READABLE JSON (for restore / import)",
    "------------------------------------------------------------------------------",
    JSON.stringify(payload, null, 2),
    ""
  );

  return lines.join("\n");
}

function runWrangler(args) {
  const wranglerJs = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [wranglerJs, ...args], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || "command failed").trim() || `wrangler exited ${code}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function parseWranglerJson(stdout) {
  const start = stdout.indexOf("[");
  const alt = stdout.indexOf("{");
  const idx = start >= 0 && (alt < 0 || start <= alt) ? start : alt;
  if (idx < 0) throw new Error("wrangler did not return JSON");
  const parsed = JSON.parse(stdout.slice(idx));
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && Array.isArray(first.results)) return first.results;
    return parsed;
  }
  if (parsed && Array.isArray(parsed.results)) {
    const inner = parsed.results[0];
    if (inner && Array.isArray(inner.results)) return inner.results;
    return parsed.results;
  }
  return [];
}

async function queryD1(sql) {
  const { stdout } = await runWrangler([
    "d1",
    "execute",
    DB_NAME,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  return parseWranglerJson(stdout);
}

async function exportFromD1() {
  const deviceRows = await queryD1(
    "SELECT username, created_at, last_seen_at FROM devices ORDER BY created_at ASC"
  );
  const scoreRows = await queryD1(
    "SELECT username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at FROM scores ORDER BY mode ASC, track_id ASC, best_lap ASC"
  );
  const onlineWinRows = await queryD1(
    "SELECT username_snapshot, SUM(wins) as wins, MAX(updated_at) as updated_at FROM online_wins GROUP BY username_snapshot ORDER BY wins DESC"
  );

  const devices = (deviceRows || []).map((row) => ({
    username: String(row.username || ""),
    registeredAt: isoFromEpoch(Number(row.created_at) || 0),
    lastSeenAt: isoFromEpoch(Number(row.last_seen_at) || 0),
  }));
  const scores = (scoreRows || []).map((row) => {
    const bestLap = Number(row.best_lap) || 0;
    const total = row.total == null ? null : Number(row.total);
    return {
      mode: String(row.mode || ""),
      trackId: Number(row.track_id) || 0,
      trackName: row.track_name || null,
      username: String(row.username_snapshot || ""),
      bestLap,
      bestLapText: formatLapTime(bestLap),
      total: total != null && Number.isFinite(total) ? total : null,
      totalText: total != null && Number.isFinite(total) ? formatLapTime(total) : null,
      winner: row.winner || null,
      createdAt: isoFromEpoch(Number(row.created_at) || 0),
      updatedAt: isoFromEpoch(Number(row.updated_at) || 0),
    };
  });

  const onlineWins = (onlineWinRows || []).map((row) => {
    const wins = Number(row.wins) || 0;
    return {
      username: String(row.username_snapshot || ""),
      wins,
      winsText: String(wins),
      updatedAt: isoFromEpoch(Number(row.updated_at) || 0),
    };
  });

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    scoreCount: scores.length,
    onlineWinCount: onlineWins.length,
    devices,
    scores,
    onlineWins,
  };
  return formatLeaderboardBackupText(payload);
}

async function exportFromWorker() {
  const url = process.env.LEADERBOARD_BACKUP_URL || DEFAULT_BACKUP_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`backup endpoint HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith("KartBlitz Leaderboard Backup")) {
    throw new Error("backup endpoint did not return a leaderboard snapshot");
  }
  return text;
}

async function main() {
  let text = "";
  let source = "";
  try {
    text = await exportFromD1();
    source = "d1";
  } catch (err) {
    console.warn("D1 export failed, falling back to Worker endpoint:", err && err.message ? err.message : err);
    text = await exportFromWorker();
    source = "worker";
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, String(text || "").replace(/\s+$/, "") + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH} from ${source}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
