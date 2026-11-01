import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1420,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:39361/');await page.waitForTimeout(1200);
  if(await page.title()!=='抖音 × Codex')throw new Error('控制台标题错误');
  const targetsOpen=await page.locator('#targetsPanel').evaluate(e=>e.open);if(!targetsOpen)await page.locator('#targetsPanel>summary').click();
  await page.getByRole('button',{name:'读取本机聊天'}).click();await page.waitForFunction(()=>document.querySelectorAll('#threadSelect option').length>1);
  const checks=await page.evaluate(async()=>({
    status:(await (await fetch('/api/state')).json()).runtime,
    threads:document.querySelectorAll('#threadSelect option').length-1,
    invalidHost:(await fetch('/api/state',{headers:{}})).status
  }));
  if(!targetsOpen){await page.locator('#targetsPanel>summary').click();await page.waitForTimeout(200);}
  await page.screenshot({path:'data/ui-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'data/ui-mobile.png',fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  const noAuth=await browser.newContext();const response=await noAuth.request.get('http://127.0.0.1:39361/api/state');if(response.status()!==401)throw new Error('未登录请求未被阻止');await noAuth.close();
  console.log(JSON.stringify({ok:true,threads:checks.threads,codex:checks.status.codex,asrReady:checks.status.asrReady,uiErrors:errors.length,unauthenticatedBlocked:true},null,2));
}finally{await browser.close();}
