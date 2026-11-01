import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {launchTestBrowser} from './browser.mjs';
import {Store} from '../src/store.mjs';import {BridgeEngine,mayDispatch} from '../src/engine.mjs';import {Conversations} from '../src/conversations.mjs';import {scanConversation} from '../src/douyin.mjs';import {requestKey} from '../src/progress.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const owner={chatKey:'owner-chat',peerUid:'owner'},msg=(id,text,extra={})=>({id:'owner-chat:'+id,platformId:id,peer:'owner-chat',conversation:'owner-chat',sender:'owner',direction:'in',created:Date.now(),kind:'text',text,...extra});
function setup(root){
 const s=new Store(root||mkdtempSync(join(base,'reply-ref-')));s.saveConfig({enabled:true,owner,autoRoute:false,targets:[{id:'project-chat',alias:'网站'}]});const c=new EventEmitter();let seq=0;c.ready=true;c.ensureAuthenticated=async()=>{};c.createCoordinator=async()=>`assistant-${++seq}`;c.request=async()=>({thread:{status:{type:'idle'}}});c.calls=[];
 const prefs={work:async()=>({}),light:async()=>({}),describe:()=>''},conv=new Conversations({store:s,codex:c,preferences:prefs});const sent=[];const adapter={send:async(_o,text)=>{const id=String(9000000000000000000n+BigInt(sent.length));sent.push({id,text});return {messageId:id};},react:async()=>({verified:true})};const engine=new BridgeEngine({store:s,codex:c,adapter,media:{},preferences:prefs,conversations:conv});
 c.run=async(thread,input,options)=>{c.calls.push({thread,input});options.onSubmitted?.();options.onStarted?.('turn');if(c.dispatch)await options.toolHandler({tool:'dispatch_task',arguments:{alias:'网站',instruction:'结合视频和反馈实现'}});return {text:'已处理',turnId:'turn'};};c.runEphemeral=async()=>({text:JSON.stringify({title:'参考视频',goal:'参考视频',constraints:[],decisions:[],pending:[],progress:'已处理'})});
 return {s,c,conv,engine,adapter,sent};
}
async function drain(h){for(let i=0;i<50&&h.s.pendingOutbox().length;i++)await h.engine.deliver();}
async function source(h){
 const need=await h.conv.create('原视频需求'),id='9000000000000000123',folder=join(h.s.root,'knowledge',id);mkdirSync(folder,{recursive:true});const path=join(folder,'note.md');writeFileSync(path,'视频原始证据');h.s.addKnowledge({id,title:'原视频',path,transcript:'原始口播',summary:'视觉结果'});h.conv.needs.attach(need.id,id);
 const m=msg('8000000000000000001','',{kind:'video',awemeId:id,title:'原视频'});h.s.incoming(m);h.engine.progress.receive(m);h.engine.progress.identify(m.id);h.engine.progress.bind(m.id,need.id,need.thread);
 const body='第一分段：布局、颜色与操作步骤。'.repeat(30)+'\n第二部分：过渡动画和边界处理。'.repeat(25);const out=h.engine.reply(body,{operationId:m.id,payload:{videoId:id}});assert.ok(out.length>2);h.s.messageStatus(m.id,'done');h.engine.progress.finish(m.id);await drain(h);assert.equal(h.engine.progress.get(m.id).status,'done');
 const rows=out.map(id=>h.s.db.prepare('SELECT * FROM outbox WHERE id=?').get(id));return {need,id,m,rows};
}

