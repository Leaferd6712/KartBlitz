/**
 * Extract TRACKS waypoints from KartBlitz.html and bake splines/checkpoints
 * into sim/tracks/bakes.json for Durable Object authority.
 *
 * Usage: node scripts/export-track-bakes.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const htmlPath = path.join(root, "KartBlitz.html");
const outPath = path.join(root, "sim", "tracks", "bakes.json");

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function buildSpline(wps, steps = 28) {
  const pts = [];
  const n = wps.length;
  for (let i = 0; i < n; i++) {
    const p0 = wps[(i - 1 + n) % n];
    const p1 = wps[i];
    const p2 = wps[(i + 1) % n];
    const p3 = wps[(i + 2) % n];
    for (let s = 0; s < steps; s++) pts.push(catmullRom(p0, p1, p2, p3, s / steps));
  }
  return pts;
}

function bakeTrack(raw) {
  const wps = raw.waypoints || [];
  if (wps.length < 4) return null;
  const spline = buildSpline(wps, 28).map((p) => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
  }));
  const cum = [0];
  for (let i = 1; i < spline.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(spline[i].x - spline[i - 1].x, spline[i].y - spline[i - 1].y));
  }
  const totalLen = cum[cum.length - 1] || 1;
  const trackWidth = raw.trackWidth || 160;
  const hw = trackWidth / 2 + 20;
  const fracs = raw.cpFracs || [0, 0.25, 0.5, 0.75];
  const cpLines = fracs.map((frac) => {
    const dist = frac * totalLen;
    let idx = 0;
    while (idx < cum.length - 1 && cum[idx] < dist) idx++;
    const p = spline[idx];
    const p2 = spline[(idx + 1) % spline.length];
    const tx = p2.x - p.x;
    const ty = p2.y - p.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    return {
      x1: p.x + nx * hw,
      y1: p.y + ny * hw,
      x2: p.x - nx * hw,
      y2: p.y - ny * hw,
    };
  });
  const drsFracs = raw.drsFracs || [];
  const drsZones = drsFracs.map(([sf, ef]) => {
    const sIdx = Math.max(0, Math.min(spline.length - 1, Math.round((sf || 0) * spline.length)));
    const eIdx = Math.max(0, Math.min(spline.length - 1, Math.round((ef || 0) * spline.length)));
    return { sIdx, eIdx };
  });
  const startPos = raw.startPos || spline[0];
  const startAngle = raw.startAngle || 0;
  const ang = startAngle;
  const backX = -Math.cos(ang);
  const backY = -Math.sin(ang);
  const perpX = -Math.sin(ang);
  const perpY = Math.cos(ang);
  const gridSlots = [];
  for (let i = 0; i < 6; i++) {
    const row = Math.floor(i / 2);
    const lane = i % 2 === 0 ? -1 : 1;
    gridSlots.push({
      x: startPos.x + backX * 55 * row + perpX * 28 * lane,
      y: startPos.y + backY * 55 * row + perpY * 28 * lane,
      a: ang,
    });
  }
  return {
    id: raw.id,
    trackWidth,
    spline,
    cum,
    totalLen,
    startPos: { x: startPos.x, y: startPos.y },
    startAngle,
    cpLines,
    drsZones,
    gridSlots,
    surface: { offTrackMult: (raw.surface && raw.surface.offTrackMult != null) ? raw.surface.offTrackMult : 1 },
  };
}

function extractTracks(html) {
  // Pull each track object that has id + waypoints — lightweight regex scan
  const tracks = [];
  const re = /\{\s*id\s*:\s*(\d+)[\s\S]*?waypoints\s*:\s*\[([\s\S]*?)\]\s*,/g;
  let m;
  while ((m = re.exec(html))) {
    const id = parseInt(m[1], 10);
    const wpBody = m[2];
    const waypoints = [];
    const ptRe = /\{\s*x\s*:\s*(-?[\d.]+)\s*,\s*y\s*:\s*(-?[\d.]+)/g;
    let pm;
    while ((pm = ptRe.exec(wpBody))) {
      waypoints.push({ x: parseFloat(pm[1]), y: parseFloat(pm[2]) });
    }
    if (waypoints.length < 4) continue;

    // Find startPos / trackWidth near this id block (search forward limited)
    const chunk = html.slice(m.index, m.index + 8000);
    const sp = chunk.match(/startPos\s*:\s*\{\s*x\s*:\s*(-?[\d.]+)\s*,\s*y\s*:\s*(-?[\d.]+)/);
    const sa = chunk.match(/startAngle\s*:\s*(-?[\d.]+)/);
    const tw = chunk.match(/trackWidth\s*:\s*(\d+)/);
    const cp = chunk.match(/cpFracs\s*:\s*\[([^\]]+)\]/);
    const drs = chunk.match(/drsFracs\s*:\s*\[([\s\S]*?)\]/);
    const surf = chunk.match(/surface\s*:\s*\{\s*offTrackMult\s*:\s*([\d.]+)/);
    let cpFracs = [0, 0.25, 0.5, 0.75];
    if (cp) {
      cpFracs = cp[1].split(",").map((s) => parseFloat(s.trim())).filter((n) => Number.isFinite(n));
    }
    let drsFracs = [];
    if (drs) {
      const pairRe = /\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g;
      let dm;
      while ((dm = pairRe.exec(drs[1]))) {
        drsFracs.push([parseFloat(dm[1]), parseFloat(dm[2])]);
      }
    }
    const offTrackMult = surf ? parseFloat(surf[1]) : 1;
    tracks.push({
      id,
      waypoints,
      startPos: sp ? { x: parseFloat(sp[1]), y: parseFloat(sp[2]) } : waypoints[0],
      startAngle: sa ? parseFloat(sa[1]) : 0,
      trackWidth: tw ? parseInt(tw[1], 10) : 160,
      cpFracs,
      drsFracs,
      surface: { offTrackMult: Number.isFinite(offTrackMult) ? offTrackMult : 1 },
    });
  }
  return tracks;
}

const html = fs.readFileSync(htmlPath, "utf8");
const rawTracks = extractTracks(html);
const out = { version: 2, tracks: {} };
for (const raw of rawTracks) {
  const baked = bakeTrack(raw);
  if (baked) out.tracks[String(raw.id)] = baked;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log("Wrote", Object.keys(out.tracks).length, "tracks to", outPath);
