/** Check shipped resources at a GitHub Pages subpath, not only the repository root. */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'public');
const manifest=JSON.parse(await readFile(path.join(output,'asset-manifest.json'),'utf8'));
const base=new URL('https://example.test/KartBlitz/');
let checked=0;
for(const file of manifest.files) {
  assert.ok(!file.startsWith('/')&&!file.includes('..'),'Manifest paths must stay relative');
  assert.ok(!/(^|\/)(\.git|node_modules|\.dev.vars|test-results)(\/|$)/.test(file),'Development files must not ship');
  await access(path.join(output,file));
  if(!/\.(html|css|m?js)$/.test(file)||file.endsWith('.bundle.js'))continue;
  const text=await readFile(path.join(output,file),'utf8');
  const staticRefs=file.endsWith('.html')?[...text.matchAll(/(?:src|href)="([^"#]+)"/g)]:file.endsWith('.css')?[...text.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)]:[...text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)];
  const references=staticRefs.map(m=>({ref:m[1],documentRelative:false}));
  if(/\.m?js$/.test(file)) {
    // DOM URLs resolve against the HTML document, whereas imports resolve against the script.
    references.push(...[...text.matchAll(/(?:loadScript\(\s*|\.(?:src|href)\s*=\s*)['"]([^'"]+)['"]/g)].map(m=>({ref:m[1],documentRelative:true})));
  }
  for(const {ref,documentRelative} of references) {
    if(/^(https?:|data:|#|mailto:|javascript:)/.test(ref)||!/[./]/.test(ref))continue;
    if(!/\.(css|js|mjs|svg|png|woff2)([?#]|$)/.test(ref))continue;
    const url=new URL(ref,documentRelative?base:new URL(file,base));
    assert.ok(url.pathname.startsWith(base.pathname),`${file}: ${ref} escapes the Pages subpath`);
    await access(path.join(output,decodeURIComponent(url.pathname.slice(base.pathname.length))));checked++;
  }
}
const versions=await Promise.all(['package.json','desktop/package.json','core/game-manifest.json'].map(async file=>JSON.parse(await readFile(path.join(root,file),'utf8')).version));
assert.equal(new Set(versions).size,1,'Keep browser, package and desktop versions aligned');
const readme=await readFile(path.join(root,'README.md'),'utf8');
for(const target of [...readme.matchAll(/(?:\]\(|src=")([^"\s)]+)[")]/g)].map(m=>m[1])) {
  if(!/^(https?:|#)/.test(target))await access(path.resolve(root,decodeURIComponent(target.split(/[?#]/)[0])));
  if(target.startsWith('https://leaferd6712.github.io/KartBlitz/')) {
    const relative=decodeURIComponent(new URL(target).pathname.slice('/KartBlitz/'.length)) || 'index.html';
    assert.ok(manifest.files.includes(relative),`README launch target is missing from the web build: ${relative}`);
  }
}
console.log(`Runtime verified: ${manifest.files.length} assets, ${checked} relative references, aligned versions and README links.`);
