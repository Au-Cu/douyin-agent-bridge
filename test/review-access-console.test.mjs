import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createPreviewServer} from '../scripts/ui-preview.mjs';
import {launchTestBrowser,answerConfirmation} from './browser.mjs';

test('both layouts expose global manual review and separate exact execution recovery when every reply is already sent',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');const browser=await launchTestBrowser(t);
  if(!browser){server.close();return;}
  const work={...state.work[0],id:'uncertain-execution',number:36,status:'uncertain',canCheckExecution:true,replies:[{id:'timeout',status:'sent',notification:true}],receipts:state.work[0].receipts.map(r=>({...r,uncertain:0}))};state.work=[work];
  try{for(const layout of ['modern','classic']){
    const page=await browser.newPage({viewport:{width:1280,height:900}}),calls=[];let resolved=false;
    const receipt={id:'old-reaction',operationId:'archived',number:7,title:'旧任务',kind:'progress_reaction',status:'uncertain',label:'表情：收到 · 👌',body:'原消息',created:1,lastCheck:{at:2,reason:'原消息不在当前可读历史中'},canResend:false};
    await page.route('**/api/outbox/review?*',route=>route.fulfill({json:{rows:resolved?[]:[receipt]}}));
    await page.route('**/api/outbox/resolve',route=>{calls.push(route.request().postDataJSON());resolved=true;return route.fulfill({json:{ok:true}});});
    await page.route('**/api/operations/reconcile',route=>{calls.push(route.request().postDataJSON());return route.fulfill({json:{recovered:true,reason:'原回合已完成，未重新执行'}});});
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#workbench'));
    await page.locator('#reviewAllDeliveries').click();await page.locator('#deliveryReviewDialog[open]').waitFor();
    assert.match(await page.locator('#deliveryReviewRows').textContent(),/原消息不在当前可读历史中/);
    const manual=page.locator('[data-review-resolve="old-reaction"][data-review-status="sent"]');await manual.click();await page.locator('#actionDialog[open]').waitFor();await page.keyboard.press('Escape');assert.equal(calls.length,0);
    await answerConfirmation(page,page.locator('[data-review-resolve="old-reaction"][data-review-status="abandoned"]'));await page.waitForFunction(()=>document.querySelector('#deliveryReviewRows').textContent.includes('没有送达不明'));
    assert.deepEqual(calls[0],{id:'old-reaction',status:'abandoned',confirmed:true});await page.locator('#closeDeliveryReview').click();
    const check=page.locator('[data-check-execution="uncertain-execution"]');await answerConfirmation(page,check);await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('未重新执行'));
    assert.deepEqual(calls[1],{id:'uncertain-execution',confirmed:true});assert.equal(calls.length,2);await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
