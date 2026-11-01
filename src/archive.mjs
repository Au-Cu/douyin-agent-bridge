export const archiveScopes=new Set(['current','archived','all']);
export const taskStatuses=new Set(['all','queued','running','blocked','uncertain','done','cancelled','failed','waiting','sending','failed_delivery','stopping']);
export const archiveScope=value=>{const scope=value||'current';if(!archiveScopes.has(scope))throw new Error('归档范围必须为 current、archived 或 all');return scope;};
export const codexThreadUrl=id=>/^(?:dsh:)?[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(id||''))?String(id).startsWith('dsh:')?'dsh://session/'+encodeURIComponent(id.slice(4)):'codex://threads/'+encodeURIComponent(id):null;

export class Archives{
  constructor({store,codex,progress,conversations}){
    Object.assign(this,{store,codex,progress,conversations});this.db=store.db;this.busy=new Set();
    this.db.prepare("UPDATE archive_jobs SET status='uncertain',error='上次归档请求的结果需要核实' WHERE status='submitted'").run();
    this.db.prepare("UPDATE archive_records SET state='attention',error='上次归档过程被中断，请核对归档或恢复；未自动重复提交' WHERE kind='need' AND state='pending'").run();
  }
  task(value){const raw=String(value).trim().replace(/^任务\s*/,'');const op=/^\d+(?:-\d+)?$/.test(raw)?this.db.prepare('SELECT * FROM operations WHERE number=?').get(raw.includes('-')?raw:Number(raw)):this.progress.get(raw);if(!op)throw new Error('未找到该任务，请使用任务编号。');return op;}
  archiveTask(value,{reason='manual'}={}){
    const op=this.task(value);if(this.store.isArchived('task',op.id)){this.progress.detachArchivedParents(op.id);return op;}
    const meta={status:op.status,phase:op.phase};this.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.setArchived('task',op.id,true,{reason,meta});
      for(const task of this.progress.tasks(op.id))if(['queued','blocked'].includes(task.status)&&!task.turn){
        this.store.taskStatus(task.id,'blocked','用户已归档，未提交工作暂停');
        this.db.prepare('INSERT OR REPLACE INTO task_waits VALUES(?,?,?,?,?,?,1)').run(task.id,op.id,'用户已归档，未提交工作暂停',Date.now(),0,0);
      }
      const message=this.db.prepare('SELECT status FROM messages WHERE id=?').get(op.id);
      if(!op.submitted&&op.status!=='running'&&message&&['new','classifying','processing','blocked','waiting_auth','waiting_route'].includes(message.status)){
        this.store.messageStatus(op.id,'blocked','用户已归档，未提交工作暂停');
        this.db.prepare('INSERT OR REPLACE INTO task_waits VALUES(?,?,?,?,?,?,1)').run('message:'+op.id,op.id,'用户已归档，未提交工作暂停',Date.now(),0,0);
        this.db.prepare("UPDATE operations SET status='blocked',phase='已归档，未提交工作暂停' WHERE id=?").run(op.id);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}this.progress.detachArchivedParents(op.id);return this.progress.get(op.id);
  }
  restoreTask(value){const op=this.task(value);this.store.setArchived('task',op.id,false,{reason:'restored'});return op;}
  knowledge(id,archived){const item=this.store.knowledge(String(id));if(!item)throw new Error('学习资料不存在');this.store.setArchived('knowledge',item.id,archived,{reason:archived?'manual':'restored'});return item;}
  async threadArchived(thread){
    const client=this.codex.forThread?.(thread)||this.codex;
    await client.connect?.();
    const {thread:t}=await client.request('thread/read',{threadId:thread,includeTurns:false});
    if(typeof t?.archived==='boolean')return t.archived;
    const path=String(t?.path||'').replaceAll('\\','/');if(path.includes('/archived_sessions/'))return true;if(path.includes('/sessions/'))return false;
    let cursor;for(let page=0;page<50;page++){
      const result=await client.request('thread/list',{archived:true,limit:100,...(cursor?{cursor}:{})});if(result.data?.some(t=>t.id===thread))return true;
      cursor=result.nextCursor;if(!cursor)return false;
    }throw new Error('归档状态目录尚未核实完整，未重复发送归档请求');
  }
  async need(value,archived){
    const need=this.conversations.needs.lookup(value,{includeArchived:true}),key=need.id;
    if(this.busy.has(key))throw new Error('该需求的归档操作正在核对，请稍后查看。');this.busy.add(key);
    try{
      const threads=this.db.prepare('SELECT thread FROM need_threads WHERE need_id=? ORDER BY seq').all(need.id).map(t=>t.thread);if(need.thread&&!threads.includes(need.thread))threads.push(need.thread);
      const localOnly=threads.filter(t=>(this.codex.forThread?.(t)||this.codex).capabilities?.nativeArchive===false);
      if(archived){
        if(this.db.prepare("SELECT 1 FROM operations WHERE need_id=? AND kind<>'control' AND status='running' LIMIT 1").get(need.id))throw new Error('该需求仍在执行，先等任务结束再归档需求；可单独收起任务卡片。');
        for(const thread of threads){const client=this.codex.forThread?.(thread)||this.codex;if(client.threadLocks?.has(thread)||client.runs?.has(thread))throw new Error('对应助手聊天仍在运行，未归档。');if(localOnly.includes(thread)){if(client.state?.turns(thread).some(t=>t.status==='inProgress'))throw new Error('对应 DSH 聊天的运行结果尚未核实，未归档。');continue;}await client.connect?.();const read=await client.request('thread/read',{threadId:thread,includeTurns:false});if(read.thread?.status?.type==='active')throw new Error('对应助手聊天仍在运行，未归档。');}
      }
      const previous=this.store.archiveRecord('need',need.id);
      this.store.setArchived('need',need.id,!!previous?.archived,{desired:archived,state:'pending',reason:archived?'manual':'restored'});
      if(archived){
        if(this.store.config.activeNeed===need.id)this.store.saveConfig({activeNeed:'',coordinator:'',needEpoch:(this.store.config.needEpoch||0)+1});
        for(const op of this.db.prepare("SELECT id FROM operations WHERE need_id=? AND kind<>'control' AND status<>'merged'").all(need.id))this.archiveTask(op.id,{reason:'need_archived'});
      }
      for(const thread of threads){
        const direction=Number(archived),old=this.db.prepare('SELECT * FROM archive_jobs WHERE need_id=? AND thread=? AND direction=?').get(need.id,thread,direction);
        if(localOnly.includes(thread)){this.db.prepare('INSERT OR REPLACE INTO archive_jobs VALUES(?,?,?,?,?,?)').run(need.id,thread,direction,'done','仅本地归档：DSH ACP 不支持原生归档',Date.now());continue;}
        const current=await this.threadArchived(thread);
        if(current===archived){this.db.prepare('INSERT OR REPLACE INTO archive_jobs VALUES(?,?,?,?,?,?)').run(need.id,thread,direction,'done','',Date.now());continue;}
        if(old?.status==='uncertain'||old?.status==='submitted')throw new Error('该聊天的上次归档请求仍需核实，未重复提交；可稍后核对，或恢复需求显示。');
        this.db.prepare('INSERT OR REPLACE INTO archive_jobs VALUES(?,?,?,?,?,?)').run(need.id,thread,direction,'submitted','',Date.now());
        try{await this.codex.request(archived?'thread/archive':'thread/unarchive',{threadId:thread});this.db.prepare("UPDATE archive_jobs SET status='done',error='',changed=? WHERE need_id=? AND thread=? AND direction=?").run(Date.now(),need.id,thread,direction);}
        catch(e){this.db.prepare('UPDATE archive_jobs SET status=?,error=?,changed=? WHERE need_id=? AND thread=? AND direction=?').run(e.remote&&!e.uncertain?'failed':'uncertain',String(e.message).slice(0,400),Date.now(),need.id,thread,direction);throw e;}
      }
      this.store.setArchived('need',need.id,archived,{desired:archived,state:'done',reason:archived?'manual':'restored'});
      this.db.prepare("UPDATE archive_jobs SET status='reconciled',error='',changed=? WHERE need_id=? AND direction<>? AND status IN ('submitted','uncertain')").run(Date.now(),need.id,Number(archived));
      return {number:need.number,title:need.title,archived,threads:threads.length,localOnlyThreads:localOnly.length};
    }catch(e){const old=this.store.archiveRecord('need',key);if(old?.state==='pending')this.store.setArchived('need',key,!!old.archived,{desired:archived,state:'attention',error:String(e.message).slice(0,500),reason:old.reason});throw e;}
    finally{this.busy.delete(key);}
  }
}
