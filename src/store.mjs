import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, readdirSync,rmSync } from 'node:fs';
import { join,resolve,relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import {durableJson,lockStorage} from './durable.mjs';

export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.unlock=lockStorage(root);
    try{
    const established=existsSync(join(root,'config.json'))||existsSync(join(root,'storage.json'));
    if(!existsSync(join(root,'bridge.sqlite'))&&(existsSync(join(root,'backups','latest.json'))||established&&['knowledge','needs','reply-references'].some(name=>existsSync(join(root,name))&&readdirSync(join(root,name)).length)))throw new Error('已保存资料的数据库文件缺失，已停止启动并保留资料与备份，不能创建空库替代。');
    this.db = new DatabaseSync(join(root, 'bridge.sqlite'));
    if(this.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('数据库完整性检查未通过，已保留原文件；请从备份恢复并核实任务状态，不能创建空记忆替代。');
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_records(kind TEXT,id TEXT,archived INTEGER NOT NULL DEFAULT 0,desired INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'done',error TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',meta TEXT NOT NULL DEFAULT '{}',changed INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS archive_jobs(need_id TEXT,thread TEXT,direction INTEGER,status TEXT,error TEXT,changed INTEGER,PRIMARY KEY(need_id,thread,direction));
      CREATE TABLE IF NOT EXISTS interruptions(operation_id TEXT PRIMARY KEY,state TEXT,requested INTEGER,updated INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS outgoing_message_links(peer TEXT NOT NULL,platform_id TEXT NOT NULL,outbox_id TEXT NOT NULL,method TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(peer,platform_id));
      CREATE TABLE IF NOT EXISTS reply_reference_links(message_id TEXT PRIMARY KEY,peer TEXT NOT NULL,platform_id TEXT NOT NULL,outbox_id TEXT NOT NULL,match_method TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, peer TEXT, kind TEXT, body TEXT, status TEXT, result TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, title TEXT, transcript TEXT, summary TEXT, path TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, alias TEXT, thread TEXT, prompt TEXT, status TEXT, turn TEXT, result TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, peer TEXT, body TEXT, status TEXT, error TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT, message TEXT, created INTEGER);`);
    const outboxColumns=new Set(this.db.prepare('PRAGMA table_info(outbox)').all().map(c=>c.name));
    for(const [name,definition] of Object.entries({kind:"TEXT NOT NULL DEFAULT 'text'",payload:"TEXT NOT NULL DEFAULT '{}'",priority:'INTEGER NOT NULL DEFAULT 0',dedupe:"TEXT NOT NULL DEFAULT ''",next_attempt:'INTEGER NOT NULL DEFAULT 0'})){
      if(!outboxColumns.has(name))this.db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe ON outbox(dedupe) WHERE dedupe<>''");
    if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='context'))this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}'");
    // A crash after a side effect must never cause that side effect to be repeated silently.
    this.db.exec(`UPDATE messages SET status='uncertain' WHERE status='processing';
      UPDATE tasks SET status='uncertain' WHERE status='running';
      UPDATE outbox SET status='uncertain' WHERE status='sending';`);
    const file = join(root, 'config.json');
    const stored=this.db.prepare("SELECT value FROM app_settings WHERE key='config'").get();let saved;
    if(stored){saved=JSON.parse(stored.value);if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new Error('已保存的配置无效，已停止启动以保留现场。');if(existsSync(file))try{JSON.parse(readFileSync(file,'utf8'));}catch{this.recovery='配置文件损坏，已从数据库恢复完整设置';}}
    else{for(const candidate of [file,file+'.tmp',file+'.bak'])if(existsSync(candidate)){try{const v=JSON.parse(readFileSync(candidate,'utf8'));if(v&&typeof v==='object'&&!Array.isArray(v)){saved=v;if(candidate!==file)this.recovery='已从配置备份恢复设置';break;}}catch{}}if(!saved&&[file,file+'.tmp',file+'.bak'].some(existsSync))throw new Error('配置文件无法读取，原文件已保留；请恢复备份，不能用空配置覆盖。');}
    saved||={};
    this.config = { port: 39361, enabled: false, owner: null, targets: [], coordinator: '', pollMs: 3000, maxVideoSeconds: 1800, visualFps:4, ackMode:'auto',model:'',reasoningEffort:'',fastMode:false,chatModel:saved.model||'',chatReasoningEffort:saved.reasoningEffort||'',chatFastMode:!!saved.fastMode,chatWebSearch:true,chatCodeSandbox:false,autoRoute:true,contextBudget:48000,activeNeed:'',harness:'',resumeOnStartup:!!saved.enabled, ...saved };
    // Explicitly re-arm the listener after a restart; old history is not a new command.
    this.config.enabled = false;
    if(!this.config.uiPanels)this.config.uiPanels={model:!!(saved.model||saved.reasoningEffort||saved.fastMode||saved.autoRoute===false||saved.contextBudget&&saved.contextBudget!==48000),targets:!!saved.targets?.length};
    if(!this.config.uiConfigured)this.config.uiConfigured={model:!!(saved.model||saved.reasoningEffort||saved.fastMode||saved.autoRoute===false||saved.contextBudget&&saved.contextBudget!==48000),targets:!!saved.targets?.length};
    for(const key of ['model','targets'])if(this.config.uiConfigured[key]&&!(key in this.config.uiPanels))this.config.uiPanels[key]=true;
    if(!('storage' in this.config.uiPanels))this.config.uiPanels.storage=true;
    if(typeof this.config.ignoreMessages!=='boolean')this.config.ignoreMessages=false;
    this.saveConfig({});
    if(this.recovery)this.event(this.recovery,'attention');
    }catch(e){try{this.db?.close();}catch{}this.unlock();throw e;}
  }
  saveConfig(patch) {
    const next={...this.config,...patch};
    // The authoritative copy commits with SQLite FULL durability before a
    // successful response. JSON is a readable recovery mirror, not sole state.
    this.db.prepare("INSERT OR REPLACE INTO app_settings VALUES('config',?,?)").run(JSON.stringify(next),Date.now());this.config=next;
    const file = join(this.root,'config.json');
    try{if(existsSync(file))try{const old=JSON.parse(readFileSync(file,'utf8'));durableJson(file+'.bak',old);}catch{}durableJson(file,this.config);}catch{this.event('配置已提交数据库，但可读配置镜像暂未写入，请检查磁盘可用空间。','attention');}
    return this.config;
  }
  event(message, level='info') {
    this.db.prepare('INSERT INTO events(level,message,created) VALUES(?,?,?)').run(level,String(message).slice(0,3000),Date.now());
  }
  incoming(message) {
    return this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)')
      .run(message.id,message.peer,message.kind,JSON.stringify(message),'new','',Date.now()).changes > 0;
  }
  messageStatus(id,status,result='') { this.db.prepare('UPDATE messages SET status=?,result=? WHERE id=?').run(status,result,id); }
  pendingMessages() { return this.db.prepare("SELECT m.* FROM messages m WHERE m.status='new' AND NOT EXISTS(SELECT 1 FROM interruptions i WHERE i.operation_id=m.id) AND NOT EXISTS(SELECT 1 FROM archive_records a WHERE a.kind='task' AND a.id=m.id AND a.archived=1) ORDER BY m.created LIMIT 20").all(); }
  addKnowledge(item) {
    this.db.prepare('INSERT OR REPLACE INTO knowledge VALUES(?,?,?,?,?,?)').run(item.id,item.title,item.transcript||'',item.summary||'',item.path,Date.now());
  }
  knowledge(id) { return this.db.prepare('SELECT * FROM knowledge WHERE id=?').get(id); }
  search(query='',limit=6) {
    const terms = String(query).trim().split(/[\s,，。；;]+/).filter(Boolean).slice(0,8);
    if(!terms.length) return this.db.prepare('SELECT * FROM knowledge ORDER BY created DESC LIMIT ?').all(limit);
    // LIKE handles Chinese without requiring an English FTS tokenizer.
    const where=terms.map(()=>"(title LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')").join(' OR ');
    const args=terms.flatMap(t=>{ const v='%'+t.replace(/[\\%_]/g,'\\$&')+'%'; return [v,v,v]; });
    return this.db.prepare(`SELECT * FROM knowledge WHERE ${where} ORDER BY created DESC LIMIT ?`).all(...args,limit);
  }
  createTask(alias,thread,prompt,context={}) {
    const id=randomUUID();
    this.db.prepare('INSERT INTO tasks(id,alias,thread,prompt,status,turn,result,created,context) VALUES(?,?,?,?,?,?,?,?,?)').run(id,alias,thread,prompt,'queued','','',Date.now(),JSON.stringify(context));
    return id;
  }
  taskStatus(id,status,result='',turn='') { this.db.prepare('UPDATE tasks SET status=?,result=?,turn=CASE WHEN ?=\'\' THEN turn ELSE ? END WHERE id=?').run(status,result,turn,turn,id); }
  queuedTasks() { return this.db.prepare("SELECT t.* FROM tasks t WHERE t.status='queued' AND NOT EXISTS(SELECT 1 FROM interruptions i WHERE i.operation_id=json_extract(t.context,'$.operationId')) AND NOT EXISTS(SELECT 1 FROM archive_records a WHERE a.kind='task' AND a.id=json_extract(t.context,'$.operationId') AND a.archived=1) ORDER BY t.created LIMIT 20").all(); }
  knowledgeList({scope='current',limit=100}={}){const where=scope==='all'?'1=1':scope==='archived'?'COALESCE(a.archived,0)=1':'COALESCE(a.archived,0)=0';return this.db.prepare("SELECT k.*,COALESCE(a.archived,0) AS archived FROM knowledge k LEFT JOIN archive_records a ON a.kind='knowledge' AND a.id=k.id WHERE "+where+' ORDER BY k.created DESC LIMIT ?').all(limit);}
  enqueueReply(peer,body,{kind='text',payload={},priority=0,dedupe=''}={}) {
    const id=randomUUID();
    const inserted=this.db.prepare('INSERT OR IGNORE INTO outbox(id,peer,body,status,error,created,kind,payload,priority,dedupe) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,peer,body,'pending','',Date.now(),kind,JSON.stringify(payload),priority,dedupe).changes;
    return inserted?id:this.outboxByDedupe(dedupe)?.id;
  }
  outboxByDedupe(key){return this.db.prepare('SELECT * FROM outbox WHERE dedupe=?').get(key);}
  mergeOutboxPayload(id,patch){const row=this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id);if(row)this.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload),...patch}),id);}
  updatePendingOutbox(id,{body,payload,priority}){
    return this.db.prepare("UPDATE outbox SET body=?,payload=?,priority=? WHERE id=? AND status='pending'").run(body,JSON.stringify(payload),priority,id).changes>0;
  }
  latestVideoMessage(awemeId){
    return this.db.prepare("SELECT body FROM messages WHERE kind='video' ORDER BY created DESC LIMIT 100").all().map(m=>JSON.parse(m.body)).find(m=>m.awemeId===awemeId);
  }
  archiveRecord(kind,id){return id?this.db.prepare('SELECT * FROM archive_records WHERE kind=? AND id=?').get(kind,id):null;}
  isArchived(kind,id){return !!this.archiveRecord(kind,id)?.archived;}
  setArchived(kind,id,archived,{reason='manual',state='done',desired=archived,error='',meta={}}={}){
    this.db.prepare('INSERT OR REPLACE INTO archive_records VALUES(?,?,?,?,?,?,?,?,?)').run(kind,id,Number(archived),Number(desired),state,error,reason,JSON.stringify(meta),Date.now());return this.archiveRecord(kind,id);
  }
  autoArchiveTask(id){this.db.prepare("INSERT OR IGNORE INTO archive_records(kind,id,archived,desired,state,reason,changed) VALUES('task',?,1,1,'done','completed',?)").run(id,Date.now());}
  pendingOutbox(limit=1) { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY priority DESC,created LIMIT ?").all(Date.now(),limit); }
  delivery(id,status,error='') { this.db.prepare('UPDATE outbox SET status=?,error=?,next_attempt=? WHERE id=?').run(status,error,status==='pending'&&error?Date.now()+10000:0,id); }
  confirmTextDelivery(id,platformId){
    const out=this.db.prepare('SELECT peer FROM outbox WHERE id=?').get(id);if(!out)throw new Error('未找到发送记录');this.db.exec('BEGIN IMMEDIATE');
    try{let conflict=false;if(platformId&&/^\d{5,32}$/.test(String(platformId))){const old=this.db.prepare('SELECT outbox_id FROM outgoing_message_links WHERE peer=? AND platform_id=?').get(out.peer,String(platformId));conflict=!!old&&old.outbox_id!==id;if(!old)this.db.prepare('INSERT INTO outgoing_message_links VALUES(?,?,?,?,?)').run(out.peer,String(platformId),id,'delivery',Date.now());}this.delivery(id,conflict?'uncertain':'sent',conflict?'消息 ID 与历史记录冲突，需核实送达':'');this.db.exec('COMMIT');return !conflict;}catch(e){this.db.exec('ROLLBACK');throw Object.assign(e,{uncertain:true});}
  }
  snapshot() {
    const read=(table)=>this.db.prepare(`SELECT * FROM ${table} ORDER BY created DESC LIMIT 35`).all();
    const counts={knowledge:this.db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n,queuedTasks:this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='queued'").get().n,runningTasks:this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='running'").get().n};
    return {config:this.config,counts,knowledge:read('knowledge'),tasks:read('tasks'),messages:read('messages').map(({body,...r})=>r),outbox:read('outbox'),events:read('events')};
  }
  backup(){
    if(this.backingUp)return this.backingUp;
    this.backingUp=(async()=>{
      const parent=join(this.root,'backups'),name='state-'+Date.now()+'-'+randomUUID(),folder=join(parent,name);mkdirSync(folder,{recursive:true});
      await backup(this.db,join(folder,'bridge.sqlite'));const snapshot=new DatabaseSync(join(folder,'bridge.sqlite'),{readOnly:true});let saved;try{saved=JSON.parse(snapshot.prepare("SELECT value FROM app_settings WHERE key='config'").get().value);}finally{snapshot.close();}durableJson(join(folder,'config.json'),saved);
      const record={created:Date.now(),folder:name,includes:['配置','需求记忆','学习索引','任务与送达记录'],media:'原视频、连续画面和浏览器登录态仍保存在固定数据目录中'};durableJson(join(folder,'snapshot.json'),record);durableJson(join(parent,'latest.json'),record);
      const snapshots=readdirSync(parent).filter(n=>/^state-\d{13}-[a-f\d-]{36}$/.test(n)).sort().reverse();
      for(const old of snapshots.slice(32)){const target=resolve(parent,old);if(relative(resolve(parent),target)!==old)throw new Error('备份路径校验失败');rmSync(target,{recursive:true,force:true});}
      return record;
    })().finally(()=>{this.backingUp=null;});return this.backingUp;
  }
  storageState(){let latest=null;try{latest=JSON.parse(readFileSync(join(this.root,'backups','latest.json'),'utf8'));}catch{}return {dataRoot:resolve(this.root),persistent:true,backup:latest,recovery:this.recovery||''};}
  close() {if(this.closed)return;this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();this.unlock();this.closed=true;}
}