test('实际网页的 Long 引用 ID 不丢精度；正文只取用户本条指令',async t=>{
 const browser=await launchTestBrowser(t);if(!browser)return;try{const page=await browser.newPage();await page.setContent('<div class="RightPanelHeadertitle">test</div><div class="messageMessageBoxcontentBox" data-direction="in"><div>fixture</div></div>');await page.evaluate(()=>{const row=document.querySelector('.messageMessageBoxcontentBox');const ref={referenced_message_id:{toString:()=> '90071992547409931'},referenced_message_status:0,hint:JSON.stringify({content:'之前的反馈',refmsg_uid:'assistant'})};const m={serverId:'90071992547409932',sender:'owner',conversationId:'owner-chat',createTime:Date.now(),content:JSON.stringify({text:'请落实'})};Object.defineProperty(m,'referenceInfo',{get:()=>ref});row.__reactProps$fixture={message:m};});const result=await page.evaluate(scanConversation);assert.equal(result.messages[0].replyTo.messageId,'90071992547409931');assert.equal(result.messages[0].replyTo.hint,'之前的反馈');assert.equal(result.messages[0].text,'请落实');
 }finally{await browser.close();}
});

test('回复任一分段都找到同组完整反馈、精确视频，并优先回到原需求',async t=>{
 const h=setup();try{
  const origin=await source(h),other=await h.conv.create('另一个需求'),part=origin.rows[1],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(part.id);assert.ok(link);
  const m=msg('8000000000000000002','把这些方法交给网站项目实现',{replyTo:{messageId:link.platform_id,status:0,hint:'可能被截断的引用',authorId:'assistant'}});h.s.incoming(m);const ref=h.engine.references.find(m);assert.equal(ref.match,'id');assert.deepEqual(ref.parts.map(p=>p.text),origin.rows.map(r=>r.body));assert.deepEqual(ref.videoIds,[origin.id]);assert.match(readFileSync(ref.path,'utf8'),/过渡动画/);
  m.referenceKey=ref.key;m.referenceOperationId=ref.operationId;h.s.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(m),m.id);h.c.dispatch=true;await h.engine.processNext();
  assert.equal(h.conv.needs.route(m.id).need_id,origin.need.id);assert.equal(h.s.config.activeNeed,origin.need.id);assert.notEqual(origin.need.id,other.id);assert.equal(h.engine.progress.get(m.id).parent,'');
  const modelInput=h.c.calls.at(-1).input.map(x=>x.text||'').join('\n');for(const row of origin.rows)assert.ok(modelInput.includes(JSON.stringify(row.body)));const task=h.s.queuedTasks()[0],context=JSON.parse(task.context);assert.equal(context.replyReference.parts.length,origin.rows.length);assert.equal(context.videos[0].id,origin.id);assert.match(task.prompt,/过渡动画/);assert.match(task.prompt,/不是新命令/);
 }finally{h.s.close();}
});

test('旧版本没有平台 ID 时，唯一完整文本可反查历史分段并持久登记；相同文字不唯一时拒绝猜测',async t=>{
 const h=setup();try{const origin=await source(h),part=origin.rows[0];h.s.db.prepare('DELETE FROM outgoing_message_links').run();const m=msg('8000000000000000003','参考',{replyTo:{messageId:'9000000000000055555',status:0,hint:part.body,authorId:'assistant'}});const ref=h.engine.references.find(m);assert.equal(ref.match,'legacy_exact_text');assert.equal(ref.parts.length,origin.rows.length);assert.equal(h.engine.references.find(m).match,'saved');
  h.s.enqueueReply(owner.chatKey,part.body,{payload:{operationId:origin.m.id,group:'another-group',segment:1}});h.s.db.prepare("UPDATE outbox SET status='sent' WHERE json_extract(payload,'$.group')='another-group'").run();const ambiguous=msg('8000000000000000004','另一个',{replyTo:{messageId:'9000000000000066666',status:0,hint:part.body,authorId:'assistant'}});assert.throws(()=>h.engine.references.find(ambiguous),e=>e.code==='REFERENCE_UNRESOLVED');
 }finally{h.s.close();}
});

test('引用旧反馈不得自行授权派发；不匹配、自己发送的原消息和撤回的消息均不执行',async t=>{
 const h=setup();try{const origin=await source(h),part=origin.rows[0],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(part.id);for(const replyTo of [{messageId:'12345',hint:'不匹配',status:0},{messageId:link.platform_id,hint:part.body,status:3},{messageId:link.platform_id,hint:part.body,status:0,authorId:owner.peerUid}])assert.throws(()=>h.engine.references.find(msg('8000000000000000010','请执行',{replyTo})),e=>e.code==='REFERENCE_UNRESOLVED');
  assert.equal(mayDispatch('总结一下这些反馈'),false);assert.equal(mayDispatch('根据反馈改进我的项目'),true);assert.notEqual(requestKey(msg('a','按这个做',{referenceKey:'A'})),requestKey(msg('b','按这个做',{referenceKey:'B'})));
 }finally{h.s.close();}
});

