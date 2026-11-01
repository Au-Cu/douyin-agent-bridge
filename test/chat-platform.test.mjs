import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
import {scanConversation,matchesPeer} from '../src/douyin.mjs';import {SafariDouyinAdapter} from '../src/safari.mjs';
test('actual browser extraction keeps group identity stable and reads only native mention UIDs; Safari uses the same group guard',async()=>{
  const browser=await chromium.launch({channel:process.env.BRIDGE_TEST_BROWSER||'msedge',headless:true});try{
    const page=await browser.newPage({viewport:{width:1000,height:800}});await page.setContent('<div class="RightPanelHeadertitle">测试群</div>');
    await page.evaluate(()=>{const add=(message,direction)=>{const e=document.createElement('div');e.className='messageMessageBoxcontentBox';e.style='height:60px';e.dataset.direction=direction;e.textContent='fixture';e.__reactProps$fixture={message};document.body.append(e);};
      const common={conversationId:'0:2:300000:400000',conversationType:2,createTime:Date.now()};
      add({...common,serverId:'90000000000001',sender:'999999',content:JSON.stringify({text:'助手在群内发过的消息'})},'out');
      add({...common,serverId:'90000000000002',sender:'222222',mentionedUsers:['999999'],content:JSON.stringify({text:'@助手 你好'})},'in');
      add({...common,serverId:'90000000000003',sender:'333333',content:JSON.stringify({text:'@助手 普通字符',referenceInfo:{mentionedUsers:['999999']}})},'in');
      add({...common,serverId:'90000000000004',sender:'444444',ext:{'awe:mention_users':JSON.stringify([{uid:'999999'}])},content:JSON.stringify({text:'来自另一群成员的 @'})},'in');
    });
    const scan=await page.evaluate(scanConversation);assert.equal(scan.peer.type,'group');assert.equal(scan.peer.peerUid,'group:0:2:300000:400000');assert.equal(scan.peer.selfUid,'999999');assert.deepEqual(scan.messages.map(m=>m.mentionedUids),[[],['999999'],[],['999999']]);
    const safari=new SafariDouyinAdapter({root:'fixture'});safari.page={};safari.windowId=1;safari.inTab=code=>page.evaluate(source=>eval('(()=>{'+source+'})()'),code);
    assert.equal(await safari.inTab('const w=window;'+safari.ownerCheck(scan.peer)+'return true;'),true);
    await assert.rejects(safari.inTab('const w=window;'+safari.ownerCheck({...scan.peer,selfUid:'wrong-account'})+'return true;'),/会话已切换/);
    assert.equal(matchesPeer(scan.peer,{...scan.peer,type:'single'}),false);
    await page.evaluate(()=>{document.querySelectorAll('.messageMessageBoxcontentBox')[1].__reactProps$fixture.message.conversationType=1;});const conflict=await page.evaluate(scanConversation);assert.equal(conflict.peer.type,'unknown');assert.equal(matchesPeer(conflict.peer,scan.peer),false);
  }finally{await browser.close();}
});
