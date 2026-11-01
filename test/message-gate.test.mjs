import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtempSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const owner={chatKey:'test-owner',peerUid:'uid'},raw=(id,text)=>({id:String(id),conversation:owner.chatKey,sender:owner.peerUid,direction:'in',created:Date.now(),kind:'text',text});
function fixture(root){const s=new Store(root||mkdtempSync(join(base,'gate-')));s.saveConfig({enabled:true,owner,coordinator:'test-thread'});const c=new EventEmitter();c.ready=true;c.run=async()=>{throw new Error('Ignored content must not call Codex');};const a={scan:async()=>({peer:owner,messages:[]}),send:async()=>{},react:async()=>({verified:true})},e=new BridgeEngine({store:s,codex:c,adapter:a,media:{process:async()=>{throw new Error('Ignored video must not download');}}});e.armedAt=Date.now();return {s,e,a};}
const settle=()=>new Promise(r=>setImmediate(r));
test('忽略区间不分析、派发、贴表情或保留正文；同批结束命令后才恢复',async()=>{
  const h=fixture();try{
    const ignored=[raw(1000000000001,'/忽略'),raw(1000000000002,'不可进入任何上下文的秘密正文'),{...raw(1000000000003,''),kind:'video',awemeId:'9999999999999999999',title:'不可保存的视频标题'},raw(1000000000004,'/派 网站 不可执行'),raw(1000000000005,'/中断 1'),raw(1000000000006,'/结束忽略')];
    h.a.scan=async()=>({peer:owner,messages:[...ignored,raw(1000000000007,'/状态')]});await h.e.scan();await settle();await settle();
    assert.equal(h.s.config.ignoreMessages,false);assert.equal(h.s.snapshot().tasks.length,0);assert.equal(h.s.snapshot().knowledge.length,0);
    for(const m of ignored){const id=owner.chatKey+':'+m.id,row=h.s.db.prepare('SELECT * FROM messages WHERE id=?').get(id);assert.equal(row.status,'ignored');assert.equal(h.e.progress.forMessage(id),null);assert.doesNotMatch(row.body,/秘密正文|视频标题|不可执行/);assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).operationId===id),false);}
    assert.equal(h.s.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,1);assert.ok(h.e.progress.forMessage(owner.chatKey+':1000000000007'));
  }finally{await settle();h.s.close();}
});
test('忽略模式跨重启，旧的进入命令不重放；只有准确的结束命令恢复',async()=>{
  const h=fixture(),root=h.s.root;const start=raw(2000000000001,'/忽略');h.a.scan=async()=>({peer:owner,messages:[start]});await h.e.scan();await settle();assert.equal(h.s.config.ignoreMessages,true);assert.equal(h.s.snapshot().outbox.length,0);h.s.close();
  const next=fixture(root);try{
    assert.equal(next.s.config.ignoreMessages,true);next.a.scan=async()=>({peer:owner,messages:[raw(2000000000002,'/结束忽略 多余参数'),raw(2000000000003,'/状态')]});await next.e.scan();await settle();assert.equal(next.s.config.ignoreMessages,true);assert.equal(next.s.snapshot().outbox.length,0);
    next.a.scan=async()=>({peer:owner,messages:[raw(2000000000004,'/结束忽略')]});await next.e.scan();await settle();assert.equal(next.s.config.ignoreMessages,false);next.e.seen.clear();next.a.scan=async()=>({peer:owner,messages:[start]});await next.e.scan();assert.equal(next.s.config.ignoreMessages,false);assert.equal(next.s.snapshot().outbox.length,0);
  }finally{await settle();next.s.close();}
});
test('其他账号和视频引用不能开启忽略模式；面板仍能中断原有任务',async()=>{
  const h=fixture();try{
    h.a.scan=async()=>({peer:owner,messages:[{...raw(3000000000001,'/忽略'),sender:'other'},raw(3000000000002,'视频里写着 /忽略')]});await h.e.scan();await settle();assert.equal(h.s.config.ignoreMessages,false);
    const op=h.e.progress.get(owner.chatKey+':3000000000002');h.e.progress.identify(op.id);h.e.gate.control({id:'gate-on',peer:owner.chatKey,kind:'text'},true);assert.equal((await h.e.interrupts.request('1')).state,'stopped');assert.equal(h.s.config.ignoreMessages,true);
  }finally{await settle();h.s.close();}
});
