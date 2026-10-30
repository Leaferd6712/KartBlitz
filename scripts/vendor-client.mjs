import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({entryPoints:[path.join(root,'sim/customisation.mjs')],outfile:path.join(root,'ui/customisation.bundle.js'),bundle:true,format:'iife',globalName:'KartBlitzCustomisation',target:'es2022',minify:true});
await build({ entryPoints: [path.join(root, 'ui/car-preview.js')], outfile: path.join(root, 'ui/car-preview.bundle.js'), bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'eof' });
await mkdir(path.join(root, 'ui/fonts'), { recursive: true });
for (const weight of [400,700,800,900]) {
  const filename = `nunito-latin-${weight}-normal.woff2`;
  await copyFile(path.join(root, 'node_modules/@fontsource/nunito/files', filename), path.join(root,'ui/fonts',filename));
}
await copyFile(path.join(root,'node_modules/@fontsource/nunito/LICENSE'), path.join(root,'ui/fonts/OFL.txt'));
await copyFile(path.join(root,'node_modules/three/LICENSE'), path.join(root,'ui/THREE-LICENSE.txt'));
console.log('Built local vehicle preview and fonts. No runtime CDN is required.');
