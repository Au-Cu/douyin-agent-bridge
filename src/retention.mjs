import {createHash,randomUUID} from 'node:crypto';import {resolve} from 'node:path';
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export class ArchiveRetention{
  constructor({store,deletion,sessions}){Object.assign(this,{store,deletion,sessions});this.db=store.db;this.db.exec('CREATE TABLE IF NOT EXISTS archive_retention_checks(kind TEXT,id TEXT,checked INTEGER,PRIMARY KEY(kind,id))');}
  policy(){return {enabled:false,hours:720,...this.store.config.archiveRetention};}
  configure({enabled,hours}){if(typeof enabled!=='boolean'||!Number.isInteger(hours)||hours<1||hours>87600)throw new Error('请选择开关及 1–87600 小时的保留时长');this.store.saveConfig({archiveRetention:{enabled,hours}});return this.state();}
  state(){const last=this.db.prepare("SELECT value FROM app_settings WHERE key='archiveRetentionLastRun'").get();return {policy:this.policy(),last:last?JSON.parse(last.value):null};}
  async run(now=Date.now()){
    if(this.running||!this.policy().enabled)return;this.running=true;
    try{this.db.exec('DELETE FROM archive_retention_checks WHERE NOT EXISTS(SELECT 1 FROM archive_records a WHERE a.kind=archive_retention_checks.kind AND a.id=archive_retention_checks.id)');const cutoff=now-this.policy().hours*3600000,rows=this.db.prepare("SELECT a.* FROM archive_records a LEFT JOIN archive_retention_checks c ON c.kind=a.kind AND c.id=a.id WHERE archived=1 AND desired=1 AND state='done' AND changed<=? ORDER BY COALESCE(c.checked,0),CASE a.kind WHEN 'need' THEN 0 WHEN 'task' THEN 1 WHEN 'chat_session' THEN 2 ELSE 3 END,changed LIMIT 40").all(cutoff),report={at:now,deleted:0,blocked:[]};
      for(const row of rows){if(this.closing||!this.policy().enabled)break;const current=this.store.archiveRecord(row.kind,row.id);if(!current?.archived||current.state!=='done'||current.changed>now-this.policy().hours*3600000)continue;
        try{if(['need','task'].includes(row.kind)){const p=this.deletion.prepare(row.kind,row.id);this.deletion.remove({kind:row.kind,id:row.id,token:p.token});}
          else if(row.kind==='knowledge')this.knowledge(row.id);else if(row.kind==='chat_session')this.session(row.id);else continue;report.deleted++;
        }catch(e){report.blocked.push({kind:row.kind,id:row.id,reason:String(e.message).slice(0,180)});}
        if(this.store.archiveRecord(row.kind,row.id))this.db.prepare('INSERT OR REPLACE INTO archive_retention_checks VALUES(?,?,?)').run(row.kind,row.id,now);else this.db.prepare('DELETE FROM archive_retention_checks WHERE kind=? AND id=?').run(row.kind,row.id);
        await new Promise(resolve=>setImmediate(resolve));
      }
      this.db.prepare("INSERT OR REPLACE INTO app_settings VALUES('archiveRetentionLastRun',?,?)").run(JSON.stringify(report),Date.now());return report;
    }finally{this.running=false;}
  }
  cleanup(paths,fn){const key=randomUUID();this.db.exec('BEGIN IMMEDIATE');try{fn();this.db.prepare('INSERT INTO deletion_cleanup VALUES(?,?,?)').run(key,JSON.stringify(paths),Date.now());this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}this.deletion.cleanup();}
  knowledge(id){
    const k=this.store.knowledge(id);if(!k)return;if(!/^\d{12,24}$/.test(id)||resolve(k.path)!==resolve(this.store.root,'knowledge',id,'note.md'))throw new Error('资料目录未通过归属校验，已保留');
    if(this.db.prepare('SELECT 1 FROM need_assets WHERE video_id=?').get(id)||this.db.prepare("SELECT 1 FROM messages WHERE json_extract(body,'$.awemeId')=?").get(id)||this.db.prepare("SELECT 1 FROM tasks, json_each(tasks.context,'$.videos') v WHERE json_extract(v.value,'$.id')=?").get(id))throw new Error('资料仍被保留的需求或任务引用，暂不删除');
    this.cleanup(['knowledge/'+id],()=>{this.db.prepare('DELETE FROM knowledge WHERE id=?').run(id);this.db.prepare("DELETE FROM archive_records WHERE kind='knowledge' AND id=?").run(id);});
  }
  session(id){
    const s=this.sessions.get(id);if(!s)return;if(this.sessions.current(s.peer)?.id===id||!['done','unsupported'].includes(s.archive_state))throw new Error('当前会话或 Agent 端归档结果未核实，暂不删除');
    const messages=this.db.prepare('SELECT b.* FROM bot_messages b JOIN chat_session_messages m ON m.message_id=b.id WHERE m.session_id=?').all(id);
    if(messages.some(m=>['new','preparing','submitted','replying','delivery_uncertain','uncertain'].includes(m.status)))throw new Error('该会话还有执行或送达未核实，暂不删除');
    const ids=new Set(messages.map(m=>m.id)),out=this.db.prepare('SELECT * FROM outbox').all().filter(o=>ids.has(JSON.parse(o.payload||'{}').botId));if(out.some(o=>['pending','sending','uncertain'].includes(o.status)))throw new Error('该会话仍有待发送或未核实回执，暂不删除');
    const media=this.db.prepare('SELECT message_id,folder FROM chat_media').all().filter(m=>ids.has(m.message_id));if(media.some(m=>!/^[a-f\d]{64}$/.test(m.folder)))throw new Error('群聊视频缓存目录无效');
    this.cleanup(media.map(m=>'chat-media/'+m.folder),()=>{
      for(const m of messages){this.db.prepare('INSERT OR IGNORE INTO deleted_messages VALUES(?)').run(hash(m.id));this.db.prepare('DELETE FROM bot_messages WHERE id=?').run(m.id);const source=JSON.parse(m.body);this.db.prepare('DELETE FROM bot_seen WHERE peer=? AND platform_id=?').run(m.peer,String(source.id));this.db.prepare('DELETE FROM chat_media WHERE message_id=?').run(m.id);}
      for(const o of out){for(const l of this.db.prepare('SELECT * FROM outgoing_message_links WHERE outbox_id=?').all(o.id))this.db.prepare('INSERT OR IGNORE INTO deleted_reply_links VALUES(?)').run(hash(l.peer+':'+l.platform_id));for(const table of ['outgoing_message_links','reply_reference_links'])this.db.prepare('DELETE FROM '+table+' WHERE outbox_id=?').run(o.id);this.db.prepare('DELETE FROM outbox WHERE id=?').run(o.id);}
      this.db.prepare('DELETE FROM chat_session_messages WHERE session_id=?').run(id);this.db.prepare('DELETE FROM chat_sessions WHERE id=?').run(id);this.db.prepare("DELETE FROM archive_records WHERE kind='chat_session' AND id=?").run(id);
    });
  }
}