test('引用已归档需求时新建独立需求，保留原视频且不恢复旧任务',async t=>{
 const h=setup();try{const origin=await source(h),sourceOp=h.engine.progress.get(origin.m.id);h.s.setArchived('need',origin.need.id,true);h.s.saveConfig({activeNeed:'',coordinator:''});const message=msg('8000000000000000005','根据反馈继续做'),reference={needId:origin.need.id,title:'旧反馈',videoIds:[origin.id]};const route=await h.conv.prepare(message,{reference});assert.notEqual(route.needId,origin.need.id);assert.equal(h.s.isArchived('need',origin.need.id),true);assert.equal(h.s.isArchived('task',sourceOp.id),true);assert.equal(h.conv.related(route.needId)[0].id,origin.id);
 }finally{h.s.close();}
});

test('补充编号采用 1-1、1-2，独立新任务仍为 2；中断、重试、归档均接受编号',async t=>{
 const h=setup(),root=h.s.root;try{
  const first=msg('8000000000000000011','视频'),a=msg('8000000000000000012','补充一'),b=msg('8000000000000000013','补充二'),next=msg('8000000000000000014','独立新任务');for(const m of [first,a,b,next]){h.s.incoming(m);h.engine.progress.receive(m);}h.engine.progress.identify(first.id);h.engine.progress.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(first.id,a.id);h.engine.progress.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(first.id,b.id);assert.equal(h.engine.progress.identify(a.id).number,'1-1');assert.equal(h.engine.progress.identify(b.id).number,'1-2');assert.equal(h.engine.progress.identify(next.id).number,2);
  h.engine.archives.archiveTask('1-1');assert.equal(h.s.isArchived('task',a.id),true);h.engine.archives.restoreTask('1-1');assert.equal(h.engine.progress.retry('1-1'),a.id);assert.equal((await h.engine.interrupts.request('1-2')).state,'stopped');assert.match(await h.engine.handleSettingCommand({name:'archive_task',arg:'1-1'}),/1-1/);
 }finally{h.s.close();}const fresh=setup(root);try{assert.equal(fresh.engine.progress.get('owner-chat:8000000000000000012').number,'1-1');assert.equal(fresh.engine.progress.get('owner-chat:8000000000000000014').number,2);}finally{fresh.s.close();}
});

test('真实接收路径在分类前保存引用，将消息归入对应需求并读取整个分段组',async t=>{
 const h=setup();try{const origin=await source(h);await h.conv.create('其他需求');const selected=origin.rows.at(-1),link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(selected.id),incoming={id:'8000000000000000040',conversation:owner.chatKey,sender:owner.peerUid,direction:'in',created:Date.now(),kind:'text',text:'请复述这段完整反馈，不派任务',replyTo:{messageId:link.platform_id,status:0,hint:selected.body,authorId:'assistant'}};h.engine.armedAt=Date.now()-1000;h.adapter.scan=async()=>({peer:owner,messages:[incoming]});await h.engine.scan();await new Promise(r=>setImmediate(r));await h.engine.processNext();const id=owner.chatKey+':'+incoming.id,record=JSON.parse(h.s.db.prepare('SELECT body FROM messages WHERE id=?').get(id).body);assert.ok(record.referenceKey);assert.equal(h.conv.needs.route(id).need_id,origin.need.id);const text=h.c.calls.at(-1).input.map(x=>x.text||'').join('\n');for(const row of origin.rows)assert.ok(text.includes(JSON.stringify(row.body)));assert.equal(h.s.queuedTasks().length,0);
 }finally{h.s.close();}
});

