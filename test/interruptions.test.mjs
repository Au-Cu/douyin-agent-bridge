import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtempSync,mkdirSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {CodexClient} from '../src/codex.mjs';import {commandHelp} from '../src/commands.mjs';import {runFfmpeg} from '../src/media.mjs';import {operationContext,workSignal,interruptedError} from '../src/execution.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const waitFor=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Fixture wait timed out');};
function harness({real=false,root}={}){
  const s=new Store(root||mkdtempSync(join(base,'interrupt-')));s.saveConfig({enabled:true,owner:{chatKey:'owner',peerUid:'owner-id'},coordinator:'chat-A',targets:[{id:'chat-B',alias:'网站'}]});
  const c=real?new CodexClient({codexHome:mkdtempSync(join(base,'interrupt-auth-')),executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-interrupt-rpc.mjs',import.meta.url))]}):new EventEmitter();
  if(!real){c.ready=true;c.connect=async()=>{};c.ensureAuthenticated=async()=>{};c.interrupt=async()=>({confirmed:true});}
  const e=new BridgeEngine({store:s,codex:c,adapter:{send:async()=>{},react:async()=>({verified:true})},media:{}});
  const msg=(text,id=String(Date.now())+String(Math.random()).slice(2,5))=>{const m={id:'owner:'+id,platformId:id,peer:'owner',sender:'owner-id',direction:'in',created:Date.now(),kind:'text',text};s.incoming(m);e.progress.receive(m);if(!text.startsWith('/'))e.progress.identify(m.id);return m;};
  return {s,c,e,msg,close:()=>{c.close?.();s.close();}};
}
test('中断绕过已堵塞控制队列和执行锁；立即停止对应回合，其他聊天继续',async()=>{
  const h=harness({real:true});try{
    const a=h.msg('long'),running=h.e.processNext();await waitFor(()=>[...h.c.runs.values()].some(r=>r.threadId==='chat-A'&&r.turnId));
    const b=h.msg('其他聊天');const other=h.e.interrupts.run(b.id,()=>h.c.run('chat-B',[{type:'text',text:'finish'}]));
    h.e.controlTail=new Promise(()=>{});const stop=h.msg('/中断 1');assert.equal(h.e.busy,true);h.e.handleControl(stop);assert.ok(h.e.interrupts.record(a.id),'必须同步落盘并触发停止，不能等控制队列');
    await running;assert.equal(h.e.busy,false);const result=await h.e.interrupts.requests.get(a.id);assert.equal(result.state,'stopped');assert.equal((await other).text,'OTHER_CHAT_OK');
    assert.equal(h.e.progress.get(a.id).status,'cancelled');h.e.progress.finish(a.id);h.e.progress.stage(a.id,'迟到结果','',{running:true});h.e.reply('不应发送',{operationId:a.id});assert.equal(h.e.progress.get(a.id).status,'cancelled');assert.equal(h.s.snapshot().outbox.some(o=>o.body==='不应发送'),false);
    assert.throws(()=>h.e.progress.retry('1'),/已中断/);assert.equal(h.c.interrupting.size,0);
  }finally{h.close();}
});
test('turn/start 尚未返回时中断，收到回合号后仍会取消，不能漏掉启动窗口',async()=>{
  const h=harness({real:true});try{
    const m=h.msg('gap'),run=h.e.processNext();await waitFor(()=>[...h.c.runs.values()].some(r=>r.threadId==='chat-A'&&r.turnId));
    const result=await h.e.interrupts.request('1');assert.equal(result.state,'stopped');await run;assert.equal(h.e.progress.get(m.id).status,'cancelled');assert.equal(h.c.runs.size,0);
  }finally{h.close();}
});
test('真实 FFmpeg 子进程被中断终止，释放调度；已完成证据无需删除',async()=>{
  const h=harness();try{
    const m=h.msg('视频处理'),run=h.e.interrupts.run(m.id,async()=>{h.e.progress.stage(m.id,'解码','',{running:true});await runFfmpeg(['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=black:s=16x16:r=1','-f','null','-'],60000);});run.catch(()=>{});
    await waitFor(()=>h.e.progress.get(m.id).status==='running');await new Promise(r=>setTimeout(r,100));const child=[...h.e.interrupts.scopes.get(m.id).processes][0],result=await h.e.interrupts.request('1');assert.equal(result.state,'stopped');assert.ok(child.exitCode!==null||child.signalCode!==null,'必须等真实子进程退出才确认停止');await assert.rejects(run,e=>e.code==='TASK_INTERRUPTED');assert.equal(h.e.progress.get(m.id).status,'cancelled');
  }finally{h.close();}
});
test('中断状态跨重启保留，不因恢复显示或迟到结果重新执行',async()=>{
  const h=harness(),root=h.s.root,m=h.msg('排队');await h.e.interrupts.request('1');h.close();const restored=harness({root});try{assert.equal(restored.e.progress.get(m.id).status,'cancelled');restored.s.messageStatus(m.id,'new');assert.equal(restored.s.pendingMessages().length,0);restored.e.archives.archiveTask('1');restored.e.archives.restoreTask('1');assert.throws(()=>restored.e.progress.retry('1'),/已中断/);}finally{restored.close();}
});
test('中断命令越过普通收件队列前 20 条，且帮助不再显示旧指令兼容尾行',async()=>{
  const h=harness();try{
    const target=h.msg('等待任务');for(let i=0;i<25;i++)h.msg('普通排队 '+i);const stop=h.msg('/中断 1');h.e.busy=true;h.e.controlTail=new Promise(()=>{});await h.e.processNext();await waitFor(()=>h.e.interrupts.record(target.id)?.state==='stopped');assert.equal(h.e.progress.get(target.id).status,'cancelled');assert.notEqual(h.s.db.prepare('SELECT status FROM messages WHERE id=?').get(stop.id).status,'new');assert.match(commandHelp,/\/中断/);assert.doesNotMatch(commandHelp,/旧的|继续兼容/);
  }finally{h.close();}
});
test('发送中断保留已尝试发送的未知回执，撤下尚未发送的后续分段',async()=>{
  const h=harness();try{
    const m=h.msg('分段结果');h.e.progress.db.prepare("UPDATE operations SET ended=1,status='sending',outcome='done' WHERE id=?").run(m.id);const ids=h.e.reply('结果'.repeat(700),{operationId:m.id});
    h.s.db.prepare("UPDATE outbox SET priority=-1 WHERE kind='progress_reaction'").run();let entered=false;
    h.e.adapter.send=async()=>{operationContext.getStore().delivery.submitted=true;entered=true;await new Promise((_,reject)=>workSignal().addEventListener('abort',()=>reject(interruptedError()),{once:true}));};
    const sending=h.e.deliver();await waitFor(()=>entered);const result=await h.e.interrupts.request('1');await sending;assert.equal(result.state,'stopped');assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(ids[0]).status,'uncertain');for(const id of ids.slice(1))assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'superseded');
  }finally{h.close();}
});
test('归档任务不参与新消息的重复或补充关联，恢复后也不自动重挂旧补充',async()=>{
  const h=harness();try{
    const old=h.msg('做网站'),child=h.msg('改绿色');h.e.progress.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(old.id,child.id);h.e.archives.archiveTask('1');assert.equal(h.e.progress.get(child.id).parent,'');assert.equal(h.e.progress.canRun(child.id),false);assert.equal(h.e.progress.get(child.id).status,'blocked');
    const seen=[];h.e.progress.classify=async p=>{seen.push(p);return {text:JSON.stringify({relation:'supplement',operationId:old.id})};};const fresh=h.msg('做网站');const routed=await h.e.progress.triage(fresh);assert.equal(routed.relation,'independent');assert.equal(h.e.progress.get(fresh.id).parent,'');assert.ok(seen.every(p=>p.activeRequests.every(o=>o.id!==old.id)));
    h.e.archives.restoreTask('1');assert.equal(h.e.progress.get(child.id).parent,'');
  }finally{h.close();}
});
test('判断期间原任务被归档，迟到的补充关联结果必须作废',async()=>{
  const h=harness();try{
    const old=h.msg('做网站'),fresh=h.msg('改蓝色');let complete;h.e.progress.classify=()=>new Promise(r=>complete=r);const deciding=h.e.progress.triage(fresh);await waitFor(()=>!!complete);h.e.archives.archiveTask('1');complete({text:JSON.stringify({relation:'supplement',operationId:old.id})});assert.equal((await deciding).relation,'independent');assert.equal(h.e.progress.get(fresh.id).parent,'');
  }finally{h.close();}
});

