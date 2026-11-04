import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {requestKey,explicitRedo} from '../src/progress.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const owner={chatKey:'owner-chat',peerUid:'owner'};
const msg=(id,text)=>({id:'owner-chat:'+id,platformId:id,peer:owner.chatKey,kind:'text',text,created:Date.now()});
function harness(root){
  const s=new Store(root||mkdtempSync(join(base,'progress-')));s.saveConfig({enabled:true,owner,coordinator:'assistant',targets:[{id:'project',alias:'网站'}]});
  const c=new EventEmitter();c.ready=true;c.connect=async()=>{};c.ensureAuthenticated=async()=>{};c.request=async()=>({thread:{status:{type:'idle'}}});const calls=[],sent=[],reactions=[];
  c.run=async(id,input,options)=>{calls.push({id,input,options});options.onSubmitted?.();options.onStarted?.('fixture-turn');return {text:'结果文字'.repeat(250),turnId:'fixture-turn'};};
  const adapter={send:async(o,t)=>sent.push(t),react:async(o,id,options)=>{reactions.push({id,emojis:options.emojis});return {verified:true,emoji:options.emojis[0]};}};
  const engine=new BridgeEngine({store:s,codex:c,adapter,media:{}});let clock=1000000;engine.progress.now=()=>clock;
  return {s,c,engine,calls,sent,reactions,advance:ms=>clock+=ms};
}
async function drain(h){for(let i=0;i<60&&h.s.pendingOutbox().length;i++)await h.engine.deliver();}
async function firstPart(h,id){for(let i=0;i<10&&h.engine.progress.resultParts(id).sent<1;i++)await h.engine.deliver();assert.equal(h.engine.progress.resultParts(id).sent,1);}

test('三段回复发到一半的重复要求关联原操作，不再次调用模型；done 等所有分段和催办答复送达',async()=>{
  const h=harness();try{
    const first=msg('1000000000001','按视频做一个网站');h.s.incoming(first);await h.engine.processNext();
    assert.equal(h.calls.length,1);assert.equal(h.engine.progress.resultParts(first.id).total,3);
    await firstPart(h,first.id);
    assert.equal(h.engine.progress.resultParts(first.id).sent,1);assert.match(h.engine.progress.status(first.id),/第 2\/3 段/);
    const repeat=msg('1000000000002',first.text);h.s.incoming(repeat);await h.engine.processNext();assert.equal(h.calls.length,1);assert.equal(h.s.db.prepare('SELECT status FROM messages WHERE id=?').get(repeat.id).status,'linked');
    assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).stage==='done'),false);
    await drain(h);assert.equal(h.engine.progress.get(first.id).status,'done');assert.equal(h.calls.length,1);
    assert.ok(h.sent.some(t=>t.includes('这项要求正在处理，没有重复启动')&&t.includes('第 2/3 段')));
    assert.ok(h.sent.some(t=>t.startsWith('任务 1 · 回复 1/3 段')));assert.ok(h.sent.some(t=>t.startsWith('任务 1 · 回复 3/3 段（末段）')));assert.equal(h.sent.filter(t=>t.startsWith('已登记任务 1：')).length,1);assert.equal(h.engine.progress.forMessage(repeat.id).number,1);
    for(const id of [first.platformId,repeat.platformId])assert.deepEqual(h.reactions.filter(r=>r.id===id).map(r=>r.emojis[0]),['👌','[奋斗]','🎉']);
  }finally{h.s.close();}
});

test('新增颜色修改保留为补充并等待原回复结束；明确重新做允许新一轮，不能吞掉否定和数字变化',async()=>{
  const h=harness();try{
    const first=msg('2000000000001','做绿色网站');h.s.incoming(first);await h.engine.processNext();
    h.engine.progress.classify=async()=>({text:JSON.stringify({relation:'supplement',operationId:first.id})});
    const edit=msg('2000000000002','把绿色改成蓝色，不要改文字');h.s.incoming(edit);await h.engine.processNext();assert.equal(h.calls.length,1);assert.equal(h.engine.progress.forMessage(edit.id).parent,first.id);
    await drain(h);await h.engine.processNext();assert.equal(h.calls.length,2);assert.match(h.calls[1].input[0].text,/改成蓝色/);
    const redo=msg('2000000000003','重新做一遍，改成红色');h.s.incoming(redo);await h.engine.processNext();assert.equal(h.calls.length,3);assert.equal(h.engine.progress.forMessage(redo.id).parent,'');
    assert.notEqual(requestKey(msg('a','宽度 1-2')),requestKey(msg('b','宽度 12')));assert.notEqual(requestKey(msg('a','不要红色')),requestKey(msg('b','要红色')));
    assert.equal(explicitRedo('不要重新做，等发完即可'),false);assert.equal(explicitRedo('重新执行这项任务'),true);assert.equal(explicitRedo('你为什么重新做了一遍？'),false);assert.equal(explicitRedo('“重新做”这个词是什么意思？'),false);assert.equal(explicitRedo('把这个任务重新做一遍'),true);
  }finally{h.s.close();}
});

