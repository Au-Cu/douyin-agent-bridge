import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { inspectComposers } from '../src/douyin.mjs';
test('输入框的 Slate 提示和零宽字符不会被误认为草稿；真实文字和媒体草稿保留',async()=>{
  const browser=await chromium.launch({channel:process.env.BRIDGE_TEST_BROWSER||'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    await page.setContent('<div contenteditable="true" style="position:absolute;left:450px;top:500px;width:400px;height:60px"><span data-slate-placeholder="true">发送消息</span><p>\u200b</p></div>');
    assert.equal((await page.evaluate(inspectComposers))[0].text,'');
    await page.locator('[contenteditable]').fill('这是我还没有发送的文字');
    assert.equal((await page.evaluate(inspectComposers))[0].text,'这是我还没有发送的文字');
    await page.locator('[contenteditable]').evaluate(el=>el.innerHTML='<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="emoji">');
    assert.match((await page.evaluate(inspectComposers))[0].text,/非文字内容/);
  }finally{await browser.close();}
});
