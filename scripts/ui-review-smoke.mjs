import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createPreviewServer } from './ui-preview.mjs';

const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port;
const root=fileURLToPath(new URL('../data/ui-review/',import.meta.url));await mkdir(root,{recursive:true});
const browser=await chromium.launch({channel:process.env.BRIDGE_TEST_BROWSER||(process.platform==='win32'?'msedge':'chrome'),headless:true});
const results=[],errors=[];
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
try {
  const page=await browser.newPage({viewport:{width:1440,height:1080},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('[data-operation="demo-task-27"]').waitFor();
  await check('workbench hierarchy and exact task visual progress',async()=>{
    assert.equal(await page.locator('#settingsView').isVisible(),false);
    assert.match(await page.locator('#currentNeedTitle').textContent(),/需求 9/);
    assert.equal(await page.locator('[data-operation="demo-task-27"] progress').getAttribute('value'),'4');
    assert.match(await page.locator('[data-operation="demo-task-27"] .visual-facts').textContent(),/32.0 \/ 132.5/);
    assert.equal(await page.locator('[data-operation="demo-task-28"] progress').count(),0);
    assert.match(await page.locator('[data-operation="demo-task-26"] .delivery-summary').textContent(),/2 \/ 3/);
    await page.screenshot({path:join(root,'desktop.png'),fullPage:false});
  });
  await check('polling retains card identity, keyboard focus and scroll',async()=>{
    await page.locator('[data-operation="demo-task-26"] button[data-archive-kind]').focus();
    const before=await page.evaluate(()=>{window.probe={card:document.querySelector('[data-operation="demo-task-26"]'),focus:document.activeElement};return scrollY;});
    state.work[0].detail='正在逐段读取完整视频，当前片段完成后自动保存。';
    await page.waitForFunction(()=>document.querySelector('[data-operation="demo-task-27"] .work-detail').textContent.includes('当前片段'));
    const after=await page.evaluate(()=>({same:window.probe.card===document.querySelector('[data-operation="demo-task-26"]'),focus:window.probe.focus===document.activeElement,y:scrollY}));
    assert.ok(after.same&&after.focus);assert.ok(Math.abs(after.y-before)<=2);
  });
  await check('expanded help, commands and retry log survive updates',async()=>{
    await page.locator('#commandsPanel>summary').click();
    await page.locator('[data-fold-key="commands"]>summary').click();
    await page.locator('.retry-details>summary').click();
    await page.evaluate(()=>window.retryNode=document.querySelector('.retry-details'));
    state.work.find(w=>w.id==='demo-task-24').detail+=' 调度详情更新。';
    await page.waitForFunction(()=>document.querySelector('[data-operation="demo-task-24"] .work-detail').textContent.includes('详情更新'));
    assert.ok(await page.evaluate(()=>document.querySelector('#commandsPanel').open&&document.querySelector('[data-fold-key="commands"]').open&&document.querySelector('.retry-details').open&&window.retryNode===document.querySelector('.retry-details')));
  });
  await check('dirty model form and option focus survive polls',async()=>{
    await page.locator('a[data-view="settings"]').click();await page.locator('#modelPanel>summary').click();
    await page.locator('#defaultModel').selectOption('gpt-6-astra');await page.locator('#defaultEffort').selectOption('max');await page.locator('#contextBudget').fill('65000');await page.locator('#defaultEffort').focus();
    await page.evaluate(()=>window.formProbe={focus:document.activeElement,option:document.querySelector('#defaultEffort option[value="max"]')});
    const synced=await page.locator('#syncStatus').textContent();await page.waitForFunction(previous=>document.querySelector('#syncStatus').textContent!==previous,synced);
    assert.equal(await page.locator('#defaultModel').inputValue(),'gpt-6-astra');assert.equal(await page.locator('#contextBudget').inputValue(),'65000');
    assert.ok(await page.evaluate(()=>window.formProbe.focus===document.activeElement&&window.formProbe.option===document.querySelector('#defaultEffort option[value="max"]')));
    await page.locator('#savePreferences').click();assert.equal(state.config.model,'gpt-6-astra');assert.equal(state.config.contextBudget,65000);
    await page.locator('#targetsPanel>summary').click();await page.locator('#loadThreads').click();await page.waitForFunction(()=>document.querySelector('#threadSelect').options.length===3);
    const option=await page.locator('#threadSelect').evaluate(e=>({text:e.options[2].text.length,title:e.options[2].title.length,direction:getComputedStyle(e).direction}));assert.ok(option.text<option.title);assert.equal(option.direction,'ltr');
  });
  await check('status filtering, reversible archive and immediate interruption',async()=>{
    await page.locator('a[data-view="workbench"]').click();await page.locator('#workStatus').selectOption('done');
    await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1&&document.querySelector('#taskList .work-card').dataset.operation==='demo-task-22');
    assert.equal(await page.locator('#workScope').inputValue(),'all');
    await page.locator('[data-operation="demo-task-22"] [data-archive-kind]').click();assert.equal(state.work.find(w=>w.id==='demo-task-22').archived,false);
    await page.locator('#workStatus').selectOption('all');await page.locator('#workScope').selectOption('current');
    await page.locator('[data-operation="demo-task-28"] [data-interrupt-task]').click();
    await page.waitForFunction(()=>document.querySelector('[data-operation="demo-task-28"] .pill').textContent==='已取消');
    assert.equal(state.work.find(w=>w.id==='demo-task-28').status,'cancelled');
    await page.locator('[data-operation="demo-task-22"] [data-archive-kind]').click();await page.locator('#workScope').selectOption('archived');
    await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1&&document.querySelector('#taskList .work-card').dataset.operation==='demo-task-22');
  });
  await check('stale filter response never repaints a newer selection',async()=>{
    await page.locator('#workScope').selectOption('current');
    let release,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    await page.route('**/api/state**',async route=>{if(new URL(route.request().url()).searchParams.get('status')==='blocked'){const response=await route.fetch();entered();await gate;await route.fulfill({response});}else await route.continue();});
    await page.locator('#workStatus').selectOption('blocked');await reached;
    await page.locator('#workStatus').selectOption('sending');
    await page.evaluate(()=>{window.staleSeen=false;window.observer=new MutationObserver(()=>{if(document.querySelector('#taskList [data-operation="demo-task-24"]')&&document.querySelector('#workStatus').value==='sending')window.staleSeen=true;});window.observer.observe(document.querySelector('#taskList'),{childList:true,subtree:true});});
    release();await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1&&document.querySelector('#taskList .work-card').dataset.operation==='demo-task-26');
    assert.equal(await page.evaluate(()=>{window.observer.disconnect();return window.staleSeen;}),false);await page.unroute('**/api/state**');
    await page.locator('#workStatus').selectOption('all');
  });
  await check('long text and all views fit 320, 390 and 768 pixel screens',async()=>{
    state.knowledge[0].title='很长的连续标题'+ 'LongUnbrokenTitle'.repeat(35);
    state.conversations.current.summary+='\n'+'LongUnbrokenSummary'.repeat(20);
    for(const width of [320,390,768]){
      await page.setViewportSize({width,height:844});
      for(const view of ['workbench','library','settings']){
        await page.locator('a[data-view="'+view+'"]').click();
        if(view==='library'){await page.locator('.knowledge-summary>summary').first().click();}
        const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width,JSON.stringify({view,...sizes}));
        if(width===390)await page.screenshot({path:join(root,'mobile-'+view+'.png'),fullPage:true});
      }
    }
  });
  await check('theme persists, reduced motion disables list movement',async()=>{
    await page.setViewportSize({width:1440,height:1080});await page.locator('a[data-view="workbench"]').click();await page.locator('#themeToggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.reload();await page.locator('#taskList .work-card').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.screenshot({path:join(root,'dark.png'),fullPage:false});
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#workStatus').selectOption('blocked');await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1);
    assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
  });
  await check('modern and classic share data, remember choice and guard unsaved edits',async()=>{
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('a[data-view="settings"]').click();
    if(!await page.locator('#modelPanel').evaluate(e=>e.open))await page.locator('#modelPanel>summary').click();
    await page.locator('#contextBudget').fill('66000');
    await page.locator('#contextBudget').dispatchEvent('change');
    await page.locator('#uiLayoutChoice').selectOption('classic');
    assert.equal(await page.locator('html').getAttribute('data-layout'),'modern');
    assert.match(await page.locator('#notice').textContent(),/先保存/);
    await page.locator('#savePreferences').click();
    await page.waitForFunction(()=>!document.querySelector('#savePreferences').disabled&&document.querySelector('#notice').textContent.includes('默认配置已保存'));
    await Promise.all([page.waitForURL('**/classic.html?ui=classic#settings'),page.locator('#uiLayoutChoice').selectOption('classic')]);
    await page.locator('#taskList .work-card').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-layout'),'classic');
    assert.equal(await page.locator('#uiLayoutChoice').inputValue(),'classic');
    assert.equal(await page.locator('#defaultModel').inputValue(),'gpt-6-astra');
    assert.equal(await page.locator('#contextBudget').inputValue(),'66000');
    assert.match(await page.locator('#currentNeed').textContent(),/当前需求 9/);
    await page.goto(url);await page.waitForURL('**/classic.html');await page.locator('#taskList .work-card').first().waitFor();
    await page.screenshot({path:join(root,'classic-desktop.png'),fullPage:false});
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});
      const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width,'classic '+JSON.stringify(sizes));
    }
    await page.locator('#workStatus').selectOption('blocked');
    await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1&&document.querySelector('#taskList .work-card').dataset.operation==='demo-task-24');
    await page.locator('#chatsPanel>summary').click();
    await page.locator('[data-ai-reply="demo-group"]').selectOption('all');
    await page.waitForFunction(()=>!document.querySelector('[data-ai-reply="demo-group"]').disabled);
    assert.equal(state.aiChats.chats[0].groupReplyMode,'all');
    await page.locator('#uiLayoutChoice').selectOption('modern');await page.waitForURL('**/?ui=modern');await page.locator('#taskList .work-card').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-layout'),'modern');
    await page.reload();assert.equal(await page.locator('html').getAttribute('data-layout'),'modern');
  });
  await check('permanent archive deletion requires confirmation in both layouts and survives polling',async()=>{
    await page.locator('#workScope').selectOption('archived');await page.locator('[data-delete-kind="task"]').click();
    await page.locator('#deleteDialog').waitFor();
    assert.equal(await page.locator('#confirmDelete').isDisabled(),true);assert.match(await page.locator('#deleteLabel').textContent(),/任务 22/);
    await page.locator('#cancelDelete').click();assert.ok(state.work.some(w=>w.id==='demo-task-22'));
    await page.locator('[data-delete-kind="task"]').click();await page.locator('#deleteDialog').waitFor();await page.locator('#deleteAcknowledge').check();
    state.work.find(w=>w.id==='demo-task-24').detail+=' 本轮更新';
    const synced=await page.locator('#syncStatus').textContent();await page.waitForFunction(previous=>document.querySelector('#syncStatus').textContent!==previous,synced);
    assert.equal(await page.locator('#deleteAcknowledge').isChecked(),true);assert.equal(await page.locator('#confirmDelete').isEnabled(),true);
    await page.locator('#confirmDelete').click();await page.waitForFunction(()=>!document.querySelector('#deleteDialog').open);assert.equal(state.work.some(w=>w.id==='demo-task-22'),false);
    await page.locator('#uiLayoutChoice').selectOption('classic');await page.waitForURL('**/classic.html?ui=classic');await page.locator('#taskList .work-card').first().waitFor();if(!await page.locator('#modelPanel').evaluate(e=>e.open))await page.locator('#modelPanel>summary').click();await page.locator('#needScope').selectOption('archived');
    await page.locator('[data-delete-kind="need"]').click();await page.locator('#deleteDialog').waitFor();assert.match(await page.locator('#deleteLabel').textContent(),/需求 7/);
    await page.setViewportSize({width:390,height:844});const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dialog:document.querySelector('#deleteDialog').getBoundingClientRect().width}));assert.ok(sizes.scroll<=sizes.width&&sizes.dialog<=sizes.width);
    await page.locator('#deleteAcknowledge').check();await page.locator('#confirmDelete').click();await page.waitForFunction(()=>!document.querySelector('#deleteDialog').open);assert.equal(state.conversations.needs.some(n=>n.id==='demo-need-7'),false);
  });
  await check('preview cannot execute real APIs or accept foreign-origin mutations',async()=>{
    assert.equal((await fetch(url+'/api/browser/open',{method:'POST',body:'{}'})).status,409);
    assert.equal((await fetch(url+'/api/listen',{method:'POST',headers:{Origin:'https://example.com'},body:'{"enabled":false}'})).status,403);
  });
  assert.deepEqual(errors,[]);
  await writeFile(join(root,'report.json'),JSON.stringify({ok:true,checks:results,uiErrors:errors,realAccountMessages:0,screenshots:['desktop.png','mobile-workbench.png','mobile-library.png','mobile-settings.png','dark.png','classic-desktop.png']},null,2));
  console.log(JSON.stringify({ok:true,checks:results.length,uiErrors:errors.length,realAccountMessages:0,screenshotRoot:root}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