test('active writer 在提交前退避并保留原因；到界限暂停，重试只恢复确定未提交的任务',async()=>{
  const h=harness();try{
    const m=msg('3000000000001','/派 网站 修改首页');h.s.incoming(m);await h.engine.processNext();const task=h.s.queuedTasks()[0];let attempts=0;
    h.c.run=async(id,input,o)=>{attempts++;o.onSubmitted();throw Object.assign(new Error('already has an active writer'),{remote:true,notSubmitted:true});};
    await h.engine.runTask();assert.match(h.s.queuedTasks()[0].result,/active writer/);assert.match(h.engine.progress.status(m.id),/尚未提交/);
    let history=h.engine.progress.cards().find(c=>c.id===m.id).retries[0];assert.deepEqual(history.events.map(e=>[e.attempt,e.at,e.outcome]),[[1,1000000,'blocked']]);assert.deepEqual(history.wait,{paused:false,nextAttempt:1010000});
    await h.engine.runTask();assert.equal(attempts,1);
    for(let i=0;i<5;i++){h.advance(61000);await h.engine.runTask();}
    const blocked=h.s.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.turn,'');assert.equal(attempts,6);assert.match(h.engine.progress.status(m.id),/调度已暂停/);
    history=h.engine.progress.cards().find(c=>c.id===m.id).retries[0];assert.deepEqual(history.events.map(e=>e.attempt),[1,2,3,4,5,6]);assert.equal(history.events.at(-1).at,1305000);assert.equal(history.wait.paused,true);
    assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).stage==='active'),false);
    const messages=h.s.snapshot().outbox.filter(o=>o.kind==='text').length;h.engine.busy=true;h.advance(120000);await h.engine.progress.inspect();assert.equal(h.s.snapshot().outbox.filter(o=>o.kind==='text').length,messages);
    h.engine.progress.retry(task.id.slice(0,8));assert.equal(h.s.queuedTasks()[0].id,task.id);
    h.c.run=async(id,input,o)=>{o.onSubmitted();o.onStarted('submitted-turn');throw Object.assign(new Error('connection lost; already has an active writer'),{uncertain:true});};
    await h.engine.runTask();assert.equal(h.s.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'uncertain');assert.equal(h.s.queuedTasks().length,0);assert.throws(()=>h.engine.progress.retry(task.id.slice(0,8)),/结果不明/);
    // Manual resume never erases old evidence, even when this retry becomes uncertain.
    history=h.engine.progress.cards().find(c=>c.id===m.id).retries[0];assert.equal(history.events.length,8);assert.deepEqual(history.events.slice(-2).map(e=>[e.attempt,e.outcome]),[[7,'started'],[7,'uncertain']]);assert.equal(history.wait,null);
  }finally{h.s.close();}
});

test('写入恢复只在实际开始后记为成功，记录跨重启保留；旧等待只恢复可证明的最后一次',async()=>{
  const root=mkdtempSync(join(base,'retry-history-'));let h=harness(root);
  try{
    const m=msg('3100000000001','/派 网站 修改首页');h.s.incoming(m);await h.engine.processNext();const task=h.s.queuedTasks()[0];
    h.c.run=async()=>{throw Object.assign(new Error('already has an active writer'),{notSubmitted:true});};
    await h.engine.runTask();h.advance(61000);await h.engine.runTask();
    h.s.db.prepare('DELETE FROM task_retry_events').run();h.s.close();h=harness(root);
    let history=h.engine.progress.cards().find(c=>c.id===m.id).retries[0];assert.equal(history.events.length,1);assert.deepEqual({attempt:history.events[0].attempt,at:history.events[0].at,legacy:history.events[0].legacy},{attempt:2,at:1061000,legacy:true});
    h.advance(122000);h.c.run=async(id,input,o)=>{o.onSubmitted();o.onStarted('resumed-turn');return {text:'完成',turnId:'resumed-turn'};};await h.engine.runTask();
    history=h.engine.progress.cards().find(c=>c.id===m.id).retries[0];assert.deepEqual(history.events.map(e=>[e.attempt,e.outcome]),[[2,'blocked'],[3,'started']]);assert.equal(history.wait,null);
    h.s.close();h=harness(root);history=h.engine.progress.cards({scope:'all'}).find(c=>c.id===m.id).retries[0];assert.deepEqual(history.events.map(e=>e.outcome),['blocked','started']);assert.equal(h.s.db.prepare('SELECT turn FROM tasks WHERE id=?').get(task.id).turn,'resumed-turn');
  }finally{h.s.close();}
});

