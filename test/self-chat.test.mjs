import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeEngine} from '../src/engine.mjs';
import {matchesPeer,scanConversation,selfChatInput} from '../src/douyin.mjs';
import {PeerBrowser} from '../src/peer-browser.mjs';
import {Store} from '../src/store.mjs';
import {launchTestBrowser} from './browser.mjs';

const owner={chatKey:'0:1:123456:123456',peerUid:'123456',selfUid:'123456',type:'single',selfChat:true};
const raw=(id,text,extra={})=>({id:String(id),conversation:owner.chatKey,sender:owner.selfUid,direction:'out',created:Date.now(),kind:'text',text,...extra});

test('SDK participant pair verifies the self chat; an outgoing-only normal chat cannot pass',async t=>{
  const browser=await launchTestBrowser(t);if(!browser)return;
  try{
    const page=await browser.newPage();
    await page.setContent('<div class="messageMessageBoxcontentBox" data-direction="out">fixture</div>');
    const read=async conversationId=>{
      await page.evaluate(conversationId=>{document.querySelector('.messageMessageBoxcontentBox').__reactProps$fixture={message:{conversationId,conversationType:1,sender:'123456',serverId:'90000000000001',content:'{"text":"/助手 /状态"}',createTime:Date.now()}};},conversationId);
      return page.evaluate(scanConversation);
    };
    assert.equal(matchesPeer((await read(owner.chatKey)).peer,owner),true);
    assert.equal((await read('0:1:123456:987654')).peer.selfChat,undefined);
    assert.equal((await read('0:1:987654:987654')).peer.selfChat,undefined);
  }finally{await browser.close();}
});

test('self chat polling bypasses known zero unread and selects it even without ordinary chat mode',async()=>{
  let current={chatKey:'other',peerUid:'654321'},switches=0,now=0;
  const native={scan:async()=>({peer:current,messages:[]}),inbox:async()=>({entries:[{ids:[owner.chatKey],unread:0}]}),restoreOwner:async peer=>{current=peer;switches++;}};
  const browser=new PeerBrowser(native,{now:()=>now,wait:async ms=>{now+=ms;}});
  await browser.scanPeer(owner,{background:true});
  current={chatKey:'other',peerUid:'654321'};
  await browser.scanPeer(owner,{background:true});
  assert.equal(switches,2);
});

test('self chat accepts explicit human text or native video, never its own text replies or old messages',async()=>{
  const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
  const store=new Store(mkdtempSync(join(base,'self-chat-')));
  const codex=new EventEmitter(),sent=[];
  let messages=[],peer=owner;
  const adapter={scan:async()=>({peer,messages}),react:async()=>({verified:true}),send:async(target,text)=>{
    const id=String(90000000000100+sent.length);
    sent.push(text);messages.push(raw(id,text));return {messageId:id};
  }};
  try{
    store.saveConfig({owner,enabled:true,coordinator:'fixture'});
    const engine=new BridgeEngine({store,adapter,codex,media:{}});
    engine.armedAt=Date.now()-100;
    const prompt=raw(90000000000001,'/助手 /状态');
    const video=raw(90000000000003,'',{kind:'video',awemeId:'90000000000099'});
    assert.equal(selfChatInput(video,owner,engine.armedAt),video);
    assert.equal(selfChatInput({...video,awemeId:''},owner,engine.armedAt),null);
    assert.equal(selfChatInput({...prompt,created:engine.armedAt-1},owner,engine.armedAt),null);
    messages=[prompt,raw(90000000000002,'/状态'),raw(90000000000004,'/助手 /状态',{sender:'654321'})];
    peer={...owner,selfChat:false};await engine.scan();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
    peer=owner;await engine.scan();
    await new Promise(r=>setImmediate(r));
    engine.reply('/助手 /派 项目 不得执行');
    while(store.pendingOutbox().length)await engine.deliver();
    assert.ok(sent.length>=2);
    assert.ok(sent.every(text=>text.startsWith('AI 回复\n\n')));
    engine.seen.clear();await engine.scan();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
    const at=Date.now();
    messages=[video,raw(90000000000005,'只看第一张图',{created:at+100}),raw(90000000000006,'AI 回复\n\n这是助手生成的文字',{created:at+200})];
    messages[0]={...video,created:at};
    await engine.scan();
    const stored=JSON.parse(store.db.prepare("SELECT body FROM messages WHERE kind='video'").get().body);
    assert.deepEqual(stored.attachmentCaptions.map(c=>c.text),['只看第一张图']);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='merged_attachment'").get().n,1);
    messages=[raw(90000000000007,'/助手 只看第二张图',{created:at+400})];
    store.db.prepare("UPDATE messages SET body=json_set(body,'$.attachmentWaitUntil',0) WHERE kind='video'").run();
    await engine.scan();
    messages.push({...video,id:'90000000000008',awemeId:'90000000000109',created:at+410});
    await engine.scan();
    const reversed=JSON.parse(store.db.prepare("SELECT body FROM messages WHERE json_extract(body,'$.awemeId')='90000000000109'").get().body);
    assert.deepEqual(reversed.attachmentCaptions.map(c=>c.text),['只看第二张图']);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='merged_attachment'").get().n,2);
  }finally{store.close();}
});

test('manual self-chat selection drains an in-flight navigation and prevents another poll or send from moving it',async()=>{
  let current={chatKey:'other',peerUid:'654321'},finishNavigation;
  const group={chatKey:'group',peerUid:'group:group'},native={
    scan:async()=>({peer:current,messages:[]}),
    restoreOwner:async peer=>{await new Promise(resolve=>{finishNavigation=resolve;});current=peer;},
    send:async()=>{throw new Error('unexpected send');},
    open:async peer=>{assert.equal(peer,undefined);}
  };
  let now=0;
  const browser=new PeerBrowser(native,{now:()=>now,wait:async ms=>{now+=ms;}});
  browser.multiple=true;
  const polling=browser.scanPeer(group);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof finishNavigation,'function');
  let ready=false;
  const picking=browser.selection(true,'self').then(()=>{ready=true;});
  assert.equal(ready,false);
  await assert.rejects(browser.scanPeer(group),/轮询暂时暂停/);
  assert.throws(()=>browser.selection(true,'chat'),/完成或取消/);
  browser.selection(false,'chat');
  assert.equal(browser.selectionKind,'self');
  finishNavigation();
  await polling;
  await picking;
  current=owner;
  await browser.open(group);
  await assert.rejects(browser.send(group,'fixture'),/操作暂时暂停/);
  await assert.rejects(browser.quoteSchema(group),/自动切换暂时暂停/);
  assert.equal((await browser.scan()).peer,owner);
  browser.selection(false,'self');
  assert.equal(browser.selecting,false);
});
