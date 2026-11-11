import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createPreviewServer} from '../scripts/ui-preview.mjs';import {launchTestBrowser,answerConfirmation} from './browser.mjs';
test('both consoles expose isolated group history, blank reset confirmation, lightweight video and opt-in retention without poll loss',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const sessions=[{id:'current',seq:2,harness:'codex',peer:'demo-group',thread:'native',current:true,state:'current',created:Date.now(),archived:0,archive_state:'none'},{id:'old',seq:1,harness:'dsh',peer:'demo-group',thread:'dsh:native',current:false,state:'archived',created:Date.now()-3000,archived:1,archive_state:'unsupported'}];let resets=0,policies=[],groupSaves=[];
  const group=state.aiChats.chats.find(c=>c.chatKey==='demo-group');group.sessions={current:{id:'current',seq:2,harness:'codex',tokens:1200,state:'current'},busy:false,budget:16000};state.retention={policy:{enabled:false,hours:720},last:null};
  try{for(const layout of ['modern','classic']){
    const page=await browser.newPage({viewport:{width:1280,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/chat-sessions?*',route=>route.fulfill({json:{sessions}}));await page.route('**/api/chat-sessions/read?*',route=>route.fulfill({json:{session:sessions.find(s=>s.id===new URL(route.request().url()).searchParams.get('id')),source:'bridge_records',notice:'DSH ACP 不提供完整历史导出，以下为原始交流记录。',turns:[],exchanges:[{user:'这段视频讲了什么？',assistant:'完整回复第一段\n完整回复第二段',status:'done'}]}}));
    await page.route('**/api/chat-sessions/reset',route=>{resets++;return route.fulfill({json:{id:'blank'}});});await page.route('**/api/chat-sessions/archive',route=>route.fulfill({json:{ok:true}}));
    await page.route('**/api/ai-chats/save',route=>{const body=route.request().postDataJSON();groupSaves.push(body);Object.assign(group,body);return route.fulfill({json:{ok:true}});});
    await page.route('**/api/archive/retention',route=>{const body=route.request().postDataJSON();policies.push(body);state.retention.policy=body;return route.fulfill({json:{policy:body}});});
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/#chats/peer/demo-group/settings'));await page.locator('[data-group-sessions="demo-group"]').waitFor({state:'attached'});
    if(layout==='classic'&&!await page.locator('#chatsPanel').evaluate(e=>e.open))await page.locator('#chatsPanel>summary').click();
    await page.locator('[data-group-video="demo-group"]').check();await page.selectOption('[data-group-video-limit="demo-group"]','60');await page.waitForFunction(()=>document.querySelector('[data-group-video-limit]').value==='60'&&!document.querySelector('[data-group-video-limit]').disabled);assert.equal(groupSaves.at(-1).videoMaxSeconds,60);
    if(layout==='modern')await page.locator('#conversationHistoryTab').click();await page.locator('[data-group-sessions="demo-group"]').click();await page.locator('[data-session-read="old"]').waitFor();assert.match(await page.locator('#chatSessionList').innerText(),/DSH ACP 不支持原生归档/);assert.equal(await page.locator('#chatSessionList a[href^="codex:"]').count(),0);await page.locator('[data-session-read="old"]').click();await page.locator('#chatSessionTranscript').filter({hasText:'完整回复第二段'}).waitFor();await page.waitForTimeout(2800);assert.equal(await page.locator('#chatSessionsDialog').evaluate(e=>e.open),true);await page.locator('#closeChatSessions').click();
    if(layout==='modern')await page.locator('#conversationSettingsTab').click();
    const before=resets;await answerConfirmation(page,page.locator('[data-group-reset="demo-group"]'),{accept:false});assert.equal(resets,before);
    if(layout==='modern'){
      await page.locator('[data-group-reset="demo-group"]').click();await page.locator('#actionDialog[open]').waitFor();
      group.sessions.current={...group.sessions.current,id:'rolled-over'};await page.waitForTimeout(2700);
      await page.locator('#confirmAction').click();await page.locator('#noticeText').filter({hasText:'会话状态已变化'}).waitFor();assert.equal(resets,before);
      group.sessions.current={...group.sessions.current,id:'current'};await page.waitForTimeout(2700);
    }
    await answerConfirmation(page,page.locator('[data-group-reset="demo-group"]'));await page.waitForFunction(()=>!document.querySelector('[data-group-reset]').disabled);assert.equal(resets,before+1);
    if(layout==='modern')await page.locator('a[data-view="settings"]').click();
    if(!await page.locator('#storagePanel').evaluate(e=>e.open))await page.locator('#storagePanel>summary').click();await page.locator('#retentionEnabled').check();await page.locator('#retentionAge').fill('7');await page.locator('#retentionAge').blur();await page.waitForTimeout(2800);assert.equal(await page.locator('#retentionAge').inputValue(),'7');assert.equal(await page.locator('#retentionEnabled').isChecked(),true);
    const policyBefore=policies.length;await answerConfirmation(page,page.locator('#saveRetention'),{accept:false});assert.equal(policies.length,policyBefore);await answerConfirmation(page,page.locator('#saveRetention'));await page.waitForFunction(()=>!document.querySelector('#saveRetention').disabled);assert.deepEqual(policies.at(-1),{enabled:true,hours:168});
    await page.locator('#retentionEnabled').uncheck();await page.locator('#saveRetention').click();await page.waitForFunction(()=>!document.querySelector('#saveRetention').disabled);assert.equal(policies.at(-1).enabled,false);
    for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    assert.deepEqual(errors,[]);await page.close();state.retention.policy={enabled:false,hours:720};
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
