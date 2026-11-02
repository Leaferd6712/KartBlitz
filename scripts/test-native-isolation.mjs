/** Actual browser regression for the hidden-spectator respawn/DNF bug. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {officialTracks} from '../ml_training/official-worker-v2.mjs';
import {PHYSICS_HASH,trackFingerprint} from '../sim/official-policy.mjs';
import {OBSERVATION_NAMES,ACTION_NAMES} from '../sim/official-policy-v2.mjs';
fs.mkdirSync(path.resolve('ml_training/runs'),{recursive:true});
const output=fs.mkdtempSync(path.resolve('ml_training/runs/isolation-check-'));
const pack={format:'kartblitz-official-track-v2',modelGeneration:2,name:'Isolation fixture',trackId:0,
  physicsHash:PHYSICS_HASH,trackFingerprint:trackFingerprint(officialTracks[0]),observationVersion:2,observationCount:57,
  observationNames:OBSERVATION_NAMES,actionNames:ACTION_NAMES,actionCount:4,
  variants:{extreme:{id:'isolation',policy:{layers:[{kernel:Array.from({length:4},()=>Array(57).fill(0)),bias:[0,1,-1,-1]}]}}}};
const candidate=path.join(output,'fixture.json'),report=path.join(output,'report.json');fs.writeFileSync(candidate,JSON.stringify(pack));
const result=spawnSync(process.execPath,['scripts/energy-browser-check.mjs',candidate,'extreme',report,'--offline-assets','--isolation-smoke'],{stdio:'inherit'});
if(result.status!==0)throw Error('Native isolation runner failed');
const data=JSON.parse(fs.readFileSync(report,'utf8'));assert.equal(data.approved,false);
for(const row of data.cases){assert.equal(row.spectatorIntrusionTicks,0);assert.equal(row.measuredOpponentCount,0);assert.equal(row.defensiveReversalFlags,0);}
const race=data.cases.find(r=>r.arm==='Legacy'&&r.mode==='ai');assert(race.finished&&race.valid);assert.equal(race.lapTimes.length,3);assert(race.raceTime>30,'Spectator must not auto-DNF a race after 30 seconds');
assert(race.initialDrivingState.speed>0,'Capture the real native launch speed, not an assumed standing reset');assert.equal(race.initialDrivingState.opponents.length,0);
console.log('Native isolation: solo stays solo, inactive Shootout kart is safe, and a complete three-lap race runs beyond 30 seconds.');
