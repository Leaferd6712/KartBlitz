import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultLivery,ownedColours,equipColour,PAINT_COLORS} from '../customisation.mjs';
test('new players own only pure white on every part',()=>{
 assert.deepEqual(ownedColours({}),['white']);assert.ok(Object.values(defaultLivery()).every(id=>id==='white'));
 assert.equal(PAINT_COLORS[0].body,'#FFFFFF');assert.equal(PAINT_COLORS[0].shadow,'#FFFFFF');
});
test('purchase is atomic, permanent and shared; re-equipping is free',()=>{
 const original={coins:150,gems:7,programme:{nodes:{example:true}},ownedPaints:['white']};
 assert.equal(equipColour(original,'p1','chassis','red'),null);
 assert.equal(equipColour({...original,coins:99},'p1','chassis','red',{purchase:true}),null);
 const purchased=equipColour(original,'p1','chassis','red',{purchase:true});assert.equal(purchased.coins,50);assert.equal(original.coins,150);assert.equal(purchased.gems,7);assert.deepEqual(purchased.programme,original.programme);
 const reloaded=JSON.parse(JSON.stringify(purchased));const equipped=equipColour(reloaded,'p2','nose','red');assert.equal(equipped.coins,50);assert.equal(equipped.p2livery.nose,'red');assert.deepEqual(equipped.ownedPaints,['white','red']);
});
test('legacy equipped customisations remain owned without unlocking every colour',()=>{
 assert.deepEqual(new Set(ownedColours({p1paint:'red',p2livery:{nose:'gold',chassis:'stock'}})),new Set(['white','red','gold']));
 assert.deepEqual(ownedColours({ownedPaints:['white'],p1paint:'red'}),['white']);
});
