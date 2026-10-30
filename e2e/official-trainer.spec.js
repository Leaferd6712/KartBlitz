import {test,expect,gotoGame} from './fixtures/game.js';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';

test('local trainer streams real training, saves weights and replays, and accepts controls',async({page,request},testInfo)=>{
  test.skip(!existsSync('.venv-official/Scripts/python.exe'),'Local Python trainer is optional on browser-only CI');
  test.setTimeout(180000);
  const port=20000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`,headers={'X-KartBlitz-Key':'e2e-local'};
  const server=spawn('.venv-official/Scripts/python.exe',['-m','ml_training.server','--official','--port',String(port),'--pairing-code','e2e-local'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';server.stderr.on('data',b=>diagnostics+=b);
  try{
    await expect.poll(async()=>{try{return (await request.get(base+'/api/official/status')).status();}catch{return 0;}},{timeout:30000}).toBe(200);
    await page.route('**/api/official/**',route=>route.continue());
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await gotoGame(page,{path:base+'/index.html?tool=official-ml&trainerCode=e2e-local'});
    await page.locator('#om-password').fill('KartBlitzPass');await page.locator('#om-unlock button').click();
    await page.locator('#om-url').fill(base);await page.locator('#om-connect').click();await expect(page.locator('#om-device')).toContainText('Ready');
    const response=await request.post(base+'/api/official/jobs',{headers,data:{format:'kartblitz-official-job-v1',trackIds:[0],allDifficulties:false,totalSteps:4096,numEnvs:2,workers:1,horizon:32,episodeSeconds:.5,evaluationEpisodes:1,device:'cpu'}});
    expect(response.status()).toBe(202);const {id}=await response.json();
    let phase='';await expect.poll(async()=>{const s=await (await request.get(`${base}/api/official/jobs/${id}`,{headers})).json();if(s.error)throw Error(s.error+diagnostics);if(s.phase!==phase){phase=s.phase;console.log('Local trainer:',s.status,phase);}return !!s.track;},{timeout:60000}).toBe(true);
    await page.locator('#om-load-id').fill(id);await page.locator('#om-load').click();
    await expect(page.locator('#om-car-status')).toContainText('Car 0');
    await page.locator('#om-pause').click();
    await expect.poll(async()=>{const r=await request.get(`${base}/api/official/jobs/${id}`,{headers});return (await r.json()).status;}).toBe('paused');
    await page.locator('#om-resume-button').click();
    let job;
    await expect.poll(async()=>{job=await (await request.get(`${base}/api/official/jobs/${id}`,{headers})).json();if(job.status==='failed')throw Error(job.error+diagnostics);return job.status;},{timeout:60000}).toBe('complete');
    const model=await (await request.get(`${base}/api/official/jobs/${id}/model?trackId=0`,{headers})).json();expect(model.variants.extreme.policy.layers).toHaveLength(3);
    const replays=await (await request.get(`${base}/api/official/jobs/${id}/replays?cohort=early&trackId=0`,{headers})).json();expect(replays.attempts.length).toBeGreaterThan(1);
    await page.locator('#om-view').selectOption('early');await expect(page.locator('#om-message')).toContainText(`${replays.attempts.length} recorded attempts loaded`);await expect(page.locator('#om-car-status')).toContainText('Attempt');
    await page.evaluate(()=>{const root=document.getElementById('official-ml');root.scrollTop=document.getElementById('om-view-title').offsetTop-20;});
    await page.screenshot({path:testInfo.outputPath('official-training-window.png')});expect(errors).toEqual([]);
    const stopped=await request.post(base+'/api/official/jobs',{headers,data:{format:'kartblitz-official-job-v1',trackIds:[0],allDifficulties:false,totalSteps:1000000,numEnvs:2,workers:1,horizon:16,episodeSeconds:.2,evaluationEpisodes:1,device:'cpu'}});
    const next=await stopped.json();await request.post(`${base}/api/official/jobs/${next.id}/control`,{headers,data:{action:'stop'}});
    await expect.poll(async()=>{const r=await request.get(`${base}/api/official/jobs/${next.id}`,{headers});return (await r.json()).status;},{timeout:20000}).toBe('cancelled');
  }finally{
    try{await request.post(base+'/api/official/shutdown',{headers,data:{}});}catch{}
    if(server.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill();resolve();},5000);server.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
});
