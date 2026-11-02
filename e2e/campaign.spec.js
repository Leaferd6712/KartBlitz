import {test,expect} from './fixtures/game.js';
import {officialTracks} from '../ml_training/official-worker.mjs';

test('campaign labels active slots and hands over only at a camera boundary',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const first='a'.repeat(32),second='b'.repeat(32);let run=first;
  const t=officialTracks[0],track={id:0,name:t.name,width:t.trackWidth,length:t.totalLen,spline:t.spline,cum:t.cum,cpLines:t.cpLines};
  const p=t.spline[20],car={...p,a:0,speed:100,ersCharge:.75,ersActive:true,drsActive:true,drsInZone:true};
  await page.route('**/api/official/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/campaign'))return route.fulfill({json:{phase:'training',activeCount:2,queuedCount:7,trainStop:1793644800,deadline:1793648400,
      resources:{onMains:true,gpuUtilPercent:40,gpuUsedMiB:1500,gpuTotalMiB:8151,sharedGpuMiB:0,ramPercent:70,cpuPercent:80},
      active:[{id:run,slot:0,track:run===first?0:1,trackName:run===first?'Sunset Speedway':'Meadow Park',difficulty:'extreme',stage:'solo',phase:'learning',steps:1000,attempts:5}]}});
    if(url.pathname.endsWith('/status'))return route.fulfill({json:{ready:true,cudaAvailable:true,deviceName:'Test GPU'}});
    if(url.pathname.endsWith('/replays'))return route.fulfill({json:{attempts:[{attempt:5,finished:true,mode:'ai',points:[{...car,t:0},{...car,x:car.x+100,t:30}]}]}});
    return route.fulfill({json:{id:url.pathname.split('/').at(-1),status:'running',phase:'learning',runName:'Test campaign',trackId:0,difficulty:'extreme',track,
      preview:{batch:0,batchCount:1,environments:[{environment:0,episode:1,mode:'ai',car,reward:5,path:[{...car,t:0},{...car,t:2}]}]}}});
  });
  await page.goto('/ui/campaign.html?slot=0&trainerCode=test');await page.locator('#password').fill('KartBlitzPass');await page.locator('#unlock button').click();
  await expect(page.locator('#summary')).toContainText('2 active trainings');await expect(page.locator('#title')).toContainText('Sunset Speedway');
  const frame=page.frameLocator('#viewer');await expect(frame.locator('#om-camera')).toBeVisible();
  await expect(frame.locator('#om-car-status')).toContainText('recorded attempt 5');
  await frame.locator('body').evaluate((_,id)=>window.parent.postMessage({type:'kartblitz-camera-started',jobId:id},location.origin),first);
  run=second;await expect(page.locator('#message')).toContainText('Next: Meadow Park');
  await expect(page.locator('#viewer')).toHaveAttribute('src',new RegExp(first));
  await frame.locator('body').evaluate((_,id)=>window.parent.postMessage({type:'kartblitz-camera-lap-ended',jobId:id},location.origin),first);
  await expect(page.locator('#viewer')).toHaveAttribute('src',new RegExp(second));
  expect(errors).toEqual([]);
});
