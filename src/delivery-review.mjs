import {matchesPeer} from './douyin.mjs';
import {randomUUID} from 'node:crypto';
import {matchesOutgoingText} from './chat-text.mjs';

const data=row=>JSON.parse(row.payload||'{}');
const stages={roger:'收到 · 👌',active:'运行 · 奋斗',done:'完成 · 🎉'};
// These operations reconcile an existing receipt only. They never call a model,
// restart a task, or click an emoji except through explicit text-resend intent.
export class DeliveryReview{
  constructor({store,adapter,engine,chats}){Object.assign(this,{store,adapter,engine,chats});this.db=store.db;this.busy=new Set();const previous=this.db.prepare("SELECT value FROM app_settings WHERE key='deliveryReviewBatch'").get();this.batch=previous?JSON.parse(previous.value):null;if(this.batch?.status==='running'){this.batch.status='interrupted';this.saveBatch();}}
  saveBatch(){this.db.prepare("INSERT OR REPLACE INTO app_settings VALUES('deliveryReviewBatch',?,?)").run(JSON.stringify(this.batch),Date.now());}
  batchState(){return this.batch;}
  replyScope(kind,id){
    let field,key;
    if(kind==='task'){field='operationId';key=this.engine.archives.task(id).id;}
    else if(kind==='chat_reply'){
      const row=this.db.prepare('SELECT peer FROM bot_messages WHERE id=?').get(String(id));
      if(!row||!this.chats.get(row.peer))throw new Error('请登录此回复所属账号并选择原聊天');
      field='botId';key=String(id);
    }else throw new Error('请选择任务或普通聊天回复');
    return {field,key,lock:JSON.stringify([field,key])};
  }
  replyRows(kind,id){
    const {field,key}=this.replyScope(kind,id);
    return this.db.prepare("SELECT * FROM outbox WHERE kind='text' AND json_extract(payload,?)=? ORDER BY created,rowid").all('$.'+field,key);
  }
  cancellable(row){return ['pending','held','sending','uncertain'].includes(row.status);}
  retryable(row){return ['pending','held','sending','uncertain'].includes(row.status)||row.status==='superseded'&&data(row).deliveryReview?.resolution==='abandoned';}
  controls(kind,id){
    let rows;try{rows=this.replyRows(kind,id);}catch{return {canCancel:false,canResend:false,waiting:0,cancelled:0};}
    return {canCancel:rows.some(row=>this.cancellable(row)),canResend:rows.some(row=>this.retryable(row)),waiting:rows.filter(row=>this.cancellable(row)).length,cancelled:rows.filter(row=>row.status==='superseded'&&data(row).deliveryReview?.resolution==='abandoned').length};
  }
  cancelReplies(kind,id){
    const {lock}=this.replyScope(kind,id);this.controlRevisions??=new Map();this.controlRevisions.set(lock,(this.controlRevisions.get(lock)||0)+1);
    const rows=this.replyRows(kind,id).filter(row=>this.cancellable(row));
    if(!rows.length)return {ok:true,cancelled:0};
    if(rows.some(row=>this.isInactive(row)))throw new Error('请登录此回复所属的抖音账号');
    const ids=rows.map(row=>row.id),now=Date.now(),active=this.engine.activeDelivery;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const row of rows){
        this.store.mergeOutboxPayload(row.id,{
          deliveryReview:{at:now,method:'manual_cancel',resolution:'abandoned',previousStatus:row.status},
          deliveryControl:{action:'cancel',at:now,uncertain:row.status==='uncertain'||row.status==='sending'&&(!active||active.id!==row.id||active.submitted)}
        });
        this.store.delivery(row.id,'superseded','用户已取消发送，原回复和送达现场已保留');
      }
      const p=data(rows[0]),field=p.chatbot?'botId':'operationId',key=p.chatbot?p.botId:p.operationId;
      if(key)for(const receipt of this.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction' AND json_extract(payload,?)=? AND json_extract(payload,'$.stage')='done' AND status IN ('pending','held','uncertain')").all('$.'+field,key)){
        this.store.mergeOutboxPayload(receipt.id,{deliveryReview:{at:now,method:'manual_cancel',resolution:'abandoned',previousStatus:receipt.status}});
        this.store.delivery(receipt.id,'unavailable','用户已取消后续文字，完成表情已停止');
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.engine.stopReplyDelivery(ids);
    this.sync(rows[0]);
    return {ok:true,cancelled:rows.length};
  }
  async resendReplies(kind,id,{confirmed=false,confirmUnreceived=false}={}){
    if(confirmed!==true)throw new Error('请确认重新发送剩余回复');
    const {lock}=this.replyScope(kind,id);this.controlRevisions??=new Map();let revision=this.controlRevisions.get(lock)||0;
    const guard=()=>{if((this.controlRevisions.get(lock)||0)!==revision)throw new Error('重新发送期间已收到取消操作，保留取消状态');};
    this.resending||=new Set();
    if(this.resending.has(lock))throw new Error('这组回复正在恢复发送，请稍候');
    this.resending.add(lock);
    try{
      let rows=this.replyRows(kind,id).filter(row=>this.retryable(row));
      if(!rows.length)return {ok:true,requeued:0};
      for(const row of rows){
        const p=data(row),target=this.target(row);
        if(!target||this.isInactive(row)||target.deliveryPaused||p.contextReset||p.recipientVisibility?.state==='reported_invisible'||this.store.isArchived('task',p.operationId)||this.engine.interrupts.record(p.operationId))throw new Error('原聊天已暂停、账号变化，或该回复已归档、中断、清空；请先处理对应状态');
      }
      const active=this.engine.activeDelivery,activeInGroup=active&&rows.some(row=>row.id===active.id);
      if(rows.some(row=>row.status==='sending')||activeInGroup){
        this.cancelReplies(kind,id);
        revision=this.controlRevisions.get(lock);
        if(activeInGroup){
          let timer;
          const stopped=await Promise.race([active.done.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),8000))]).finally(()=>clearTimeout(timer));
          guard();
          if(!stopped)return {ok:true,waiting:true,message:'已请求停止当前发送，等待浏览器释放；原回复已保留，请稍后重发。'};
        }
        rows=this.replyRows(kind,id).filter(row=>this.retryable(row));
      }
      const uncertain=rows.filter(row=>row.status==='uncertain'||data(row).deliveryControl?.uncertain||data(row).cancelledDeliveryEvidence?.uncertain);
      if(uncertain.length&&confirmUnreceived!==true){
        for(const row of uncertain)if(row.status==='uncertain'&&this.target(row))await this.reconcile(row.id).catch(()=>{});
        guard();
        rows=this.replyRows(kind,id).filter(row=>this.retryable(row));
        if(rows.some(row=>row.status==='uncertain'||data(row).deliveryControl?.uncertain||data(row).cancelledDeliveryEvidence?.uncertain))return {ok:true,needsConfirmation:true,message:'部分回复可能已发出，但无法核实。请确认接收方未收到后再重新发送。'};
      }
      guard();
      for(const row of rows){
        const p=data(row),target=this.target(row);
        if(!target||this.isInactive(row)||target.deliveryPaused||p.contextReset||p.recipientVisibility?.state==='reported_invisible'||this.store.isArchived('task',p.operationId)||this.engine.interrupts.record(p.operationId))throw new Error('等待期间聊天状态已变化，请刷新后重试');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of rows){
          const p=data(row);
          this.store.mergeOutboxPayload(row.id,{
            deliveryReview:{at:Date.now(),method:'manual_resend',resolution:'pending',previousStatus:row.status},
            deliveryControl:null,cancelledDeliveryEvidence:null,deliveryRetry:{failures:0},
            resendHistory:[...(p.resendHistory||[]),{at:Date.now(),previousStatus:row.status,deliveryAttempt:p.deliveryAttempt||null,confirmedUnreceived:confirmUnreceived}].slice(-10)
          });
          this.store.delivery(row.id,'pending');
        }
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
      if(rows[0]){
        const p=data(rows[0]);
        if(p.chatbot)this.chats.set(p.botId,'replying');
        this.sync(rows[0]);
      }
      return {ok:true,requeued:rows.length};
    }finally{this.resending.delete(lock);}
  }
  startBatch({kind,id}={}){
    if(this.batch?.status==='running')return this.batch;
    if((kind&&!id)||(!kind&&id))throw new Error('请完整指定核实范围');
    const rows=kind?this.rows(kind,id):this.db.prepare("SELECT * FROM outbox WHERE status IN ('uncertain','sending') ORDER BY peer,created,rowid").all().filter(o=>!this.isInactive(o)),ids=rows.filter(o=>o.status==='uncertain').map(o=>o.id);
    this.batch={id:randomUUID(),kind:kind||'all',scopeId:id||'',status:'running',total:ids.length,checked:0,verified:0,unresolved:0,waiting:rows.filter(o=>o.status==='sending').length,started:Date.now(),finished:0};this.saveBatch();
    this.batchWork=(async()=>{for(const key of ids){if(this.closing){this.batch.status='interrupted';break;}const row=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(key);if(row?.status==='uncertain')try{const result=await this.reconcile(key);if(result.verified)this.batch.verified++;else this.batch.unresolved++;}catch(e){this.batch.unresolved++;const current=this.db.prepare('SELECT status FROM outbox WHERE id=?').get(key);if(current?.status==='uncertain')this.store.mergeOutboxPayload(key,{deliveryRecheck:{verified:false,at:Date.now(),method:'batch_read_only',reason:String(e.message).slice(0,240)}});}this.batch.checked++;this.saveBatch();await new Promise(resolve=>setImmediate(resolve));}if(this.batch.status==='running')this.batch.status='done';this.batch.finished=Date.now();this.saveBatch();})().catch(()=>{this.batch.status='interrupted';this.batch.finished=Date.now();this.saveBatch();});return this.batch;
  }
  target(out){const p=data(out);if(p.chatbot)return this.chats.deliveryTarget(p,out.peer);const owner=this.store.config.owner;return owner?.chatKey===out.peer?owner:null;}
  isInactive(out){return !!data(out).chatbot&&!!this.chats.isInactive?.(out.peer);}
  rows(kind,id){
    let operationIds;
    if(kind==='chat'||kind==='chat_session'){
      const session=kind==='chat_session'&&this.chats.sessions?.get(id),peer=session?.peer||id;if((kind==='chat_session'&&!session)||!this.chats.get(peer))throw new Error('只能核实已配置的聊天');
      const scope="SELECT * FROM outbox WHERE peer=? AND json_extract(payload,'$.chatbot')=1"+(session?" AND EXISTS (SELECT 1 FROM chat_session_messages WHERE session_id=? AND message_id=json_extract(outbox.payload,'$.botId'))":"");
      const args=session?[peer,id]:[peer];
      const unresolved=this.db.prepare(scope+" AND status IN ('uncertain','sending','pending','held') ORDER BY created DESC").all(...args);
      const recentSent=this.db.prepare(scope+" AND status='sent' AND kind='text' ORDER BY created DESC LIMIT 150").all(...args);
      return [...unresolved,...recentSent];
    }
    if(kind==='task')operationIds=new Set([this.engine.archives.task(id).id]);
    else if(kind==='need'){
      const need=this.engine.conversations.needs.lookup(id,{includeArchived:true});
      operationIds=new Set(this.db.prepare('SELECT id FROM operations WHERE need_id=?').all(need.id).map(o=>o.id));
      for(const t of this.db.prepare("SELECT context FROM tasks WHERE json_extract(context,'$.needId')=?").all(need.id))operationIds.add(JSON.parse(t.context).operationId);
    }else throw new Error('请指定任务或需求');
    return this.db.prepare("SELECT * FROM outbox WHERE status IN ('uncertain','sending') ORDER BY created,rowid").all().filter(o=>operationIds.has(data(o).operationId));
  }
  view(kind,id){return {kind,id,rows:this.rows(kind,id).map(o=>{
    const p=data(o),op=this.engine.progress.get(p.operationId),bot=p.botId&&this.db.prepare('SELECT body FROM bot_messages WHERE id=?').get(p.botId),original=bot||p.messageId&&this.db.prepare('SELECT body FROM messages WHERE peer=? AND (id=? OR id=?)').get(o.peer,p.messageId,o.peer+':'+p.messageId),m=original?JSON.parse(original.body):null;
    return {id:o.id,isChat:!!p.chatbot,operationId:p.operationId,number:op?.number,title:op?.title||this.chats.get(o.peer)?.displayName,kind:o.kind,status:o.status,label:o.kind==='progress_reaction'?'表情：'+(stages[p.stage]||p.stage):p.notification?'文字通知':`文字回复：第 ${p.segment||1}/${p.totalSegments||1} 段`,body:o.kind==='text'?o.body:'原消息：'+(m?.text||m?.title||m?.awemeId||'请在抖音核对原消息'),error:o.error,created:o.created,lastCheck:p.deliveryRecheck||null,recipientVisibility:p.recipientVisibility?.state||'unknown',canReportVisibility:o.kind==='text'&&p.chatbot&&this.chats.get(o.peer)?.type==='group'&&o.status==='sent',canResend:o.status==='uncertain'&&o.kind==='text'&&!!this.target(o)&&!this.target(o).deliveryPaused&&!p.contextReset&&p.recipientVisibility?.state!=='reported_invisible'&&!this.store.isArchived('task',p.operationId)&&!this.engine.interrupts.record(p.operationId)};
  })};}
  sync(out){const p=data(out);if(p.operationId)this.engine.progress.sync(p.operationId);if(p.chatbot)this.chats.reconcile();}
  checkText(out,scan){
    const target=this.target(out),p=data(out);if(!target||!matchesPeer(scan.peer,target)||!scan.peer?.selfUid)return {verified:false,reason:'原聊天或助手账号身份尚未核实。'};
    if(p.recipientVisibility?.state==='reported_invisible')return {verified:false,reason:'用户已反馈接收方不可见；助手端气泡不能解除此状态，请人工确认接收方。'};
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
    const out=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(id));if(!out||!(['uncertain'].includes(out.status)||['pending','held'].includes(out.status)&&status==='abandoned'||out.status==='sent'&&out.kind==='text'&&status==='sent'))throw new Error('此回执无需人工处理，请刷新查看');
    if(this.isInactive(out))throw new Error('请登录此聊天所属的抖音账号后处理');
    if(!['sent','pending','abandoned'].includes(status))throw new Error('无效处理方式');const p=data(out);
    if(status==='pending'&&(out.kind!=='text'||!this.target(out)||this.target(out).deliveryPaused||p.contextReset||p.recipientVisibility?.state==='reported_invisible'||this.engine.interrupts.record(p.operationId)||this.store.isArchived('task',p.operationId)))throw new Error('仅可重新发送未归档、未中断、未清空、未报告接收方不可见且聊天未暂停的文字；表情不会重复点击。');
    const next=status==='abandoned'?(out.kind==='progress_reaction'?'unavailable':'superseded'):status;
    this.db.exec('BEGIN IMMEDIATE');try{this.store.mergeOutboxPayload(out.id,{deliveryReview:{at:Date.now(),method:'manual',resolution:status,previousStatus:out.status},...(status==='sent'&&out.kind==='text'&&p.chatbot?{recipientVisibility:{state:'confirmed',method:'manual_recipient',at:Date.now()}}:{})});this.store.delivery(out.id,next,status==='sent'?'用户已在抖音人工确认送达':status==='abandoned'?'用户确认不再发送此回执；未将其标记为送达':'用户确认未收到，明确授权重新发送此段文字');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.sync(out);return {ok:true,status:next};
  }
  reportInvisible(id,{confirmed=false}={}){
    const out=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(id)),p=out&&data(out);if(!confirmed||!out||out.kind!=='text'||!p.chatbot||!['sent','uncertain'].includes(out.status))throw new Error('请明确确认这条普通聊天回复在接收方不可见');
    if(this.isInactive(out))throw new Error('请登录此聊天所属的抖音账号后处理');
    this.store.mergeOutboxPayload(out.id,{recipientVisibility:{state:'reported_invisible',method:'manual_recipient',at:Date.now()}});this.store.delivery(out.id,'uncertain','用户反馈接收方不可见；此前仅确认助手端显示');
    this.db.prepare("UPDATE bot_messages SET status='delivery_uncertain',updated=? WHERE id=? AND status NOT IN ('cancelled','uncertain')").run(Date.now(),p.botId);this.chats.pauseDelivery(out.peer,true,'用户反馈本群消息仅助手端可见，待核实');return {ok:true};
  }
}
