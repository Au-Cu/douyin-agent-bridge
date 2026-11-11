import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {Conversations} from '../src/conversations.mjs';import {DeliveryReview} from '../src/delivery-review.mjs';import {ArchivedDeletion} from '../src/deletion.mjs';
import {Chats} from '../src/chats.mjs';

test('global review exposes orphaned archived reactions with exact failed checks and manual decisions',async()=>{
  const h=await setup();try{
    const receipt=h.s.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction' LIMIT 1").get();
    h.s.delivery(receipt.id,'uncertain','历史点击结果不明');h.s.mergeOutboxPayload(receipt.id,{deliveryRecheck:{at:1,verified:false,reason:'原消息不在当前可读历史中'}});
    h.e.archives.archiveTask(h.m.id);h.s.saveConfig({owner:{...h.owner,chatKey:'another-owner'}});
    const row=h.r.view('all','').rows.find(r=>r.id===receipt.id);assert.equal(row.number,1);assert.equal(row.lastCheck.reason,'原消息不在当前可读历史中');assert.equal(row.canResend,false);
    h.r.startBatch();await h.r.batchWork;assert.equal(h.r.batch.verified,0);assert.equal(h.r.batch.results[0].id,receipt.id);assert.match(h.r.batch.results[0].reason,/绑定已变化/);
    assert.throws(()=>h.r.resolve(receipt.id,'sent'),/确认/);h.r.resolve(receipt.id,'abandoned',{confirmed:true});
    assert.equal(h.r.view('all','').rows.length,0);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(receipt.id).status,'unavailable');
  }finally{h.s.close();}
});

