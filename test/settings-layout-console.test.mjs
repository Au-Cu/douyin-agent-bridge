import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createPreviewServer} from '../scripts/ui-preview.mjs';
import {launchTestBrowser,answerConfirmation} from './browser.mjs';

const tracked=new Set(['preferences','chat-preferences','harness','chat-harness','video-preferences','config','targets','conversation-preferences','ai-chats/save','chat-sessions/reset']);
function observe(page){const calls=[];page.on('request',r=>{const path=new URL(r.url()).pathname.replace('/api/','');if(r.method()==='POST'&&tracked.has(path))calls.push({path,body:r.postDataJSON()});});return calls;}
async function expanded(page,id){if(!await page.locator('#'+id).evaluate(e=>e.open))await page.locator('#'+id+'>summary').click();}
async function save(page,id){await page.locator('#'+id).click();await page.waitForFunction(id=>!document.getElementById(id).disabled,id);}

test('both styles keep model, backend and video save scopes separate and preserve failed model drafts inline',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const base='http://127.0.0.1:'+server.address().port,initial=structuredClone(state);
  try{for(const layout of ['modern','classic']){
    Object.assign(state,structuredClone(initial));
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),calls=observe(page),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();
    await page.goto(base+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#settings/agent-defaults'));await expanded(page,'modelPanel');await page.locator('#defaultModel option[value="gpt-6-astra"]').waitFor({state:'attached'});
    await page.locator('#agentHarness').selectOption('dsh');assert.equal(calls.filter(c=>c.path==='harness').length,0);await save(page,'saveHarness');assert.deepEqual(calls.find(c=>c.path==='harness').body,{harness:'dsh'});assert.equal(state.runtime.harness.active,'codex');
    await page.locator('#defaultModel').selectOption('gpt-6-astra');await page.locator('#defaultEffort').selectOption('max');await page.locator('#fastMode').check();await page.locator('#autoRoute').uncheck();await page.locator('#contextBudget').fill('65000');
    assert.equal(calls.filter(c=>c.path==='preferences').length,0);await save(page,'savePreferences');assert.deepEqual(calls.find(c=>c.path==='preferences').body,{model:'gpt-6-astra',reasoningEffort:'max',fastMode:true,autoRoute:false,contextBudget:65000});
    const targets=structuredClone(state.config.targets);await expanded(page,'modelPanel');await page.locator('#maxMinutes').fill('7');await page.locator('#visualFps').selectOption('2');await save(page,'saveConfig');
    assert.deepEqual(calls.find(c=>c.path==='video-preferences').body,{maxVideoSeconds:420,visualFps:2,ackMode:'auto'});assert.equal(calls.filter(c=>c.path==='config'||c.path==='targets').length,0);assert.deepEqual(state.config.targets,targets);assert.equal(state.config.model,'gpt-6-astra');assert.equal(state.config.contextBudget,65000);
    if(layout==='modern')await page.evaluate(()=>location.hash='settings/chat-defaults');await expanded(page,'chatsPanel');
    await page.locator('#chatHarness').selectOption('dsh');await page.waitForFunction(()=>!document.querySelector('#chatHarness').disabled);assert.deepEqual(calls.find(c=>c.path==='chat-harness').body,{harness:'dsh'});
    await page.locator('#chatModel').selectOption('gpt-6-luna');await page.locator('#chatEffort').selectOption('medium');await page.locator('#chatFast').uncheck();await page.locator('#chatWeb').uncheck();await page.locator('#chatContextBudget').fill('24000');
    assert.equal(calls.filter(c=>c.path==='chat-preferences').length,0);await save(page,'saveChatPreferences');assert.deepEqual(calls.find(c=>c.path==='chat-preferences').body,{model:'gpt-6-luna',reasoningEffort:'medium',fastMode:false,webSearch:false,codeSandbox:false,contextBudget:24000});assert.equal(state.config.chatContextBudget,24000);assert.equal(state.config.contextBudget,65000);
    if(layout==='modern')await page.evaluate(()=>location.hash='settings/agent-defaults');await expanded(page,'modelPanel');await page.locator('#contextBudget').fill('66000');
    await page.route('**/api/preferences',r=>r.fulfill({status:400,json:{error:'此模型组合暂不可用'}}));await save(page,'savePreferences');await page.locator('#agentPreferencesError').filter({hasText:'此模型组合暂不可用'}).waitFor();
    await page.mouse.move(0,0);await page.clock.fastForward(7100);assert.equal(await page.locator('#notice').isVisible(),false);assert.equal(await page.locator('#agentPreferencesError').isVisible(),true);assert.equal(await page.locator('#contextBudget').inputValue(),'66000');assert.equal(state.config.contextBudget,65000);assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('conversation overrides stay local, group toggles save immediately, and destructive controls remain separate and cancellable',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),calls=observe(page),base='http://127.0.0.1:'+server.address().port,defaults={model:state.config.model,budget:state.config.contextBudget,video:state.config.maxVideoSeconds};
    await page.goto(base+'/?ui=modern#chats/agent/settings');await page.locator('#instanceModel option[value="__inherit"]').waitFor({state:'attached'});
    await page.locator('#instanceBudget').fill('45000');await page.locator('#instanceVideoMinutes').fill('12');await page.locator('#instanceVisualFps').selectOption('8');await page.locator('#instanceFast').selectOption('off');await save(page,'saveInstancePreferences');
    assert.deepEqual(calls.find(c=>c.path==='conversation-preferences').body,{peer:'demo-owner',mode:'assistant',harness:'codex',model:null,reasoningEffort:null,fastMode:false,contextBudget:45000,maxVideoSeconds:720,visualFps:8,autoRoute:null});assert.deepEqual({model:state.config.model,budget:state.config.contextBudget,video:state.config.maxVideoSeconds},defaults);
    await page.route('**/api/conversation-preferences',r=>r.fulfill({status:400,json:{error:'当前会话暂时不能保存'}}));await page.locator('#instanceBudget').fill('46000');await save(page,'saveInstancePreferences');await page.locator('#instancePreferencesError').filter({hasText:'当前会话暂时不能保存'}).waitFor();assert.equal(await page.locator('#instanceBudget').inputValue(),'46000');
    await page.evaluate(()=>location.hash='chats/peer/demo-group/settings');await page.locator('[data-group-video="demo-group"]').waitFor();assert.equal(await page.locator('#instanceVideoGroup').isVisible(),false);
    assert.equal(await page.locator('#instancePreferencesError').isVisible(),false,'a failed save in another conversation must not label this conversation as failed');
    await page.locator('[data-group-video="demo-group"]').uncheck();await page.waitForFunction(()=>!document.querySelector('[data-group-video]').disabled);await page.locator('[data-group-video-limit="demo-group"]').selectOption('60');await page.waitForFunction(()=>!document.querySelector('[data-group-video-limit]').disabled);
    assert.ok(calls.some(c=>c.path==='ai-chats/save'&&c.body.videoOverview===false));assert.ok(calls.some(c=>c.path==='ai-chats/save'&&c.body.videoMaxSeconds===60));
    const clear=page.locator('[data-group-reset="demo-group"]');assert.equal(await clear.evaluate(e=>!!e.closest('.settings-danger')),true);assert.equal(await page.locator('[data-group-pause="demo-group"]').evaluate(e=>!!e.closest('.settings-danger')),false);
    await answerConfirmation(page,clear,{accept:false});assert.equal(calls.filter(c=>c.path==='chat-sessions/reset').length,0);
    await page.evaluate(()=>location.hash='dispatch');await expanded(page,'targetsPanel');await page.locator('#addTarget').click();await page.locator('#targetFormError').filter({hasText:'请先选择聊天'}).waitFor();assert.equal(calls.filter(c=>c.path==='targets').length,0);
    const select=await page.locator('#threadSelect').boundingBox(),alias=await page.locator('#targetAlias').boundingBox();assert.ok(alias.y>select.y+select.height);assert.ok(Math.abs(alias.width-select.width)<2);
    await page.evaluate(()=>location.hash='settings');await expanded(page,'storagePanel');assert.equal(await page.locator('#backupNow').evaluate(e=>!!e.closest('.settings-danger')),false);assert.equal(await page.locator('#saveRetention').evaluate(e=>!!e.closest('.settings-danger')),true);await page.close();
  }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('short settings align on desktop, stack wide fields on mobile and keep both visual styles within the viewport',async t=>{
  const {server}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const root=fileURLToPath(new URL('../data/settings-layout/',import.meta.url));await mkdir(root,{recursive:true});
  try{for(const layout of ['modern','classic']){
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#settings/agent-defaults'));await expanded(page,'modelPanel');await page.locator('#defaultModel option[value="gpt-6-astra"]').waitFor({state:'attached'});
    for(const width of [1440,768,390,320]){
      await page.setViewportSize({width,height:1000});const rows=await page.evaluate(()=>['defaultModel','defaultEffort','contextBudget','maxMinutes','visualFps'].map(id=>{const e=document.getElementById(id),label=e.closest('.setting-row').querySelector('.setting-label'),c=e.getBoundingClientRect(),l=label.getBoundingClientRect();return {control:{x:c.x,y:c.y,right:c.right,width:c.width,height:c.height},label:{x:l.x,y:l.y,bottom:l.bottom,height:l.height}};}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow at '+width);
      if(width>720){for(const row of rows){assert.ok(row.control.x>row.label.x);assert.ok(Math.abs(row.control.y+row.control.height/2-row.label.y-row.label.height/2)<3);}assert.ok(Math.max(...rows.map(r=>r.control.right))-Math.min(...rows.map(r=>r.control.right))<3);}
      else for(const row of rows){assert.ok(row.control.y>=row.label.bottom+5);assert.ok(Math.abs(row.control.x-row.label.x)<2);}
      if(width===390)await page.screenshot({path:join(root,layout+'-mobile-viewport.png')});
    }
    const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});assert.deepEqual(duplicates,[]);
    if(layout==='modern'){await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>location.hash='settings/appearance');await page.locator('#themeToggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.evaluate(()=>location.hash='settings/agent-defaults');await page.screenshot({path:join(root,'modern-dark-viewport.png')});}await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