test('独立检查器在任务锁忙或断线时仍更新真实阻塞状态；不主动发送状态文字',async()=>{
  const h=harness();try{
    const m=msg('4000000000001','长任务');h.s.incoming(m);const op=h.engine.progress.receive(m);h.engine.progress.stage(op.id,'执行任务','',{running:true,thread:'work',turn:'turn',submitted:true});h.engine.busy=true;
    h.advance(95000);let reads=0;h.c.request=async()=>{reads++;throw new Error('offline');};const before=h.s.snapshot().outbox.length;await h.engine.progress.inspect();assert.equal(reads,1);assert.match(h.engine.progress.status(op.id),/暂时无法确认运行状态/);assert.equal(h.s.snapshot().outbox.length,before);
    h.advance(31000);h.c.request=async()=>({thread:{id:'work',status:{type:'active'},turns:[{id:'turn',status:'inProgress'}]}});await h.engine.progress.inspect();assert.match(h.engine.progress.status(op.id),/报告仍在运行/);assert.equal(h.calls.length,0);
  }finally{h.s.close();}
});

test('无法核验表情时保持静默；不把不明点击自动重试，也不把不明文本交付标记完成',async()=>{
  const h=harness();try{
    const m=msg('5000000000001','测试');h.s.incoming(m);h.engine.progress.receive(m);let clicks=0;h.engine.adapter.react=async()=>{clicks++;throw Object.assign(new Error('receipt unknown'),{uncertain:true});};
    await h.engine.deliver();await h.engine.deliver();assert.equal(clicks,1);assert.equal(h.sent.length,0);
    h.engine.progress.stage(m.id,'生成答复','',{running:true});h.engine.reply('结果',{operationId:m.id});h.engine.progress.finish(m.id);
    await h.engine.deliver();h.engine.adapter.send=async()=>{throw Object.assign(new Error('delivery unknown'),{uncertain:true});};await h.engine.deliver();
    assert.match(h.engine.progress.status(m.id),/送达结果不明/);assert.notEqual(h.engine.progress.get(m.id).status,'done');assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).stage==='done'),false);
  }finally{h.s.close();}
});

test('重启保留分段发送进度与重复关联，不重跑已生成结果；新发文字只使用用户称谓',async()=>{
  const h=harness(),root=h.s.root,first=msg('6000000000001','生成长结果');h.s.incoming(first);await h.engine.processNext();await firstPart(h,first.id);h.s.close();
  const restored=harness(root);try{
    const repeat=msg('6000000000002',first.text);restored.s.incoming(repeat);await restored.engine.processNext();assert.equal(restored.calls.length,0);assert.match(restored.engine.progress.status(first.id),/2\/3/);
    const oldWord=String.fromCharCode(0x4e3b,0x4eba);restored.engine.reply(oldWord+'已确认');await drain(restored);assert.ok(restored.sent.includes('用户已确认'));assert.equal(restored.engine.progress.get(first.id).status,'done');
    restored.s.enqueueReply(owner.chatKey,oldWord+'的旧待发消息');await drain(restored);assert.ok(restored.sent.includes('用户的旧待发消息'));
  }finally{restored.s.close();}
});

test('任务使用持久递增编号和短标题；登记只通知一次，数字重试只恢复对应未提交工作',async()=>{
  const h=harness();try{
    const m=msg('8000000000001','/派 网站 修改首页配色');h.s.incoming(m);await h.engine.processNext();const op=h.engine.progress.forMessage(m.id);assert.equal(op.number,1);assert.match(op.title,/网站.*修改首页配色/);await drain(h);assert.equal(h.sent.filter(t=>t.includes('已登记任务 1：')).length,1);
    h.c.request=async()=>({thread:{status:{type:'active'}}});await h.engine.runTask();h.engine.progress.retry('1');assert.equal(h.s.queuedTasks().length,1);assert.match(h.engine.progress.label(m.id),/^任务 1：网站/);
    const second=msg('8000000000002','重新做另一份网站');h.s.incoming(second);await h.engine.processNext();assert.equal(h.engine.progress.forMessage(second.id).number,2);
    assert.throws(()=>h.engine.progress.retry('99'),/没有找到任务 99/);
  }finally{h.s.close();}
});

