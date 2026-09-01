import fs from "fs";

const path = "index.html";
let lines = fs.readFileSync(path, "utf8").split(/\r?\n/);

function lineIndex(pred) {
  for (let i = 0; i < lines.length; i++) if (pred(lines[i], i)) return i;
  return -1;
}

const splineIdx = lineIndex((l) => l.includes("// ── SPLINE MATH ──"));
const particleIdx = lineIndex((l) => l.includes("// ── PARTICLE SYSTEM"));
if (splineIdx !== -1 && particleIdx !== -1 && particleIdx > splineIdx) {
  lines.splice(splineIdx, particleIdx - splineIdx);
}

const mainScriptIdx = lineIndex((l, i) => l === "<script>" && lines[i + 1]?.includes("kart blitz - main"));
if (mainScriptIdx !== -1 && !lines.slice(0, mainScriptIdx).some((l) => l.includes("tracks-shared.js"))) {
  lines.splice(mainScriptIdx, 0, '<script src="tracks-shared.js"></script>');
}

const teStart = lineIndex((l) => l.trim() === "window.KartBlitzTrackEditor = (function(){");
let teScriptOpen = teStart > 0 && lines[teStart - 1]?.trim() === "" && lines[teStart - 2]?.trim() === "<script>" ? teStart - 2 : teStart;
const bodyEnd = lineIndex((l) => l.trim() === "</body>");
let teEnd = -1;
for (let i = bodyEnd - 1; i >= 0; i--) {
  if (lines[i].trim() === "})();") {
    teEnd = i;
    break;
  }
}
if (teScriptOpen !== -1 && teEnd !== -1 && teEnd > teScriptOpen) {
  let endRemove = teEnd + 1;
  if (lines[endRemove]?.trim() === "</script>") endRemove++;
  while (lines[teScriptOpen - 1]?.trim() === "") teScriptOpen--;
  lines.splice(teScriptOpen, endRemove - teScriptOpen);
}

// Remove stale KartBlitzTrackEditor escape checks (optional cleanup)
lines = lines.map((l) =>
  l.includes("KartBlitzTrackEditor.isUiActive") ? l.replace(/.*KartBlitzTrackEditor[^\n]*\n?/g, "") : l
).filter((l, i, arr) => {
  if (!l.trim() && lines[i]?.includes?.("isUiActive")) return false;
  return true;
});

// Cleaner: remove blocks that only check KartBlitzTrackEditor
const cleaned = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes("KartBlitzTrackEditor.isUiActive")) continue;
  if (l.includes("KartBlitzTrackEditor.closeAll")) continue;
  cleaned.push(l);
}
lines = cleaned;

fs.writeFileSync(path, lines.join("\n"));
console.log("Fixed index.html");
