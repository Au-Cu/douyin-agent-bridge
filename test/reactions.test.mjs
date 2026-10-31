import test from 'node:test';import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { DouyinAdapter,captureMessageMenu,inspectReactionChoices,markOwnerConversation } from '../src/douyin.mjs';
const owner={chatKey:'bound-chat',peerUid:'bound-owner'};

test('原生无文字圆形展开按钮也能打开完整表情；探测不点击实际表情',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="8000000000001" style="padding:30px">原消息</div>');
    await page.evaluate(()=>{window.emojiClicks=0;document.querySelector('[data-bridge-message-id]').addEventListener('contextmenu',e=>{e.preventDefault();document.querySelectorAll('[role="menu"]').forEach(n=>n.remove());const menu=document.createElement('div');menu.setAttribute('role','menu');menu.className='MessageOperatePopBodywrapper';menu.style.width='300px';menu.innerHTML='<div class="PopBodyEmojiQuickReplyrow"><img class="PopBodyEmojiQuickReplyemojiImg" alt="[微笑]" width="32" height="32"><img class="PopBodyEmojiQuickReplyemojiImg" alt="[色]" width="32" height="32"><div class="quickArrow"><svg width="32" height="32"><circle cx="16" cy="16" r="14"/><path d="M10 13L16 20L22 13"/></svg></div></div>';
      menu.querySelector('.quickArrow').onclick=()=>{const b=document.createElement('button');b.setAttribute('aria-label','[OK]');b.textContent='👌';b.onclick=()=>{window.emojiClicks++;const pill=document.createElement('span');pill.className='message-reaction';pill.textContent='👌';document.querySelector('[data-bridge-message-id]').append(pill);menu.remove();};menu.append(b);};document.body.append(menu);});});
    const a=new DouyinAdapter({root:'unused'});a.page=page;a.chatFrame=page;a.scan=async()=>({peer:owner});const probe=await a.react(owner,'8000000000001',{probeOnly:true,emojis:['👌']});assert.equal(probe.supported,true);assert.equal(await page.evaluate(()=>window.emojiClicks),0);assert.equal((await a.react(owner,'8000000000001',{emojis:['👌']})).verified,true);
  }finally{await browser.close();}
});

test('快捷表情行和整块表情网格不能被当成一个图标点击',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();await page.setContent('<div role="menu" style="width:300px"><div class="PopBodyEmojiQuickReplyrow"><img id="celebrate" alt="[庆祝]" width="32" height="32"><img id="active" alt="[一起加油]" width="32" height="32"><img id="roger" alt="[OK]" width="32" height="32"></div></div>');const choices=(await page.evaluate(inspectReactionChoices,'exact')).choices;assert.deepEqual(choices.map(c=>c.emoji),['🎉','💪','👌']);for(const c of choices)assert.equal(await page.locator('[data-bridge-reaction-choice="exact-'+c.index+'"]').evaluate(e=>e.tagName),'IMG');
  }finally{await browser.close();}
});

test('弹层拦截消息时不强制穿透点击，不发送表情并记录确定未提交',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="8000000000002" style="padding:30px">原消息</div><div class="semi-modal-wrap" style="position:fixed;inset:0;z-index:999"></div>');
    await page.evaluate(()=>{window.contextClicks=0;document.querySelector('[data-bridge-message-id]').addEventListener('contextmenu',()=>window.contextClicks++);});const a=new DouyinAdapter({root:'unused'});a.page=page;a.chatFrame=page;a.scan=async()=>({peer:owner});const result=await a.react(owner,'8000000000002');assert.equal(result.code,'OVERLAY_BLOCKED');assert.equal(result.notSubmitted,true);assert.equal(await page.evaluate(()=>window.contextClicks),0);
  }finally{await browser.close();}
});

test('弹出会话覆盖背景时选择前景可操作 iframe，不按背景消息数量选择',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});try{const context=await browser.newContext(),page=await context.newPage();
    const body=count=>'<div class="RightPanelHeadertitle">测试用户</div>'+Array.from({length:count},(_,i)=>`<div class="messageMessageBoxcontentBox" data-direction="in" data-fixture="${9000000000000+i}" style="height:42px"><div class="MessageBoxContentactiveClickArea">fixture</div></div>`).join('')+'<script>document.querySelectorAll("[data-fixture]").forEach(e=>e.__reactProps$fixture={message:{serverId:e.dataset.fixture,sender:"bound-owner",conversationId:"bound-chat",createTime:Date.now(),content:JSON.stringify({text:"fixture"})}})</script>';
    await context.route('https://www.douyin.com/chat**',route=>route.fulfill({contentType:'text/html',body:route.request().url().endsWith('/active-frame')?body(1):body(5)+'<div style="position:fixed;inset:0;z-index:100"><iframe src="https://www.douyin.com/chat/active-frame" style="width:100%;height:100%;border:0"></iframe></div>'}));
    await page.goto('https://www.douyin.com/chat');await page.frameLocator('iframe').locator('[data-fixture]').waitFor();const a=new DouyinAdapter({root:'unused'});a.context=context;a.page=page;const scan=await a.scan();assert.equal(scan.messages.length,1);assert.ok(a.chatFrame.url().endsWith('/active-frame'));assert.equal(scan.peer.peerUid,owner.peerUid);
  }finally{await browser.close();}
});

