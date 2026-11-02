import {createHash} from 'node:crypto';
import {parseCommand} from './commands.mjs';
import {codexThreadUrl} from './archive.mjs';
import {checkWork} from './execution.mjs';

export const progressEmoji={roger:['👌'],active:['[奋斗]'],done:['🎉','✅','👍']};
export const writerConflict=e=>e?.code==='THREAD_BUSY'||/\bactive writer\b|\bthread\b[^.\n]{0,100}\b(?:already (?:active|running)|busy)\b/i.test(String(e?.message||e||''));
export const explicitRedo=text=>{
  const s=String(text||'').replace(/“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g,'').replace(/(?:不要|不必|无需|不需要|别).{0,3}(?:重新(?:做|执行|生成|分析)|重做|再做|从头(?:做|来))/g,'').trim();
  return /^(?:(?:请|麻烦你?|帮我|我要你?|我要求你?|现在|这次|给我|把.{0,20})\s*){0,3}(?:重新(?:做|执行|生成|分析)|重做|再做一遍|从头(?:做|来))/.test(s)||/(?:请|要求你|帮我|给我|麻烦你).{0,10}(?:重新(?:做|执行|生成|分析)|重做|再做一遍|从头(?:做|来))/.test(s);
};
export const requestKey=m=>(m.kind==='video'?'video:'+m.awemeId:'text:'+String(m.text||'').normalize('NFKC').replace(/\s+/g,' ').trim().replace(/[。！!]+$/,''))+(m.referenceKey?'|reply:'+m.referenceKey:'');
const unfinished="'queued','running','sending','waiting','blocked','uncertain','failed_delivery','stopping'";
const opColumns='id,peer,request,fingerprint,kind,need_id,status,phase,detail,created,started,changed,last_notice,ended,outcome,parent,thread,turn,submitted';
export function operationTitle(value){const raw=String(value||'').replace(/\s+/g,' ').trim(),specific=String(value||'').match(/(?:具体任务|用户(?:的)?(?:原话|指示|指令))[:：]\s*([^\n]+)/)?.[1];const text=(specific||raw).replace(/^\/(?:派给|派|dispatch)\s+(\S+)\s+/,'$1：').replace(/^转发视频[:：]/,'学习视频：');const chars=Array.from(text||'未命名任务');return chars.slice(0,36).join('')+(chars.length>36?'…':'');}
const followupSchema={type:'object',properties:{relation:{type:'string',enum:['duplicate','supplement','independent']},operationId:{type:'string'}},required:['relation','operationId'],additionalProperties:false};

