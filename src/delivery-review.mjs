import {matchesPeer} from './douyin.mjs';
import {matchesOutgoingText} from './chat-text.mjs';

const data=row=>JSON.parse(row.payload||'{}');
const stages={roger:'收到 · 👌',active:'运行 · 奋斗',done:'完成 · 🎉'};
// These operations reconcile an existing receipt only. They never call a model,
// restart a task, or click an emoji except through explicit text-resend intent.
export class DeliveryReview{
  constructor({store,adapter,engine,chats}){Object.assign(this,{store,adapter,engine,chats});this.db=store.db;this.busy=new Set();}
  target(out){const p=data(out);if(p.chatbot)return this.chats.deliveryTarget(p,out.peer);const owner=this.store.config.owner;return owner?.chatKey===out.peer?owner:null;}
  rows(kind,id){
    let operationIds;
    if(kind==='task')operationIds=new Set([this.engine.archives.task(id).id]);
    else if(kind==='need'){
      const need=this.engine.conversations.needs.lookup(id,{includeArchived:true});
      operationIds=new Set(this.db.prepare('SELECT id FROM operations WHERE need_id=?').all(need.id).map(o=>o.id));
      for(const t of this.db.prepare("SELECT context FROM tasks WHERE json_extract(context,'$.needId')=?").all(need.id))operationIds.add(JSON.parse(t.context).operationId);
    }else throw new Error('请指定任务或需求');
    return this.db.prepare("SELECT * FROM outbox WHERE status IN ('uncertain','sending') ORDER BY created,rowid").all().filter(o=>operationIds.has(data(o).operationId));
  }
  view(kind,id){return {kind,id,rows:this.rows(kind,id).map(o=>{
    const p=data(o),op=this.engine.progress.get(p.operationId),original=p.messageId&&this.db.prepare('SELECT body FROM messages WHERE peer=? AND (id=? OR id=?)').get(o.peer,p.messageId,o.peer+':'+p.messageId),m=original?JSON.parse(original.body):null;
    return {id:o.id,operationId:p.operationId,number:op?.number,title:op?.title,kind:o.kind,status:o.status,label:o.kind==='progress_reaction'?'表情：'+(stages[p.stage]||p.stage):p.notification?'文字通知':`文字回复：第 ${p.segment||1}/${p.totalSegments||1} 段`,body:o.kind==='text'?o.body:'原消息：'+(m?.text||m?.title||m?.awemeId||'请在抖音核对原消息'),error:o.error,created:o.created,lastCheck:p.deliveryRecheck||null,canResend:o.kind==='text'&&!!this.target(o)&&!this.store.isArchived('task',p.operationId)&&!this.engine.interrupts.record(p.operationId)};
  })};}
  sync(out){const p=data(out);if(p.operationId)this.engine.progress.sync(p.operationId);if(p.chatbot)this.chats.reconcile();}
  checkText(out,scan){
    const target=this.target(out),p=data(out);if(!target||!matchesPeer(scan.peer,target)||!scan.peer?.selfUid)return {verified:false,reason:'原聊天或助手账号身份尚未核实。'};
    let expectedSender='';if(p.replyToMessageId&&p.botId){const origin=this.db.prepare('SELECT body FROM bot_messages WHERE id=? AND peer=?').get(p.botId,out.peer);expectedSender=origin?JSON.parse(origin.body).sender:'';if(!expectedSender)return {verified:false,reason:'原生引用的发送者记录缺失，请人工核实。'};}
    const known=this.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(out.id),attempt=p.deliveryAttempt;
    if(!known&&!p.replyToMessageId&&!(attempt?.started&&attempt.ended>=attempt.started))return {verified:false,reason:'这条历史文字没有保存发送时间边界，无法自动排除同文消息，请人工确认。'};
    const start=attempt?.started||out.created,end=attempt?.ended||0;
    const candidates=(scan.messages||[]).filter(m=>m.direction==='out'&&m.sender===scan.peer.selfUid&&m.created>=start-1500&&(!end||m.created<=end+1500)&&(!known||m.id===known.platform_id)&&(!p.replyToMessageId||m.replyTo?.messageId===p.replyToMessageId)&&matchesOutgoingText(m,out.body,{replyToMessageId:p.replyToMessageId,replyToSender:expectedSender}));
    if(candidates.length!==1)return {verified:false,reason:candidates.length?'找到多条匹配消息，无法唯一核实，未重发。':'当前可读历史中没有唯一匹配；这不能证明未送达，未重发。'};
    const collision=this.db.prepare('SELECT outbox_id FROM outgoing_message_links WHERE peer=? AND platform_id=?').get(out.peer,candidates[0].id);if(collision&&collision.outbox_id!==out.id)return {verified:false,reason:'匹配消息属于另一段回复，不能冒充本段送达。'};
    const current=this.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id);if(current?.status!=='uncertain')return {verified:false,reason:'回执状态已变化，请刷新后查看。'};
    const verified=this.store.confirmTextDelivery(out.id,candidates[0].id);if(verified){this.store.mergeOutboxPayload(out.id,{deliveryRecheck:{verified:true,at:Date.now(),method:'exact_message',reason:'已核验助手身份、时间、完整正文和原生引用（如有）'}});this.sync(out);}return {verified,reason:verified?'已核验原聊天中的完整文字，未重发。':'平台消息身份冲突，保持待核实。'};
  }
  observe(scan){
    if(!scan?.peer)return;
    for(const out of this.db.prepare("SELECT * FROM outbox WHERE kind='text' AND status='uncertain' AND peer=? ORDER BY created LIMIT 100").all(scan.peer.chatKey))this.checkText(out,scan);
  }
  async reconcile(id){
    const out=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(id));if(!out||out.status!=='uncertain')throw new Error('此回执无需核实，请刷新查看当前状态');
    if(this.busy.has(out.id))throw new Error('正在核验这条回执，请稍后');const target=this.target(out);if(!target)throw new Error('原聊天已停用或绑定已变化，不能自动核验；可在抖音人工确认后处理。');
    this.busy.add(out.id);try{
      let result;
      if(out.kind==='progress_reaction'){
        const p=data(out);if(!Array.isArray(p.emojis)||!p.emojis.length)throw new Error('原表情身份记录缺失，请人工确认。');
        result=await this.adapter.react(target,p.messageId,{emojis:p.emojis,verifyOnly:true});
        if(this.target(out)!==target||this.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id)?.status!=='uncertain')return {verified:false,reason:'聊天或回执状态已变化，请刷新查看。'};
        if(result.verified){this.store.delivery(out.id,'sent','只读核验原消息菜单的本账号选中状态');this.sync(out);}
        result={verified:!!result.verified,reason:result.reason||'当前无法确认该表情已由助手贴出，未点击或重试表情。'};
      }else if(out.kind==='text'){const scan=await this.adapter.scanPeer(target);result=this.checkText(out,scan);}
      else throw new Error('此历史回执请人工核实');
      const row=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(out.id);if(row)this.store.mergeOutboxPayload(out.id,{deliveryRecheck:{verified:!!result.verified,at:Date.now(),method:out.kind==='text'?'exact_message':'native_selected_reaction',reason:result.reason}});
      return result;
    }finally{this.busy.delete(out.id);}
  }
  resolve(id,status,{confirmed=false}={}){
    if(confirmed!==true)throw new Error('请先在本机确认回执的实际情况。');
    const out=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(id));if(!out||out.status!=='uncertain')throw new Error('此回执无需人工处理，请刷新查看');
    if(!['sent','pending','abandoned'].includes(status))throw new Error('无效处理方式');const p=data(out);
    if(status==='pending'&&(out.kind!=='text'||!this.target(out)||this.engine.interrupts.record(p.operationId)||this.store.isArchived('task',p.operationId)))throw new Error('仅可重新发送未归档、未中断且聊天身份仍有效的文字；表情不会重复点击。');
    const next=status==='abandoned'?(out.kind==='progress_reaction'?'unavailable':'superseded'):status;
    this.db.exec('BEGIN IMMEDIATE');try{this.store.mergeOutboxPayload(out.id,{deliveryReview:{at:Date.now(),method:'manual',resolution:status,previousStatus:out.status}});this.store.delivery(out.id,next,status==='sent'?'用户已在抖音人工确认送达':status==='abandoned'?'用户确认不再发送此回执；未将其标记为送达':'用户确认未收到，明确授权重新发送此段文字');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.sync(out);return {ok:true,status:next};
  }
}
