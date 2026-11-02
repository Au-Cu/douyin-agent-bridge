import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {replyReferencePath} from './reply-reference.mjs';
import {emptyMemory} from './needs.mjs';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const json=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const unsafe=new Set(['running','sending','uncertain','failed_delivery','stopping','processing','classifying','submitted']);

// Permanent deletion is local, explicitly confirmed, and never a model tool or
// slash command. The database transaction queues only bounded cache cleanup;
// a crash cannot leave resumable task rows behind or replay external work.
export class ArchivedDeletion{
  constructor({store,engine,conversations}){
    Object.assign(this,{store,engine,conversations});this.db=store.db;this.confirmations=new Map();
    this.cleanup();
  }
  plan(kind,id){
    if(!['task','need'].includes(kind))throw new Error('仅支持彻底删除已归档的任务或需求。');
    const need=kind==='need'?this.conversations.needs.lookup(id,{includeArchived:true}):null;
    const selected=need||this.engine.archives.task(id),archive=this.store.archiveRecord(kind,selected.id);
    if(!archive?.archived||archive.state!=='done'||!archive.desired)throw new Error('请先完成归档，再彻底删除；归档仍需核实时不能删除。');
    if(need&&this.engine.archives.busy.has(need.id))throw new Error('该需求正在归档或恢复，请稍后再删除。');
    if(need&&this.db.prepare("SELECT 1 FROM archive_jobs WHERE need_id=? AND status IN ('submitted','uncertain')").get(need.id))throw new Error('该需求的原生归档结果尚未核实，不能删除。');
    const operations=this.db.prepare('SELECT * FROM operations ORDER BY created,id').all();
    const ids=new Set(need?operations.filter(o=>o.need_id===need.id).map(o=>o.id):[selected.id]);
    const links=this.db.prepare('SELECT * FROM operation_messages ORDER BY message_id').all();
    // Include true linked children and the hidden duplicate operation rows,
    // never another independent task merely because it has a similar title.
    for(let changed=true;changed;){changed=false;for(const op of operations)if(!ids.has(op.id)&&(ids.has(op.parent)||links.some(l=>l.message_id===op.id&&ids.has(l.operation_id)))){ids.add(op.id);changed=true;}}
    const ops=operations.filter(o=>ids.has(o.id));
    for(const op of ops){
      if(op.status!=='merged'&&!this.store.isArchived('task',op.id))throw new Error('关联任务 '+(op.number||op.title||'命令回执')+' 尚未归档，请先归档后再删除。');
      if(unsafe.has(op.status))throw Object.assign(new Error('关联任务仍在运行、发送或结果尚未核实，不能删除现场。'),op.status==='failed_delivery'?{code:'DELIVERY_UNCONFIRMED'}:{});
      if(op.submitted&&!op.turn&&!['done','merged'].includes(op.status))throw new Error('关联任务已提交但缺少可核实的回合，不能删除现场。');
      const record=this.store.archiveRecord('task',op.id);if(record&&record.state!=='done')throw new Error('关联任务的归档状态尚未核实。');
    }
    const tasks=this.db.prepare('SELECT * FROM tasks ORDER BY id').all().filter(t=>{const c=json(t.context);return ids.has(c.operationId)||need&&c.needId===need.id;});
    if(tasks.some(t=>unsafe.has(t.status)||!['queued','blocked','done','failed','cancelled'].includes(t.status)||['queued','blocked'].includes(t.status)&&!!t.turn))throw new Error('关联执行的状态尚未核实，不能删除现场。');
    const taskIds=new Set(tasks.map(t=>t.id)),messageIds=new Set([...ids,...links.filter(l=>ids.has(l.operation_id)).map(l=>l.message_id),...tasks.map(t=>'task-result:'+t.id)]);
    const turns=this.db.prepare('SELECT * FROM need_turns ORDER BY message_id').all().filter(t=>messageIds.has(t.message_id)||need&&t.need_id===need.id);
    if(turns.some(t=>unsafe.has(t.status)))throw new Error('关联需求回合的结果尚未核实，不能删除。');
    for(const t of turns)messageIds.add(t.message_id);
    const needIds=new Set([...(need?[need.id]:[]),...ops.map(o=>o.need_id),...turns.map(t=>t.need_id),...tasks.map(t=>json(t.context).needId)].filter(Boolean));
    const messages=this.db.prepare('SELECT * FROM messages ORDER BY id').all().filter(m=>messageIds.has(m.id));
    if(messages.some(m=>unsafe.has(m.status)))throw new Error('关联消息仍在处理中或结果尚未核实，不能删除。');
    const outbox=this.db.prepare('SELECT * FROM outbox ORDER BY id').all().filter(o=>{const p=json(o.payload);return ids.has(p.operationId)||taskIds.has(p.taskId)||messageIds.has(p.messageId);});
    if(outbox.some(o=>['sending','uncertain'].includes(o.status)))throw Object.assign(new Error('关联回复或表情的送达尚未核实，请先打开“核实送达”处理，不能直接删除发送现场。'),{code:'DELIVERY_UNCONFIRMED'});
    const outIds=new Set(outbox.map(o=>o.id));
    const references=this.db.prepare('SELECT * FROM reply_reference_links ORDER BY message_id').all().filter(r=>messageIds.has(r.message_id)||outIds.has(r.outbox_id));
    const outgoing=this.db.prepare('SELECT * FROM outgoing_message_links ORDER BY peer,platform_id').all().filter(l=>outIds.has(l.outbox_id));
    const interruptions=this.db.prepare('SELECT * FROM interruptions ORDER BY operation_id').all().filter(i=>ids.has(i.operation_id));
    if(interruptions.some(i=>i.state!=='stopped'))throw new Error('关联任务的中断结果尚未核实，不能删除。');
    // Even a completed operation can still be writing its auxiliary summary.
    // A short, local busy fence prevents late cache writes from resurrecting it.
    if(this.engine.busy||this.engine.picking||this.engine.memoryUpdates?.size||this.engine.reconcilingTasks)throw new Error('助手正在整理或核对记录，请稍后再删除。');
    const dependent=new Set([...ids,...references.map(r=>r.message_id)]);
    if([...this.engine.interrupts.scopes].some(([key,s])=>dependent.has(key)&&s.users>0)||tasks.some(t=>this.engine.taskRuns.get(t.thread)===t.id))throw new Error('关联任务仍有运行进程，请等结束或先中断并核实。');
    for(const op of operations)if(!ids.has(op.id)&&needIds.has(op.need_id)&&unsafe.has(op.status))throw new Error('同一需求还有运行或未核实的任务，暂不能清理其历史缓存。');
    const paths=new Set();
    const add=path=>paths.add(relative(this.store.root,path).split(sep).join('/'));
    for(const mid of messageIds)add(replyReferencePath(this.store.root,mid));
    for(const ref of references)add(replyReferencePath(this.store.root,ref.message_id));
    if(need)add(join(this.store.root,'needs',need.id));
    for(const nid of needIds){
      if(nid===need?.id)continue;
      add(join(this.store.root,'needs',nid,'history.json'));
      // Derived handoffs may contain a deleted turn's summary. Regenerate from
      // surviving source rows instead of feeding those caches back to the model.
      const folder=join(this.store.root,'needs',nid);
      if(existsSync(folder))for(const name of readdirSync(folder))if(/^handoff-\d+\.json$/.test(name))add(join(folder,name));
      for(const mid of messageIds)add(join(folder,'input-'+mid.replace(/[^\w-]/g,'').slice(-80)+'.json'));
    }
    const plan={kind,id:selected.id,label:(need?'需求 ':'任务 ')+(selected.number||'')+'：'+selected.title,ops,tasks,messages,turns,outbox,references,outgoing,interruptions,needIds:[...needIds].sort(),messageIds:[...messageIds].sort(),paths:[...paths].sort(),need,archive};
    // Include source rows, not only counts: restoring or changing any selected
    // record invalidates an already displayed confirmation.
    plan.revision=hash(JSON.stringify(plan));return plan;
  }
  prepare(kind,id){
    const p=this.plan(kind,id),token=randomUUID();for(const [k,v]of this.confirmations)if(v.expires<Date.now())this.confirmations.delete(k);
    this.confirmations.set(token,{kind,id:p.id,revision:p.revision,expires:Date.now()+5*60000});
    return {token,label:p.label,counts:{operations:p.ops.filter(o=>o.status!=='merged').length,tasks:p.tasks.length,messages:p.messages.length,replies:p.outbox.filter(o=>o.kind==='text').length,receipts:p.outbox.filter(o=>o.kind!=='text').length},warning:'永久删除本机桥接记录，无法用“恢复显示”找回。抖音消息、Codex／DSH 原聊天、学习资料、已有备份及其他独立任务中的副本保留。仅保留防重复处理的不可逆消息指纹和编号计数。'};
  }
  remove({kind,id,token}){
    const confirmation=this.confirmations.get(token);
    if(!confirmation||confirmation.expires<Date.now()||confirmation.kind!==kind||confirmation.id!==id)throw new Error('删除确认已失效，请重新打开确认框。');
    const p=this.plan(kind,id);if(p.revision!==confirmation.revision)throw new Error('记录已经变化，请重新确认删除范围。');
    const opIds=new Set(p.ops.map(o=>o.id)),taskIds=new Set(p.tasks.map(t=>t.id));
    const cleanupId=randomUUID(),clearCurrent=p.need&&(this.store.config.activeNeed===p.need.id||this.store.config.coordinator===p.need.thread);this.db.exec('BEGIN IMMEDIATE');
    try{
      // The tiny hash-only dedupe fence survives deletion and restart. No old
      // request, reply, title, account identifier or execution prompt is kept.
      for(const mid of p.messageIds)this.db.prepare('INSERT OR IGNORE INTO deleted_messages VALUES(?)').run(hash(mid));
      for(const link of p.outgoing)this.db.prepare('INSERT OR IGNORE INTO deleted_reply_links VALUES(?)').run(hash(link.peer+':'+link.platform_id));
      for(const op of p.ops){
        if(op.number){const [root,suffix]=String(op.number).split('-');this.store.retainNumber(suffix?'supplement:'+root:'task',Number(suffix||root));}
        for(const [table,column] of [['task_waits','operation_id'],['task_retry_events','operation_id'],['interruptions','operation_id'],['operation_messages','operation_id'],['operations','id']])this.db.prepare('DELETE FROM '+table+' WHERE '+column+'=?').run(op.id);
        this.db.prepare("DELETE FROM archive_records WHERE kind='task' AND id=?").run(op.id);
      }
      for(const t of p.tasks){for(const [table,column] of [['task_waits','task_id'],['task_retry_events','task_id'],['tasks','id']])this.db.prepare('DELETE FROM '+table+' WHERE '+column+'=?').run(t.id);}
      for(const mid of p.messageIds){
        for(const [table,column] of [['messages','id'],['need_turns','message_id'],['need_routes','message_id'],['operation_messages','message_id'],['reply_reference_links','message_id']])this.db.prepare('DELETE FROM '+table+' WHERE '+column+'=?').run(mid);
        this.db.prepare('DELETE FROM task_waits WHERE task_id=?').run('message:'+mid);
      }
      for(const out of p.outbox){for(const [table,column] of [['outgoing_message_links','outbox_id'],['reply_reference_links','outbox_id'],['outbox','id']])this.db.prepare('DELETE FROM '+table+' WHERE '+column+'=?').run(out.id);}
      this.db.prepare("UPDATE operations SET parent='' WHERE parent<>'' AND NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=operations.parent)").run();
      for(const nid of p.needIds){
        if(nid===p.need?.id)continue;
        const n=this.conversations.needs.get(nid);if(n){this.db.prepare('UPDATE needs SET memory=?,version=version+1,summary_version=-1,updated=? WHERE id=?').run(JSON.stringify({...emptyMemory(),title:n.title}),Date.now(),nid);this.db.prepare("UPDATE need_threads SET handoff='' WHERE need_id=?").run(nid);}
      }
      if(p.need){
        this.store.retainNumber('need',p.need.number);
        for(const [table,column] of [['need_turns','need_id'],['need_routes','need_id'],['need_assets','need_id'],['need_threads','need_id'],['archive_jobs','need_id'],['needs','id']])this.db.prepare('DELETE FROM '+table+' WHERE '+column+'=?').run(p.need.id);
        this.db.prepare("DELETE FROM archive_records WHERE kind='need' AND id=?").run(p.need.id);
        if(clearCurrent){const config={...this.store.config,activeNeed:'',coordinator:'',needEpoch:(this.store.config.needEpoch||0)+1};this.db.prepare("UPDATE app_settings SET value=?,updated=? WHERE key='config'").run(JSON.stringify(config),Date.now());}
      }
      this.db.prepare('INSERT INTO deletion_cleanup VALUES(?,?,?)').run(cleanupId,JSON.stringify(p.paths),Date.now());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    if(clearCurrent)this.store.saveConfig({activeNeed:'',coordinator:'',needEpoch:(this.store.config.needEpoch||0)+1});
    this.confirmations.delete(token);
    for(const op of opIds)this.engine.progress.checks.delete(op);
    for(const task of taskIds)this.engine.taskObservations.delete(task);
    const remaining=this.cleanup();
    for(const nid of p.needIds)if(nid!==p.need?.id&&this.conversations.needs.get(nid))try{this.conversations.needs.history(nid);}catch{}
    this.store.event('用户已彻底删除已归档的'+(kind==='need'?'需求':'任务')+'记录');
    return {deleted:true,cleanupPending:remaining>0,operations:p.ops.filter(o=>o.status!=='merged').length};
  }
  cleanup(){
    for(const job of this.db.prepare('SELECT * FROM deletion_cleanup').all()){
      try{for(const path of JSON.parse(job.paths))this.removeCache(path);this.db.prepare('DELETE FROM deletion_cleanup WHERE id=?').run(job.id);}
      catch{this.store.event('删除已提交；部分历史缓存尚未清理，重启后将继续清理。','attention');}
    }
    return this.db.prepare('SELECT COUNT(*) AS n FROM deletion_cleanup').get().n;
  }
  removeCache(path){
    if(!/^(?:needs\/[a-f\d]{8}(?:\/(?:history|handoff-\d+|input-[\w-]+)\.json)?|reply-references\/[a-f\d]{64}\.json)$/.test(path))throw new Error('拒绝清理非需求或引用缓存路径');
    const root=realpathSync(this.store.root),target=resolve(root,...path.split('/'));
    if(!target.startsWith(root+sep))throw new Error('清理路径越界');
    let current=root;
    for(const part of path.split('/')){current=join(current,part);if(!existsSync(current))return;const info=lstatSync(current);if(info.isSymbolicLink()||realpathSync(current)!==current)throw new Error('缓存路径含链接，已保留待核实');}
    const check=folder=>{for(const name of readdirSync(folder)){const child=join(folder,name),info=lstatSync(child);if(info.isSymbolicLink())throw new Error('缓存包含链接，已保留待核实');if(info.isDirectory())check(child);}};
    if(lstatSync(target).isDirectory())check(target);
    rmSync(target,{recursive:true,force:true});
  }
}
