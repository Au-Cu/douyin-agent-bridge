import {operationContext,checkWork,interruptedError,raceWork} from './execution.mjs';
const unfinished=new Set(['queued','running','sending','waiting','blocked','uncertain','failed_delivery','stopping']);
export class Interruptions{
  constructor({store,codex,progress}){
    Object.assign(this,{store,codex,progress});this.scopes=new Map();this.requests=new Map();
    store.db.prepare("UPDATE interruptions SET state='uncertain',error='中断期间程序重启，停止结果需核实' WHERE state='stopping'").run();
    for(const r of store.db.prepare('SELECT * FROM interruptions').all())store.db.prepare('UPDATE operations SET status=?,phase=?,ended=1,outcome=? WHERE id=?').run(r.state==='stopped'?'cancelled':'uncertain',r.state==='stopped'?'用户已中断':'中断结果需要核实','cancelled',r.operation_id);
  }
  record(id){return id?this.store.db.prepare('SELECT * FROM interruptions WHERE operation_id=?').get(id):null;}
  assert(id){if(this.record(id))throw interruptedError();}
  async run(id,fn){
    let scope=this.scopes.get(id);if(!scope){const controller=new AbortController();scope={operationId:id,controller,signal:controller.signal,stopChecks:new Set(),users:0,guard:()=>this.assert(id)};this.scopes.set(id,scope);}
    scope.users++;try{return await operationContext.run(scope,()=>{checkWork();return raceWork(Promise.resolve().then(fn));});}
    finally{scope.users--;if(!scope.users&&!scope.signal.aborted)this.scopes.delete(id);}
  }
  request(value){
    const raw=String(value).trim().replace(/^任务\s*/,''),op=/^\d+$/.test(raw)?this.store.db.prepare('SELECT * FROM operations WHERE number=?').get(Number(raw)):this.progress.get(raw);
    if(!op||op.kind==='control')throw new Error('未找到该任务，请填写任务编号，例如 /中断 5。');
    if(this.requests.has(op.id))return this.requests.get(op.id);
    const old=this.record(op.id);if(old)return Promise.resolve({number:op.number,title:op.title,state:old.state,error:old.error,alreadyRequested:true});
    if(!unfinished.has(op.status))return Promise.resolve({number:op.number,title:op.title,state:'finished',error:'该任务已结束，没有需要中断的执行。'});
    const scope=this.scopes.get(op.id),tasks=this.progress.tasks(op.id),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare("INSERT INTO interruptions VALUES(?,'stopping',?,?, '')").run(op.id,Date.now(),Date.now());
      db.prepare("UPDATE operations SET status='stopping',phase='正在强制中断',ended=1,outcome='cancelled' WHERE id=?").run(op.id);
      db.prepare("UPDATE messages SET status='cancelled',result='用户已中断' WHERE id=?").run(op.id);
      if(scope?.delivery?.submitted)db.prepare("UPDATE outbox SET status='uncertain',error='中断时已尝试发送，送达需要核实' WHERE id=? AND status='sending'").run(scope.delivery.id);
      db.prepare("UPDATE outbox SET status='superseded',error='用户中断，取消尚未发送的结果和后续进度' WHERE status='pending' AND json_extract(payload,'$.operationId')=? AND (kind='text' OR json_extract(payload,'$.stage')<>'roger')").run(op.id);
      db.prepare('DELETE FROM task_waits WHERE operation_id=?').run(op.id);
      for(const child of db.prepare("SELECT id FROM operations WHERE parent=? AND submitted=0 AND status IN ('queued','waiting','blocked')").all(op.id)){
        db.prepare("UPDATE operations SET status='blocked',phase='原任务已中断，补充要求暂停' WHERE id=?").run(child.id);this.store.messageStatus(child.id,'blocked','原任务已中断，补充要求暂停');
        db.prepare('INSERT OR REPLACE INTO task_waits VALUES(?,?,?,?,?,?,1)').run('message:'+child.id,child.id,'原任务已中断，补充要求暂停',Date.now(),0,0);
      }
      for(const t of tasks)if(!['done','failed','cancelled'].includes(t.status))this.store.taskStatus(t.id,t.turn?'uncertain':'cancelled','用户已中断，正在核对停止结果');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    // This abort is synchronous. It bypasses every engine/model/settings queue.
    scope?.controller.abort(interruptedError());
    const promise=this.finish(op,scope,tasks);this.requests.set(op.id,promise);promise.finally(()=>this.requests.delete(op.id));return promise;
  }
  async finish(op,scope,tasks){
    const checks=[...(scope?.stopChecks||[])];
    // Reconcile an explicitly selected persisted turn only, never another turn
    // that happens to be running in the same target chat.
    const owned=new Map();if(op.submitted&&op.thread&&op.turn)owned.set(op.thread+':'+op.turn,{thread:op.thread,turn:op.turn});for(const t of tasks)if(t.turn&&['running','uncertain'].includes(t.status))owned.set(t.thread+':'+t.turn,{thread:t.thread,turn:t.turn});
    for(const t of owned.values())if(![...(scope?.nativeRuns||[])].some(r=>r.threadId===t.thread&&r.turnId===t.turn))checks.push(this.codex.interrupt(t.thread,{turnId:t.turn,verifyOwnership:true}).then(result=>({...result,kind:'codex',external:true})));
    if(op.submitted&&!owned.size&&!scope?.nativeRuns?.size)checks.push(Promise.resolve({confirmed:false,error:'没有可核实的 Codex 回合编号'}));
    const results=await Promise.all(checks.map(p=>Promise.resolve(p).catch(e=>({confirmed:false,error:e.message}))));
    if(scope)scope.lastStopResults=results;
    const unknown=results.filter(r=>!r?.confirmed),confirmed=!unknown.length,state=confirmed?'stopped':'uncertain',error=unknown.map(r=>r?.error||'暂时无法确认运行状态').join('；').slice(0,600);
    this.store.db.prepare('UPDATE interruptions SET state=?,updated=?,error=? WHERE operation_id=?').run(state,Date.now(),error,op.id);
    this.store.db.prepare('UPDATE operations SET status=?,phase=?,detail=? WHERE id=?').run(confirmed?'cancelled':'uncertain',confirmed?'用户已中断':'本地已切断，Codex 停止结果需核实',error,op.id);
    for(const t of tasks)if(!['done','failed','cancelled'].includes(t.status))this.store.taskStatus(t.id,confirmed?'cancelled':'uncertain',confirmed?'用户已中断':error);
    if(confirmed)this.scopes.delete(op.id);
    return {number:op.number,title:op.title,state,error};
  }
  describe(result){return `任务 ${result.number}：${result.title}\n`+(result.state==='finished'?result.error:result.state==='stopped'?'已中断，后续执行和未发送的回复已停止。':'本地处理已切断；Codex 停止结果暂时无法确认，保留现场，不会自动重跑。');}
  reconcile(){
    for(const [id,scope] of this.scopes){
      if(this.record(id)?.state!=='uncertain'||!scope.nativeRuns?.size||!scope.lastStopResults?.every(r=>r.confirmed||r.kind==='codex'&&!r.external)||![...scope.nativeRuns].every(r=>r.terminal&&['completed','failed','interrupted'].includes(r.terminal.status)))continue;
      this.store.db.prepare("UPDATE interruptions SET state='stopped',error='',updated=? WHERE operation_id=?").run(Date.now(),id);this.store.db.prepare("UPDATE operations SET status='cancelled',phase='用户已中断，停止已核实',detail='' WHERE id=?").run(id);
      for(const task of this.progress.tasks(id))if(task.status==='uncertain')this.store.taskStatus(task.id,'cancelled','用户已中断，停止已核实');this.scopes.delete(id);
    }
  }
}