test('execution recovery reads only the submitted turn and restores its final answer once without replaying delivery',async()=>{
  const h=await setup();try{
    h.e.progress.stage(h.m.id,'生成答复','',{running:true,thread:h.n.thread,turn:'original-turn',submitted:true});h.s.messageStatus(h.m.id,'uncertain','fixture timeout');h.e.progress.finish(h.m.id,'uncertain');
    let reads=0;h.c.request=async(method,params)=>{reads++;assert.equal(method,'thread/read');assert.equal(params.threadId,h.n.thread);return {thread:{id:h.n.thread,turns:[{id:'original-turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:'处理中'},{type:'agentMessage',phase:'final_answer',text:'真正的最终答复'}]},{id:'newer-turn',status:'inProgress',items:[]}]}};};
    const before=h.s.db.prepare('SELECT count(*) n FROM outbox').get().n;
    const result=await h.e.reconcileOperation(h.m.id);assert.equal(result.recovered,true);assert.equal(reads,1);
    const out=h.s.outboxByDedupe('result:'+h.m.id+':0');assert.match(out.body,/真正的最终答复/);assert.doesNotMatch(out.body,/处理中/);assert.equal(h.e.progress.get(h.m.id).status,'sending');
    h.s.delivery(out.id,'uncertain');h.e.progress.finish(h.m.id,'uncertain');await h.e.reconcileOperation(h.m.id);
    assert.equal(h.s.db.prepare('SELECT count(*) n FROM outbox').get().n,before+1);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id).status,'uncertain');
    assert.equal(h.s.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
  }finally{h.s.close();}
});

test('execution recovery refuses commentary-only results, missing exact turns and archives made during the read',async()=>{
  const h=await setup();try{
    h.e.progress.stage(h.m.id,'生成答复','',{running:true,thread:h.n.thread,turn:'original-turn',submitted:true});h.s.messageStatus(h.m.id,'uncertain','timeout');h.e.progress.finish(h.m.id,'uncertain');
    const before=h.s.db.prepare('SELECT count(*) n FROM outbox').get().n;
    h.c.request=async()=>({thread:{id:h.n.thread,turns:[{id:'original-turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:'并非最终结果'}]}]}});
    assert.match((await h.e.reconcileOperation(h.m.id)).reason,/没有可识别/);
    h.c.request=async()=>({thread:{id:h.n.thread,turns:[{id:'another-turn',status:'completed',text:'别的任务'}]}});assert.match((await h.e.reconcileOperation(h.m.id)).reason,/暂不可确认/);
    h.c.request=async()=>{h.e.archives.archiveTask(h.m.id);return {thread:{id:h.n.thread,turns:[{id:'original-turn',status:'completed',text:'不可恢复'}]}};};
    assert.match((await h.e.reconcileOperation(h.m.id)).reason,/已变化/);assert.equal(h.s.db.prepare('SELECT count(*) n FROM outbox').get().n,before);
  }finally{h.s.close();}
});
import {checkWork,operationContext} from '../src/execution.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
async function setup(){const s=new Store(mkdtempSync(join(base,'delivery-review-'))),owner={chatKey:'owner',peerUid:'owner-id',selfUid:'assistant',type:'single'};s.saveConfig({owner,autoRoute:false});const c=new EventEmitter();c.createCoordinator=async()=>randomUUID();const preferences={work:async()=>({})},conversations=new Conversations({store:s,codex:c,preferences}),scan={peer:owner,messages:[]},adapter={scanPeer:async()=>scan,send:()=>{throw Error('不得发送');},react:()=>{throw Error('不得点击表情');}},e=new BridgeEngine({store:s,codex:c,adapter,conversations,preferences,media:{}}),chats={deliveryTarget:()=>null,reconcile:()=>{}},r=new DeliveryReview({store:s,adapter,engine:e,chats}),n=await conversations.create('回执核实'),m={id:'owner:80000001',peer:'owner',platformId:'80000001',kind:'text',text:'原指令',created:Date.now()};s.incoming(m);e.progress.receive(m);e.progress.identify(m.id);e.progress.bind(m.id,n.id,n.thread);s.messageStatus(m.id,'done');return {s,c,e,r,n,m,scan,adapter,owner,delete:new ArchivedDeletion({store:s,engine:e,conversations})};}
test('人工确认指定文字后立即同步任务，归档删除可用；其他分段和执行均不重跑',async()=>{const h=await setup();try{const [id]=h.e.reply('待核实文字',{operationId:h.m.id});h.s.delivery(id,'uncertain','断线');h.e.progress.finish(h.m.id);h.e.archives.archiveTask(h.m.id);assert.equal(h.e.progress.get(h.m.id).status,'failed_delivery');assert.throws(()=>h.delete.prepare('task',h.m.id),e=>e.code==='DELIVERY_UNCONFIRMED');assert.throws(()=>h.r.resolve(id,'sent'),/先在本机确认/);const rows=h.r.view('need',h.n.id).rows;assert.equal(rows.length,1);assert.equal(rows[0].body,h.s.db.prepare('SELECT body FROM outbox WHERE id=?').get(id).body);assert.equal(rows[0].canResend,false);
  h.r.resolve(id,'sent',{confirmed:true});assert.equal(h.e.progress.get(h.m.id).status,'done');assert.equal(h.r.view('task',h.m.id).rows.length,0);assert.ok(h.delete.prepare('task',h.m.id).token);assert.equal(h.s.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);assert.equal(JSON.parse(h.s.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id).payload).deliveryReview.method,'manual');
}finally{h.s.close();}});
test('未知表情可只读核验或人工放弃；不可重试点击、不冒充送达，之后可删除归档',async()=>{const h=await setup();try{h.e.progress.finish(h.m.id);h.e.archives.archiveTask(h.m.id);const receipt=h.s.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction' AND json_extract(payload,'$.stage')='roger'").get();h.s.delivery(receipt.id,'uncertain','点击后断线');let checks=0;h.adapter.react=async(peer,id,options)=>{assert.equal(options.verifyOnly,true);assert.equal(id,'80000001');assert.deepEqual(options.emojis,['👌']);checks++;return {verified:false,reason:'菜单不提供本账号选中证据'};};assert.equal((await h.r.reconcile(receipt.id)).verified,false);assert.equal(checks,1);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(receipt.id).status,'uncertain');assert.throws(()=>h.r.resolve(receipt.id,'pending',{confirmed:true}),/表情不会重复点击/);h.r.resolve(receipt.id,'abandoned',{confirmed:true});assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(receipt.id).status,'unavailable');assert.ok(h.delete.prepare('task',h.m.id).token);
}finally{h.s.close();}});
test('只有完整原文、助手身份、时间边界、原生引用和唯一匹配均成立才自动核实文字',async()=>{const h=await setup();try{const now=Date.now(),[id]=h.e.reply('完整反馈',{operationId:h.m.id});h.s.mergeOutboxPayload(id,{deliveryAttempt:{started:now,ended:now+1000},replyToMessageId:'80000001'});h.s.delivery(id,'uncertain');h.e.progress.finish(h.m.id);const out=h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id),candidate={id:'90000001',direction:'out',sender:'assistant',created:now+300,text:out.body,replyTo:{messageId:'80000001'}};
  for(const invalid of [{...candidate,sender:'someone'},{...candidate,created:now-2000},{...candidate,created:now+3000},{...candidate,text:'片段'},{...candidate,replyTo:{messageId:'wrong'}}]){h.scan.messages=[invalid];h.r.observe(h.scan);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'uncertain');}
  h.scan.messages=[candidate,{...candidate,id:'90000002'}];h.r.observe(h.scan);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'uncertain');h.scan.messages=[candidate];h.r.observe(h.scan);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'sent');assert.equal(h.e.progress.get(h.m.id).status,'done');assert.equal(h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(id).platform_id,candidate.id);
}finally{h.s.close();}});
test('旧文字没有发送边界时拒绝猜测；不同聊天、错误绑定、冲突平台 ID 均不通过',async()=>{const h=await setup();try{const [id]=h.e.reply('相同正文',{operationId:h.m.id});h.s.delivery(id,'uncertain');const out=h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);h.scan.messages=[{id:'90000001',text:out.body,direction:'out',sender:'assistant',created:Date.now()}];assert.match((await h.r.reconcile(id)).reason,/发送时间边界/);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'uncertain');h.s.mergeOutboxPayload(id,{deliveryAttempt:{started:Date.now()-500,ended:Date.now()+500}});h.scan.peer={...h.owner,peerUid:'other'};assert.equal((await h.r.reconcile(id)).verified,false);h.scan.peer=h.owner;h.s.db.prepare('INSERT INTO outgoing_message_links VALUES(?,?,?,?,?)').run(h.owner.chatKey,'90000001','different-reply','fixture',Date.now());assert.equal((await h.r.reconcile(id)).verified,false);h.s.saveConfig({owner:{...h.owner,chatKey:'changed'}});await assert.rejects(h.r.reconcile(id),/绑定已变化/);
}finally{h.s.close();}});
test('人工放弃未送达文字不会标记完成或生成完成表情；归档可删除而不重跑执行',async()=>{const h=await setup();try{const [id]=h.e.reply('放弃的分段',{operationId:h.m.id});h.s.delivery(id,'uncertain');h.e.progress.finish(h.m.id);h.r.resolve(id,'abandoned',{confirmed:true});assert.equal(h.e.progress.get(h.m.id).status,'cancelled');assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'superseded');assert.equal(h.s.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload,'$.stage')='done'").get().n,0);h.e.archives.archiveTask(h.m.id);assert.ok(h.delete.prepare('task',h.m.id).token);
}finally{h.s.close();}});
test('只读核验等待期间人工已处理或绑定变化时，迟到结果不能覆盖人工决定',async()=>{const h=await setup();try{const receipt=h.s.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction'").get();h.s.delivery(receipt.id,'uncertain');let release;h.adapter.react=()=>new Promise(r=>release=r);const pending=h.r.reconcile(receipt.id);h.r.resolve(receipt.id,'abandoned',{confirmed:true});release({verified:true});assert.equal((await pending).verified,false);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(receipt.id).status,'unavailable');
}finally{h.s.close();}});
test('群聊旧引用回复仍可核实完整原文和原始成员，确认后立即同步聊天送达状态',async()=>{const h=await setup();try{const group={chatKey:'group',peerUid:'group:group',type:'group',selfUid:'assistant',mode:'chat',enabled:true,revision:'saved'},source={id:'80000002',sender:'member',kind:'text',text:'请解释'};h.s.saveConfig({aiChats:[group]});const chats=new Chats({store:h.s,adapter:h.adapter,sandbox:{},preferences:{}});h.r.chats=chats;h.s.db.prepare("INSERT INTO bot_messages VALUES(?,?,?,?,?,?,?,?,?,?)").run('bot-origin','group','saved',JSON.stringify(source),'delivery_uncertain','回复','','',Date.now(),Date.now());const id=h.s.enqueueReply('group','完整反馈',{payload:{chatbot:true,botId:'bot-origin',chatRevision:'saved',replyToMessageId:source.id}});h.s.delivery(id,'uncertain');h.scan.peer=group;h.scan.messages=[{id:'90000003',sender:'assistant',direction:'out',created:Date.now(),text:'@成员 完整反馈',replyTo:{messageId:source.id},nativeReplyBody:{uid:'wrong-member',text:'完整反馈'}}];assert.equal((await h.r.reconcile(id)).verified,false);h.scan.messages[0].nativeReplyBody.uid='member';assert.equal((await h.r.reconcile(id)).verified,true);assert.equal(h.s.db.prepare('SELECT status FROM bot_messages WHERE id=?').get('bot-origin').status,'done');
}finally{h.s.close();}});

test('one-click review checks all scoped receipts without resend, preserves missing evidence and deduplicates concurrent clicks',async()=>{
  const h=await setup();try{const now=Date.now(),[text]=h.e.reply('批量完整回复',{operationId:h.m.id});h.s.mergeOutboxPayload(text,{deliveryAttempt:{started:now,ended:now+1000}});h.s.delivery(text,'uncertain');const reaction=h.s.db.prepare("SELECT * FROM outbox WHERE kind='progress_reaction'").get();h.s.delivery(reaction.id,'uncertain');const failed=h.s.enqueueReply('owner','',{kind:'progress_reaction',payload:{operationId:h.m.id,messageId:'80000001',stage:'active',emojis:['[奋斗]']}});h.s.delivery(failed,'uncertain');const sending=h.s.enqueueReply('owner','正在发送',{payload:{operationId:h.m.id}});h.s.delivery(sending,'sending');
    h.scan.messages=[{id:'sent-123',direction:'out',sender:'assistant',created:now+200,text:h.s.db.prepare('SELECT body FROM outbox WHERE id=?').get(text).body}];let release;h.adapter.react=async(_p,_id,options)=>{assert.equal(options.verifyOnly,true);if(options.emojis[0]==='[奋斗]')throw new Error('fixture menu unavailable');await new Promise(resolve=>release=resolve);return {verified:true};};
    const batch=h.r.startBatch({kind:'task',id:h.m.id});assert.equal(batch.total,3);assert.equal(batch.waiting,1);assert.equal(h.r.startBatch().id,batch.id);release();await h.r.batchWork;assert.equal(h.r.batchState().status,'done');assert.equal(batch.checked,3);assert.equal(batch.verified,2);assert.equal(batch.unresolved,1);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(failed).status,'uncertain');assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(sending).status,'sending');assert.match(JSON.parse(h.s.db.prepare('SELECT payload FROM outbox WHERE id=?').get(failed).payload).deliveryRecheck.reason,/fixture menu/);assert.equal(h.s.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
  }finally{h.s.close();}
});

