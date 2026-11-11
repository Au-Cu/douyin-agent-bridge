import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createPreviewServer} from '../scripts/ui-preview.mjs';import {launchTestBrowser,answerConfirmation} from './browser.mjs';

test('both consoles retry/cancel exact stored reply groups; chat read errors release the button and controls fit mobile',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const task=state.work.find(w=>w.id==='demo-task-26'),bot=state.aiChats.messages.find(m=>m.id==='demo-group-reply');let calls=[];
  try{for(const layout of ['modern','classic']){
    state.aiChats.selecting=false;
    task.deliveryControls={canCancel:true,canResend:true};bot.deliveryControls={canCancel:true,canResend:true};
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/ai-chats/select',route=>{state.aiChats.selecting=true;return route.fulfill({json:{ok:true}});});
    await page.route('**/api/outbox/*-replies',async route=>{
      const body=route.request().postDataJSON(),cancel=route.request().url().endsWith('cancel-replies');calls.push({cancel,...body});
      const row=body.kind==='task'?task:bot;row.deliveryControls={canCancel:!cancel,canResend:true,cancelled:cancel?1:0};
      await route.fulfill({json:cancel?{ok:true,cancelled:1}:{ok:true,requeued:1}});
    });
    const address='http://127.0.0.1:'+server.address().port,taskPath=layout==='classic'?'/classic.html?ui=classic':'/#workbench';
    await page.goto(address+taskPath);const cancel=page.locator('#taskList [data-reply-id="demo-task-26"][data-reply-action="cancel"]');await cancel.waitFor();
    const count=calls.length;await answerConfirmation(page,cancel,{accept:false});assert.equal(calls.length,count);
    await answerConfirmation(page,cancel);await cancel.waitFor({state:'hidden'});assert.deepEqual(calls.at(-1),{cancel:true,kind:'task',id:task.id,confirmed:true});
    assert.match(await page.locator('[data-operation="demo-task-26"]').innerText(),/已取消 1 段，原文已保留/);
    await answerConfirmation(page,page.locator('#taskList [data-reply-id="demo-task-26"][data-reply-action="resend"]'));await cancel.waitFor();assert.equal(calls.at(-1).cancel,false);
    if(layout==='modern')await page.goto(address+'/#chats/peer/demo-group');
    else if(!await page.locator('#chatsPanel').evaluate(e=>e.open))await page.locator('#chatsPanel>summary').click();
    if(layout==='classic')await page.locator('details[data-fold-key="bot-history"]>summary').click();
    const groupCancel=page.locator('#botHistory [data-reply-id="demo-group-reply"][data-reply-action="cancel"]');await groupCancel.waitFor();await answerConfirmation(page,groupCancel);await groupCancel.waitFor({state:'hidden'});assert.deepEqual(calls.at(-1),{cancel:true,kind:'chat_reply',id:bot.id,confirmed:true});
    for(const width of [320,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await page.setViewportSize({width:1280,height:900});
    if(layout==='modern')await page.goto(address+'/#chats/add');
    await page.locator('#selectAiChat').click();await page.locator('#observeAiChat').waitFor({state:'visible'});
    await page.route('**/api/ai-chats/current',route=>route.fulfill({json:{chatKey:'demo-group',peerUid:'group-id',selfUid:'999999',type:'group',displayName:'演示群',token:'observed-fixture'}}));
    await page.locator('#observeAiChat').click();await page.waitForFunction(()=>!document.querySelector('#enableAiChat').disabled);
    await page.route('**/api/ai-chats/current',route=>route.fulfill({status:500,json:{error:'抖音页面读取超时，已退出本次检查，稍后重试。'}}));
    await page.locator('#observeAiChat').click();await page.waitForFunction(()=>!document.querySelector('#observeAiChat').disabled);
    assert.match(await page.locator('#notice').innerText(),/读取超时/);assert.equal(await page.locator('#enableAiChat').isDisabled(),true);
    assert.match(await page.locator('#observedChat').innerText(),/读取失败/);
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();await new Promise(r=>server.close(r));}
});