test('弹层遮挡仅对确定未点击的表情退避三次；点击不明的回执保留不重试',async()=>{
  const h=harness();try{const m=msg('9000000000001','测试');h.s.incoming(m);h.engine.progress.receive(m);let attempts=0;h.engine.adapter.react=async()=>{attempts++;return {supported:false,notSubmitted:true,retryable:true,code:'OVERLAY_BLOCKED',reason:'弹层遮挡'};};
    for(let i=0;i<3;i++){await h.engine.deliver();h.s.db.prepare('UPDATE outbox SET next_attempt=0').run();}await h.engine.deliver();assert.equal(attempts,3);assert.equal(h.s.snapshot().outbox[0].status,'unavailable');assert.equal(h.sent.length,0);
  }finally{h.s.close();}
});

test('派发调度只锁具体目标聊天，不同目标并行，同目标后续任务串行',async()=>{
  const h=harness();try{h.s.saveConfig({targets:[{id:'chat-A',alias:'A'},{id:'chat-B',alias:'B'}]});const a=h.engine.dispatch('A','第一个','授权A'),again=h.engine.dispatch('A','第二个','授权A2'),b=h.engine.dispatch('B','独立任务','授权B');let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r),calls=[];
    h.c.run=async(id,input,o)=>{calls.push(id);const turnId='turn-'+calls.length;o.onSubmitted();o.onStarted(turnId);if(calls.length===1){started();await hold;}return {text:'完成',turnId};};
    const first=h.engine.runTask();await ready;await h.engine.runTask();assert.deepEqual(calls,['chat-A','chat-B']);assert.equal(h.s.db.prepare('SELECT status FROM tasks WHERE id=?').get(b).status,'done');assert.equal(h.s.db.prepare('SELECT status FROM tasks WHERE id=?').get(a).status,'running');assert.equal(h.s.db.prepare('SELECT status FROM tasks WHERE id=?').get(again).status,'queued');assert.equal(h.engine.taskBusy,true);
    release();await first;await h.engine.runTask();assert.deepEqual(calls,['chat-A','chat-B','chat-A']);assert.equal(h.engine.taskBusy,false);
  }finally{h.s.close();}
});

test('轻量判断尚未返回时重叠调度不能重复启动模型',async()=>{
  const h=harness();try{
    const first=msg('7000000000001','制作网站');h.s.incoming(first);await h.engine.processNext();
    let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    h.engine.progress.classify=async()=>{entered();await barrier;return {text:JSON.stringify({relation:'independent',operationId:''})};};
    h.s.incoming(msg('7000000000002','整理另一项资料'));const processing=h.engine.processNext();await started;await h.engine.processNext();release();await processing;assert.equal(h.calls.length,2);
  }finally{h.s.close();}
});

test('升级遗留的排队任务如已有执行回合，隔离核实而不重跑',async()=>{
  const h=harness(),root=h.s.root;const id=h.s.createTask('网站','project','原任务');h.s.taskStatus(id,'queued','','existing-turn');h.s.close();
  const restored=harness(root);try{await restored.engine.runTask();assert.equal(restored.calls.length,0);assert.equal(restored.s.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'uncertain');}finally{restored.s.close();}
});

test('媒体后的同一用户说明合并到原操作，不启动第二轮模型',async()=>{
  const h=harness();try{
    const time=Date.now(),native=(id,extra)=>({id,conversation:owner.chatKey,sender:owner.peerUid,direction:'in',created:time,...extra});
    h.engine.armedAt=time-100;
    h.engine.adapter.scan=async()=>({peer:owner,messages:[native('8100000000001',{kind:'video',awemeId:'1234567890123456'}),native('8100000000002',{kind:'text',text:'只解释第 2 张图',created:time+500})]});
    const note=join(h.s.root,'note.md');
    await import('node:fs/promises').then(fs=>fs.writeFile(note,'fixture'));
    h.engine.media.process=async()=>({id:'1234567890123456',kind:'album',title:'fixture',path:note,images:[],slides:[]});
    await h.engine.scan();await h.engine.processNext();assert.equal(h.calls.length,0,'attachment waits briefly for its caption');
    h.s.db.prepare("UPDATE messages SET body=json_set(body,'$.attachmentWaitUntil',0) WHERE kind='video'").run();
    await h.engine.processNext();await h.engine.processNext();
    assert.equal(h.calls.length,1);assert.match(h.calls[0].input[0].text,/只解释第 2 张图/);
    assert.equal(h.s.db.prepare("SELECT count(*) n FROM operations").get().n,1);
    assert.equal(h.s.db.prepare("SELECT status FROM messages WHERE kind='text'").get().status,'merged_attachment');
  }finally{h.s.close();}
});
