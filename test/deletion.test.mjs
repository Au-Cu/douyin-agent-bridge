import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {Conversations} from '../src/conversations.mjs';import {ArchivedDeletion} from '../src/deletion.mjs';import {replyReferencePath} from '../src/reply-reference.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
function setup(root){
  const s=new Store(root||mkdtempSync(join(base,'deletion-')));s.saveConfig({owner:{chatKey:'owner'},autoRoute:false});
  const c=new EventEmitter(),native=new Map(),calls=[];c.createCoordinator=async()=>{const id=randomUUID();native.set(id,false);return id;};c.connect=async()=>{};c.threadLocks=new Map();
  c.request=async(method,p)=>{calls.push(method);if(method==='thread/read')return {thread:{archived:native.get(p.threadId),status:{type:'idle'}}};if(method==='thread/archive'||method==='thread/unarchive'){native.set(p.threadId,method==='thread/archive');return {};}throw new Error('unexpected native mutation');};
  const preferences={work:async()=>({}),light:async()=>({})},conversations=new Conversations({store:s,codex:c,preferences}),e=new BridgeEngine({store:s,codex:c,conversations,preferences,adapter:{},media:{}}),d=new ArchivedDeletion({store:s,engine:e,conversations});
  const message=(need,text='待删除记录',parent='')=>{const id='owner:'+randomUUID(),m={id,peer:'owner',kind:'text',text,created:Date.now()};s.incoming(m);e.progress.receive(m);if(parent)s.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(parent,id);e.progress.identify(id);e.progress.bind(id,need.id,need.thread);conversations.needs.reserve(m,need);conversations.record(id,'原始反馈');s.messageStatus(id,'done');e.progress.finish(id);e.archives.archiveTask(id);return {...m,number:e.progress.get(id).number};};
  const confirm=(kind,id)=>{const p=d.prepare(kind,id);return d.remove({kind,id,token:p.token});};
  return {s,c,e,d,conversations,native,calls,message,confirm};
}
test('只删除已归档记录；必须显式预览范围并二次确认，恢复会使确认失效',async()=>{
  const h=setup();try{const n=await h.conversations.create('范围'),m=h.message(n);h.e.archives.restoreTask(m.id);assert.throws(()=>h.d.prepare('task',m.id),/先完成归档/);h.e.archives.archiveTask(m.id);
    assert.throws(()=>h.d.remove({kind:'task',id:m.id}),/确认已失效/);const p=h.d.prepare('task',m.id);assert.match(p.label,/任务 1/);assert.equal(p.counts.operations,1);assert.equal(p.counts.messages,1);assert.equal(h.e.progress.get(m.id).id,m.id);
    h.e.archives.restoreTask(m.id);assert.throws(()=>h.d.remove({kind:'task',id:m.id,token:p.token}),/先完成归档/);assert.ok(h.e.progress.get(m.id));assert.throws(()=>h.d.prepare('knowledge','vid'),/仅支持/);
  }finally{h.s.close();}
});
test('删除任务清理请求、执行、完整回复组、回执、重试和引用缓存；保留同需求其他任务与学习资料',async()=>{
  const h=setup();try{
    const n=await h.conversations.create('保留需求'),m=h.message(n),other=h.message(n,'保留任务'),task=h.s.createTask('项目',randomUUID(),'待删除指令',{operationId:m.id,needId:n.id});h.s.taskStatus(task,'done','执行完成','native-turn');
    const rows=h.e.reply('完整反馈一。'.repeat(150),{operationId:m.id});for(const [i,id]of rows.entries())h.s.confirmTextDelivery(id,String(9000000+i));
    const refMessage={id:'owner:external',peer:'owner',created:Date.now(),kind:'text',text:'独立参考',replyTo:{messageId:'9000000',hint:'',status:0}};h.s.incoming(refMessage);const ref=h.e.references.find(refMessage);assert.ok(existsSync(ref.path));
    h.s.db.prepare('INSERT INTO task_waits VALUES(?,?,?,?,?,?,?)').run(task,m.id,'旧调度',1,1,2,1);h.s.db.prepare("INSERT INTO task_retry_events VALUES(1,?,?,1,1,'blocked','旧原因',0,0)").run(task,m.id);
    h.conversations.needs.reserve({id:'task-result:'+task,kind:'text',text:'执行原文'},n);h.conversations.record('task-result:'+task,'执行结果');
    const input=h.conversations.needs.json(n.id,'input-'+m.id.replace(/[^\w-]/g,'').slice(-80)+'.json',{ownerMessage:m});h.conversations.needs.json(n.id,'handoff-2.json',{memory:'含待删除反馈'});h.conversations.needs.json(n.id,'history.json',{old:'含待删除反馈'});
    const knowledge=join(h.s.root,'knowledge','v');mkdirSync(knowledge,{recursive:true});const note=join(knowledge,'note.md');writeFileSync(note,'视觉证据');h.s.addKnowledge({id:'v',title:'保留视频',path:note});h.conversations.needs.attach(n.id,'v');
    const calls=h.calls.length;const result=h.confirm('task',m.id);assert.equal(result.deleted,true);assert.equal(result.cleanupPending,false);assert.equal(h.calls.length,calls,'删除不得操作原生聊天或派发');
    for(const [table,where,args]of [['messages','id=?',[m.id]],['operations','id=?',[m.id]],['tasks','id=?',[task]],['outbox',"json_extract(payload,'$.operationId')=?",[m.id]],['task_waits','operation_id=?',[m.id]],['task_retry_events','operation_id=?',[m.id]],['outgoing_message_links','platform_id=?',['9000000']],['reply_reference_links','message_id=?',[refMessage.id]]])assert.equal(h.s.db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE '+where).get(...args).n,0,table);
    assert.equal(existsSync(ref.path),false);assert.equal(existsSync(input),false);assert.equal(existsSync(join(h.s.root,'needs',n.id,'handoff-2.json')),false);const history=readFileSync(h.conversations.needs.history(n.id),'utf8');assert.equal(history.includes(m.id),false);assert.ok(history.includes(other.id));assert.ok(h.e.progress.get(other.id));assert.equal(readFileSync(note,'utf8'),'视觉证据');assert.equal(h.conversations.needs.knowledge(n.id)[0].id,'v');assert.equal(h.conversations.needs.get(n.id).memory.progress,'');
    assert.equal(h.s.db.prepare('SELECT COUNT(*) AS n FROM deleted_messages').get().n,2);assert.ok(h.s.db.prepare('SELECT hash FROM deleted_messages').all().every(r=>/^[a-f\d]{64}$/.test(r.hash)));
    assert.throws(()=>h.e.references.find(refMessage),/已被彻底删除/);
  }finally{h.s.close();}
});
test('删除归档需求连同其任务和完整记忆目录，保留其他需求、授权项目聊天与原片',async()=>{
  const h=setup();try{const n=await h.conversations.create('删除整个需求'),m=h.message(n),other=await h.conversations.create('其他需求'),m2=h.message(other);h.conversations.needs.json(n.id,'history.json',{secret:'需求原文'});const project=randomUUID();h.s.saveConfig({targets:[{alias:'项目',thread:project}]});const task=h.s.createTask('项目',project,'授权',{needId:n.id,operationId:m.id});h.s.taskStatus(task,'done','完成','turn');
    await h.e.archives.need(n.id,true);const nativeCalls=h.calls.length;h.confirm('need',n.id);assert.equal(h.calls.length,nativeCalls);assert.equal(h.conversations.needs.get(n.id),null);assert.equal(h.e.progress.get(m.id),undefined);assert.equal(existsSync(join(h.s.root,'needs',n.id)),false);assert.equal(h.conversations.needs.get(other.id).title,'其他需求');assert.ok(h.e.progress.get(m2.id));assert.equal(h.s.config.targets[0].thread,project);assert.equal(h.native.get(n.thread),true);assert.equal(h.s.db.prepare('SELECT COUNT(*) AS n FROM archive_jobs WHERE need_id=?').get(n.id).n,0);
  }finally{h.s.close();}
});
test('运行、结果不明、中断不明及不确定送达均不可删除，其他项目并行不阻断删除',async()=>{
  const h=setup();try{const n=await h.conversations.create('状态边界'),m=h.message(n);for(const status of ['running','sending','uncertain','failed_delivery','stopping']){h.s.db.prepare('UPDATE operations SET status=? WHERE id=?').run(status,m.id);assert.throws(()=>h.d.prepare('task',m.id),/尚未核实|不能删除/);}h.s.db.prepare("UPDATE operations SET status='done' WHERE id=?").run(m.id);
    const out=h.s.enqueueReply('owner','未核实',{payload:{operationId:m.id}});for(const status of ['uncertain','sending']){h.s.delivery(out,status);assert.throws(()=>h.d.prepare('task',m.id),/送达尚未核实/);}h.s.delivery(out,'sent');
    h.s.db.prepare("INSERT INTO interruptions VALUES(?,'uncertain',1,1,'')").run(m.id);assert.throws(()=>h.d.prepare('task',m.id),/中断结果/);h.s.db.prepare('DELETE FROM interruptions').run();
    const pending=Promise.resolve();h.e.memoryUpdates.add(pending);assert.throws(()=>h.d.prepare('task',m.id),/整理或核对/);h.e.memoryUpdates.delete(pending);
    h.e.taskRuns.set('unrelated-project','different-task');h.confirm('task',m.id);assert.equal(h.e.taskRuns.get('unrelated-project'),'different-task');
  }finally{h.s.close();}
});
test('确认后记录变化必须重新确认，错误 token 和失效 token 均不删除',async()=>{
  const h=setup();try{const n=await h.conversations.create('确认时效'),m=h.message(n),p=h.d.prepare('task',m.id);h.e.reply('新的一段回复',{operationId:m.id});assert.throws(()=>h.d.remove({kind:'task',id:m.id,token:p.token}),/记录已经变化/);const p2=h.d.prepare('task',m.id);h.d.confirmations.get(p2.token).expires=0;assert.throws(()=>h.d.remove({kind:'task',id:m.id,token:p2.token}),/确认已失效/);assert.ok(h.e.progress.get(m.id));
  }finally{h.s.close();}
});
test('删除最高任务、补充和需求后重启不复用编号，原消息不会重新接收或执行',async()=>{
  const h=setup(),root=h.s.root;try{
    const n=await h.conversations.create('旧需求'),m=h.message(n),child=h.message(n,'补充',m.id);assert.equal(child.number,'1-1');h.confirm('task',child.id);const child2=h.message(n,'再次补充',m.id);assert.equal(child2.number,'1-2');h.confirm('task',child2.id);h.confirm('task',m.id);await h.e.archives.need(n.id,true);h.confirm('need',n.id);h.s.close();
    const fresh=setup(root);try{assert.equal(fresh.e.gate.accept(m),false);assert.equal(fresh.s.incoming(m),false);assert.throws(()=>fresh.e.progress.receive(m),/已被彻底删除/);const newer=await fresh.conversations.create('新需求');assert.equal(newer.number,2);assert.equal(fresh.message(newer).number,2);assert.equal(fresh.s.queuedTasks().length,0);assert.equal(fresh.s.pendingMessages().length,0);}finally{fresh.s.close();}
  }finally{if(!h.s.closed)h.s.close();}
});
test('删除提交后清理失败可在重启续清理，数据库记录始终消失且不重跑',async()=>{
  const h=setup(),root=h.s.root;try{const n=await h.conversations.create('崩溃清理'),m=h.message(n);await h.e.archives.need(n.id,true);const path=h.conversations.needs.json(n.id,'history.json',{source:'原文'});h.d.removeCache=()=>{throw new Error('temporary disk busy');};const result=h.confirm('need',n.id);assert.equal(result.cleanupPending,true);assert.equal(h.conversations.needs.get(n.id),null);assert.equal(existsSync(path),true);h.s.close();const fresh=setup(root);try{assert.equal(fresh.s.db.prepare('SELECT COUNT(*) AS n FROM deletion_cleanup').get().n,0);assert.equal(existsSync(path),false);assert.equal(fresh.s.incoming(m),false);assert.equal(fresh.s.queuedTasks().length,0);}finally{fresh.s.close();}
  }finally{if(!h.s.closed)h.s.close();}
});
test('清理拒绝遍历、符号链接及工作区以外路径，外部文件始终保留',async()=>{
  const h=setup();try{const n=await h.conversations.create('路径边界'),outside=mkdtempSync(join(base,'outside-'));writeFileSync(join(outside,'keep.txt'),'不可删除');for(const path of ['../outside','knowledge/vid','needs/../../outside','reply-references/anything.json'])assert.throws(()=>h.d.removeCache(path),/拒绝/);
    const folder=join(h.s.root,'needs',n.id);mkdirSync(folder,{recursive:true});symlinkSync(outside,join(folder,'external'),process.platform==='win32'?'junction':'dir');assert.throws(()=>h.d.removeCache('needs/'+n.id),/包含链接/);assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'不可删除');
  }finally{h.s.close();}
});
