import {test,expect,gotoGame} from './fixtures/game.js';

async function open(page){
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  await page.locator('#om-password').fill('KartBlitzPass');
  await page.locator('#om-unlock button').click();
  await page.locator('#om-url').fill(new URL(page.url()).origin);
}

test('GPU workload defaults reach the trainer and measured telemetry is displayed',async({page})=>{
  await open(page);let submitted;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/official/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/status'))return route.fulfill({json:{ready:true,cudaAvailable:true,deviceName:'RTX 5070',torchVersion:'test'}});
    if(path.endsWith('/jobs')){submitted=route.request().postDataJSON();return route.fulfill({json:{id:'perf-test'}});}
    return route.fulfill({json:{id:'perf-test',status:'running',phase:'learning',completedSteps:128,totalSteps:1000000,
      diagnostics:{approx_kl:.012,clip_fraction:.15,explained_variance:null},
      evaluation:{cancelled:true},budgetMode:'time',durationSeconds:7200,elapsedSeconds:60,timeRemainingSeconds:7140,
      performance:{stepsPerSecond:5207,collectionSeconds:21.2,updateSeconds:3.9,updateWallFraction:.155},
      hardware:{gpuUtilizationPercent:12,gpuMemoryUsedMiB:880,gpuMemoryTotalMiB:8151,torchAllocatedMiB:18,torchPeakAllocatedMiB:27,torchReservedMiB:30,sampleAt:1793408433}}});
  });
  await expect(page.locator('#om-budget')).toHaveValue('time');await expect(page.locator('#om-hours')).toHaveValue('2');
  await page.locator('#om-run-name').fill('Two hour test');
  await page.locator('#om-connect').click();await page.locator('#om-start').click();
  expect(submitted).toMatchObject({budgetMode:'time',durationSeconds:7200,runName:'Two hour test',numEnvs:128,workers:8,horizon:128,batchSize:2048,device:'cuda',allDifficulties:false,difficulty:'extreme',traffic:0});
  await expect(page.locator('#om-performance')).toContainText('5207 actual steps/s');
  await expect(page.locator('#om-hardware')).toContainText('12% whole-device utilization');
  await expect(page.locator('#om-hardware')).toContainText('0.86 / 7.96 GiB');
  await expect(page.locator('#om-hardware')).toContainText('Torch tensors 18.0 MiB');
  await expect(page.locator('#om-diagnostics')).toContainText('KL 0.012');
  await expect(page.locator('#om-diagnostics')).toContainText('clipped updates 15.0%');
  await expect(page.locator('#om-diagnostics')).toContainText('explained variance unavailable');
  await expect(page.locator('#om-metrics')).toContainText('Evaluation incomplete');
  await expect(page.locator('#om-metrics')).toContainText('01:59:00 remaining');
  expect(errors).toEqual([]);
});

test('partial calibration results do not replace settings until calibration finishes',async({page})=>{
  await open(page);let complete=false;
  await page.route('**/api/official/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/jobs'))return route.fulfill({json:{id:'calibration-test'}});
    return route.fulfill({json:{id:'calibration-test',kind:'benchmark',status:complete?'complete':'running',phase:complete?'benchmark-finished':'benchmark-measuring',
      benchmark:[{device:'cuda',numEnvs:64,workers:8,batchSize:1024,stepsPerSecond:6000}],
      recommendedConfig:{device:'cuda',numEnvs:64,workers:8,horizon:128,batchSize:1024},
      fastestOverall:{device:'cpu',stepsPerSecond:6100}}});
  });
  await page.locator('#om-advanced').evaluate(el=>el.open=true);await page.locator('#om-benchmark').click();await expect(page.locator('#om-benchmark-results')).toContainText('6000 steps/s');
  await expect(page.locator('#om-envs')).toHaveValue('128');await expect(page.locator('#om-device-choice')).toHaveValue('cuda');
  complete=true;await expect(page.locator('#om-envs')).toHaveValue('64');
  await expect(page.locator('#om-batch-size')).toHaveValue('1024');
  await expect(page.locator('#om-device-choice')).toHaveValue('cuda');
  await expect(page.locator('#om-message')).toContainText('compute speed, not driving quality');
});

test('simple training page explains CMD startup, time and replay without setup instructions',async({page},testInfo)=>{
  await open(page);
  await expect(page.locator('#om-command')).toHaveText('cd /d "C:\\Users\\mcmat\\Downloads\\KartBlitz"\nnpm run official:start');
  await expect(page.locator('#om-duration-preset')).toBeVisible();await expect(page.locator('#om-duration-preset')).toHaveValue('2');
  await page.locator('#om-duration-preset').selectOption('4');await expect(page.locator('#om-hours')).toHaveValue('4');
  await expect(page.locator('#om-envs')).toBeHidden();
  await page.getByRole('button',{name:'Watch current batch',exact:true}).click();await expect(page.locator('#om-message')).toContainText('Start training first');
  await page.locator('#om-duration-preset').selectOption('2');await page.locator('#official-ml').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:testInfo.outputPath('simple-training.png'),fullPage:true});
});
