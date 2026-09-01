import fs from "fs";

const path = "index.html";
let text = fs.readFileSync(path, "utf8");

function cut(startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  if (s === -1) {
    console.warn("Start not found:", startMarker.slice(0, 50));
    return;
  }
  const e = text.indexOf(endMarker, s);
  if (e === -1) {
    console.warn("End not found after:", startMarker.slice(0, 50));
    return;
  }
  text = text.slice(0, s) + text.slice(e);
}

cut("/* ── Embedded Track Editor ── */", "\n</style>");
cut("<!-- TRACK EDITOR PASSCODE -->", "<!-- AD REQUEST BLOCKER");

if (!text.includes('<script src="tracks-shared.js"></script>')) {
  cut(
    "// ── SPLINE MATH ─────────────────────────────────────────",
    "TRACKS.forEach(tr => finalizeTrack(tr));\n"
  );
  text = text.replace(
    "// ── PARTICLE SYSTEM",
    '<script src="tracks-shared.js"></script>\n// ── PARTICLE SYSTEM'
  );
}

cut("function openTrackEditorFromMenu()", "console.log('Tracks:");

const teBlock = "\n<script>\n\nwindow.KartBlitzTrackEditor = (function(){";
const teStart = text.indexOf(teBlock);
if (teStart !== -1) {
  const teEnd = text.indexOf("\n})();\n\n</script>\n</body>", teStart);
  if (teEnd !== -1) text = text.slice(0, teStart) + text.slice(teEnd + "\n})();\n\n</script>".length);
}

text = text.replace(
  /<button type="button" class="btn btn-sm" id="btn-track-editor"[^>]*> TRACK EDITOR<\/button>/,
  '<a class="btn btn-sm" id="btn-track-editor" style="color:#3dd6c6;text-decoration:none;display:inline-flex;align-items:center;" href="admin.html" target="_blank" rel="noopener"> ADMIN</a>'
);

fs.writeFileSync(path, text);
console.log("Patched index.html");
