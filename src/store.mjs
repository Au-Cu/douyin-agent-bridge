import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'bridge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
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
    const saved = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
    this.config = { port: 39361, enabled: false, owner: null, targets: [], coordinator: '', pollMs: 3000, maxVideoSeconds: 1800, visualFps:4, ackMode:'auto', ...saved };
    // Explicitly re-arm the listener after a restart; old history is not a new command.
    this.config.enabled = false;
    this.saveConfig({});
  }
  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    const file = join(this.root,'config.json');
    writeFileSync(file+'.tmp',JSON.stringify(this.config,null,2));
    renameSync(file+'.tmp',file);
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
  pendingMessages() { return this.db.prepare("SELECT * FROM messages WHERE status='new' ORDER BY created LIMIT 20").all(); }
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
  queuedTasks() { return this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created LIMIT 10").all(); }
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
  pendingOutbox() { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY priority DESC,created LIMIT 1").all(Date.now()); }
  delivery(id,status,error='') { this.db.prepare('UPDATE outbox SET status=?,error=?,next_attempt=? WHERE id=?').run(status,error,status==='pending'&&error?Date.now()+10000:0,id); }
  snapshot() {
    const read=(table)=>this.db.prepare(`SELECT * FROM ${table} ORDER BY created DESC LIMIT 35`).all();
    const counts={knowledge:this.db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n,queuedTasks:this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='queued'").get().n,runningTasks:this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='running'").get().n};
    return {config:this.config,counts,knowledge:read('knowledge'),tasks:read('tasks'),messages:read('messages').map(({body,...r})=>r),outbox:read('outbox'),events:read('events')};
  }
  close() { this.db.close(); }
}
