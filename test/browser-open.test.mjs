import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {browserChannel} from './browser.mjs';import {mkdir,mkdtemp} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {DouyinAdapter} from '../src/douyin.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));
test('a failed first navigation can be retried without losing the browser profile; an existing window is surfaced',async()=>{
  await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'first-browser-')),original=chromium.launchPersistentContext.bind(chromium);let calls=0,front=0,fail=true;
  chromium.launchPersistentContext=async(profile,options)=>{calls++;const context=await original(profile,{...options,channel:browserChannel,headless:true});await context.route('https://www.douyin.com/**',route=>fail?route.abort('failed'):route.fulfill({contentType:'text/html',body:'<title>Fixture login page</title>'}));for(const page of context.pages()){const focus=page.bringToFront.bind(page);page.bringToFront=async()=>{front++;return focus();};}return context;};
  const adapter=new DouyinAdapter({root});try{await assert.rejects(adapter.open());assert.ok(adapter.context,'the profile remains reusable after a network error');
    const goto=adapter.page.goto.bind(adapter.page);let interrupted=false;adapter.page.goto=async(url,options)=>{if(!interrupted&&url.includes('douyin.com')){interrupted=true;throw new Error('page.goto: Navigation is interrupted by another navigation to "chrome-error://chromewebdata/"');}return goto(url,options);};
    fail=false;await adapter.open();assert.equal(interrupted,true);assert.equal(await adapter.page.title(),'Fixture login page','retry must actually navigate again');assert.equal(adapter.page.url(),'https://www.douyin.com/chat');assert.equal(calls,1,'do not launch a competing profile process');await adapter.open();assert.ok(front>=1,'the open button must show an already-open window');
    adapter.openFailed=true;adapter.page.goto=async()=>{throw new Error('Navigation is interrupted by another navigation to "https://www.douyin.com/chat"');};await adapter.open();assert.equal(adapter.status,'waiting_login','an existing exact-target navigation must be verified in the real document');
    let attempts=0;adapter.openFailed=true;adapter.page.goto=async url=>{if(url.includes('douyin.com'))attempts++;throw new Error('Navigation is interrupted by another navigation to "chrome-error://chromewebdata/"');};await assert.rejects(adapter.open(),/chrome-error/);assert.equal(attempts,3,'a persistent failure must be reported after the bounded retries');assert.equal(adapter.status,'open_error');
  }finally{chromium.launchPersistentContext=original;await adapter.close();}
});

test('opening an existing loading shell focuses it and retries once, then keeps the ready login page',async()=>{
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'loading-browser-'));
  const context=await chromium.launchPersistentContext(root,{channel:browserChannel,headless:true});
  const adapter=new DouyinAdapter({root});
  let navigations=0,focuses=0;
  try{
    await context.route(/^https:\/\/www\.douyin\.com\/chat\?isPopup=1$/,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:++navigations===1?'<h1>抖音聊天</h1><div class="skeleton"> </div>':'<h1>扫码登录</h1>'}));
    adapter.context=context;adapter.page=context.pages()[0];
    adapter.focus=async()=>{focuses++;return true;};
    await adapter.page.goto('https://www.douyin.com/chat?isPopup=1');
    assert.equal((await adapter.scan()).diagnostics.chatLoading,true);
    assert.equal(await adapter.open(undefined,{foreground:true}),true);
    assert.equal((await adapter.scan()).loginRequired,true);
    assert.equal(await adapter.open(undefined,{foreground:true}),true);
    assert.equal(navigations,2);
    assert.equal(focuses,2);
  }finally{await context.close();}
});