test('收取私信时发送锁不阻挡中断，且同批中断先于普通指令分类',async()=>{
  const h=harness();try{
    const target=h.msg('等着处理');h.e.busy=true;h.e.armedAt=Date.now()-1000;h.e.controlTail=new Promise(()=>{});h.e.adapter.sending=true;let checkedBeforeClassify=false;
    const raw=(id,text)=>({id,conversation:'owner',sender:'owner-id',direction:'in',kind:'text',text,created:Date.now()});h.e.adapter.scan=async()=>({peer:h.s.config.owner,messages:[raw('8000000000001','普通新消息'),raw('8000000000002','/中断 1')]});
    const triage=h.e.progress.triage.bind(h.e.progress);h.e.progress.triage=async m=>{checkedBeforeClassify=!!h.e.interrupts.record(target.id);return triage(m);};await h.e.scan();await waitFor(()=>checkedBeforeClassify);assert.ok(h.e.interrupts.record(target.id));
  }finally{await new Promise(r=>setTimeout(r,30));h.close();}
});
test('Codex 未确认停止时保留需核实与同聊天隔离，不谎报取消或重复中断',async()=>{
  const h=harness({real:true});try{
    const m=h.msg('no-confirm'),run=h.e.processNext();await waitFor(()=>[...h.c.runs.values()].some(r=>r.turnId));const result=await h.e.interrupts.request('1');await run;assert.equal(result.state,'uncertain');assert.equal(h.e.progress.get(m.id).status,'uncertain');const seq=h.c.seq;assert.equal((await h.e.interrupts.request('1')).state,'uncertain');assert.equal(h.c.seq,seq);await assert.rejects(h.c.run('chat-A',[{type:'text',text:'finish'}]),e=>e.code==='THREAD_BUSY');assert.equal((await h.c.run('chat-B',[{type:'text',text:'finish'}])).text,'OTHER_CHAT_OK');
  }finally{h.close();}
});