test('重复打开平台菜单仍能识别三个表情，并阻止浏览器菜单遮挡而不截断平台处理',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="9000000000001" style="padding:30px">原消息</div><div class="MessageOperatePopBodywrapper" style="width:300px"><img alt="[OK]" src="data:," width="30" height="30"><img alt="[奋斗]" src="data:," width="30" height="30"><img alt="[撒花]" src="data:," width="30" height="30"></div>');
    await page.evaluate(()=>document.querySelector('[data-bridge-message-id]').addEventListener('contextmenu',e=>{window.platformHandled=true;window.browserMenuPrevented=e.defaultPrevented;}));
    await page.evaluate(captureMessageMenu);await page.locator('[data-bridge-message-id]').click({button:'right'});
    assert.equal(await page.evaluate(()=>window.platformHandled),true);assert.equal(await page.evaluate(()=>window.browserMenuPrevented),true);
    assert.deepEqual((await page.evaluate(inspectReactionChoices,'existing')).choices.map(c=>c.emoji),['👌','💪','🎉']);
  }finally{await browser.close();}
});

test('只在消息菜单识别贴表情选项；成功贴到原消息后才报告已确认，同名会话不能发送',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="123456789012345" style="padding:30px">视频卡片</div><button aria-label="点赞">页面其他位置的点赞</button>');
    assert.equal((await page.evaluate(inspectReactionChoices,'before')).choices.length,0);
    await page.evaluate(()=>{
      window.contextClicks=0;
      const row=document.querySelector('[data-bridge-message-id]');row.addEventListener('contextmenu',e=>{
        e.preventDefault();window.contextClicks++;const menu=document.createElement('div');menu.setAttribute('role','menu');menu.style.width='220px';menu.innerHTML='<button aria-label="👀">👀</button><button>复制</button>';
        menu.querySelector('button').onclick=()=>{const reaction=document.createElement('span');reaction.className='message-reaction';reaction.textContent='👀';row.append(reaction);menu.remove();};document.body.append(menu);
      });
    });
    const a=new DouyinAdapter({root:'unused'});a.page=page;a.chatFrame=page;a.scan=async()=>({peer:owner});
    const result=await a.react(owner,'123456789012345');assert.equal(result.verified,true);assert.equal(result.emoji,'👀');
    a.scan=async()=>({peer:{chatKey:'other-chat',peerUid:'other-owner',displayName:'同名'}});
    await assert.rejects(a.react(owner,'123456789012345'),/用户会话/);assert.equal(await page.evaluate(()=>window.contextClicks),1);
    await page.setContent('<div class="conversationConversationItemwrapper">同名</div><div class="conversationConversationItemwrapper">同名</div>');
    assert.equal(await page.evaluate(markOwnerConversation,'同名'),2);assert.equal(await page.locator('[data-bridge-owner-choice]').count(),0);
  }finally{await browser.close();}
});

test('识别右键后新出现的原生菜单和默认 OK 表情，不依赖固定菜单类名',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="123456789012345" style="width:900px;padding:30px"><div class="MessageBoxContentactiveClickArea" style="position:relative;width:180px;height:100px;padding:8px">视频卡片<svg style="position:absolute;left:50%;top:50%;width:50px;height:50px;transform:translate(-50%,-50%)"><rect width="50" height="50" fill="gray"/></svg></div></div>');
    await page.evaluate(()=>document.querySelector('.MessageBoxContentactiveClickArea').addEventListener('contextmenu',e=>{
      if(e.target.closest('svg'))return;
      e.preventDefault();const menu=document.createElement('div');menu.className='native-menu-new-class';menu.style.width='260px';menu.innerHTML='<div>回复 复制 分享 多选 删除</div><button aria-label="👌">👌</button>';
      menu.querySelector('button').onclick=()=>{const pill=document.createElement('div');pill.className='MessageBoxContentBottomwrapper';pill.textContent='👌 | 助手';document.querySelector('[data-bridge-message-id]').append(pill);menu.remove();};document.body.append(menu);
    }));
    const a=new DouyinAdapter({root:'unused'});a.page=page;a.chatFrame=page;a.scan=async()=>({peer:owner});
    const result=await a.react(owner,'123456789012345');assert.equal(result.verified,true);assert.equal(result.emoji,'👌');
  }finally{await browser.close();}
});

test('三个阶段选择不同表情；展开更多后核验庆祝表情，已有表情不会被重复点击撤销',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div data-bridge-message-id="7000000000001" style="padding:30px">用户文字消息</div>');
    await page.evaluate(()=>{
      window.reactionClicks=[];document.querySelector('[data-bridge-message-id]').addEventListener('contextmenu',e=>{
        e.preventDefault();document.querySelectorAll('[role="menu"]').forEach(e=>e.remove());const menu=document.createElement('div');menu.setAttribute('role','menu');menu.style.width='300px';
        const add=emoji=>{const b=document.createElement('button');b.setAttribute('aria-label',emoji);b.textContent=emoji;b.onclick=()=>{window.reactionClicks.push(emoji);const pill=document.createElement('span');pill.className='message-reaction';pill.textContent=emoji;document.querySelector('[data-bridge-message-id]').append(pill);menu.remove();};menu.append(b);};
        add('👌');add('👀');const more=document.createElement('button');more.setAttribute('aria-label','展开更多表情');more.textContent='更多';more.onclick=()=>{add('🎉');more.remove();};menu.append(more);document.body.append(menu);
      });
    });
    const a=new DouyinAdapter({root:'unused'});a.page=page;a.chatFrame=page;a.scan=async()=>({peer:owner});
    for(const emoji of ['👌','👀','🎉']){const result=await a.react(owner,'7000000000001',{emojis:[emoji]});assert.equal(result.verified,true);assert.equal(result.emoji,emoji);}
    assert.deepEqual(await page.evaluate(()=>window.reactionClicks),['👌','👀','🎉']);
    const repeat=await a.react(owner,'7000000000001',{emojis:['🎉']});assert.equal(repeat.verified,undefined);assert.equal((await page.evaluate(()=>window.reactionClicks)).length,3);
  }finally{await browser.close();}
});
