const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {resolveAsset}=require('./asset-policy.cjs');
const root=path.resolve('desktop/game'),allowed=new Set(['index.html','ui/game-ui.css']);
test('only manifested runtime assets are served',()=>{
  assert.equal(resolveAsset('kbapp://game/',root,allowed).file,path.join(root,'index.html'));
  assert.match(resolveAsset('kbapp://game/ui/game-ui.css?v=1',root,allowed).type,/text\/css/);
  for(const url of ['https://game/index.html','kbapp://evil/index.html','kbapp://game/.dev.vars','kbapp://game/desktop/main.cjs','kbapp://game/%2e%2e/README.md','kbapp://game/%5c..%5cLICENSE','kbapp://game/%00']) assert.throws(()=>resolveAsset(url,root,allowed));
});
