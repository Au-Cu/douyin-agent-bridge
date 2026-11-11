import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createPreviewServer} from '../scripts/ui-preview.mjs';
import {launchTestBrowser,answerConfirmation} from './browser.mjs';

test('both consoles cancel decisions safely and require a second explicit consent for uncertain resends',async t=>{
  const {server,state}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const root=fileURLToPath(new URL('../data/ui-review/popups/',import.meta.url));await mkdir(root,{recursive:true});
  const task=state.work.find(w=>w.id==='demo-task-26');task.deliveryControls={canCancel:true,canResend:true};
  try{for(const layout of ['modern','classic']){
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),calls=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{errors.push('unexpected native dialog');d.dismiss();});
    await page.route('**/api/outbox/resend-replies',route=>{
      const body=route.request().postDataJSON();calls.push(body);
      return route.fulfill({json:body.confirmUnreceived?{requeued:1,message:'演示：已确认重发'}:{needsConfirmation:true,message:'此段曾进入发送；请从接收方确认未收到，再决定是否重发。'}});
    });
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#workbench'));
    const resend=page.locator('#taskList [data-reply-id="demo-task-26"][data-reply-action="resend"]');await resend.waitFor();
    const cancel=page.locator('#taskList [data-reply-id="demo-task-26"][data-reply-action="cancel"]');
    await cancel.click();await page.locator('#actionDialog[open]').waitFor();
    assert.equal(await page.locator('#actionDialog').getAttribute('data-overlay'),'local');
    assert.equal(await page.locator('#actionDialog').evaluate(e=>getComputedStyle(e,'::backdrop').backgroundColor),'rgba(0, 0, 0, 0)');
    await page.screenshot({path:join(root,'local-confirm-'+layout+'.png')});await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');
    await resend.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);
    await resend.click();await page.locator('#actionDialog[open]').waitFor();
    assert.equal(await page.locator('#cancelAction').evaluate(e=>e===document.activeElement),true);
    assert.equal(await page.locator('#actionDialog').getAttribute('role'),'alertdialog');
    assert.equal(await page.evaluate(async()=>{const {confirmAction}=await import('/dom.js');return confirmAction({title:'不得排队的另一次决定',message:'忽略',confirmLabel:'忽略'});}),false);
    await page.screenshot({path:join(root,'confirmation-'+layout+'.png')});
    await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');
    assert.equal(calls.length,0);assert.equal(await resend.evaluate(e=>e===document.activeElement),true);
    assert.ok(Math.abs((await page.evaluate(()=>scrollY))-scroll)<3);
    await resend.click();await page.locator('#actionDialog[open]').waitFor();await page.mouse.click(2,2);
    await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');assert.equal(calls.length,0);
    await resend.click();await page.locator('#actionDialog[open]').waitFor();await page.evaluate(()=>location.hash='settings');
    await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');assert.equal(calls.length,0);
    if(layout==='modern')await page.locator('a[data-view="workbench"]').click();
    await answerConfirmation(page,resend);await page.locator('#actionHeading').filter({hasText:'确认接收方未收到'}).waitFor();
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-reply-action="resend"]').disabled);
    assert.deepEqual(calls,[{kind:'task',id:task.id,confirmed:true}]);
    await answerConfirmation(page,resend);await page.locator('#actionHeading').filter({hasText:'确认接收方未收到'}).waitFor();
    const submitted=page.waitForResponse('**/api/outbox/resend-replies');await page.locator('#confirmAction').click();await submitted;
    await page.waitForFunction(()=>!document.querySelector('[data-reply-action="resend"]').disabled);
    assert.deepEqual(calls.at(-1),{kind:'task',id:task.id,confirmed:true,confirmUnreceived:true});assert.equal(calls.length,3);
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});await resend.click();await page.locator('#actionDialog[open]').waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const box=await page.locator('#actionDialog').boundingBox();assert.ok(box.x>=0&&box.width<=width);
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');
    }
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('reading uses scrollable drawers while background sync failures stay inline and recover without a popup',async t=>{
  const {server}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const root=fileURLToPath(new URL('../data/ui-review/popups/',import.meta.url));await mkdir(root,{recursive:true});
  try{for(const layout of ['modern','classic']){
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route(/\/api\/knowledge\/\d+$/,route=>route.fulfill({json:{note:'用于验收的完整学习笔记\n\n'+'长笔记在自己的面板内滚动，关闭后返回原位置。\n'.repeat(150)}}));
    await page.goto('http://127.0.0.1:'+server.address().port+(layout==='classic'?'/classic.html?ui=classic':'/?ui=modern#library'));
    const trigger=page.locator('#knowledgeList [data-note]').first();await trigger.waitFor();
    await trigger.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);await trigger.click();
    const drawer=page.locator('#noteDialog');await drawer.waitFor();
    assert.equal(await drawer.getAttribute('data-overlay'),'reader');assert.equal(await drawer.getAttribute('aria-labelledby'),'noteHeading');
    const rect=await drawer.boundingBox();assert.ok(Math.abs(rect.x+rect.width-1280)<2);
    assert.equal(await drawer.evaluate(e=>e.scrollHeight>e.clientHeight),true);
    await drawer.evaluate(e=>e.scrollTop=600);await page.waitForTimeout(2700);assert.equal(await drawer.evaluate(e=>e.scrollTop),600);
    await page.screenshot({path:join(root,'reader-'+layout+'.png')});await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
    assert.ok(Math.abs((await page.evaluate(()=>scrollY))-scroll)<3);assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});await trigger.click();await drawer.waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const box=await drawer.boundingBox();assert.ok(Math.abs(box.width-width)<2);
      if(width===390)await page.screenshot({path:join(root,'reader-mobile-'+layout+'.png')});
      await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
    }
    await page.route('**/api/state*',route=>route.fulfill({status:503,json:{error:'演示连接暂不可用'}}));
    await page.locator('#syncIssue').waitFor();assert.match(await page.locator('#syncIssue').innerText(),/暂时无法确认最新状态/);
    assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#notice').isVisible(),false);
    await page.unroute('**/api/state*');await page.locator('#syncIssue button').click();await page.locator('#syncIssue').waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('permanent decisions require acknowledgement and in-flight deletion cannot close or submit twice',async t=>{
  const {server}=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await launchTestBrowser(t);if(!browser){server.close();return;}
  const root=fileURLToPath(new URL('../data/ui-review/popups/',import.meta.url));await mkdir(root,{recursive:true});
  let finish;const pending=new Promise(resolve=>{finish=resolve;});let submissions=0;
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
    await page.goto('http://127.0.0.1:'+server.address().port+'/?ui=modern#workbench');await page.locator('#taskList [data-operation]').first().waitFor();
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';import('/dom.js').then(({confirmAction})=>{confirmAction({title:'启用归档到期永久清理？',message:'将永久删除符合保留策略的桥接记录与专属缓存。',context:'归档后保留 7 天',kind:'danger',confirmLabel:'启用永久清理',acknowledge:'我理解符合条件的桥接记录与缓存无法恢复'});});});
    await page.locator('#actionDialog[open]').waitFor();assert.equal(await page.locator('#confirmAction').isDisabled(),true);
    await page.locator('#actionAcknowledge').check();assert.equal(await page.locator('#confirmAction').isDisabled(),false);
    await page.screenshot({path:join(root,'danger-mobile-dark.png')});await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#actionDialog').dataset.decision==='cancel');
    await page.selectOption('#workScope','archived');await page.locator('[data-delete-kind="task"]').click();await page.locator('#deleteDialog[open]').waitFor();
    assert.equal(await page.locator('#confirmDelete').isDisabled(),true);assert.equal(await page.locator('#deleteDialog').getAttribute('role'),'alertdialog');
    await page.route('**/api/archive/delete',async route=>{submissions++;await pending;return route.fulfill({json:{deleted:true}});});
    await page.locator('#deleteAcknowledge').check();await page.locator('#confirmDelete').click();await page.locator('#confirmDelete[data-dialog-busy="true"]').waitFor({state:'attached'});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#deleteDialog').evaluate(e=>e.open),true);
    assert.equal(await page.locator('#deleteAcknowledge').isDisabled(),true);assert.equal(await page.locator('#cancelDelete').isDisabled(),true);
    await page.evaluate(()=>document.querySelector('#confirmDelete').click());assert.equal(submissions,1);
    finish();await page.locator('#deleteDialog').waitFor({state:'hidden'});await page.close();
  }finally{finish();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
