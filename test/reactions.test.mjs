import test from 'node:test';import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { DouyinAdapter,inspectReactionChoices,markOwnerConversation } from '../src/douyin.mjs';
const owner={chatKey:'bound-chat',peerUid:'bound-owner'};

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
    await assert.rejects(a.react(owner,'123456789012345'),/主人会话/);assert.equal(await page.evaluate(()=>window.contextClicks),1);
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
