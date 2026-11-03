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
const results=[],errors=[];let page;
const check=async(name,fn)=>{if(await page?.locator('#closeNotice').isVisible())await page.locator('#closeNotice').click();await fn();results.push(name);console.log('PASS '+name);};
try {
  page=await browser.newPage({viewport:{width:1440,height:1080},colorScheme:'light'});page.on('pageerror',e=>errors.push(e.message));
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
    await page.locator('a[data-view="settings"]').click();await page.locator('#commandsPanel>summary').click();
    await page.locator('a[data-view="workbench"]').click();await page.locator('[data-fold-key="commands"]>summary').click();
    await page.locator('.retry-details>summary').click();
    await page.evaluate(()=>window.retryNode=document.querySelector('.retry-details'));
    state.work.find(w=>w.id==='demo-task-24').detail+=' 调度详情更新。';
    await page.waitForFunction(()=>document.querySelector('[data-operation="demo-task-24"] .work-detail').textContent.includes('详情更新'));
    assert.ok(await page.evaluate(()=>document.querySelector('#commandsPanel').open&&document.querySelector('[data-fold-key="commands"]').open&&document.querySelector('.retry-details').open&&window.retryNode===document.querySelector('.retry-details')));
  });
  await check('dirty model form and option focus survive polls',async()=>{
    await page.locator('a[data-view="settings"]').click();if(!await page.locator('#modelPanel').evaluate(e=>e.open))await page.locator('#modelPanel>summary').click();
    await page.locator('#defaultModel').selectOption('gpt-6-astra');await page.locator('#defaultEffort').selectOption('max');await page.locator('#contextBudget').fill('65000');await page.locator('#defaultEffort').focus();
    await page.evaluate(()=>window.formProbe={focus:document.activeElement,option:document.querySelector('#defaultEffort option[value="max"]')});
    const synced=await page.locator('#syncStatus').textContent();await page.waitForFunction(previous=>document.querySelector('#syncStatus').textContent!==previous,synced);
    assert.equal(await page.locator('#defaultModel').inputValue(),'gpt-6-astra');assert.equal(await page.locator('#contextBudget').inputValue(),'65000');
    assert.ok(await page.evaluate(()=>window.formProbe.focus===document.activeElement&&window.formProbe.option===document.querySelector('#defaultEffort option[value="max"]')));
    await page.locator('#savePreferences').click();assert.equal(state.config.model,'gpt-6-astra');assert.equal(state.config.contextBudget,65000);
    await page.locator('a[data-view="dispatch"]').click();await page.locator('#targetsPanel>summary').click();await page.locator('#loadThreads').click();await page.waitForFunction(()=>document.querySelector('#threadSelect').options.length===3);
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
      for(const view of ['workbench','chats','library','dispatch','settings']){
        await page.locator('a[data-view="'+view+'"]').click();
        if(view==='library'){await page.locator('.knowledge-summary>summary').first().click();}
        const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width,JSON.stringify({view,...sizes}));
        if(width===390)await page.screenshot({path:join(root,'mobile-'+view+'.png'),fullPage:true});
      }
    }
  });

  await check('conversation directory scopes controls and history and becomes list/detail on mobile',async()=>{
    await page.setViewportSize({width:1440,height:1080});
    await page.locator('a[data-view="chats"]').click();
    await page.locator('#chatSearch').fill('设计讨论');
    assert.equal(await page.locator('#chatDirectory a[href="#chats/peer/demo-single"]').count(),0);
    await page.locator('#chatSearch').fill('');
    await page.locator('#chatDirectory a[href="#chats/peer/demo-group"]').click();
    await page.locator('#botHistory').filter({hasText:'这段视频的关键交互是什么'}).waitFor();
    assert.equal(await page.locator('#botHistory').getByText('这是一条独立的演示单聊记录。').count(),0);
    assert.equal(await page.locator('[data-group-reset="demo-group"]').isVisible(),false);
    await page.locator('#conversationSettingsTab').click();
    assert.equal(await page.locator('[data-group-reset="demo-group"]').isVisible(),true);
    assert.equal(await page.locator('#activeAgentModel').isVisible(),false);
    await page.screenshot({path:join(root,'desktop-conversation-settings.png'),fullPage:true});
    await page.locator('#conversationHistoryTab').click();
    await page.screenshot({path:join(root,'desktop-conversations.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#chatSearch').isVisible(),false);
    assert.equal(await page.locator('#chatBack').isVisible(),true);
    await page.screenshot({path:join(root,'mobile-conversation.png'),fullPage:true});
    await page.locator('#chatBack').click();await page.locator('#chatSearch').waitFor();
    assert.equal(await page.locator('#conversationDetail').isVisible(),false);
    await page.locator('#chatDirectory a[href="#chats/peer/demo-single"]').click();
    await page.locator('#botHistory').filter({hasText:'这是一条独立的演示单聊记录'}).waitFor();
    assert.equal(await page.locator('[data-group-reset]').count(),0);
    assert.equal(await page.locator('#botHistory').getByText('发送受阻，等待重试').isVisible(),true);
    assert.equal(await page.locator('#consoleVersion').textContent(),'v'+(await (await page.request.get(new URL('/api/instance',url).href)).json()).version+' · 预览');
    await page.locator('a[data-view="workbench"]').click();
  });

  await check('workbench guides initial setup and each conversation inherits or overrides system defaults',async()=>{
    await page.setViewportSize({width:1440,height:1080});
    const backup={owner:state.config.owner,enabled:state.config.enabled,codex:state.runtime.codex,asr:state.runtime.asrReady,browser:state.runtime.browser};
    Object.assign(state.config,{owner:null,enabled:false});Object.assign(state.runtime,{codex:false,asrReady:false,browser:'select_chat'});
    await page.locator('a[data-view="workbench"]').click();await page.locator('#setupAccountLink').waitFor();
    assert.equal(await page.locator('#setupAgentLink').isVisible(),true);assert.equal(await page.locator('#setupAsrLink').isVisible(),true);
    await page.locator('#setupAccountLink').click();
    await page.locator('#agentConnection').waitFor();assert.equal(await page.locator('[data-setup-return="#chats/agent/self/settings"]').isVisible(),true);
    for(const mode of ['self','assistant']){
      state.demoBindMode=mode;
      await page.locator('#startSelfBinding').click();await page.locator('#bindOwner').click();
      await page.locator('#agentBindingResult').filter({hasText:mode==='self'?'启用主号自聊':'代收助手'}).waitFor();
      await page.locator('#bindSelf').click();
      await page.waitForFunction(()=>document.querySelector('#selfBindingControls').hidden);
      assert.equal(!!state.config.owner.selfChat,mode==='self');
    }
    await page.locator('#chatDirectory a[href="#chats/agent/self"]').click();await page.locator('#conversationSettingsTab').click();
    assert.equal(await page.locator('[data-setup-return="#chats/agent/self/settings"]').isVisible(),false);
    await page.locator('#instanceVisualFps').selectOption('8');await page.locator('#instanceVideoMinutes').fill('2');
    await page.locator('#saveInstancePreferences').click();await page.waitForFunction(()=>!document.querySelector('#saveInstancePreferences').disabled);
    const key='conversation:'+JSON.stringify(['agent','demo-self','111111']);
    assert.equal(state.config.conversationOverrides[key].visualFps,8);assert.equal(state.config.visualFps,4);
    await page.locator('#chatDirectory a[href="#chats/agent/assistant"]').click();await page.locator('#conversationSettingsTab').click();
    assert.equal(await page.locator('#instanceVisualFps').inputValue(),'');
    state.demoBindMode='self';
    await page.locator('#startSelfBinding').click();await page.locator('#bindOwner').click();
    await page.locator('#agentBindingResult').filter({hasText:'当前登录的就是主号'}).waitFor();
    assert.equal(await page.locator('#bindSelf').isDisabled(),true);
    await page.locator('#cancelSelfBinding').click();state.demoBindMode='assistant';
    await page.locator('#chatDirectory a[href="#chats/peer/demo-group"]').click();await page.locator('#conversationSettingsTab').click();
    await page.locator('#instanceBudget').fill('8000');await page.locator('#saveInstancePreferences').click();
    await page.waitForFunction(()=>!document.querySelector('#saveInstancePreferences').disabled);
    assert.equal(state.config.conversationOverrides['conversation:'+JSON.stringify(['chat','demo-group',''])].contextBudget,8000);
    await page.locator('#instanceSystemDefaults').click();await page.locator('#chatsPanel').waitFor();assert.equal(await page.locator('#chatsPanel').evaluate(e=>e.open),true);
    assert.equal(await page.locator('#modelPanel').evaluate(e=>e.closest('.system-defaults')===document.querySelector('#chatsPanel').closest('.system-defaults')),true);
    assert.equal(await page.locator('#appearanceSection #themeToggle').count(),1);assert.equal(await page.locator('.app-header #themeToggle').count(),0);
    Object.assign(state.config,{owner:backup.owner,enabled:backup.enabled});Object.assign(state.runtime,{codex:backup.codex,asrReady:backup.asr,browser:backup.browser});
  });

  await check('fresh Agent and transcription setup show the next action and return to the workbench',async()=>{
    const {auth}=state.runtime,{coordinator}=state.config,{current}=state.conversations;
    state.runtime.auth={status:'login'};
    state.config.coordinator='';
    state.conversations.current=null;
    state.runtime.asrReady=false;
    await page.locator('a[data-view="workbench"]').click();
    await page.locator('#setupAgentLink').click();
    await page.locator('#beginCodexLogin').waitFor();
    assert.equal(await page.locator('#createCoordinator').isDisabled(),true);
    await page.locator('#beginCodexLogin').click();
    await page.locator('#codexLoginLink').waitFor();
    assert.equal(await page.locator('#codexLoginLink').getAttribute('href'),'https://auth.openai.com/');
    state.runtime.auth={status:'ready'};
    await page.locator('#createCoordinator').click();
    await page.locator('#agentSetupStatus').filter({hasText:'个人 Agent 已就绪'}).waitFor();
    await page.locator('[data-setup-return="#settings/runtime"]').click();
    await page.locator('#setupAsrLink').click();
    await page.locator('#setupAsr').click();
    await page.locator('#asrSetupStatus').filter({hasText:'正在解压'}).waitFor();
    Object.assign(state.runtime,{asrReady:true,asrInstalling:false});
    await page.locator('#asrSetupStatus').filter({hasText:'口播转写已就绪'}).waitFor();
    await page.locator('[data-setup-return="#settings/transcription"]').click();
    assert.equal(await page.locator('#setupAgentLink').isVisible(),false);
    assert.equal(await page.locator('#setupAsrLink').isVisible(),false);
    Object.assign(state.runtime,{auth,asrProgress:''});
    state.config.coordinator=coordinator;
    state.conversations.current=current;
  });

  await check('within-conversation navigation preserves scroll and setup return links depend on how the page was opened',async()=>{
    await page.setViewportSize({width:1280,height:720});
    await page.locator('a[data-view="chats"]').click();await page.locator('#chatDirectory a[href="#chats/peer/demo-group"]').click();
    await page.locator('#activeChatRecords').evaluate(e=>e.style.minHeight='960px');
    await page.locator('#activeChatSettings').evaluate(e=>e.style.minHeight='960px');
    await page.evaluate(()=>scrollTo(0,225));
    await page.locator('#conversationSettingsTab').evaluate(e=>e.click());
    await page.waitForFunction(()=>!document.querySelector('#activeChatSettings').hidden);
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-225)<=2);
    await page.locator('#conversationHistoryTab').evaluate(e=>e.click());
    await page.waitForFunction(()=>!document.querySelector('#activeChatRecords').hidden);
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-225)<=2);
    assert.equal(await page.locator('#chatDirectory a[href="#chats/account"]').count(),0);
    await page.setViewportSize({width:390,height:844});
    await page.locator('#chatBack').evaluate(e=>e.click());await page.locator('#chatSearch').waitFor();
    await page.locator('#chatDirectory').evaluate(e=>e.style.minHeight='960px');
    await page.evaluate(()=>scrollTo(0,210));
    await page.locator('#chatDirectory a[href="#chats/peer/demo-group"]').evaluate(e=>e.click());
    await page.locator('#chatBack').waitFor();await page.locator('#chatBack').evaluate(e=>e.click());
    await page.waitForFunction(()=>Math.abs(scrollY-210)<=2);
    await page.locator('#chatDirectory').evaluate(e=>e.style.minHeight='');
    await page.locator('#activeChatRecords').evaluate(e=>e.style.minHeight='');
    await page.locator('#activeChatSettings').evaluate(e=>e.style.minHeight='');
    await page.locator('a[data-view="workbench"]').click();
    state.runtime.asrReady=false;await page.locator('#setupAsrLink').click();
    const back=page.locator('[data-setup-return="#settings/transcription"]');await back.waitFor();
    assert.equal(await page.locator('[data-setup-return="#settings/runtime"]').isVisible(),false);
    await back.click();await page.waitForURL('**/#workbench');
    state.runtime.asrReady=true;await page.locator('#setupAsrLink').waitFor({state:'hidden'});
    await page.evaluate(()=>location.hash='settings/transcription');await page.locator('#transcriptionSection').waitFor();
    assert.equal(await back.isVisible(),false);
  });
  await check('theme persists, reduced motion disables list movement',async()=>{
    await page.setViewportSize({width:1440,height:1080});await page.locator('a[data-view="settings"]').click();await page.locator('#themeToggle').click();await page.locator('a[data-view="workbench"]').click();
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
    if(!await page.locator('#chatsPanel').evaluate(e=>e.open))await page.locator('#chatsPanel>summary').click();
    await page.locator('[data-ai-reply="demo-group"]').selectOption('all');
    await page.waitForFunction(()=>!document.querySelector('[data-ai-reply="demo-group"]').disabled);
    assert.equal(state.aiChats.chats.find(c=>c.chatKey==='demo-group').groupReplyMode,'all');
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
    await page.locator('a[data-view="settings"]').click();await page.locator('#uiLayoutChoice').selectOption('classic');await page.waitForURL('**/classic.html?ui=classic#settings');await page.locator('#taskList .work-card').first().waitFor();if(!await page.locator('#modelPanel').evaluate(e=>e.open))await page.locator('#modelPanel>summary').click();await page.locator('#needScope').selectOption('archived');
    await page.locator('[data-delete-kind="need"]').click();await page.locator('#deleteDialog').waitFor();assert.match(await page.locator('#deleteLabel').textContent(),/需求 7/);
    await page.setViewportSize({width:390,height:844});const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dialog:document.querySelector('#deleteDialog').getBoundingClientRect().width}));assert.ok(sizes.scroll<=sizes.width&&sizes.dialog<=sizes.width);
    await page.locator('#deleteAcknowledge').check();await page.locator('#confirmDelete').click();await page.waitForFunction(()=>!document.querySelector('#deleteDialog').open);assert.equal(state.conversations.needs.some(n=>n.id==='demo-need-7'),false);
  });

  await check('archived learning materials require explicit deletion in both layouts',async()=>{
    const id='1000000000000000004',button=page.locator('[data-delete-kind="knowledge"][data-delete-id="'+id+'"]');
    await page.locator('#knowledgeScope').selectOption('archived');await button.click();
    await page.locator('#deleteDialog').waitFor();
    assert.match(await page.locator('#deleteCounts').textContent(),/学习资料及其本地文件/);
    assert.equal(await page.locator('#confirmDelete').isDisabled(),true);
    await page.locator('#cancelDelete').click();
    assert.ok(state.knowledge.some(k=>k.id===id));
    await page.locator('#uiLayoutChoice').selectOption('modern');await page.waitForURL('**/?ui=modern#settings');
    await page.locator('a[data-view="library"]').click();
    await page.locator('#knowledgeScope').selectOption('archived');
    await button.click();await page.locator('#deleteAcknowledge').check();await page.locator('#confirmDelete').click();
    await page.waitForFunction(()=>!document.querySelector('#deleteDialog').open);
    assert.equal(state.knowledge.some(k=>k.id===id),false);assert.equal(state.knowledge.length,3);
    await page.locator('a[data-view="workbench"]').click();
  });
  await check('errors stay visible while scrolled, fit narrow screens, preserve position and can be dismissed in both layouts',async()=>{
    await page.route('**/api/storage/backup',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'测试报错：未能完成备份。请检查磁盘空间。\n'+ '较长的排查说明，'.repeat(70)})}));
    for(const layout of ['classic','modern']){
      if(await page.locator('html').getAttribute('data-layout')!==layout){if(layout==='classic')await page.locator('a[data-view="settings"]').click();await page.locator('#uiLayoutChoice').selectOption(layout);await page.waitForFunction(l=>document.documentElement.dataset.layout===l,layout);await page.locator('#storagePanel').waitFor();}
      if(layout==='modern')await page.locator('a[data-view="settings"]').click();
      if(!await page.locator('#storagePanel').evaluate(e=>e.open))await page.locator('#storagePanel>summary').click();
      for(const width of [320,1440]){
        await page.setViewportSize({width,height:844});await page.locator('#backupNow').scrollIntoViewIfNeeded();const before=await page.evaluate(()=>scrollY);await page.locator('#backupNow').click();await page.locator('#noticeText').filter({hasText:'测试报错'}).waitFor();
        const state=await page.evaluate(()=>{const n=document.querySelector('#notice'),r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:innerWidth,height:innerHeight,scroll:scrollY,documentWidth:document.documentElement.scrollWidth,focused:n.contains(document.activeElement),role:n.getAttribute('role')};});
        assert.ok(state.top>=14&&state.top<=24&&state.bottom<=state.height&&state.left>=0&&state.right<=state.width);assert.ok(Math.abs((state.left+state.right)/2-state.width/2)<2);assert.ok(state.documentWidth<=state.width);assert.ok(Math.abs(state.scroll-before)<3);assert.equal(state.focused,false);assert.equal(state.role,'alert');
        if(width===320)await page.screenshot({path:join(root,'floating-error-'+layout+'.png')});
        await page.locator('#closeNotice').click();assert.equal(await page.locator('#notice').isVisible(),false);
      }
    }await page.unroute('**/api/storage/backup');
  });
  await check('top-centred error expires automatically without moving focus or scrolling',async()=>{
    await page.route('**/api/storage/backup',route=>route.fulfill({status:400,json:{error:'自动消失测试'}}));
    await page.clock.install();await page.locator('#backupNow').click();await page.locator('#noticeText').filter({hasText:'自动消失测试'}).waitFor();await page.mouse.move(0,840);await page.clock.fastForward(10100);assert.equal(await page.locator('#notice').isVisible(),false);await page.clock.resume();await page.unroute('**/api/storage/backup');
  });
  await check('receipt review lists the exact uncertain emoji and text; cancelling confirmation does not resolve or resend',async()=>{
    let rows=[{id:'review-emoji',operationId:'demo-task-23',number:23,title:'确认上一轮回复',kind:'progress_reaction',status:'uncertain',label:'表情：运行 · 奋斗',body:'原消息：请分析视频',error:'点击后连接中断',created:Date.now(),canResend:false},{id:'review-text',number:23,title:'确认上一轮回复',kind:'text',status:'uncertain',label:'文字回复：第 2/3 段',body:'完整反馈第二段',error:'送达未核实',created:Date.now(),canResend:true}],resolved=[];
    await page.route('**/api/outbox/review?*',route=>route.fulfill({json:{rows}}));
    await page.route('**/api/outbox/reconcile',route=>route.fulfill({json:{verified:false,reason:'原消息菜单未提供本账号选中证据，未点击表情。'}}));
    await page.route('**/api/outbox/resolve',async route=>{const body=route.request().postDataJSON();resolved.push(body);rows=rows.filter(r=>r.id!==body.id);await route.fulfill({json:{ok:true}});});
    await page.locator('a[data-view="workbench"]').click();await page.locator('#workScope').selectOption('current');await page.locator('#workStatus').selectOption('all');await page.locator('[data-operation="demo-task-23"] [data-review-kind]').click();
    await page.locator('#deliveryReviewDialog').waitFor();assert.equal(await page.locator('[data-ui-key="review:review-emoji"] [data-review-status="pending"]').count(),0);
    await page.locator('[data-review-reconcile="review-emoji"]').click();await page.locator('#reviewError').filter({hasText:'未点击表情'}).waitFor();
    let batches=0;await page.route('**/api/outbox/reconcile-batch',route=>{if(route.request().method()==='POST'){assert.deepEqual(route.request().postDataJSON(),{kind:'task',id:'demo-task-23'});batches++;}return route.fulfill({json:{batch:{status:'done',checked:2,total:2,verified:1,unresolved:1,waiting:0}}});});await page.locator('#reconcileReviewBatch').click();await page.locator('#reviewBatchStatus').filter({hasText:'已确认 1 条'}).waitFor();assert.equal(batches,1);assert.equal(resolved.length,0);await page.unroute('**/api/outbox/reconcile-batch');
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-review-resolve="review-text"][data-review-status="sent"]').click();assert.equal(resolved.length,0);
    page.once('dialog',dialog=>dialog.accept());await page.locator('[data-review-resolve="review-emoji"][data-review-status="abandoned"]').click();await page.waitForFunction(()=>!document.querySelector('[data-ui-key="review:review-emoji"]'));assert.deepEqual(resolved,[{id:'review-emoji',status:'abandoned',confirmed:true}]);
    await page.locator('#closeDeliveryReview').click();await page.unroute('**/api/outbox/review?*');await page.unroute('**/api/outbox/reconcile');await page.unroute('**/api/outbox/resolve');
  });
  await check('preview cannot execute real APIs or accept foreign-origin mutations',async()=>{
    assert.equal((await fetch(url+'/api/browser/open',{method:'POST',body:'{}'})).status,409);
    assert.equal((await fetch(url+'/api/listen',{method:'POST',headers:{Origin:'https://example.com'},body:'{"enabled":false}'})).status,403);
  });
  assert.deepEqual(errors,[]);
  await writeFile(join(root,'report.json'),JSON.stringify({ok:true,checks:results,uiErrors:errors,realAccountMessages:0,screenshots:['desktop.png','mobile-workbench.png','mobile-library.png','mobile-settings.png','dark.png','classic-desktop.png']},null,2));
  console.log(JSON.stringify({ok:true,checks:results.length,uiErrors:errors.length,realAccountMessages:0,screenshotRoot:root}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
