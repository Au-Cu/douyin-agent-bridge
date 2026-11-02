import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {EventEmitter} from 'node:events';
import {CodexClient} from '../src/codex.mjs';import {operationContext} from '../src/execution.mjs';import {nativeTurnState} from '../src/native-turn-state.mjs';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const make=()=>new CodexClient({codexHome:mkdtempSync(join(base,'long-task-home-')),executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-long-task-rpc.mjs',import.meta.url))]});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<150;i++){if(check())return;await delay(5);}throw Error('fixture condition not reached');}

test('项目超过原等待时限仍监听原回合；只锁同一聊天，完成后返回一次结果',async()=>{
  const c=make();let running;
  try{let settled=false;running=c.run('project',[{type:'text',text:'long task'}],{waitForCompletion:true,timeoutMs:15,reconcileIntervalMs:15}).finally(()=>settled=true);
    await until(()=>c.runs.has([...c.runs.keys()].find(k=>k.startsWith('owned-'))));await delay(65);
    assert.equal(settled,false);assert.equal(c.threadLocks.has('project'),true);assert.ok((await c.request('test/stats')).reads>=1);
    await assert.rejects(c.run('project',[]),e=>e.notSubmitted);
    const other=c.run('unrelated',[],{waitForCompletion:true,reconcileIntervalMs:15});await until(()=>[...c.runs.values()].some(r=>r.threadId==='unrelated'));await c.request('test/finish',{threadId:'unrelated'});assert.equal((await other).text,'OWN_RESULT');
    await c.request('test/finish',{threadId:'project'});assert.equal((await running).text,'OWN_RESULT');assert.equal(c.runs.size,0);assert.equal(c.threadLocks.size,0);assert.equal((await c.request('test/stats')).starts,2);
  }finally{await c.close();await running?.catch(()=>{});}
});
test('完成通知缺失时读回确切原回合，聊天后续活跃与新回复不能冒充原任务',async()=>{
  const c=make();let running;
  try{running=c.run('project',[],{waitForCompletion:true,timeoutMs:10,reconcileIntervalMs:45});await until(()=>[...c.runs.values()].some(r=>r.turnId));const original=[...c.runs.values()][0].turnId;
    await c.request('test/finish',{threadId:'project',emit:false});await c.request('test/newer',{threadId:'project'});
    const result=await running;assert.equal(result.turnId,original);assert.equal(result.text,'OWN_RESULT');assert.equal((await c.request('test/stats')).interrupts,0);
  }finally{await c.close();await running?.catch(()=>{});}
});
test('状态读取失败或只有其他回合时保留等待；不伪造完成、不重发任务',async()=>{
  const c=make();let running;
  try{const states=[];let settled=false;running=c.run('project',[],{waitForCompletion:true,reconcileIntervalMs:15,timeoutMs:10,onWaitState:s=>states.push(s.state)}).finally(()=>settled=true);await until(()=>[...c.runs.values()].some(r=>r.turnId));
    await c.request('test/readMode',{mode:'offline'});await until(()=>states.includes('unknown'));assert.equal(settled,false);
    await c.request('test/readMode',{mode:'missing'});await delay(45);assert.equal(settled,false);assert.equal((await c.request('test/stats')).starts,1);
    await c.request('test/readMode',{mode:'normal'});await c.request('test/finish',{threadId:'project'});assert.equal((await running).text,'OWN_RESULT');
  }finally{await c.close();await running?.catch(()=>{});}
});
test('只读分析仍有时限；用户中断长期项目仍只停止对应原回合',async()=>{
  const c=make();let running;
  try{await assert.rejects(c.run('readonly',[],{waitForCompletion:true,timeoutMs:15,interruptOnTimeout:true}),/只读视觉分析超时/);await until(()=>c.early.size>0);
    const controller=new AbortController(),scope={signal:controller.signal,stopChecks:new Set()};running=operationContext.run(scope,()=>c.run('project',[],{waitForCompletion:true,reconcileIntervalMs:15}));const ended=running.catch(e=>e);await until(()=>[...c.runs.values()].some(r=>r.threadId==='project'&&r.turnId));controller.abort(Object.assign(new Error('用户中断'),{code:'TASK_INTERRUPTED'}));assert.equal((await ended).code,'TASK_INTERRUPTED');await until(()=>c.interrupting.size===0);assert.equal((await c.request('test/stats')).interrupts,2);
  }finally{await c.close();await running?.catch(()=>{});}
});
test('原生回合核验不以聊天总体状态推断任务完成',async()=>{
  const client={request:async()=>({thread:{id:'a',status:{type:'active'},turns:[{id:'own',status:'completed',items:[]},{id:'newer',status:'inProgress'}]}})};
  assert.equal((await nativeTurnState(client,'a','own')).state,'completed');assert.equal((await nativeTurnState(client,'a','missing')).state,'unknown');assert.equal((await nativeTurnState(client,'other-chat','own')).state,'unknown');
});
test('目标任务完成后先保存回复；辅助摘要超时不能回写成任务失败',async()=>{
  const s=new Store(mkdtempSync(join(base,'long-task-engine-'))),c=new EventEmitter();let workOptions;
  c.ready=true;c.connect=async()=>{};c.request=async()=>({thread:{status:{type:'idle'}}});
  c.run=async(id,input,o)=>{workOptions=o;o.onSubmitted();o.onStarted('native-turn');o.onWaitState({state:'active',turnId:'native-turn'});return {text:'项目完成的真实结果',turnId:'native-turn'};};
  s.saveConfig({enabled:true,owner:{chatKey:'owner',peerUid:'user'},coordinator:'assistant'});
  const conversations={lightCall:async()=>{},needs:{get:()=>({id:'need'}),reserve:()=>{}},record:()=>{},refreshMemory:async()=>{assert.ok(s.outboxByDedupe('task-result:'+taskId+':0'));throw new Error('Codex 任务超时');}};
  const engine=new BridgeEngine({store:s,codex:c,adapter:{},media:{},conversations}),m={id:'owner-message',peer:'owner',platformId:'platform',kind:'text',text:'修改授权项目',created:Date.now()};
  s.incoming(m);const op=engine.progress.receive(m),taskId=s.createTask('目标项目','project','用户直接要求',{operationId:op.id,needId:'need'});
  try{await operationContext.run({operationId:op.id},()=>engine.processTask(s.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));await Promise.allSettled([...engine.memoryUpdates]);assert.equal(workOptions.waitForCompletion,true);assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'done');const rows=s.snapshot().outbox.filter(o=>o.kind==='text');assert.ok(rows.some(o=>o.body.includes('真实结果')));assert.equal(rows.some(o=>o.body.includes('任务暂未完成')),false);}finally{s.close();}
});

function recovery(){
  const store=new Store(mkdtempSync(join(base,'turn-recovery-'))),client=new EventEmitter();client.ready=true;client.connect=async()=>{};client.run=async()=>{throw Error('reconciliation must never start a turn');};
  client.request=async()=>({thread:{id:'project',status:{type:'active'},turns:[{id:'original',status:'completed',items:[{type:'agentMessage',text:'原回合最终结果'}]},{id:'newer',status:'inProgress'}]}});
  store.saveConfig({enabled:true,owner:{chatKey:'owner',peerUid:'user'},coordinator:'assistant'});
  const engine=new BridgeEngine({store,codex:client,adapter:{},media:{}}),message={id:'original-message',peer:'owner',platformId:'original-platform',kind:'text',text:'用户授权项目任务',created:Date.now()};store.incoming(message);const op=engine.progress.receive(message),id=store.createTask('项目','project','原始要求',{operationId:op.id});store.taskStatus(id,'uncertain','旧等待超时','original');engine.progress.stage(op.id,'等待结果','',{running:true,thread:'project',turn:'original',submitted:true});engine.progress.finish(op.id);engine.busy=true;
  return {store,client,engine,op,id,task:()=>store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)};
}
test('独立检查器补录已提交原回合结果一次；未知送达、已归档与用户绑定边界保留',async()=>{
  const h=recovery();try{
    await h.engine.reconcileTasks();assert.equal(h.task().status,'done');assert.equal(h.task().turn,'original');let parts=h.store.snapshot().outbox.filter(o=>o.dedupe.startsWith('task-result:'));assert.equal(parts.length,1);assert.match(parts[0].body,/未重新执行/);assert.match(parts[0].body,/原回合最终结果/);
    h.store.delivery(parts[0].id,'uncertain','未知送达');h.store.taskStatus(h.id,'uncertain','重启恢复','original');h.engine.taskObservations.clear();await h.engine.reconcileTasks();parts=h.store.snapshot().outbox.filter(o=>o.dedupe.startsWith('task-result:'));assert.equal(parts.length,1);assert.equal(parts[0].status,'uncertain');
    h.store.taskStatus(h.id,'uncertain','','original');h.store.setArchived('task',h.op.id,true);h.engine.taskObservations.clear();let reads=0;h.client.request=async()=>{reads++;throw Error('must not read archived task');};await h.engine.reconcileTasks();assert.equal(reads,0);
    h.store.setArchived('task',h.op.id,false);h.store.saveConfig({owner:{chatKey:'another-owner',peerUid:'another-user'}});await h.engine.reconcileTasks();assert.equal(reads,0);
  }finally{h.store.close();}
});
test('原回合仍在运行或状态缺失时不启动新任务；核验期间归档不能恢复任务',async()=>{
  const h=recovery();try{
    h.client.request=async()=>({thread:{id:'project',status:{type:'idle'},turns:[{id:'original',status:'inProgress'}]}});await h.engine.reconcileTasks();assert.equal(h.task().status,'running');assert.equal(h.store.snapshot().outbox.some(o=>o.kind==='text'),false);
    let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);h.client.request=async()=>{entered();await hold;return {thread:{id:'project',turns:[{id:'original',status:'completed',items:[{type:'agentMessage',text:'不得交付'}]}]}};};h.engine.taskObservations.clear();const pending=h.engine.reconcileTasks();await ready;h.store.setArchived('task',h.op.id,true);release();await pending;assert.notEqual(h.task().status,'done');assert.equal(h.store.snapshot().outbox.some(o=>o.kind==='text'),false);
  }finally{h.store.close();}
});
