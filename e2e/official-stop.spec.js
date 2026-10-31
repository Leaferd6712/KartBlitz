import {test,expect,gotoGame} from './fixtures/game.js';

async function setup(page,{benchmark=false,failStop=false}={}){
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  await page.locator('#om-password').fill('KartBlitzPass');await page.locator('#om-unlock button').click();await page.locator('#om-url').fill(new URL(page.url()).origin);
  const track=await page.evaluate(()=>{const t=TRACKS[0];return {id:0,name:t.name,width:t.trackWidth,length:t.totalLen,spline:t.spline,cum:t.cum,cpLines:t.cpLines};});
  const p=track.spline[20],q=track.spline[21],car={id:1,...p,a:Math.atan2(q.y-p.y,q.x-p.x),speed:100};
  const state={status:benchmark?'complete':'running',failPoll:false,controls:0};
  await page.route('**/api/official/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/control')){
      state.controls++;if(failStop)return route.abort();
      state.status='cancelled';return route.fulfill({json:{ok:true,status:'stopping'}});
    }
    if(path.endsWith('/jobs'))return route.fulfill({json:{id:'stop-test'}});
    if(state.failPoll)return route.abort();
    return route.fulfill({json:{id:'stop-test',status:state.status,kind:benchmark?'benchmark':'training',phase:benchmark?'benchmark-finished':'learning',completedSteps:128,totalSteps:benchmark?0:1000000,track,preview:{batch:0,batchCount:1,environments:[{environment:0,episode:1,mode:'ai',time:2,progress:.1,reward:3,car,path:[{...car,t:0},{...car,x:car.x+200,t:2}]}]}}});
  });
  await page.locator('#om-start').click();await expect(page.locator('#om-car-status')).toContainText('Car 0');return state;
}
async function expectFrozen(page){
  const before=await page.locator('#om-car-status').textContent();
  // Observe beyond one second of playback; an animating cached clip changes its timestamp.
  await page.evaluate(()=>new Promise(resolve=>{const start=performance.now();requestAnimationFrame(function frame(now){if(now-start>1100)resolve();else requestAnimationFrame(frame);});}));
  await expect(page.locator('#om-car-status')).toHaveText(before);
}

test('Stop and save freezes the car and waits for confirmed cancellation',async({page})=>{
  const state=await setup(page);await expect(page.locator('#om-view-title')).toHaveText('Live training batch');
  await page.locator('#om-stop').click();await expect(page.locator('#om-message')).toContainText('Stop confirmed');
  await expect(page.locator('#om-view-status')).toContainText('cancelled');await expect(page.locator('#om-car-status')).toContainText('PREVIEW STOPPED');await expectFrozen(page);expect(state.controls).toBe(1);
});

test('a completed benchmark does not loop its last car clip or restart a finished job',async({page})=>{
  const state=await setup(page,{benchmark:true});await expect(page.locator('#om-view-status')).toContainText('Benchmark complete');
  await expect(page.locator('#om-metrics')).toContainText('Benchmark · complete');await expect(page.locator('#om-metrics')).not.toContainText('/ 0');await expectFrozen(page);
  await page.locator('#om-stop').click();await expect(page.locator('#om-message')).toContainText('already finished');expect(state.controls).toBe(0);
});

test('a failed stop request freezes playback but does not claim training has stopped',async({page})=>{
  await setup(page,{failStop:true});await page.locator('#om-stop').click();await expect(page.locator('#om-message')).toContainText('STOP NOT CONFIRMED');
  await expect(page.locator('#om-view-status')).toContainText('preview frozen');await expect(page.locator('#om-car-status')).toContainText('PREVIEW STOPPED');await expectFrozen(page);
});

test('losing the polling connection freezes the last preview instead of simulating progress',async({page})=>{
  const state=await setup(page);state.failPoll=true;await expect(page.locator('#om-view-status')).toContainText('Connection lost');await expectFrozen(page);
});