test('引用无法核实时原要求保留并提示，不进入模型和项目任务队列',async t=>{
 const h=setup();try{await h.conv.create('当前需求');const incoming={id:'8000000000000000041',conversation:owner.chatKey,sender:owner.peerUid,direction:'in',created:Date.now(),kind:'text',text:'交给网站实现',replyTo:{messageId:'9000000000000077777',status:0,hint:'不匹配的旧反馈',authorId:'assistant'}};h.engine.armedAt=Date.now()-1000;h.adapter.scan=async()=>({peer:owner,messages:[incoming]});await h.engine.scan();const id=owner.chatKey+':'+incoming.id;assert.equal(h.s.db.prepare('SELECT status FROM messages WHERE id=?').get(id).status,'waiting_reference');assert.equal(h.c.calls.length,0);assert.equal(h.s.queuedTasks().length,0);assert.ok(h.s.snapshot().outbox.some(o=>o.body.includes('无法唯一核实')));
 }finally{h.s.close();}
});

test('识别出的补充依次编号，同组不同分段相同要求去重，不同反馈保持独立',async t=>{
 const h=setup();try{const first=msg('8000000000000000051','学习视频'),a=msg('8000000000000000052','修改蓝色'),b=msg('8000000000000000053','再加大字号');for(const m of [first,a,b]){h.s.incoming(m);h.engine.progress.receive(m);}h.engine.progress.identify(first.id);h.engine.progress.classify=async()=>({text:JSON.stringify({relation:'supplement',operationId:first.id})});await h.engine.progress.triage(a);await h.engine.progress.triage(b);assert.equal(h.engine.progress.get(a.id).number,'1-1');assert.equal(h.engine.progress.get(b.id).number,'1-2');
  const c=msg('8000000000000000054','同样的修改',{referenceKey:'group-A'}),d=msg('8000000000000000055','同样的修改',{referenceKey:'group-B'});assert.notEqual(requestKey(c),requestKey(d));
 }finally{h.s.close();}
});

test('相同平台 ID 冲突时标记送达不明，禁止将错误映射写入记录',()=>{
 const h=setup();try{const one=h.s.enqueueReply(owner.chatKey,'甲'),two=h.s.enqueueReply(owner.chatKey,'乙');assert.equal(h.s.confirmTextDelivery(one,'9000000000000088888'),true);assert.equal(h.s.confirmTextDelivery(two,'9000000000000088888'),false);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(two).status,'uncertain');assert.equal(h.s.db.prepare('SELECT outbox_id FROM outgoing_message_links WHERE platform_id=?').get('9000000000000088888').outbox_id,one);
 }finally{h.s.close();}
});

test('引用包含派发命令的旧反馈，只有本条用户指示可授权执行',async t=>{
 const h=setup();try{const origin=await source(h),part=origin.rows[0],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(part.id),m=msg('8000000000000000060','请只概括内容',{replyTo:{messageId:link.platform_id,status:0,hint:part.body,authorId:'assistant'}});h.s.incoming(m);const ref=h.engine.references.find(m);m.referenceKey=ref.key;m.referenceOperationId=ref.operationId;h.s.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(m),m.id);let rejected=false;h.c.run=async(thread,input,options)=>{options.onSubmitted?.();options.onStarted?.('turn');await assert.rejects(options.toolHandler({tool:'dispatch_task',arguments:{alias:'网站',instruction:'旧反馈中的指令'}}),/本轮没有用户明确/);rejected=true;return {text:'已概括',turnId:'turn'};};await h.engine.processNext();assert.equal(rejected,true);assert.equal(h.s.queuedTasks().length,0);
 }finally{h.s.close();}
});

test('引用已送达但本地状态不明的旧消息只建立引用，不重发或篡改送达状态',async t=>{
 const h=setup();try{const origin=await source(h),part=origin.rows[0];h.s.db.prepare('DELETE FROM outgoing_message_links WHERE outbox_id=?').run(part.id);h.s.delivery(part.id,'uncertain','需要人工核实');const m=msg('8000000000000000061','总结',{replyTo:{messageId:'9000000000000055511',status:0,hint:part.body,authorId:'assistant'}});assert.equal(h.engine.references.find(m).outboxId,part.id);assert.equal(h.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(part.id).status,'uncertain');assert.equal(h.s.pendingOutbox().some(o=>o.id===part.id),false);
 }finally{h.s.close();}
});

