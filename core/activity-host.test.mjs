import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityHost, scopedStorage } from './activity-host.js';
function memory() { const data=new Map(); return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}; }
test('switching activities aborts input and cleans up before the next activity starts',async()=>{
  const calls=[], storage=memory(),host=createActivityHost({storage}); let signal;
  host.register({id:'racing',title:'Racing',start(context){signal=context.signal;context.own(()=>calls.push('cleanup'));context.storage.set('best',42);calls.push('start');},pause(){calls.push('pause');},resume(){calls.push('resume');},dispose(){calls.push('dispose');}});
  host.register({id:'test-activity',title:'Test',start(context){assert.equal(context.storage.get('best'),null);assert.equal(signal.aborted,true);calls.push('next');}});
  await host.start('racing');await host.pause();await host.pause();await host.resume();await host.start('test-activity');
  assert.deepEqual(calls,['start','pause','resume','dispose','cleanup','next']);
  assert.equal(scopedStorage('racing',storage).get('best'),42);await host.stop();assert.equal(host.active,null);
});
test('failed starts still release listeners, and later activities can start',async()=>{
  const host=createActivityHost({storage:memory()});let cleaned=false;
  host.register({id:'failed',start(context){context.own(()=>cleaned=true);throw new Error('expected');}});
  host.register({id:'works',start(){}});
  await assert.rejects(host.start('failed'),/expected/);assert.equal(cleaned,true);await host.start('works');assert.equal(host.active,'works');
});
test('queued launches finish in order and invalid activities cannot replace the active one',async()=>{
  const host=createActivityHost({storage:memory()}),calls=[];
  host.register({id:'one',async start(){await Promise.resolve();calls.push(1);}});host.register({id:'two',start(){calls.push(2);}});
  await Promise.all([host.start('one'),host.start('two')]);assert.deepEqual(calls,[1,2]);await assert.rejects(host.start('missing'));assert.equal(host.active,'two');
});
