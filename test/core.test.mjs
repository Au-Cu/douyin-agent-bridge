import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { BridgeEngine,parseDispatch,mayDispatch,splitReply } from '../src/engine.mjs';
import { isOwnerMessage,safeMediaUrl } from '../src/douyin.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const temp=()=>mkdtempSync(base+'case-');
const owner={chatKey:'chat-1',peerUid:'owner-uid',displayName:'主人'};

test('只接收绑定 UID 的新消息，拒绝旧历史、同名账号、未知方向和其他会话',()=>{
  const now=Date.now(),m={sender:'owner-uid',conversation:'chat-1',direction:'in',created:now,kind:'text'};
  assert.equal(isOwnerMessage(m,owner,now),true);
  for(const patch of [{sender:'attacker'},{conversation:'chat-2'},{direction:'unknown'},{direction:'out'},{created:now-90000},{created:0},{kind:'unsupported'}])assert.equal(isOwnerMessage({...m,...patch},owner,now),false);
});
test('视频地址限定 HTTPS 平台域名，拒绝本机、伪后缀、文件协议',()=>{
  assert.equal(safeMediaUrl('https://v3-web.douyinvod.com/abc.mp4'),true);
  for(const u of ['http://127.0.0.1/a','file:///C:/a','https://douyin.com.attacker.test/a','https://evil.test/a','https://localhost/'])assert.equal(safeMediaUrl(u),false);
});
test('私信与任务持久去重；重启后的未确认操作不自动重做',()=>{
  const dir=temp();let s=new Store(dir);
  const m={id:'msg-1',peer:'chat-1',kind:'text',text:'交给网站去做'};
  assert.equal(s.incoming(m),true);assert.equal(s.incoming(m),false);
  s.messageStatus(m.id,'processing');const id=s.createTask('网站','thread-1','任务');s.taskStatus(id,'running','', 'turn-1');const out=s.enqueueReply('chat-1','收到');s.delivery(out,'sending');s.close();
  s=new Store(dir);const snapshot=s.snapshot();assert.equal(snapshot.messages[0].status,'uncertain');assert.equal(snapshot.tasks[0].status,'uncertain');assert.equal(snapshot.outbox[0].status,'uncertain');assert.equal(s.pendingMessages().length,0);assert.equal(s.queuedTasks().length,0);assert.equal(s.pendingOutbox().length,0);s.close();
});
test('中文资料检索与通配符转义',()=>{
  const s=new Store(temp());s.addKnowledge({id:'1',title:'首页设计',transcript:'百分之百的清晰表达',path:'note.md'});s.addKnowledge({id:'2',title:'100% 完成',transcript:'测试',path:'other.md'});
  assert.equal(s.search('清晰')[0].id,'1');assert.equal(s.search('100%')[0].id,'2');assert.equal(s.search('%').length,1);s.close();
});
test('任务别名支持空格，避免短别名截断；正文不直接当作系统命令',()=>{
  const targets=[{alias:'网站',id:'1'},{alias:'网站 开发',id:'2'}];
  assert.equal(parseDispatch('/派给 网站 开发 根据视频修改首页',targets).target.id,'2');
  assert.throws(()=>parseDispatch('/派给 未授权 删除文件',targets),/找不到/);
  assert.equal(parseDispatch('视频里提到 /派给 网站 做事',targets),null);
  assert.equal(mayDispatch('请总结这个视频'),false);assert.equal(mayDispatch('交给网站聊天去实现'),true);
});
test('回复分段不切断 emoji 代理对',()=>{const parts=splitReply('你'.repeat(449)+'🙂你好',450);assert.equal(parts.join(''),'你'.repeat(449)+'🙂你好');assert.equal(Array.from(parts[0]).length,450);});

