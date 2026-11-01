import {comparableChatText} from './chat-text.mjs';
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {durableJson} from './durable.mjs';
export const replyReferencePath=(root,messageId)=>join(root,'reply-references',createHash('sha256').update(messageId).digest('hex')+'.json');
const data=row=>{try{return JSON.parse(row?.payload||'{}');}catch{return {};}};
const question='无法唯一核实你回复的是哪一条助手消息，已保留你的要求，没有执行。请重新回复具体的一段反馈，或在新消息中说明要参考的内容。';
export class ReplyReferences{
  constructor(store){this.store=store;this.db=store.db;}
  find(message){
    const ref=message.replyTo;if(!ref)return null;
    if(!/^\d{5,32}$/.test(ref.messageId||'')||[3,4].includes(ref.status)||ref.authorId&&ref.authorId===this.store.config.owner?.peerUid)throw Object.assign(new Error(question),{code:'REFERENCE_UNRESOLVED'});
    const previous=this.db.prepare('SELECT outbox_id FROM reply_reference_links WHERE message_id=? AND peer=?').get(message.id,message.peer);
    let row=previous&&this.db.prepare('SELECT * FROM outbox WHERE id=? AND peer=?').get(previous.outbox_id,message.peer);
    let method='saved';
    if(!row){const link=this.db.prepare('SELECT outbox_id FROM outgoing_message_links WHERE peer=? AND platform_id=?').get(message.peer,ref.messageId);row=link&&this.db.prepare("SELECT * FROM outbox WHERE id=? AND peer=? AND kind='text' AND status IN ('sent','uncertain')").get(link.outbox_id,message.peer);method='id';}
    if(!row){
      const hint=comparableChatText(ref.hint);if(!hint)throw Object.assign(new Error(question),{code:'REFERENCE_UNRESOLVED'});
      const candidates=this.db.prepare("SELECT * FROM outbox WHERE peer=? AND kind='text' AND status IN ('sent','uncertain') ORDER BY created").all(message.peer).filter(o=>comparableChatText(o.body)===hint&&!!data(o).operationId);
      const distinct=new Set(candidates.map(o=>data(o).group||o.id));if(!candidates.length||distinct.size!==1)throw Object.assign(new Error(question),{code:'REFERENCE_UNRESOLVED'});row=candidates[0];method='legacy_exact_text';
    }
    const p=data(row),op=this.db.prepare("SELECT * FROM operations WHERE id=? AND peer=? AND kind<>'control'").get(p.operationId||'',message.peer);
    if(!op)throw Object.assign(new Error(question),{code:'REFERENCE_UNRESOLVED'});
    const collision=this.db.prepare('SELECT outbox_id FROM outgoing_message_links WHERE peer=? AND platform_id=?').get(message.peer,ref.messageId);
    if(collision&&collision.outbox_id!==row.id)throw Object.assign(new Error(question),{code:'REFERENCE_UNRESOLVED'});
    this.db.exec('BEGIN IMMEDIATE');try{
      if(!collision)this.db.prepare('INSERT INTO outgoing_message_links VALUES(?,?,?,?,?)').run(message.peer,ref.messageId,row.id,method,Date.now());
      this.db.prepare('INSERT OR IGNORE INTO reply_reference_links VALUES(?,?,?,?,?,?)').run(message.id,message.peer,ref.messageId,row.id,method,Date.now());this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    const parts=p.group?this.db.prepare("SELECT * FROM outbox WHERE peer=? AND kind='text' AND status<>'superseded' AND json_extract(payload,'$.group')=? AND json_extract(payload,'$.operationId')=? ORDER BY CAST(json_extract(payload,'$.segment') AS INTEGER),created,rowid").all(message.peer,p.group,op.id):[row];
    const source=this.db.prepare('SELECT body FROM messages WHERE id=?').get(op.id);let original={};try{original=JSON.parse(source?.body||'{}');}catch{}
    const tasks=this.db.prepare("SELECT alias,thread,context FROM tasks WHERE json_extract(context,'$.operationId')=? ORDER BY created").all(op.id),ids=new Set([p.videoId,original.awemeId].filter(Boolean));
    for(const task of tasks){try{for(const video of JSON.parse(task.context||'{}').videos||[])if(video.id)ids.add(video.id);}catch{}}
    if(!ids.size&&op.need_id&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='need_assets'").get())for(const x of this.db.prepare('SELECT video_id FROM need_assets WHERE need_id=?').all(op.need_id))ids.add(x.video_id);
    const videos=[...ids].map(id=>this.store.knowledge(id)).filter(Boolean);
    const reference={key:p.group||row.id,outboxId:row.id,operationId:op.id,number:op.number,title:op.title,needId:op.need_id,sourceText:row.body,parts:parts.map(part=>({text:part.body,status:part.status,segment:data(part).segment||1})),videoIds:videos.map(v=>v.id),targets:tasks.map(t=>({alias:t.alias,thread:t.thread})),match:method};
    reference.path=replyReferencePath(this.store.root,message.id);mkdirSync(join(this.store.root,'reply-references'),{recursive:true});durableJson(reference.path,reference);return reference;
  }
}
