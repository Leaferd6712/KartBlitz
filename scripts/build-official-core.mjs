/** Build a headless copy of the actual offline Kart and track code. No physics reimplementation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VISUAL_ONLY = ['updateEngine','stopEngine','playLap','playFinish','playCollision','spawnSpark','spawnSmoke','spawnDust','maybeSpawnSpeedSpray','beep','getPaintColor','kartVisPose','persistTrialPbGhost','autoSaveLapToLeaderboard'];
export function buildOfficialCore() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).find(s => s.includes('class Kart {'));
  if (!script) throw new Error('Offline Kart source was not found');
  const ast = ts.createSourceFile('game.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const registry = new Map();
  for (const node of ast.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) registry.set(node.name.text, { node, code: node.getText(ast) });
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const keyword = node.declarationList.flags & ts.NodeFlags.Const ? 'const' : node.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
      registry.set(declaration.name.text, { node: declaration, code: `${keyword} ${declaration.getText(ast)};` });
    }
  }
  const external = new Set([...VISUAL_ONLY, 'window','document','canvas','ctx','W','H','performance','OnlineSim','Math']);
  const selected = new Set();
  function select(name) {
    if (selected.has(name) || external.has(name)) return;
    const entry = registry.get(name); if (!entry) return;
    selected.add(name);
    const bound = new Set();
    function bindings(node) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) bound.add(node.name.text);
      ts.forEachChild(node, bindings);
    }
    bindings(entry.node);
    function references(node) {
      if (ts.isIdentifier(node) && registry.has(node.text) && !bound.has(node.text)) {
        const parent = node.parent;
        const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
        if (!property) select(node.text);
      }
      ts.forEachChild(node, references);
    }
    references(entry.node);
  }
  ['Kart','TRACKS','finalizeTrack','applyStockPerformanceToKart','applyWeatherToKart','applyShootoutBoost','race','BINDINGS','touchMode'].forEach(select);
  const declarations = [...registry].filter(([name]) => selected.has(name)).map(([, entry]) => entry.code).join('\n');
  if (/\b(?:document\.getElement|localStorage\.)/.test(declarations.replace(/function[\s\S]*/, ''))) throw new Error('Unexpected UI initializer in headless core');
  const hash = createHash('sha256').update(declarations.replace(/\r\n/g,'\n'))
    .update(fs.readFileSync(path.join(root,'online-sim.js'),'utf8').replace(/\r\n/g,'\n'))
    .update(fs.readFileSync(path.join(root,'sim/official-policy.mjs'),'utf8').replace(/\r\n/g,'\n')).digest('hex');
  const factory = `const window = host; const performance = {now:()=>host.time};
    const Math = Object.create(globalThis.Math); Math.random=()=>host.random();
    const OnlineSim = host.OnlineSim;
    const document = null, canvas = null, ctx = null, W=0, H=0;
    ${VISUAL_ONLY.map(name => `const ${name}=()=>{};`).join('\n')}
    ${declarations}
    TRACKS.forEach(finalizeTrack);
    return { Kart, tracks:TRACKS, applyStockPerformanceToKart, applyWeatherToKart, applyShootoutBoost,
      setWorld(value){race=value;window._raceWeather=value.weather||'dry';},
      setClock(value){host.time=value;},
      setRandom(value){host.random=value;},
      setHoldBindings(){BINDINGS.p1.ersMode=BINDINGS.p2.ersMode='hold';BINDINGS.p1.drsMode=BINDINGS.p2.drsMode='hold';}
    };`;
  const output = `// Generated from index.html by scripts/build-official-core.mjs.\nexport const PHYSICS_HASH=${JSON.stringify(hash)};\nexport function createOfficialGame(options={}){\nconst host={time:0,random:Math.random,_raceWeather:'dry',...options};\nreturn new Function('host',${JSON.stringify(factory)})(host);\n}\n`;
  fs.writeFileSync(path.join(root, 'sim/official-game.mjs'), output);
  fs.writeFileSync(path.join(root, 'sim/official-contract.mjs'), `// Generated physics compatibility contract.\nexport const PHYSICS_HASH=${JSON.stringify(hash)};\nexport const OBSERVATION_VERSION=1;\n`);
  return { hash, declarations: selected.size, bytes: output.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(buildOfficialCore());
