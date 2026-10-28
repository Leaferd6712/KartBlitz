import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const required = [
  'ui/base.css',
  'ui/kartblitz.css',
  'js/shared-modules.js',
  'js/game.js',
  'js/programme-runtime.js',
  'js/car-stage.js',
  'js/track-editor.js',
  'js/ui-preview.js',
];

for (const relativePath of required) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing required static asset: ${relativePath}`);
  }
  if (!index.includes(relativePath)) {
    throw new Error(`index.html does not reference required static asset: ${relativePath}`);
  }
}

const orderedScripts = [
  'js/shared-modules.js',
  'js/game.js',
  'js/programme-runtime.js',
  'js/car-stage.js',
  'js/track-editor.js',
  'js/ui-preview.js',
];
let previousIndex = -1;
for (const script of orderedScripts) {
  const sourceIndex = index.indexOf(script);
  if (sourceIndex <= previousIndex) throw new Error(`Unexpected script order at ${script}`);
  previousIndex = sourceIndex;
}

if (!/<body\s+class="[^"]*\bkb-ui\b/.test(index)) {
  throw new Error('index.html does not activate body.kb-ui');
}
if (!/<meta\s+name="kartblitz-patch-version"\s+content="2026-09-15">/.test(index)) {
  throw new Error('index.html patch-version metadata is missing or changed unexpectedly');
}

console.log(`Verified ${required.length} extracted static assets and explicit script order.`);