test('动态工具回调绑定正确任务的取消信号，中断后不能继续启动本地工作',async()=>{
  const h=harness({real:true});try{
    const m=h.msg('工具任务');let toolScope,localStopped=false;const run=h.e.interrupts.run(m.id,()=>h.c.run('chat-A',[{type:'text',text:'tool'}],{onSubmitted:()=>h.e.progress.stage(m.id,'提交','',{thread:'chat-A',submitted:true}),onStarted:turn=>h.e.progress.stage(m.id,'运行','',{thread:'chat-A',turn,submitted:true,running:true}),toolHandler:async()=>{toolScope=operationContext.getStore()?.operationId;await new Promise((_,reject)=>workSignal().addEventListener('abort',()=>{localStopped=true;reject(interruptedError());},{once:true}));}}));run.catch(()=>{});
    await waitFor(()=>toolScope===m.id);assert.equal((await h.e.interrupts.request('1')).state,'stopped');await assert.rejects(run,e=>e.code==='TASK_INTERRUPTED');assert.equal(localStopped,true);
  }finally{h.close();}
});
test('晚到的原生结束事件可以核实中断，检查器更新状态并释放同聊天隔离',async()=>{
  const h=harness({real:true});try{
    const m=h.msg('late-confirm'),run=h.e.processNext();await waitFor(()=>[...h.c.runs.values()].some(r=>r.turnId));const result=await h.e.interrupts.request('1');await run;assert.equal(result.state,'uncertain');await waitFor(()=>h.c.interrupting.size===0);h.e.interrupts.reconcile();assert.equal(h.e.progress.get(m.id).status,'cancelled');assert.equal(h.e.interrupts.record(m.id).state,'stopped');
  }finally{h.close();}
});