test('resend uses stored remaining parts, preserves native quote and skips confirmed parts without invoking a model',async()=>{
  const h=await setup();try{
    const ids=h.e.reply('第一段。'.repeat(180),{operationId:h.m.id});assert.ok(ids.length>1);
    h.s.confirmTextDelivery(ids[0],'90000001');
    for(const id of ids.slice(1)){h.s.mergeOutboxPayload(id,{replyToMessageId:'80000001'});h.s.delivery(id,'pending','fixture backoff',600000);}
    h.e.progress.finish(h.m.id);
    const before=ids.map(id=>h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id));
    await assert.rejects(h.r.resendReplies('task',h.m.id),/请确认/);
    const result=await h.r.resendReplies('task',h.m.id,{confirmed:true});assert.equal(result.requeued,ids.length-1);
    assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(ids[0]).status,'sent');
    for(const original of before.slice(1)){
      const row=h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(original.id),p=JSON.parse(row.payload),old=JSON.parse(original.payload);
      assert.equal(row.body,original.body);assert.equal(row.dedupe,original.dedupe);assert.equal(row.next_attempt,0);
      for(const key of ['group','segment','replyToMessageId'])assert.equal(p[key],old[key]);
      assert.equal(p.resendHistory.length,1);
    }
    assert.equal(h.s.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
  }finally{h.s.close();}
});

