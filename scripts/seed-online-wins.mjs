import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "leaderboard/online-wins.txt");

const DB_NAME = "kartblitz-leaderboard";

function sanitizeLeaderboardName(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .substring(0, 12);
}

function validLeaderboardName(name) {
  return /^[A-Z0-9]{3,12}$/.test(name);
}

function parseSeed(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const username = sanitizeLeaderboardName(parts[0]);
    if (!validLeaderboardName(username)) continue;
    const wins = Math.floor(Number(parts[1]));
    if (!Number.isFinite(wins) || wins < 0) continue;
    out.push({ username, wins });
  }
  return out;
}

function makeSeedToken(username) {
  // Device tokens are not validated by the schema, but we generate something
  // compatible with the app's device-token shape to keep behavior consistent.
  const base = `seed_${username}_`;
  const pad = "0000000000000000000000000000000000000000";
  return (base + pad).slice(0, 48);
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
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
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

async function executeSql(sql) {
  await runWrangler([
    "d1",
    "execute",
    DB_NAME,
    "--remote",
    "--command",
    sql,
  ]);
}

async function main() {
  const seedText = await readFile(SEED_PATH, "utf8");
  const entries = parseSeed(seedText);

  if (!entries.length) {
    console.log(`No seed entries found in ${SEED_PATH}`);
    return;
  }

  const now = Date.now();
  const reset = process.argv.includes("--reset");

  if (reset) {
    // Remove prior seeded rows (device_token starts with "seed_").
    await executeSql(`DELETE FROM online_wins WHERE device_token LIKE 'seed_%';`);
  }

  for (const e of entries) {
    const token = makeSeedToken(e.username);
    const u = e.username; // safe: seed file is sanitized
    const wins = Number(e.wins) || 0;
    const sql = `INSERT INTO online_wins (device_token, username_snapshot, wins, updated_at)
      VALUES ('${token}', '${u}', ${wins}, ${now})
      ON CONFLICT(device_token) DO UPDATE SET
        wins = excluded.wins,
        username_snapshot = excluded.username_snapshot,
        updated_at = excluded.updated_at`;
    await executeSql(sql);
  }

  console.log(`Seeded ${entries.length} online win rows into D1 (${reset ? "reset" : "merge"}).`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