export class Progress{
  constructor({store,codex,taskCodex=codex,notify,classify=null,now=Date.now,noticeInterval=60000,stallAfter=90000,writerLimit=5*60000}){
    Object.assign(this,{store,codex,taskCodex,notify,classify,now,noticeInterval,stallAfter,writerLimit});this.db=store.db;this.checks=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,peer TEXT,request TEXT,fingerprint TEXT,kind TEXT,need_id TEXT,status TEXT,phase TEXT,detail TEXT,created INTEGER,started INTEGER,changed INTEGER,last_notice INTEGER,ended INTEGER,outcome TEXT,parent TEXT,thread TEXT,turn TEXT,submitted INTEGER);
      CREATE TABLE IF NOT EXISTS operation_messages(message_id TEXT PRIMARY KEY,operation_id TEXT,relation TEXT,platform_id TEXT);
      CREATE TABLE IF NOT EXISTS task_waits(task_id TEXT PRIMARY KEY,operation_id TEXT,reason TEXT,since INTEGER,attempts INTEGER,next_attempt INTEGER,paused INTEGER);
      CREATE TABLE IF NOT EXISTS task_retry_events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,operation_id TEXT NOT NULL,attempt INTEGER NOT NULL,at INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,legacy INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS task_retry_events_operation ON task_retry_events(operation_id,id);`);
    // Old releases retained only the most recent failure and next deadline. The
    // last timestamp is recoverable from that deadline and the backoff formula;
    // never manufacture the missing intermediate attempts or their reasons.
    for(const w of this.db.prepare("SELECT * FROM task_waits w WHERE w.attempts>0 AND w.operation_id<>'' AND NOT EXISTS(SELECT 1 FROM task_retry_events e WHERE e.task_id=w.task_id)").all()){
      const last=w.next_attempt-Math.min(60000,10000*2**(w.attempts-1));
      if(last>=w.since&&last<=this.now())this.db.prepare("INSERT INTO task_retry_events(task_id,operation_id,attempt,at,outcome,reason,next_attempt,legacy) VALUES(?,?,?,?,'blocked',?,?,1)").run(w.task_id,w.operation_id,w.attempts,last,w.reason,w.paused?0:w.next_attempt);
    }
    const columns=new Set(this.db.prepare('PRAGMA table_info(operations)').all().map(c=>c.name));if(!columns.has('number'))this.db.exec('ALTER TABLE operations ADD COLUMN number INTEGER');if(!columns.has('title'))this.db.exec("ALTER TABLE operations ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS operations_number ON operations(number) WHERE number IS NOT NULL');
    this.db.prepare("UPDATE operations SET status='uncertain',phase='暂时无法确认运行状态',outcome='uncertain' WHERE status='running'").run();
    this.db.prepare("UPDATE messages SET status='new' WHERE status='classifying'").run();
    this.db.prepare("UPDATE outbox SET status='superseded',error='进度已改为仅贴消息表情' WHERE kind='video_ack' AND status='pending'").run();
    // Repair only older failures that prove no reaction was clicked. Never
    // replay an uncertain reaction or toggle one that may already belong to us.
    for(const row of this.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction' AND status='unavailable'").all()){
      const payload=JSON.parse(row.payload||'{}');if(payload.reactionRepairVersion||!(/^此消息菜单没有可核验的贴表情选项$/.test(row.error||'')||/intercepts pointer events/.test(row.error||'')&&/MessageBoxContentactiveClickArea/.test(row.error||'')))continue;
      this.db.exec('BEGIN IMMEDIATE');try{this.store.mergeOutboxPayload(row.id,{reactionRepairVersion:1,reactionAttempt:{state:'not_submitted',attempts:0}});this.store.delivery(row.id,'pending','准备恢复确定尚未点击的状态表情');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    this.adoptTasks();
    for(const row of this.db.prepare("SELECT id,payload FROM outbox WHERE kind='progress_reaction' AND status='pending' AND json_extract(payload,'$.stage')='active'").all())this.store.mergeOutboxPayload(row.id,{emojis:progressEmoji.active});
    for(const row of this.db.prepare("SELECT id FROM operations WHERE kind<>'control' AND status<>'merged' AND number IS NULL ORDER BY created,rowid").all())this.identify(row.id);
    for(const row of this.db.prepare("SELECT id FROM operations WHERE status='done'").all())this.store.autoArchiveTask(row.id);
    this.detachArchivedParents();
    codex.on('notification',m=>{
      if(!m.params?.threadId)return;const id=this.db.prepare("SELECT id FROM operations WHERE thread=? AND status='running' ORDER BY created DESC LIMIT 1").get(m.params.threadId)?.id;
      if(id)this.db.prepare('UPDATE operations SET changed=? WHERE id=?').run(this.now(),id);
    });
    codex.on('disconnected',()=>{
      for(const op of this.open().filter(o=>o.submitted&&!o.ended))this.notice(op.id,'断线：暂时无法确认运行状态。已提交的任务不会自动重跑。','disconnect');
    });
  }
  get(id){return id?this.db.prepare('SELECT * FROM operations WHERE id=?').get(id):null;}
  stopped(id){return !!id&&!!this.db.prepare('SELECT 1 FROM interruptions WHERE operation_id=?').get(id);}
  detachArchivedParents(parentId){
    const rows=this.db.prepare("SELECT o.id,o.parent,o.status,a.reason,p.status AS parent_status FROM operations o JOIN archive_records a ON a.kind='task' AND a.id=o.parent AND a.archived=1 JOIN operations p ON p.id=o.parent WHERE o.submitted=0 AND o.parent<>'' AND o.status IN ('queued','blocked','waiting')").all().filter(row=>!parentId||row.parent===parentId);if(!rows.length)return;
    this.db.exec('BEGIN IMMEDIATE');try{for(const row of rows){
      if(row.reason==='completed'&&row.parent_status==='done'){
        this.db.prepare("UPDATE operations SET parent='',phase='原任务已完成，已有补充独立续做' WHERE id=?").run(row.id);this.db.prepare("UPDATE operation_messages SET relation='accepted' WHERE operation_id=? AND relation='supplement'").run(row.id);continue;
      }
      this.db.prepare("UPDATE operations SET parent='',status='blocked',phase='原任务已归档，补充已独立保存并暂停' WHERE id=?").run(row.id);this.db.prepare("UPDATE operation_messages SET relation='accepted' WHERE operation_id=? AND relation='supplement'").run(row.id);
      this.store.messageStatus(row.id,'blocked','原任务已归档，补充已独立保存并暂停');this.db.prepare('INSERT OR REPLACE INTO task_waits VALUES(?,?,?,?,?,?,1)').run('message:'+row.id,row.id,'原任务已归档，补充已独立保存并暂停',this.now(),0,0);
    }this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  forMessage(id){const link=this.db.prepare('SELECT operation_id FROM operation_messages WHERE message_id=?').get(id);return link?this.get(link.operation_id):null;}
  open({includeArchived=false}={}){return this.db.prepare(`SELECT * FROM operations WHERE status IN (${unfinished}) ORDER BY created`).all().filter(o=>includeArchived||!this.store.isArchived('task',o.id));}
  identify(id,{announce=false}={}){
    let op=this.get(id);if(!op||op.kind==='control')return op;
    if(!op.number){
      const parent=this.get(op.parent);let number;
      if(parent?.number){const root=String(parent.number).split('-')[0];const numbers=this.db.prepare("SELECT number FROM operations WHERE typeof(number)='text' AND number LIKE ?").all(root+'-%').map(r=>String(r.number).match(/^\d+-(\d+)$/)?.[1]).filter(Boolean).map(Number);number=root+'-'+(numbers.reduce((max,n)=>Math.max(max,n),0)+1);}
      else number=this.db.prepare("SELECT COALESCE(MAX(number),0)+1 AS n FROM operations WHERE typeof(number)='integer'").get().n;
      this.db.prepare('UPDATE operations SET number=?,title=? WHERE id=? AND number IS NULL').run(number,operationTitle(op.request),id);op=this.get(id);
    }
    if(announce)this.notify(`已登记任务 ${op.number}：${op.title}${op.parent&&this.get(op.parent)?.number?'\n这是任务 '+this.get(op.parent).number+' 的补充要求。':''}`,{operationId:op.id,notification:true,priority:120,dedupe:'op-identity:'+id});return op;
  }
  label(id){const o=this.get(id);return o?.number?`任务 ${o.number}：${o.title}`:operationTitle(o?.request);}
  receive(message){
    const existing=this.forMessage(message.id);if(existing)return existing;
    const now=this.now(),request=message.kind==='video'?'转发视频：'+(message.title||message.awemeId):String(message.text||'');
    const command=message.kind==='text'&&parseCommand(message.text),kind=command&&command.name!=='dispatch'?'control':message.kind;
    this.db.prepare('INSERT OR IGNORE INTO operations('+opColumns+') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(message.id,message.peer||this.store.config.owner?.chatKey||'',request,requestKey(message),kind,this.store.config.activeNeed||'','queued','排队等待','',now,0,now,0,0,'','', '', '',0);
    this.db.prepare('INSERT OR IGNORE INTO operation_messages VALUES(?,?,?,?)').run(message.id,message.id,'primary',String(message.platformId||message.id.replace((message.peer||'')+':','')));
    this.reaction(message.id,'roger');return this.get(message.id);
  }
  reaction(messageId,stage){
    const link=this.db.prepare('SELECT * FROM operation_messages WHERE message_id=?').get(messageId);if(!link||!/^\d{5,32}$/.test(link.platform_id))return;
    const op=this.get(link.operation_id);if(!op?.peer)return;
    this.store.enqueueReply(op.peer,`进度：${stage==='roger'?'已收到':stage==='active'?'正在处理':'本项任务及回复均已完成'}`,{kind:'progress_reaction',priority:(stage==='roger'?160:stage==='active'?150:110)+(parseCommand(op.request)?.name==='interrupt'?1000:0),dedupe:'progress:'+messageId+':'+stage,payload:{operationId:op.id,messageId:link.platform_id,stage,emojis:progressEmoji[stage],notification:true}});
  }
  reactAll(id,stage){for(const l of this.db.prepare('SELECT message_id FROM operation_messages WHERE operation_id=?').all(id))this.reaction(l.message_id,stage);}
  stage(id,phase,detail='',{running=false,thread,turn,submitted}={}){
    if(this.stopped(id))return;
    const op=this.get(id);if(!op)return;
    const changed=phase!==op.phase||detail!==op.detail,now=this.now();
    this.db.prepare('UPDATE operations SET phase=?,detail=?,status=?,started=?,changed=?,thread=?,turn=?,submitted=? WHERE id=?').run(phase,String(detail).slice(0,500),running?'running':op.status,op.started||(running?now:0),now,thread||op.thread,turn||op.turn,submitted===undefined?op.submitted:Number(submitted),id);
    if(running)this.reactAll(id,'active');
    if(changed&&running)this.notice(id,`当前：${phase}${detail?'，'+detail:''}。`,'phase:'+phase);
  }
  bind(id,needId,thread){this.db.prepare('UPDATE operations SET need_id=?,thread=? WHERE id=?').run(needId||'',thread||'',id);}
  finish(id,outcome='done'){
    if(!id||this.stopped(id))return;const state=outcome==='done'?'sending':outcome==='waiting'?'waiting':outcome==='uncertain'?'uncertain':'failed';
    this.db.prepare('UPDATE operations SET ended=1,outcome=?,status=?,changed=? WHERE id=?').run(outcome,state,this.now(),id);
    this.sync(id);
  }
  resultParts(id){
    const rows=this.db.prepare("SELECT * FROM outbox WHERE json_extract(payload,'$.operationId')=? AND COALESCE(json_extract(payload,'$.notification'),0)=0 AND kind='text' ORDER BY created,rowid").all(id);
    return {rows,total:rows.length,sent:rows.filter(r=>r.status==='sent').length,uncertain:rows.some(r=>r.status==='uncertain'),pending:rows.some(r=>['pending','sending'].includes(r.status))};
  }
  tasks(id){return this.db.prepare("SELECT * FROM tasks WHERE json_extract(context,'$.operationId')=? ORDER BY created").all(id);}
  sync(id){
    if(this.stopped(id))return;
    const op=this.get(id);if(!op||['merged','done'].includes(op.status))return;
    const parts=this.resultParts(id),tasks=this.tasks(id);
    const noticesPending=this.db.prepare("SELECT 1 FROM outbox WHERE json_extract(payload,'$.operationId')=? AND kind='text' AND status IN ('pending','sending','uncertain') LIMIT 1").get(id);
    if(parts.uncertain){this.db.prepare("UPDATE operations SET status='failed_delivery',phase='回复送达情况需要核实' WHERE id=?").run(id);return;}
    if(!op.ended||tasks.some(t=>['queued','running','blocked','uncertain'].includes(t.status)))return;
    if((op.outcome==='failed'||tasks.some(t=>t.status==='failed'))&&!parts.pending){this.db.prepare("UPDATE operations SET status='failed',phase='本次要求未完成' WHERE id=?").run(id);return;}
    if(op.outcome==='done'&&!tasks.some(t=>t.status==='failed')&&!parts.pending&&!noticesPending){
      this.db.prepare("UPDATE operations SET status='done',phase='任务及回复全部完成',changed=? WHERE id=?").run(this.now(),id);this.reactAll(id,'done');
      this.store.autoArchiveTask(id);
      this.detachArchivedParents(id);
    }else if(parts.pending&&op.outcome==='done')this.db.prepare("UPDATE operations SET status='sending',phase='结果已生成，正在分段发送' WHERE id=?").run(id);
  }
  status(id){
    const op=this.get(id);if(!op)return '暂无可核验的任务记录';
    const stop=this.db.prepare('SELECT * FROM interruptions WHERE operation_id=?').get(id);if(stop)return stop.state==='stopped'?'用户已中断，后续执行及未发送的回复已停止。':stop.state==='stopping'?'正在强制中断对应任务，核对 Codex 与本地工作是否停止。':'本地处理已切断，Codex 停止结果暂时无法确认；保留现场，不会自动重跑。';
    const parts=this.resultParts(id),tasks=this.tasks(id),wait=tasks.map(t=>this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get(t.id)).find(Boolean)||this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get('message:'+id);
    if(parts.uncertain)return '回复已生成，但有分段送达结果不明，需要核实；不会自动重发。';
    if(tasks.some(t=>t.status==='uncertain')||op.status==='uncertain')return '暂时无法确认运行状态。已经提交的任务不会自动重跑。';
    if(wait){const retryId=op.number||(wait.task_id.startsWith('message:')?createHash('sha256').update(op.id).digest('hex').slice(0,8):wait.task_id.slice(0,8));return `${wait.paused?'调度已暂停':'排队受阻'}：${wait.reason}。${wait.paused?'处理冲突后用 /重试 '+retryId+' 恢复；尚未提交执行。':'尚未提交，稍后按退避间隔重试。'}`;}
    if(this.codex.ready===false&&op.submitted&&(!op.ended||tasks.some(t=>t.status==='running')))return '暂时无法确认运行状态；Codex 连接不可用。';
    if(op.submitted&&(!op.ended||tasks.some(t=>t.status==='running'))&&this.now()-op.changed>=this.stallAfter)return this.checks.get(id)?.state==='active'?`Codex 报告仍在运行，较长时间没有新结果。最近阶段：${op.phase}。`:'暂时无法确认运行状态；已提交的执行保留现场，不会自动重跑。';
    if(op.parent&&this.stopped(op.parent))return '原任务已中断，补充要求已保留并暂停；需明确重试此补充或发起新的独立要求。';
    if(op.parent&&this.get(op.parent)?.status!=='done')return '补充要求已保存，正在等待原要求执行及全部回复结束；原要求若需核实，补充也保持等待。';
    if(parts.pending&&op.ended&&tasks.every(t=>t.status==='done')){const next=parts.rows.find(r=>['pending','sending'].includes(r.status)),p=JSON.parse(next?.payload||'{}');return `结果已生成，正在发送第 ${p.segment||Math.min(parts.total,parts.sent+1)}/${p.totalSegments||parts.total} 段。`;}
    if(tasks.some(t=>t.status==='running'))return op.phase+(op.detail?'，'+op.detail:'')+'；其余 '+tasks.filter(t=>t.status==='queued').length+' 项待处理。';
    if(tasks.some(t=>t.status==='queued'))return '目标任务排队等待，尚未提交执行。';
    if(op.status==='done')return '任务及全部回复已完成。';
    return op.phase+(op.detail?'，'+op.detail:'')+'。';
  }
  notice(id,body,key='periodic'){
    const op=this.get(id);if(!op)return;const bucket=key==='periodic'?Math.floor(this.now()/this.noticeInterval):key;
    // Only direct answers to a duplicate request are text. Autonomous status is
    // represented by message reactions and the local console, per user choice.
    if(key.startsWith('duplicate:'))this.notify(body,{operationId:id,notification:true,priority:95,dedupe:'op-status:'+id+':'+bucket});
    this.db.prepare('UPDATE operations SET last_notice=? WHERE id=?').run(this.now(),id);
  }
  async triage(message){
    checkWork();this.detachArchivedParents();
    const previous=this.db.prepare('SELECT * FROM operation_messages WHERE message_id=?').get(message.id);
    if(previous&&['accepted','supplement','duplicate'].includes(previous.relation))return {relation:previous.relation,operationId:previous.operation_id,parent:this.get(previous.operation_id)?.parent};
    const own=this.receive(message);if(explicitRedo(message.text)){this.identify(own.id,{announce:true});return {relation:'new',operationId:own.id};}
    const candidates=this.open().filter(o=>!this.stopped(o.id)&&o.kind!=='control'&&o.id!==own.id&&o.peer===own.peer&&(message.referenceOperationId?(o.id===message.referenceOperationId||o.fingerprint.endsWith('|reply:'+message.referenceKey)):(!o.need_id||!own.need_id||o.need_id===own.need_id))&&o.parent!==own.id);
    let match=candidates.find(o=>o.fingerprint===own.fingerprint),relation=match?'duplicate':'independent';
    if(!match&&candidates.length===1&&/^(怎么(?:还|一直)|为什么(?:还|一直)|还没(?:好|完成|执行)|进度(?:呢|如何)|做到哪|处理完了吗|快点|继续处理|催一下)[\s\S]{0,22}[？?！!。]*$/.test(message.text||'')){match=candidates[0];relation='duplicate';}
    if(!match&&candidates.length&&this.classify&&message.kind==='text'){
      try{const result=JSON.parse((await this.classify({newMessage:message.text,activeRequests:candidates.slice(-4).map(o=>({id:o.id,request:o.request.slice(0,1500),state:this.status(o.id)}))},followupSchema)).text);match=candidates.find(o=>o.id===result.operationId);if(match&&['duplicate','supplement'].includes(result.relation))relation=result.relation;else match=null;}catch{match=null;}
    }
    checkWork();if(match&&(this.store.isArchived('task',match.id)||this.stopped(match.id)))match=null;
    if(match&&relation==='duplicate'){
      this.db.prepare("UPDATE operation_messages SET operation_id=?,relation='duplicate' WHERE message_id=?").run(match.id,message.id);
      this.db.prepare("UPDATE operations SET status='merged',ended=1 WHERE id=?").run(own.id);
      this.store.messageStatus(message.id,'linked',match.id);if(match.started)this.reaction(message.id,'active');
      this.notice(match.id,(this.store.isArchived('task',match.id)?'这项要求已归档，没有重复启动。':'这项要求正在处理，没有重复启动。')+'\n'+this.label(match.id)+'\n当前：'+this.status(match.id),'duplicate:'+message.id);return {relation,operationId:match.id};
    }
    if(match&&relation==='supplement'){
      this.db.prepare('UPDATE operations SET parent=?,need_id=? WHERE id=?').run(match.id,match.need_id,own.id);
      this.notice(own.id,'新增要求已保留为补充，原任务结束并送达后再处理这项修改。','supplement');
    }
    this.db.prepare('UPDATE operation_messages SET relation=? WHERE message_id=?').run(relation==='supplement'?'supplement':'accepted',message.id);
    this.identify(own.id,{announce:true});
    return {relation:match?relation:'independent',operationId:own.id,parent:match?.id};
  }
  canRun(id){if(this.store.isArchived('task',id)||this.stopped(id))return false;this.detachArchivedParents();if(!this.mayAttempt({id:'message:'+id}))return false;const op=this.get(id);if(!op?.parent)return true;const parent=this.get(op.parent);return !this.stopped(parent?.id)&&parent?.status==='done';}
  taskBlocked(task,reason){
    const context=JSON.parse(task.context||'{}'),id=context.operationId,old=this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get(task.id),now=this.now(),attempts=(old?.attempts||0)+1,since=old?.since||now,paused=now-since>=this.writerLimit||attempts>=6;
    const next=now+Math.min(60000,10000*2**(attempts-1)),number=this.db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM task_retry_events WHERE task_id=?').get(task.id).n;
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT OR REPLACE INTO task_waits VALUES(?,?,?,?,?,?,?)').run(task.id,id||'',reason,since,attempts,next,Number(paused));
      if(id)this.db.prepare("INSERT INTO task_retry_events(task_id,operation_id,attempt,at,outcome,reason,next_attempt) VALUES(?,?,?,?,'blocked',?,?)").run(task.id,id,number,now,reason,paused?0:next);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.store.taskStatus(task.id,paused?'blocked':'queued',reason);if(id){this.db.prepare("UPDATE operations SET status='blocked',phase='派发受阻',detail=? WHERE id=?").run(reason,id);this.notice(id,`任务 ${task.id.slice(0,8)} ${this.status(id)}`,'blocked:'+createHash('sha256').update(reason).digest('hex').slice(0,8)+(paused?':paused':''));}
  }
  mayAttempt(task){const w=this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get(task.id);return !w||!w.paused&&w.next_attempt<=this.now();}
  messageBlocked(message,reason){const id=this.forMessage(message.id)?.id;this.taskBlocked({id:'message:'+message.id,context:JSON.stringify({operationId:id})},reason);const w=this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get('message:'+message.id);this.store.messageStatus(message.id,w.paused?'blocked':'new',reason);}
  clearWait(taskId,{outcome,reason=''}={}){
    const wait=this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get(taskId);
    const last=outcome?this.db.prepare('SELECT * FROM task_retry_events WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId):null;
    // A manual /重试 clears the wait before the next attempt. The durable last
    // event still identifies its operation and prevents losing that outcome.
    this.db.exec('BEGIN IMMEDIATE');try{
      if(last?.outcome==='blocked'||last?.outcome==='started'&&outcome==='uncertain')this.db.prepare('INSERT INTO task_retry_events(task_id,operation_id,attempt,at,outcome,reason) VALUES(?,?,?,?,?,?)').run(taskId,wait?.operation_id||last.operation_id,last.attempt+(last.outcome==='blocked'?1:0),this.now(),outcome,String(reason).slice(0,500));
      this.db.prepare('DELETE FROM task_waits WHERE task_id=?').run(taskId);this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  recoverAuth(){for(const w of this.db.prepare("SELECT * FROM task_waits WHERE reason='等待本机 Codex 登录或额度恢复'").all()){const t=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(w.task_id);if(t&&!t.turn&&['queued','blocked'].includes(t.status)){this.clearWait(t.id);this.store.taskStatus(t.id,'queued','登录已恢复，继续确定未提交的任务');}}}
  retry(value){
    const numeric=String(value).trim().replace(/^任务\s*/,'').replace(/^#/,'');
    const isNumber=/^\d+(?:-\d+)?$/.test(numeric),lookup=isNumber?(numeric.includes('-')?numeric:Number(numeric)):numeric;
    const archived=isNumber?this.db.prepare('SELECT id FROM operations WHERE number=?').get(lookup):this.get(numeric);if(archived&&this.store.isArchived('task',archived.id))throw new Error('任务已归档，请先 /恢复任务 '+numeric+'，再明确重试。');
    if(archived&&this.stopped(archived.id))throw new Error('任务已中断，不能恢复旧执行；需要时请明确发送新的要求。');
    if(isNumber){
      const op=this.db.prepare('SELECT * FROM operations WHERE number=?').get(lookup);
      if(op){const tasks=this.tasks(op.id);if(op.status==='uncertain'||op.status==='failed_delivery'||tasks.some(t=>t.status==='uncertain'))throw new Error('任务 '+op.number+' 的执行或送达结果不明，需先核实，不能自动重跑。');
        if(op.parent&&this.stopped(op.parent)&&!op.submitted)this.db.prepare("UPDATE operations SET parent='' WHERE id=?").run(op.id);
        if(this.db.prepare('SELECT 1 FROM task_waits WHERE task_id=?').get('message:'+op.id)&&!op.submitted){this.clearWait('message:'+op.id);this.store.messageStatus(op.id,'new');this.db.prepare("UPDATE operations SET status='queued',phase='恢复未提交要求的调度' WHERE id=?").run(op.id);return op.id;}
        const pending=tasks.filter(t=>['queued','blocked'].includes(t.status)&&!t.turn);if(!pending.length)throw new Error('任务 '+op.number+' 没有可安全重试的未提交工作。');for(const t of pending){this.clearWait(t.id);this.store.taskStatus(t.id,'queued','用户要求恢复未提交任务');}return op.id;
      }if(numeric.includes('-')||numeric.length<8)throw new Error('没有找到任务 '+numeric+'，发送 /状态 查看编号与标题。');
    }
    const messages=this.open().filter(o=>o.status==='blocked'&&!o.submitted&&this.db.prepare('SELECT 1 FROM task_waits WHERE task_id=?').get('message:'+o.id)&&createHash('sha256').update(o.id).digest('hex').startsWith(String(value)));
    if(messages.length===1){const op=messages[0];this.clearWait('message:'+op.id);this.store.messageStatus(op.id,'new');this.db.prepare("UPDATE operations SET status='queued',phase='恢复未提交要求的调度' WHERE id=?").run(op.id);return op.id;}
    const matches=this.db.prepare("SELECT * FROM tasks WHERE id LIKE ? AND status IN ('queued','blocked')").all(String(value)+'%');if(matches.length!==1)throw new Error('请填写唯一的未提交任务编号；执行结果不明的任务不能自动重试。');
    const t=matches[0];if(t.turn)throw new Error('该任务已有执行回合，需先核实，不能自动重试。');this.clearWait(t.id);this.store.taskStatus(t.id,'queued','用户要求恢复未提交任务');return t.id;
  }
  adoptTasks(){
    this.db.prepare("UPDATE tasks SET status='uncertain',result='已有执行回合，需要核实，不能自动重跑' WHERE status='queued' AND turn<>''").run();
    for(const task of this.db.prepare('SELECT * FROM tasks ORDER BY created,rowid').all()){
      const c=JSON.parse(task.context||'{}');if(c.operationId)continue;
      const row=this.db.prepare('SELECT * FROM messages WHERE result=? ORDER BY created DESC LIMIT 1').get(task.id);
      const message=row?JSON.parse(row.body):{id:'legacy-task:'+task.id,peer:this.store.config.owner?.chatKey||'',kind:'text',text:task.prompt};
      // Historical operations are tracked without replaying old receipt reactions.
      const id=message.id,now=this.now();this.db.prepare('INSERT OR IGNORE INTO operations('+opColumns+') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,message.peer||'',message.text||'历史任务',requestKey(message),'text',c.needId||'',task.status==='running'?'uncertain':task.status,task.status==='done'?'历史任务已完成':task.status==='failed'?'历史任务未完成':task.status==='cancelled'?'历史任务已取消':'等待派发','',task.created,0,now,0,1,'done','',task.thread,task.turn||'',Number(!!task.turn));
      if(row)this.db.prepare('INSERT OR IGNORE INTO operation_messages VALUES(?,?,?,?)').run(id,id,'primary',String(message.platformId||''));
      this.db.prepare('UPDATE tasks SET context=? WHERE id=?').run(JSON.stringify({...c,operationId:id}),task.id);
    }
  }
  async inspect(){
    if(!this.store.config.enabled||this.inspecting)return;this.inspecting=true;
    try{
      for(const op of this.open({includeArchived:true})){
        this.sync(op.id);if(this.get(op.id)?.status==='done')continue;
        if(this.now()-op.last_notice>=this.noticeInterval){
          const pending=this.store.pendingMessages().length,elapsed=op.started?Math.floor((this.now()-op.started)/60000):0;
          this.notice(op.id,`当前：${this.status(op.id)}\n${op.started?'已运行 '+(elapsed||'不足 1')+' 分钟；':''}后续消息 ${pending} 条待处理。`);
        }
        if(op.submitted&&(!op.ended||this.tasks(op.id).some(t=>t.status==='running'))&&this.now()-op.changed>=this.stallAfter){
          if(this.now()-(this.checks.get(op.id)?.checked||0)<30000)continue;
          try{const executor=this.tasks(op.id).some(t=>t.thread===op.thread)?this.taskCodex:this.codex;const r=await executor.request('thread/read',{threadId:op.thread},5000);this.checks.set(op.id,{checked:this.now(),state:r.thread?.status?.type||'unknown'});}
          catch{this.checks.set(op.id,{checked:this.now(),state:'unknown'});}
        }
      }
    }finally{this.inspecting=false;}
  }
  state(){return this.open().map(o=>({id:o.id,number:o.number,title:o.title||operationTitle(o.request),shortId:createHash('sha256').update(o.id).digest('hex').slice(0,8),status:o.status,phase:o.phase,detail:this.status(o.id),started:o.started,created:o.created}));}
  cards(options={}){
    const {limit=100,scope='current',status='all'}=typeof options==='number'?{limit:options}:options;
    const where=scope==='all'?'1=1':scope==='archived'?'COALESCE(a.archived,0)=1':'COALESCE(a.archived,0)=0';
    return this.db.prepare("SELECT o.*,COALESCE(a.archived,0) AS archived FROM operations o LEFT JOIN archive_records a ON a.kind='task' AND a.id=o.id WHERE o.status<>'merged' AND "+where+" AND (?='all' OR o.status=?) ORDER BY CASE WHEN o.status IN ('queued','running','sending','waiting','blocked','uncertain','failed_delivery') AND o.kind<>'control' THEN 0 ELSE 1 END,o.created DESC LIMIT ?").all(status,status,limit).map(op=>{
      const rows=this.db.prepare("SELECT * FROM outbox WHERE json_extract(payload,'$.operationId')=? ORDER BY created,rowid").all(op.id);
      const receipts=['roger','active','done'].map(stage=>{const group=rows.filter(r=>r.kind==='progress_reaction'&&JSON.parse(r.payload||'{}').stage===stage);return {stage,total:group.length,sent:group.filter(r=>r.status==='sent').length,pending:group.filter(r=>['pending','sending'].includes(r.status)).length,uncertain:group.filter(r=>r.status==='uncertain').length,unavailable:group.filter(r=>r.status==='unavailable').length,errors:[...new Set(group.filter(r=>r.error&&r.status!=='sent').map(r=>r.error))]};});
      const tasks=this.tasks(op.id),parent=this.get(op.parent),needId=op.need_id||parent?.need_id,links=new Map(),assistant=needId&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='needs'").get()?this.db.prepare('SELECT thread FROM needs WHERE id=?').get(needId)?.thread:null;
      const videoIds=this.db.prepare("SELECT DISTINCT json_extract(m.body,'$.awemeId') AS id FROM operation_messages om JOIN messages m ON m.id=om.message_id WHERE om.operation_id=? AND m.kind='video' AND json_valid(m.body)").all(op.id).map(v=>v.id).filter(id=>typeof id==='string');
      for(const [id,label] of [[assistant,'需求对话'],[parent?.thread,'原任务对话'],...this.tasks(parent?.id||'').map(t=>[t.thread,'原任务目标：'+t.alias]),[op.thread,'本轮对话'],...tasks.map(t=>[t.thread,'目标：'+t.alias])]){const url=this.codex.threadUrl?this.codex.threadUrl(id):codexThreadUrl(id);if(url)links.set(id,{label,url});}
      const retryGroups=new Map(),events=this.db.prepare('SELECT e.*,t.alias,t.status AS task_status FROM task_retry_events e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.operation_id=? ORDER BY e.id').all(op.id);
      for(const e of events){if(!retryGroups.has(e.task_id)){const wait=this.db.prepare('SELECT * FROM task_waits WHERE task_id=?').get(e.task_id);retryGroups.set(e.task_id,{label:e.alias?'目标：'+e.alias:'需求对话',taskStatus:e.task_status||op.status,wait:wait?.attempts?{paused:!!wait.paused,nextAttempt:wait.next_attempt}:null,events:[]});}retryGroups.get(e.task_id).events.push({attempt:e.attempt,at:e.at,outcome:e.outcome,reason:e.reason,legacy:!!e.legacy});}
      return {id:op.id,number:op.number,title:op.title||operationTitle(op.request),kind:op.kind,status:op.status,phase:op.phase,videoIds,canInterrupt:op.kind!=='control'&&!this.stopped(op.id)&&['queued','running','sending','waiting','blocked','uncertain','failed_delivery'].includes(op.status),archived:!!op.archived,links:[...links.values()],detail:this.status(op.id),receipts,retries:[...retryGroups.values()],replies:rows.filter(r=>r.kind==='text').map(r=>({id:r.id,status:r.status,error:r.error,notification:!!JSON.parse(r.payload||'{}').notification})),targets:tasks.map(t=>({alias:t.alias,status:t.status,result:t.result?.slice(0,300)}))};
    });
  }
}