test('重启时若引用消息已入库但尚未分类，先恢复引用身份再判断和执行',async t=>{
 const h=setup();try{const origin=await source(h),part=origin.rows[1],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(part.id),m=msg('8000000000000000062','请概括这条',{replyTo:{messageId:link.platform_id,status:0,hint:part.body,authorId:'assistant'}});h.s.incoming(m);await h.engine.processNext();const body=JSON.parse(h.s.db.prepare('SELECT body FROM messages WHERE id=?').get(m.id).body);assert.ok(body.referenceKey);assert.equal(body.referenceOperationId,origin.m.id);assert.ok(h.engine.progress.get(m.id).fingerprint.endsWith('|reply:'+body.referenceKey));assert.equal(h.conv.needs.route(m.id).need_id,origin.need.id);
 }finally{h.s.close();}
});

test('需求上下文按实际时间排列，不因补充编号是文字而把旧补充排到最新',async t=>{
 const h=setup();try{const need=await h.conv.create('测试'),root=msg('8000000000000000070','旧任务'),sub=msg('8000000000000000071','旧补充');for(const m of [root,sub]){h.s.incoming(m);h.engine.progress.receive(m);h.engine.progress.bind(m.id,need.id,need.thread);}h.engine.progress.identify(root.id);h.engine.progress.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(root.id,sub.id);h.engine.progress.identify(sub.id);
  for(let i=0;i<9;i++){const m=msg(String(8000000000000000080n+BigInt(i)),'新任务'+i);h.s.incoming(m);h.engine.progress.receive(m);h.engine.progress.bind(m.id,need.id,need.thread);h.engine.progress.identify(m.id);}const requests=h.conv.context({needId:need.id}).requests;assert.equal(requests.length,8);assert.equal(requests.some(r=>r.number==='1-1'),false);
 }finally{h.s.close();}
});

test('分段记录缺失或无法确定分组时不冒充完整反馈',async t=>{
 const h=setup();try{const origin=await source(h),first=origin.rows[0],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(first.id);h.s.delivery(origin.rows[1].id,'superseded','测试缺失');const m=msg('8000000000000000089','请使用',{replyTo:{messageId:link.platform_id,status:0,hint:first.body,authorId:'assistant'}});assert.throws(()=>h.engine.references.find(m),e=>e.code==='REFERENCE_INCOMPLETE');assert.equal(h.s.db.prepare('SELECT 1 FROM reply_reference_links WHERE message_id=?').get(m.id),undefined);
  h.s.delivery(origin.rows[1].id,'sent');for(const row of origin.rows){const p=JSON.parse(row.payload);delete p.group;delete p.totalSegments;h.s.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(p),row.id);}assert.throws(()=>h.engine.references.find(m),e=>e.code==='REFERENCE_INCOMPLETE');
 }finally{h.s.close();}
});

test('旧记录缺少 group 但保留完整分段号和去重键时，能核对并恢复所有分段',async t=>{
 const h=setup();try{const origin=await source(h);for(const [i,row] of origin.rows.entries()){const p=JSON.parse(row.payload);delete p.group;h.s.db.prepare('UPDATE outbox SET payload=?,dedupe=? WHERE id=?').run(JSON.stringify(p),'result:fixture:'+i,row.id);}const first=origin.rows[0],link=h.s.db.prepare('SELECT platform_id FROM outgoing_message_links WHERE outbox_id=?').get(first.id),m=msg('8000000000000000090','请总结',{replyTo:{messageId:link.platform_id,status:0,hint:first.body,authorId:'assistant'}});assert.deepEqual(h.engine.references.find(m).parts.map(p=>p.text),origin.rows.map(r=>r.body));
 }finally{h.s.close();}
});
