/**
 * Load online-sim.js in Node (VM sandbox). Shared by RL trainer and ML env server.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(__dirname, "..", "..");
export const simJs = path.join(root, "online-sim.js");

export function ensureBundle() {
  if (fs.existsSync(simJs)) return;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-online-sim.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error("sim:browser build failed — run: npm run sim:browser");
  }
}

export function loadOnlineSim() {
  ensureBundle();
  const code = fs.readFileSync(simJs, "utf8");
  const sandbox = {
    console,
    Math,
    Date,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Float32Array,
    Int32Array,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.OnlineCodec = {
    encodeState() {
      return new ArrayBuffer(0);
    },
  };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  if (!sandbox.OnlineSim) throw new Error("OnlineSim global missing");
  return sandbox.OnlineSim;
}
