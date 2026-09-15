import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let downloadedBlob = null;
let downloadedName = null;
const local = new Map();
const context = {
  console,
  TextEncoder,
  Uint8Array,
  DataView,
  Blob,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  alert: message => { throw new Error(message); },
  localStorage: {
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
  },
  document: {
    readyState: 'loading',
    addEventListener: () => {},
    createElement: tag => {
      assert.equal(tag, 'a');
      return {
        set href(value) {},
        set download(value) { downloadedName = value; },
        click() {},
      };
    },
  },
  URL: {
    createObjectURL: blob => { downloadedBlob = blob; return 'blob:test'; },
    revokeObjectURL: () => {},
  },
  fetch: async path => {
    const bytes = Uint8Array.from(fs.readFileSync(path));
    return { ok: true, arrayBuffer: async () => bytes.buffer };
  },
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('ml/runtime.js', 'utf8'), context, { filename: 'ml/runtime.js' });
vm.runInContext(fs.readFileSync('ml/lab.js', 'utf8'), context, { filename: 'ml/lab.js' });

assert.equal(typeof context.KartBlitzMLLab.copyCommand, 'function', 'training commands should have a copy action');

const lessonResult = context.KartBlitzMLLab.scoreDecision('fastLeft', { steer: 'left', pedal: 'brake' });
assert.equal(lessonResult.score, 2, 'decision lesson should score the intended corner response');
const weights = { progress: 1, speed: .2, line: .15, heading: .2, offTrack: 1.5, smoothness: .05, stuck: 1, lap: 3 };
const safeReward = context.KartBlitzMLLab.calculateRewardFrame(weights, { progress: 1, speed: .7, alignment: .9, smooth: .2, offTrack: false, lap: false });
const offTrackReward = context.KartBlitzMLLab.calculateRewardFrame(weights, { progress: 0, speed: .7, alignment: .9, smooth: .2, offTrack: true, lap: false });
assert.ok(safeReward.total > 0, 'forward on-track driving should receive a positive teaching example');
assert.ok(offTrackReward.total < 0, 'off-track driving should receive a negative teaching example');

const button = { disabled: false, textContent: 'DOWNLOAD TRAINER PACK (.ZIP)' };
await context.KartBlitzMLLab.downloadTrainerPack(button);
assert.equal(downloadedName, 'KartBlitz-ML-Trainer.zip');
assert.ok(downloadedBlob instanceof Blob);
assert.equal(button.disabled, false);
const bytes = new Uint8Array(await downloadedBlob.arrayBuffer());
const view = new DataView(bytes.buffer);
assert.equal(view.getUint32(0, true), 0x04034b50, 'ZIP should begin with a local file header');
assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'ZIP should end with a central-directory record');
assert.equal(view.getUint16(bytes.length - 12, true), 11, 'ZIP should contain all trainer files');

console.log('ML trainer download pack tests passed');
