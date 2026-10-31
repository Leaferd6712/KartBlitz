import { mkdir, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfficialCore } from './build-official-core.mjs';
buildOfficialCore();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] || 'dist/game');
const outputs = new Set(['dist/game','desktop/game','public'].map(relative=>path.resolve(root,relative)));
if (!outputs.has(output)) throw new Error('Output must be one of the designated build directories');
// Absolute output is checked above; never remove a source directory.
await rm(output,{recursive:true,force:true});
await mkdir(output, { recursive: true });
const files = ['index.html','rb6.glb','ui/customisation.bundle.js','online.js','online-codec.js','online-sim.js','LICENSE','core/game-manifest.json','core/activity-host.js','core/shell.js',
  'ui/tool-entry.js','ui/lap-replay.js','ui/lap-archive.js','ui/official-ml.js','ui/ai-models.js','ui/ai-models.html','sim/tracks/bakes.json'];
for(const entry of await readdir(path.join(root,'sim'))) if(entry.endsWith('.mjs')) files.push(`sim/${entry}`);
for(const entry of await readdir(path.join(root,'ui'))) if(/\.(css|svg|txt)$/.test(entry) || ['app-icon.png','player-experience.js','platform.js','car-preview.bundle.js'].includes(entry)) files.push(`ui/${entry}`);
for(const entry of await readdir(path.join(root,'ui/fonts'))) files.push(`ui/fonts/${entry}`);
// README-linked tools are hosted alongside the website, outside the desktop player package.
if (process.argv.includes('--web')) {
  files.push('leaderboard-admin.html','patch-notes-editor.html','Old Track Editor/track-editor.html','docs/online-mode.html',
    'ml/lab.css','ml/lab.js','ml/runtime.js','ml/models/our-model.json');
  // Trainer downloads contain source files, never a bundled Python runtime.
  for(const entry of ['__init__.py','environment.py','model.py','train.py','server.py','requirements.txt','install.ps1','start.ps1','README.md','KartBlitz-ML-Setup.txt']) files.push(`ml_training/${entry}`);
}
for(const file of files) { await mkdir(path.dirname(path.join(output,file)),{recursive:true}); await cp(path.join(root,file),path.join(output,file)); }
const html = await readFile(path.join(output,'index.html'),'utf8');
for(const resource of [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m=>m[1].split(/[?#]/)[0]).filter(f=>f&&!/^(https?:|data:)/.test(f))) {
  if(resource.endsWith('.js')||resource.endsWith('.css')||resource.endsWith('.svg')) await readFile(path.join(output,resource));
}
await writeFile(path.join(output,'asset-manifest.json'),JSON.stringify({entry:'index.html',files:files.sort()},null,2)+'\n');
console.log(`Prepared ${files.length} runtime assets in ${path.relative(root,output)}.`);