test('cancel retains original results, releases later groups, never manufactures completion and can explicitly resume',async()=>{
  const h=await setup();try{
    const ids=h.e.reply('保留正文。'.repeat(180),{operationId:h.m.id});h.s.delivery(ids[0],'uncertain');h.e.progress.finish(h.m.id);
    const other=h.s.enqueueReply('owner','其他任务',{payload:{group:'other',segment:1}});
    const result=h.r.cancelReplies('task',h.m.id);assert.equal(result.cancelled,ids.length);
    for(const id of ids){const row=h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);assert.equal(row.status,'superseded');assert.ok(row.body);assert.equal(JSON.parse(row.payload).deliveryReview.resolution,'abandoned');}
    assert.ok(h.s.pendingOutbox(30).some(o=>o.id===other));assert.equal(h.e.progress.get(h.m.id).status,'cancelled');
    assert.equal(h.s.db.prepare("SELECT COUNT(*) n FROM outbox WHERE json_extract(payload,'$.stage')='done'").get().n,0);
    assert.equal((await h.r.resendReplies('task',h.m.id,{confirmed:true})).needsConfirmation,true);
    assert.equal((await h.r.resendReplies('task',h.m.id,{confirmed:true,confirmUnreceived:true})).requeued,ids.length);
  }finally{h.s.close();}
});

