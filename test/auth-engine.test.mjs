import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {authError} from '../src/codex-auth.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
function harness(){
  const s=new Store(mkdtempSync(join(base,'auth-engine-')));s.saveConfig({owner:{chatKey:'owner-chat'},coordinator:'assistant-chat',enabled:true,targets:[{id:'target-chat',alias:'项目'}]});
  const codex=new EventEmitter();codex.authState={status:'ready'};codex.ensureAuthenticated=async()=>{};codex.connect=async()=>{};codex.request=async()=>({thread:{status:{type:'idle'}}});
  const calls=[];codex.run=async(id,input,options)=>{calls.push({id,input,options});return{text:'已观察到页面切换',turnId:'finished-turn'};};
  const adapter={send:async()=>{}},media={},visual={};return {s,codex,media,visual,calls,engine:new BridgeEngine({store:s,codex,adapter,media,visual})};
}

test('认证恢复仅续做暂停的视频并复用原片，不重放结果不明的执行任务',async()=>{
  const h=harness(),id='9000000000000000003',folder=join(h.s.root,'knowledge',id);mkdirSync(folder,{recursive:true});
  const learned={id,title:'合成视频',path:join(folder,'note.md'),transcript:'本地转写',seconds:10};writeFileSync(learned.path,'合成笔记');writeFileSync(join(folder,'metadata.json'),JSON.stringify(learned));
  let downloads=0;h.media.process=async()=>{downloads++;return learned;};h.visual.analyze=async()=>{throw new Error('视觉分析未完成',{cause:authError('quota')});};
  h.s.incoming({id:'video-message',peer:'owner-chat',kind:'video',awemeId:id});await h.engine.processNext();
  assert.equal(h.s.snapshot().messages[0].status,'waiting_auth');assert.equal(downloads,1);
  const task=h.s.createTask('项目','target-chat','已经提交的任务');h.s.taskStatus(task,'uncertain','回执丢失');
  h.visual.analyze=async()=>({status:'complete',notes:'0–10 秒：实际视觉观察'});h.codex.emit('auth-reconnected');await h.engine.processNext();
  assert.equal(h.s.snapshot().messages[0].status,'done');assert.equal(downloads,1);assert.equal(h.s.snapshot().tasks[0].status,'uncertain');
  assert.equal(h.calls[0].options.assistant,true);assert.match(h.calls[0].input[0].text,/实际视觉观察/);assert.doesNotMatch(h.calls[0].input[0].text,/Markdown|主人明确要求时调用|每段只说一件事/);h.s.close();
});

test('未提交的指令在登录不可用时保留，恢复后发送短输入；不重复发送等待提示',async()=>{
  const h=harness();h.codex.ensureAuthenticated=async()=>{throw authError();};h.codex.authState={status:'login'};
  h.s.incoming({id:'instruction',peer:'owner-chat',kind:'text',text:'解释刚才视频里的布局'});
  await h.engine.processNext();const count=h.s.snapshot().outbox.length;await h.engine.processNext();
  assert.equal(h.s.snapshot().messages[0].status,'new');assert.equal(h.s.snapshot().outbox.length,count);assert.equal(h.calls.length,0);
  h.codex.ensureAuthenticated=async()=>{};h.codex.authState={status:'ready'};h.codex.emit('auth-reconnected');await h.engine.processNext();
  assert.equal(h.s.snapshot().messages[0].status,'done');assert.equal(h.calls.length,1);assert.ok(h.calls[0].input[0].text.length<150);h.s.close();
});

test('派发在提交前遇到登录失败时保留队列，提交后遇到同类错误时保留待核实状态',async()=>{
  const h=harness();const task=h.engine.dispatch('项目','修改页面','交给项目修改页面');
  h.codex.ensureAuthenticated=async()=>{throw authError();};await h.engine.runTask();assert.equal(h.s.snapshot().tasks[0].status,'queued');assert.equal(h.calls.length,0);
  h.codex.ensureAuthenticated=async()=>{};let submissions=0;h.codex.run=async(id,input,options)=>{options.onSubmitted();submissions++;throw authError();};
  await h.engine.runTask();assert.equal(h.s.snapshot().tasks[0].status,'uncertain');assert.equal(h.s.queuedTasks().length,0);
  h.codex.emit('auth-reconnected');await h.engine.runTask();assert.equal(submissions,1);assert.equal(h.s.snapshot().tasks[0].id,task);h.s.close();
});

test('抖音重连指令可以在分析忙时处理，等待已有任务结束，不中断或重复提交',async()=>{
  const h=harness();h.engine.busy=true;let reconnects=0;h.codex.reconnect=async()=>{reconnects++;return {deferred:true,auth:{status:'ready'}};};
  const message={id:'reconnect-command',peer:'owner-chat',kind:'text',text:'/重新连接'};h.s.incoming(message);
  assert.equal(h.engine.handleControl(message),true);await new Promise(r=>setImmediate(r));assert.equal(reconnects,1);assert.equal(h.engine.busy,true);assert.equal(h.calls.length,0);
  assert.ok(h.s.snapshot().outbox.some(o=>o.body.includes('结束后切换')));h.s.close();
});
