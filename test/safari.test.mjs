import test from 'node:test';import assert from 'node:assert/strict';import {launchTestBrowser} from './browser.mjs';
import {SafariDouyinAdapter} from '../src/safari.mjs';

async function fixture(t){
  const browser=await launchTestBrowser(t);if(!browser)return null;const page=await browser.newPage({viewport:{width:1000,height:700}});
  await page.route('https://www.douyin.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<div class="RightPanelHeadertitle">用户</div><div class="messageMessageBoxcontentBox" data-direction="in" style="height:60px"><div class="MessageBoxContentactiveClickArea">原消息</div></div><div contenteditable="true" style="position:absolute;left:400px;top:500px;width:500px;height:80px"></div><script>
  const row=document.querySelector('.messageMessageBoxcontentBox');row.__reactProps$fixture={message:{serverId:'9000000000001',sender:'owner',conversationId:'bound-chat',createTime:Date.now(),content:JSON.stringify({text:'原消息'})}};
  row.addEventListener('contextmenu',e=>{e.preventDefault();const menu=document.createElement('div');menu.setAttribute('role','menu');menu.style='position:absolute;left:20px;top:100px;width:200px;height:80px';menu.innerHTML='<button aria-label="[OK]">👌</button>';menu.firstChild.onclick=()=>{const p=document.createElement('span');p.className='message-reaction';p.textContent='👌';row.append(p);menu.remove();};document.body.append(menu);});
  document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const ed=e.currentTarget,reply=document.createElement('div');reply.className='messageMessageBoxcontentBox';reply.dataset.direction='out';reply.style.height='60px';reply.__reactProps$fixture={message:{serverId:'9000000000002',sender:'assistant',conversationId:'bound-chat',createTime:Date.now(),content:JSON.stringify({text:ed.innerText})}};reply.textContent=ed.innerText;document.body.append(reply);ed.textContent='';});</script>`}));
  await page.goto('https://www.douyin.com/chat');const adapter=new SafariDouyinAdapter({root:'unused'});adapter.page={};adapter.windowId=1;adapter.inTab=async code=>page.evaluate(source=>eval('(()=>{'+source+'})()'),code);return {browser,page,adapter};
}
const owner={chatKey:'bound-chat',peerUid:'owner',displayName:'用户'};

test('Safari 页面逻辑只回复绑定用户，保留草稿并核验实际送达',async t=>{
  const h=await fixture(t);if(!h)return;try{const scan=await h.adapter.scan();assert.equal(scan.peer.chatKey,owner.chatKey);assert.equal(scan.messages.length,1);
    await assert.rejects(h.adapter.send({...owner,peerUid:'another'},'不能发送'),/选回绑定/);
    await h.page.locator('[contenteditable]').fill('用户草稿');await assert.rejects(h.adapter.send(owner,'不能覆盖'),/草稿/);assert.equal(await h.page.locator('[contenteditable]').innerText(),'用户草稿');
    await h.page.locator('[contenteditable]').fill('');const result=await h.adapter.send(owner,'第一段\n第二段');assert.equal(result.messageId,'9000000000002');
  }finally{await h.browser.close();}
});

test('Safari 页面逻辑仅在可见的原消息菜单选择准确表情并核验',async t=>{
  const h=await fixture(t);if(!h)return;try{const probe=await h.adapter.react(owner,'9000000000001',{probeOnly:true,emojis:['👌']});assert.equal(probe.supported,true);
    await h.page.locator('[role="menu"]').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));const result=await h.adapter.react(owner,'9000000000001',{emojis:['👌']});assert.equal(result.verified,true);assert.equal(result.emoji,'👌');
  }finally{await h.browser.close();}
});

test('Safari 自动化失败时不会扩大到其他窗口或泄漏脚本到命令参数',async t=>{
  let script='';const a=new SafariDouyinAdapter({root:'unused',executeAppleScript:async s=>{script=s;return JSON.stringify({ok:true,value:42});}});a.windowId=123;a.tabIndex=1;a.page={};assert.equal(await a.inTab('return 42;'),42);assert.match(script,/window id 123/);assert.match(script,/URL of t does not start with/);assert.match(script,/do JavaScript/);a.windowId=0;await assert.rejects(a.inTab('return 1;'),/请先打开/);
});

test('Safari 视频页只使用当前视频 ID 的原片地址并验证自有标签标记',async t=>{
  const browser=await launchTestBrowser(t);if(!browser)return;const page=await browser.newPage();try{
    await page.route('https://www.douyin.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<script>window._ROUTER_DATA={unrelated:{aweme_id:'1234567890124',video:{play_addr:{url_list:['https://v.douyinvod.com/wrong.mp4']}}},correct:{aweme_id:'1234567890123',desc:'视频参考',video:{duration:4200,play_addr:{url_list:['https://v.douyinvod.com/correct.mp4']}}}};</script>`}));
    await page.goto('https://www.douyin.com/video/1234567890123');const calls=[],a=new SafariDouyinAdapter({root:'unused'});a.page={};a.windowId=1;a.apple=async script=>{calls.push(script);if(script.includes('URL of every tab of window id'))return '1\thttps://www.douyin.com/chat?isPopup=1\n2\thttps://www.douyin.com/video/1234567890123\n';return '';};a.inTab=async(code,index)=>{assert.equal(index,2);return page.evaluate(source=>eval('(()=>{'+source+'})()'),code);};
    const result=await a.resolveVideo({awemeId:'1234567890123'});assert.equal(result.url,'https://v.douyinvod.com/correct.mp4');assert.equal(result.seconds,4.2);assert.match(calls.at(-1),/douyin-codex-bridge-video/);assert.ok(await page.evaluate(()=>!!sessionStorage.getItem('douyin-codex-bridge-video')));
  }finally{await browser.close();}
});

test('Safari 只选择前景可操作的同源聊天 iframe',async t=>{
  const browser=await launchTestBrowser(t);if(!browser)return;const page=await browser.newPage({viewport:{width:900,height:700}});try{
    await page.route('https://www.douyin.com/**',r=>{const frame=r.request().url().endsWith('/frame');return r.fulfill({contentType:'text/html; charset=utf-8',body:frame?`<div class="RightPanelHeadertitle">用户</div><div class="messageMessageBoxcontentBox" data-direction="in" style="height:60px">前景</div><div contenteditable="true" style="width:300px;height:60px"></div><script>document.querySelector('.messageMessageBoxcontentBox').__reactProps$fixture={message:{serverId:'9000000000001',sender:'owner',conversationId:'bound-chat',createTime:Date.now(),content:JSON.stringify({text:'前景'})}};</script>`:`<div style="position:fixed;inset:0;z-index:10"><iframe src="https://www.douyin.com/frame" style="width:100%;height:100%;border:0"></iframe></div>`});});
    await page.goto('https://www.douyin.com/chat');await page.frameLocator('iframe').locator('[contenteditable]').waitFor();const a=new SafariDouyinAdapter({root:'unused'});a.page={};a.windowId=1;a.inTab=async code=>page.evaluate(source=>eval('(()=>{'+source+'})()'),code);const scan=await a.scan();assert.equal(scan.peer?.chatKey,'bound-chat');assert.deepEqual(a.framePath,[0]);assert.equal((await a.composerState()).length,1);
  }finally{await browser.close();}
});