test('cancel during active send fences late failure and releases the engine for another reply',async()=>{
  const h=await setup();let release;try{
    h.s.saveConfig({enabled:true});h.s.db.prepare("UPDATE outbox SET status='sent' WHERE kind='progress_reaction'").run();
    const [id]=h.e.reply('停止未提交回复',{operationId:h.m.id});h.e.progress.finish(h.m.id);
    let started;const ready=new Promise(r=>started=r);h.adapter.send=async()=>{started();await new Promise(r=>release=r);checkWork();throw Error('must not reach Enter');};
    const delivery=h.e.deliver();await ready;assert.equal(h.e.activeDelivery.submitted,false);
    h.r.cancelReplies('task',h.m.id);release();await delivery;
    const row=h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);assert.equal(row.status,'superseded');assert.equal(JSON.parse(row.payload).cancelledDeliveryEvidence.submitted,false);assert.equal(h.e.outboxBusy,false);
    const next=h.s.enqueueReply('owner','下一个独立回复');h.adapter.send=async()=>({messageId:'90000002'});await h.e.deliver();assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(next).status,'sent');
  }finally{release?.();h.s.close();}
});

test('resend waits for a cancelled active attempt; known late delivery is recorded and cannot be sent twice',async()=>{
  const h=await setup();let release;try{
    h.s.saveConfig({enabled:true});h.s.db.prepare("UPDATE outbox SET status='sent' WHERE kind='progress_reaction'").run();
    const [id]=h.e.reply('已提交的原回复',{operationId:h.m.id});h.e.progress.finish(h.m.id);
    let started;const ready=new Promise(r=>started=r);h.adapter.send=async()=>{operationContext.getStore().delivery.submitted=true;started();await new Promise(r=>release=r);return {messageId:'90000003'};};
    const delivery=h.e.deliver();await ready;h.r.cancelReplies('task',h.m.id);
    const retry=h.r.resendReplies('task',h.m.id,{confirmed:true});await new Promise(r=>setImmediate(r));
    assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'superseded');
    release();await delivery;assert.equal((await retry).requeued,0);
    assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'sent');
    assert.equal(h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(id).platform_id,'90000003');
  }finally{release?.();h.s.close();}
});

