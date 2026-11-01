import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {durableJson} from './durable.mjs';
import {join} from 'node:path';

export const emptyMemory=()=>({title:'未命名需求',goal:'',constraints:[],decisions:[],pending:[],progress:''});
export const memoryText=m=>[m.goal,...(m.constraints||[]).map(s=>'约束：'+s),...(m.decisions||[]).map(s=>'决策：'+s),m.progress,...(m.pending||[]).map(s=>'待办：'+s)].filter(Boolean).join('\n');
export class Needs{
  constructor(store){
    this.store=store;this.db=store.db;this.root=join(store.root,'needs');mkdirSync(this.root,{recursive:true});
    this.db.exec(`CREATE TABLE IF NOT EXISTS needs(id TEXT PRIMARY KEY,title TEXT,memory TEXT,thread TEXT,seq INTEGER,context_tokens INTEGER,model_window INTEGER,version INTEGER,summary_version INTEGER,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS need_turns(message_id TEXT PRIMARY KEY,need_id TEXT,thread TEXT,owner_text TEXT,reply TEXT,video_id TEXT,status TEXT,created INTEGER,revision INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS need_assets(need_id TEXT,video_id TEXT,PRIMARY KEY(need_id,video_id));
      CREATE TABLE IF NOT EXISTS need_routes(message_id TEXT PRIMARY KEY,need_id TEXT,thread TEXT,action TEXT,reason TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS need_threads(thread TEXT PRIMARY KEY,need_id TEXT,seq INTEGER,handoff TEXT,created INTEGER);`);
    if(!this.db.prepare('PRAGMA table_info(need_turns)').all().some(c=>c.name==='revision'))this.db.exec('ALTER TABLE need_turns ADD COLUMN revision INTEGER DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(needs)').all().some(c=>c.name==='number'))this.db.exec('ALTER TABLE needs ADD COLUMN number INTEGER');
    let number=this.db.prepare('SELECT COALESCE(MAX(number),0) AS n FROM needs').get().n;for(const n of this.db.prepare('SELECT id FROM needs WHERE number IS NULL ORDER BY created,rowid').all())this.db.prepare('UPDATE needs SET number=? WHERE id=?').run(++number,n.id);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS needs_number ON needs(number) WHERE number IS NOT NULL');
  }
  get(id){const row=this.db.prepare("SELECT n.*,COALESCE(a.archived,0) AS archived,COALESCE(a.state,'done') AS archiveState,COALESCE(a.desired,0) AS archiveDesired,COALESCE(a.error,'') AS archiveError FROM needs n LEFT JOIN archive_records a ON a.kind='need' AND a.id=n.id WHERE n.id=?").get(id);return row?{...row,memory:JSON.parse(row.memory)}:null;}
  list({includeArchived=false}={}){const rows=this.db.prepare("SELECT n.*,COALESCE(a.archived,0) AS archived,COALESCE(a.state,'done') AS archiveState,COALESCE(a.desired,0) AS archiveDesired,COALESCE(a.error,'') AS archiveError FROM needs n LEFT JOIN archive_records a ON a.kind='need' AND a.id=n.id ORDER BY n.updated DESC").all().map(r=>({...r,memory:JSON.parse(r.memory)}));return includeArchived?rows:rows.filter(n=>!n.archived&&!(n.archiveDesired&&n.archiveState!=='done'));}
  create(title='未命名需求',thread=''){
    const id=randomUUID().slice(0,8),now=Date.now(),number=this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM needs').get().n;this.db.prepare('INSERT INTO needs(id,title,memory,thread,seq,context_tokens,model_window,version,summary_version,created,updated,number) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,title,JSON.stringify({...emptyMemory(),title}),thread,thread?1:0,0,0,0,0,now,now,number);
    if(thread)this.db.prepare('INSERT INTO need_threads VALUES(?,?,?,?,?)').run(thread,id,1,'',now);return this.get(id);
  }
  rename(id,title){this.db.prepare('UPDATE needs SET title=? WHERE id=?').run(String(title).slice(0,60),id);}
  activate(id){const need=this.get(id);if(!need)throw new Error('需求不存在');if(need.archived||need.archiveDesired&&need.archiveState!=='done')throw new Error('需求 '+need.number+' 已归档或正在归档，请先 /恢复需求 '+need.number);this.store.saveConfig({activeNeed:id,coordinator:need.thread,needEpoch:(this.store.config.needEpoch||0)+1});return need;}
  bindThread(id,thread,handoff=''){
    const n=this.get(id),seq=n.seq+1;this.db.prepare('UPDATE needs SET thread=?,seq=?,context_tokens=0,model_window=0,updated=? WHERE id=?').run(thread,seq,Date.now(),id);
    this.db.prepare('INSERT INTO need_threads VALUES(?,?,?,?,?)').run(thread,id,seq,handoff,Date.now());
    if(this.store.config.activeNeed===id)this.store.saveConfig({coordinator:thread});return this.get(id);
  }
  usage(thread,tokens,window=0){this.db.prepare('UPDATE needs SET context_tokens=MAX(context_tokens,?),model_window=MAX(model_window,?) WHERE thread=?').run(tokens,window||0,thread);}
  estimate(id,tokens){this.db.prepare('UPDATE needs SET context_tokens=context_tokens+? WHERE id=?').run(tokens,id);}
  attach(id,video){if(video)this.db.prepare('INSERT OR IGNORE INTO need_assets VALUES(?,?)').run(id,video);}
  knowledge(id,query='',limit=6){
    const candidates=this.db.prepare('SELECT k.* FROM knowledge k JOIN need_assets a ON k.id=a.video_id WHERE a.need_id=? ORDER BY k.created DESC').all(id);
    const q=String(query).trim().toLowerCase();return candidates.filter(k=>!q||(k.title+' '+k.summary+' '+k.transcript).toLowerCase().includes(q)).slice(0,limit);
  }
  recent(id=null,limit=4){return this.db.prepare(`SELECT * FROM need_turns WHERE status='done' ${id?'AND need_id=?':''} ORDER BY created DESC LIMIT ?`).all(...(id?[id,limit]:[limit])).reverse();}
  reserve(message,need){
    const owner=message.kind==='video'?`转发视频：${message.title||message.awemeId}`:message.text;
    this.db.prepare("INSERT OR IGNORE INTO need_turns(message_id,need_id,thread,owner_text,reply,video_id,status,created) VALUES(?,?,?,?,?,?,?,?)").run(message.id,need.id,need.thread,owner||'', '',message.awemeId||'','prepared',message.created||Date.now());
  }
  complete(messageId,reply,status='done'){
    const row=this.db.prepare('SELECT * FROM need_turns WHERE message_id=?').get(messageId);if(!row)return null;
    const version=this.get(row.need_id).version+1;
    this.db.prepare('UPDATE need_turns SET reply=?,status=?,revision=? WHERE message_id=?').run(reply,status,version,messageId);
    this.db.prepare('UPDATE needs SET version=version+1,updated=? WHERE id=?').run(Date.now(),row.need_id);return this.get(row.need_id);
  }
  route(messageId){return this.db.prepare('SELECT * FROM need_routes WHERE message_id=?').get(messageId);}
  saveRoute(messageId,need,action,reason){this.db.prepare('INSERT OR REPLACE INTO need_routes VALUES(?,?,?,?,?,?)').run(messageId,need.id,need.thread,action,String(reason).slice(0,300),Date.now());}
  saveMemory(id,memory,version,expected=version){
    return this.db.prepare('UPDATE needs SET memory=?,title=?,summary_version=? WHERE id=? AND version=?').run(JSON.stringify(memory),memory.title.slice(0,60),version,id,expected).changes>0;
  }
  json(id,name,value){const folder=join(this.root,id);mkdirSync(folder,{recursive:true});const path=join(folder,name);durableJson(path,value);return path;}
  taskState(id,limit=8){const hasOperations=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operations'").get();return this.db.prepare("SELECT id,alias,status,result,turn,created,json_extract(context,'$.operationId') AS operationId FROM tasks WHERE json_extract(context,'$.needId')=? ORDER BY created DESC LIMIT ?").all(id,limit).map(({operationId,...task})=>{const op=hasOperations&&this.db.prepare('SELECT number,title FROM operations WHERE id=?').get(operationId||'');return {...task,...(op?{number:op.number,title:op.title}:{})};});}
  history(id){const turns=this.db.prepare('SELECT * FROM need_turns WHERE need_id=? ORDER BY created').all(id),tasks=this.taskState(id,10000);return this.json(id,'history.json',{needId:id,turns,tasks});}
  lookup(value,{includeArchived=false}={}){const q=String(value).trim().toLowerCase().replace(/^需求\s*/,'').replace(/^#/,'');const list=this.list({includeArchived});if(/^\d+$/.test(q)){const numbered=list.find(n=>n.number===Number(q));if(numbered)return numbered;}const matches=list.filter(n=>n.id.startsWith(q)||n.title===value);if(matches.length!==1)throw new Error(matches.length?'需求不唯一，请使用需求编号。':'未找到当前需求；已归档的需求可用 /恢复需求 编号 找回。');return matches[0];}
  directory(query='',limit=20){
    const list=this.list(),words=String(query).toLowerCase().match(/[a-z\d-]{2,}|[\p{Script=Han}]{2,}/gu)||[];
    const grams=words.flatMap(w=>/\p{Script=Han}/u.test(w)?Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2)):[w]);
    const score=n=>grams.reduce((s,w)=>s+Number((n.title+' '+memoryText(n.memory)).toLowerCase().includes(w)),0);
    const candidates=[...list.slice(0,12),...list.filter(n=>score(n)>0).sort((a,b)=>score(b)-score(a)).slice(0,8)];
    return [...new Map(candidates.map(n=>[n.id,n])).values()].slice(0,limit).map(n=>({id:n.id,number:n.number,title:n.title,summary:memoryText(n.memory).slice(0,240),updated:new Date(n.updated).toISOString()}));
  }
  state({scope='current'}={}){
    const serialize=n=>({id:n.id,number:n.number,title:n.title,archived:n.archived,archiveState:n.archiveState,archiveError:n.archiveError,summary:memoryText(n.memory).slice(0,240),updated:new Date(n.updated).toISOString(),thread:n.thread,seq:n.seq,contextTokens:n.context_tokens}),active=this.get(this.store.config.activeNeed);
    return {activeNeed:this.store.config.activeNeed,current:active?serialize(active):null,needs:this.list({includeArchived:true}).filter(n=>scope==='all'||(scope==='archived'?!!n.archived:!n.archived)).slice(0,100).map(serialize),budget:this.store.config.contextBudget};
  }
}
