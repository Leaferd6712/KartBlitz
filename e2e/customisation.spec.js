import {test,expect,gotoGame,dismissOnboarding,returningPlayerStorage,playerSaveJson} from './fixtures/game.js';
test('exact RB6 model loads with every paintable material white for a new player',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const model=page.waitForResponse(r=>r.url().endsWith('/rb6.glb'));
 await gotoGame(page);await dismissOnboarding(page);
 expect((await model).ok()).toBe(true);
 await expect(page.locator('#menu-car-canvas')).toHaveAttribute('data-model','rb6.glb',{timeout:20000});
 const state=await page.evaluate(()=>({owned:getPlayerData().ownedPaints,livery:getPlayerLivery('p1'),preview:getCarStageDiagnostics().menu}));
 expect(state.owned).toEqual(['white']);expect(Object.values(state.livery)).toEqual(['white','white','white','white','white']);
 for(const part of ['chassis','frontWing','rearWing','nose','accents'])expect(state.preview.colours[part]).toEqual(expect.arrayContaining(['#FFFFFF']));
 await page.evaluate(()=>pauseMenuCarStage());await page.screenshot({path:'test-results/rb6-white.png'});expect(errors).toEqual([]);
});
test('locked paint requires coins once and stays owned and equipped across reloads and racing',async({page})=>{
 await gotoGame(page,{storage:returningPlayerStorage({kartblitz_player:playerSaveJson({coins:250,gems:12,ownedPaints:['white']})})});
 expect(await page.evaluate(()=>setPlayerLiveryPart('p1','chassis','red'))).toBe(false);
 await page.getByRole('button',{name:'GARAGE',exact:true}).click();
 await page.getByRole('button',{name:'Buy RED for 100 coins',exact:true}).first().click();
 await expect.poll(()=>page.evaluate(()=>getCarStageDiagnostics().garage?.colours?.chassis?.[0])).toBe('#FF2222');
 expect(await page.evaluate(()=>getPlayerData().coins)).toBe(150);
 await page.reload();await page.waitForFunction(()=>window.KartBlitzProgramme&&window.getActiveRace);
 expect(await page.evaluate(()=>({owned:getPlayerData().ownedPaints,paint:getPlayerLivery('p1').chassis,gems:getPlayerData().gems}))).toEqual({owned:['white','red'],paint:'red',gems:12});
 expect(await page.evaluate(()=>{setPlayerLiveryPart('p1','chassis','white');setPlayerLiveryPart('p1','chassis','red');return getPlayerData().coins;})).toBe(150);
 await expect.poll(()=>page.evaluate(()=>getCarStageDiagnostics().menu?.colours?.chassis?.[0])).toBe('#FF2222');
 await page.locator('#quick-race-btn').click();await page.waitForFunction(()=>getActiveRace()?.mode==='ai');expect(await page.evaluate(()=>getActiveRace().karts[0].livery.chassis)).toBe('red');
});