test('cancel wins over an outstanding resend reconciliation and leaves other conversations untouched',async()=>{
  const h=await setup();let release;try{
    const [id]=h.e.reply('未知送达',{operationId:h.m.id});h.s.delivery(id,'uncertain');
    const other=h.s.enqueueReply('unrelated','不要改变');let started;const ready=new Promise(r=>started=r);
    h.adapter.scanPeer=async()=>{started();await new Promise(r=>release=r);return h.scan;};
    const resend=h.r.resendReplies('task',h.m.id,{confirmed:true});await ready;
    const failure=assert.rejects(resend,/已收到取消操作/);h.r.cancelReplies('task',h.m.id);release();await failure;
    assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(id).status,'superseded');assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(other).status,'pending');
  }finally{release?.();h.s.close();}
});

test('ordinary group reply controls preserve quote pointers, enforce account/pause/reset fences and restore delivery state',async()=>{
  const h=await setup();try{
    const group={chatKey:'group',peerUid:'group:group',selfUid:'assistant',type:'group',enabled:true,mode:'chat',revision:'saved'},chats=new Chats({store:h.s,adapter:h.adapter,sandbox:{},preferences:{}});
    h.s.saveConfig({aiChats:[group]});h.r.chats=chats;
    h.s.db.prepare('INSERT INTO bot_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run('bot','group','saved',JSON.stringify({id:'80000002',sender:'member',text:'原提问'}),'replying','现成结果','','',Date.now(),Date.now());
    const id=h.s.enqueueReply('group','现成结果',{payload:{chatbot:true,botId:'bot',chatRevision:'saved',replyToMessageId:'80000002',group:'bot',segment:1}});
    assert.equal(h.r.controls('chat_reply','bot').canCancel,true);h.r.cancelReplies('chat_reply','bot');assert.equal(chats.state().messages[0].status,'cancelled');
    chats.pauseDelivery('group',true);await assert.rejects(h.r.resendReplies('chat_reply','bot',{confirmed:true}),/已暂停/);chats.pauseDelivery('group',false);
    assert.equal((await h.r.resendReplies('chat_reply','bot',{confirmed:true})).requeued,1);assert.equal(chats.state().messages[0].status,'replying');
    assert.equal(JSON.parse(h.s.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id).payload).replyToMessageId,'80000002');
    h.s.mergeOutboxPayload(id,{contextReset:{at:Date.now()}});await assert.rejects(h.r.resendReplies('chat_reply','bot',{confirmed:true}),/清空/);
    h.s.saveConfig({aiChats:[]});assert.doesNotThrow(()=>h.r.controls('chat_reply','bot'));
  }finally{h.s.close();}
});

test('exhausted draft recovery stays visibly paused and cannot archive or mark a task complete',async()=>{
  const h=await setup();try{const [id]=h.e.reply('保留结果',{operationId:h.m.id});h.e.progress.finish(h.m.id);h.s.delivery(id,'held','自动草稿已恢复两次');h.e.progress.sync(h.m.id);assert.notEqual(h.e.progress.get(h.m.id).status,'done');assert.equal(h.s.isArchived('task',h.m.id),false);assert.match(h.e.progress.status(h.m.id),/发送已暂停/);}finally{h.s.close();}
});
