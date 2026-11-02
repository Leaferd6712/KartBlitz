import assert from 'node:assert/strict';
import fs from 'node:fs';
import {officialTracks} from '../../ml_training/official-worker.mjs';
import {analyseLoop,analysePitLane,resampleLoop} from '../road-clearance.mjs';
const backup=JSON.parse(fs.readFileSync(new URL('../../backups/tracks/before-wide-2026-11-02.json',import.meta.url),'utf8'));
const bakes=JSON.parse(fs.readFileSync(new URL('../tracks/bakes.json',import.meta.url),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
for(const track of officialTracks){
  const before=backup.baseline.find(t=>t.id===track.id),bake=bakes.tracks[track.id];
  assert.equal(track.trackWidth,before.width*2.5);
  assert.equal(track.geometryVersion,2);
  const road=analyseLoop(resampleLoop(track.spline,track.trackWidth*.075),track.trackWidth,{details:false});
  assert(road.safe,track.name+': widened road clearance');
  const pits=analysePitLane(resampleLoop(track.spline,30),track.trackWidth,{...track.pitLane,path:track.pitLane.rawPath});
  assert(pits.safe,track.name+': pit clearance');
  for(const key of ['trackWidth','spline','cum','totalLen','cpLines','drsZones','startPos','startAngle','gridSlots','pitLane'])assert.deepEqual(plain(bake[key]),plain(track[key]),track.name+': canonical online '+key);
  assert.equal(track.pitLane.width,before.pitLane.width,'Pit lane and car scale must not inflate');
}
console.log('All 8 tracks: full 2.5× width, road/pit separation, and identical online/offline/training geometry.');
