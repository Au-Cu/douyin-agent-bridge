import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createPreviewServer} from '../scripts/ui-preview.mjs';
import {launchTestBrowser} from './browser.mjs';

test('login success uses the top-center six-second notice in both layouts without reopening on polling',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);
  if(!browser){server.close();return;}
  const root=fileURLToPath(new URL('../data/ui-review/notices/',import.meta.url));await mkdir(root,{recursive:true});
  try{for(const layout of ['modern','classic']){
    state.runtime.browserLoggedIn=true;state.runtime.loginCompletedAt=Date.now();
    const page=await browser.newPage({viewport:{width:1280,height:900}});await page.clock.install();
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#workbench'));
    await page.locator('#noticeText').filter({hasText:'抖音登录成功'}).waitFor();assert.equal(await page.locator('#setupPrompt').isVisible(),false);
    const box=await page.locator('#notice').boundingBox();assert.ok(Math.abs(box.y-18)<2);assert.ok(Math.abs(box.x+box.width/2-640)<2);
    await page.screenshot({path:join(root,'login-'+layout+'.png')});await page.mouse.move(0,0);await page.clock.fastForward(6100);assert.equal(await page.locator('#notice').isVisible(),false);await page.clock.fastForward(10000);assert.equal(await page.locator('#notice').isVisible(),false);await page.clock.resume();
    if(layout==='modern')await page.locator('a[data-view="settings"]').click();
    if(!await page.locator('#storagePanel').evaluate(e=>e.open))await page.locator('#storagePanel>summary').click();
    await page.route('**/api/storage/backup',route=>route.fulfill({status:400,json:{error:'操作错误轻提示'}}));
    await page.setViewportSize({width:390,height:844});await page.locator('#backupNow').scrollIntoViewIfNeeded();const before=await page.evaluate(()=>scrollY);
    await page.locator('#backupNow').click();await page.locator('#noticeText').filter({hasText:'操作错误轻提示'}).waitFor();
    const mobile=await page.locator('#notice').boundingBox();assert.ok(Math.abs(mobile.y-12)<2);assert.ok(Math.abs(mobile.x+mobile.width/2-195)<2);assert.ok(Math.abs(await page.evaluate(()=>scrollY)-before)<3);
    await page.screenshot({path:join(root,'error-mobile-'+layout+'.png')});await page.mouse.move(0,0);await page.clock.fastForward(6100);assert.equal(await page.locator('#notice').isVisible(),false);await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