function harness(){
  const store=new Store(temp());store.saveConfig({owner,coordinator:'coordinator',targets:[{alias:'网站',id:'thread-1',name:'网站开发'}],enabled:true});
  const codex=new EventEmitter();codex.connect=async()=>{};codex.request=async()=>({thread:{status:{type:'idle'}}});codex.run=async()=>({text:'实际测试完成',turnId:'turn-1'});
  const adapter={scan:async()=>({peer:owner,messages:[]}),send:async()=>{}};
  const media={process:async()=>{throw new Error('视频无法读取');}};
  return {store,codex,adapter,engine:new BridgeEngine({store,codex,adapter,media})};
}
test('派任务携带主人原话及学习资料，只接受白名单目标',()=>{
  const h=harness();h.store.addKnowledge({id:'vid',title:'讲解',transcript:'具体视频资料',summary:'方法',path:'note.md'});
  assert.throws(()=>h.engine.dispatch('陌生聊天','做事','主人指示'),/未加入/);
  const id=h.engine.dispatch('网站','修改首页','把视频交给网站');const t=h.store.queuedTasks()[0];assert.equal(t.id,id);assert.match(t.prompt,/把视频交给网站/);assert.match(t.prompt,/具体视频资料/);h.store.close();
});
test('发送回执不明时不自动重复发送',async()=>{
  const h=harness();let calls=0;h.adapter.send=async()=>{calls++;throw Object.assign(new Error('回执丢失'),{uncertain:true});};h.engine.reply('处理完成');
  await h.engine.deliver();await h.engine.deliver();assert.equal(calls,1);assert.equal(h.store.snapshot().outbox[0].status,'uncertain');h.store.close();
});
test('视频正文读取失败时明确报告失败，不拿标题冒充学习完成',async()=>{
  const h=harness();let modelCalls=0;h.codex.run=async()=>{modelCalls++;return {text:'已经学会'};};
  h.store.incoming({id:'bad-video',peer:'chat-1',kind:'video',awemeId:'1234567890123456',title:'只有标题'});await h.engine.processNext();
  assert.equal(modelCalls,0);assert.equal(h.store.snapshot().messages[0].status,'failed');assert.equal(h.store.snapshot().knowledge.length,0);assert.ok(h.store.snapshot().outbox.some(o=>o.body.includes('未完成')));h.store.close();
});
test('跨聊天执行有单独的执行结果，提交后异常不自动重做',async()=>{
  const h=harness();const id=h.engine.dispatch('网站','做事','交给网站');h.codex.run=async(a,b,options)=>{options.onStarted('real-turn');throw new Error('连接断开');};
  await h.engine.runTask();const t=h.store.snapshot().tasks[0];assert.equal(t.status,'uncertain');assert.equal(t.turn,'real-turn');assert.equal(h.store.queuedTasks().length,0);h.store.close();
});
test('派任务成功才报告实际返回结果',async()=>{
  const h=harness();h.engine.dispatch('网站','做事','交给网站');h.codex.run=async(a,b,options)=>{options.onStarted('real-turn');return {text:'修改完成，验证已通过',turnId:'real-turn'};};await h.engine.runTask();
  assert.equal(h.store.snapshot().tasks[0].status,'done');assert.ok(h.store.snapshot().outbox.some(o=>o.body.includes('验证已通过')));h.store.close();
});
test('模型等待确认时，主人仍能在抖音批准操作，不被任务处理锁阻塞',async()=>{
  const h=harness();let approved=null;h.codex.approve=(id,allow)=>approved={id,allow};h.engine.busy=true;
  h.store.incoming({id:'approval',peer:'chat-1',kind:'text',text:'/同意 42'});
  await h.engine.processNext();assert.deepEqual(approved,{id:'42',allow:true});assert.equal(h.store.snapshot().messages[0].status,'done');h.store.close();
});
test('任务请求提交但回执丢失时保留执行中状态，重启后不自动重发',async()=>{
  const h=harness();h.engine.dispatch('网站','做事','交给网站');
  h.codex.run=async(a,b,o)=>{o.onSubmitted();throw Object.assign(new Error('提交回执丢失'),{uncertain:true});};await h.engine.runTask();
  assert.equal(h.store.snapshot().tasks[0].status,'uncertain');assert.equal(h.store.queuedTasks().length,0);h.store.close();
});
test('缺少完整视觉组件时，禁止退回口播加少量预览图冒充学习完成',async()=>{
  const h=harness();let called=0;h.engine.media.process=async()=>({id:'1234567890123456',title:'测试',path:'note.md',transcript:'口播',frames:[]});h.codex.run=async()=>{called++;return{text:'已学完'};};
  h.store.incoming({id:'vision-required',peer:'chat-1',kind:'video',awemeId:'1234567890123456'});await h.engine.processNext();
  assert.equal(called,0);assert.equal(h.store.snapshot().messages[0].status,'failed');assert.match(h.store.snapshot().messages[0].result,/不能只根据口播/);h.store.close();
});
