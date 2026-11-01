import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {BridgeEngine} from '../src/engine.mjs';import {Conversations} from '../src/conversations.mjs';import {configurePanel,updatePanels} from '../src/ui-state.mjs';import {codexThreadUrl} from '../src/archive.mjs';import {parseCommand} from '../src/commands.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
function fixture(root){
  const s=new Store(root||mkdtempSync(join(base,'archive-')));s.saveConfig({enabled:true,owner:{chatKey:'test-owner'},autoRoute:false});
  const c=new EventEmitter();c.ready=true;c.connect=async()=>{};c.ensureAuthenticated=async()=>{};c.threadLocks=new Map();const native=new Map(),calls=[];
  c.createCoordinator=async()=>{const id=randomUUID();native.set(id,{archived:false,status:{type:'idle'}});return id;};
  c.request=async(method,p)=>{calls.push({method,...p});const t=native.get(p.threadId);if(method==='thread/read')return {thread:{...t}};
    if(method==='thread/archive'||method==='thread/unarchive'){
      const step=s.db.prepare('SELECT status FROM archive_jobs WHERE thread=? AND direction=?').get(p.threadId,Number(method==='thread/archive'));assert.equal(step.status,'submitted','归档 RPC 前必须持久记录提交');
      t.archived=method==='thread/archive';return {};
    }throw new Error('unexpected RPC '+method);
  };
  const preferences={work:async()=>({}),light:async()=>({}),describe:()=>''},manager=new Conversations({store:s,codex:c,preferences});
  const e=new BridgeEngine({store:s,codex:c,adapter:{send:async()=>{},react:async()=>({verified:true})},media:{},preferences,conversations:manager});
  const message=text=>{const id='test-owner:'+randomUUID(),m={id,peer:'test-owner',kind:'text',text,created:Date.now()};s.incoming(m);e.progress.receive(m);e.progress.identify(m.id);return m;};
  return {s,c,e,manager,native,calls,message};
}
test('需求归档同步所有助手续接聊天、隐藏目录；不碰授权目标或资料，恢复编号和记忆',async()=>{
  const h=fixture();try{
    const need=await h.manager.create('一次性额度查询'),older=need.thread,newer=await h.c.createCoordinator();h.manager.needs.bindThread(need.id,newer);
    const target=await h.c.createCoordinator();h.s.saveConfig({targets:[{id:target,alias:'独立项目'}]});
    h.manager.needs.rename(need.id,'保留标题');const archived=await h.e.archives.need(String(need.number),true);
    assert.equal(archived.threads,2);assert.equal(h.native.get(older).archived,true);assert.equal(h.native.get(newer).archived,true);assert.equal(h.native.get(target).archived,false);
    assert.equal(h.manager.needs.list().length,0);assert.equal(h.manager.needs.directory().length,0);assert.equal(h.manager.state({scope:'archived'}).needs[0].number,need.number);assert.equal(h.s.config.coordinator,'');
    await h.manager.ensureLegacy();assert.equal(h.manager.needs.list({includeArchived:true}).length,1);
    await h.e.archives.need(String(need.number),false);assert.equal(h.native.get(older).archived,false);assert.equal(h.manager.needs.lookup(String(need.number)).title,'保留标题');assert.equal(h.s.config.activeNeed,'');
    await h.manager.switchTo(String(need.number));assert.equal(h.s.config.coordinator,newer);
    await h.e.archives.need(String(need.number),true);h.e.adapter.scan=async()=>({peer:h.s.config.owner,messages:[]});await h.e.arm(true);assert.equal(h.s.config.enabled,true);
    const route=await h.manager.prepare({id:'fresh',kind:'text',text:'独立新需求',created:Date.now()});assert.notEqual(route.needId,need.id);assert.ok(route.threadId);
  }finally{h.s.close();}
});
test('归档结果不明时不重复 RPC；恢复核对后允许新的明确归档',async()=>{
  const h=fixture();try{
    const n=await h.manager.create('核对归档'),request=h.c.request;let submissions=0;
    h.c.request=async(method,p)=>{if(method==='thread/archive'){submissions++;throw Object.assign(new Error('connection lost'),{uncertain:true});}return request(method,p);};
    await assert.rejects(h.e.archives.need(n.id,true),/connection lost/);assert.equal(h.s.archiveRecord('need',n.id).state,'attention');assert.equal(h.manager.state().needs.length,1);assert.equal(h.manager.needs.directory().length,0);
    await assert.rejects(h.e.archives.need(n.id,true),/仍需核实/);assert.equal(submissions,1);
    await h.e.archives.need(n.id,false);h.c.request=request;await h.e.archives.need(n.id,true);assert.equal(h.native.get(n.thread).archived,true);
  }finally{h.s.close();}
});
test('运行中的需求拒绝原生归档；已归档排队工作不会在异步提交边界恢复执行',async()=>{
  const h=fixture();try{
    const n=await h.manager.create('运行需求');h.native.get(n.thread).status={type:'active'};await assert.rejects(h.e.archives.need(n.id,true),/仍在运行/);assert.equal(h.s.archiveRecord('need',n.id),undefined);
    h.native.get(n.thread).status={type:'idle'};const m=h.message('排队的任务'),op=h.e.progress.get(m.id),target=await h.c.createCoordinator();const task=h.s.createTask('网站',target,'指令',{operationId:m.id,needId:n.id});
    h.e.archives.archiveTask(String(op.number));assert.equal(h.s.pendingMessages().length,0);assert.equal(h.s.queuedTasks().length,0);assert.throws(()=>h.e.assertNotArchived(m.id,{taskId:task}),e=>e.notSubmitted&&e.code==='ARCHIVED_TASK');
    assert.throws(()=>h.e.progress.retry(String(op.number)),/先 \/恢复任务/);h.e.archives.restoreTask(String(op.number));assert.equal(h.s.pendingMessages().length,0);assert.equal(h.s.queuedTasks().length,0);
    h.e.progress.retry(String(op.number));assert.equal(h.s.pendingMessages().length,1);
  }finally{h.s.close();}
});
test('手动归档正在执行或结果不明的任务只收起卡片，不重跑或丢失现场',async()=>{
  const h=fixture();try{
    const m=h.message('执行任务'),target=await h.c.createCoordinator(),task=h.s.createTask('网站',target,'指令',{operationId:m.id});
    h.s.taskStatus(task,'running','','real-turn');h.e.progress.stage(m.id,'执行目标','',{running:true,submitted:true,thread:target,turn:'real-turn'});h.e.archives.archiveTask(m.id);
    assert.equal(h.e.progress.open().length,0);assert.equal(h.e.progress.open({includeArchived:true}).length,1);assert.equal(h.e.progress.tasks(m.id)[0].status,'running');
    h.s.taskStatus(task,'uncertain','断线');h.e.progress.finish(m.id,'uncertain');h.e.archives.restoreTask(m.id);assert.throws(()=>h.e.progress.retry('1'),/需先核实/);assert.equal(h.s.queuedTasks().length,0);
  }finally{h.s.close();}
});
test('完成且全部分段送达才自动归档；状态筛选可找回，手动恢复不会被重启再次收起',async()=>{
  const h=fixture(),root=h.s.root;try{
    const m=h.message('完成任务');h.e.progress.stage(m.id,'生成结果','',{running:true});h.e.reply('结果',{operationId:m.id});h.s.messageStatus(m.id,'done');h.e.progress.finish(m.id);
    assert.equal(h.s.isArchived('task',m.id),false);const reply=h.e.progress.resultParts(m.id).rows[0];h.s.delivery(reply.id,'sent');h.e.progress.sync(m.id);
    assert.equal(h.s.isArchived('task',m.id),true);assert.equal(h.e.progress.cards().length,0);assert.equal(h.e.progress.cards({scope:'all',status:'done'})[0].number,1);
    h.e.archives.restoreTask('1');assert.equal(h.e.progress.cards()[0].id,m.id);h.s.close();const fresh=fixture(root);try{assert.equal(fresh.s.isArchived('task',m.id),false);assert.equal(fresh.e.progress.get(m.id).status,'done');}finally{fresh.s.close();}
  }finally{if(h.s.db.isOpen)h.s.close();}
});
test('学习资料归档保留原片笔记和原需求引用；恢复不改变记录',async()=>{
  const h=fixture();try{
    const n=await h.manager.create('视频资料'),path=join(h.s.root,'evidence.md');writeFileSync(path,'完整视觉证据');h.s.addKnowledge({id:'vid',title:'参考视频',transcript:'口播',summary:'观察',path});h.manager.needs.attach(n.id,'vid');
    h.e.archives.knowledge('vid',true);assert.equal(h.s.knowledgeList().length,0);assert.equal(h.s.knowledgeList({scope:'archived'}).length,1);assert.equal(h.manager.needs.knowledge(n.id)[0].id,'vid');assert.equal(readFileSync(path,'utf8'),'完整视觉证据');h.e.archives.knowledge('vid',false);assert.equal(h.s.knowledgeList()[0].title,'参考视频');
  }finally{h.s.close();}
});
test('配置首次保存折叠；手动展开优先并跨重启保留，未配置卡片保持展开',()=>{
  const h=fixture(),root=h.s.root;try{
    assert.equal(!!h.s.config.uiPanels.setup,false);configurePanel(h.s,'model');configurePanel(h.s,'targets');configurePanel(h.s,'setup');assert.deepEqual(h.s.config.uiPanels,{model:true,targets:true,setup:true});
    updatePanels(h.s,{model:false,targets:false});configurePanel(h.s,'model');configurePanel(h.s,'targets');assert.equal(h.s.config.uiPanels.model,false);assert.throws(()=>updatePanels(h.s,{bogus:true}),/无效/);
    h.s.close();const restored=fixture(root);try{assert.equal(restored.s.config.uiPanels.model,false);assert.equal(restored.s.config.uiPanels.setup,true);}finally{restored.s.close();}
  }finally{if(h.s.db.isOpen)h.s.close();}
});
test('归档命令指明对象；快捷链接只使用实际合法 Codex 聊天 ID',async()=>{
  for(const [cmd,name] of [['/归档需求 2','archive_need'],['/恢复需求 2','restore_need'],['/归档任务 3','archive_task'],['/恢复任务 3','restore_task']])assert.equal(parseCommand(cmd).name,name);
  assert.equal(parseCommand('/归档 2').name,'unknown');assert.equal(codexThreadUrl('javascript:alert(1)'),null);
  const h=fixture();try{
    const n=await h.manager.create('带链接需求'),m=h.message('派发任务'),target=await h.c.createCoordinator();h.s.createTask('目标项目',target,'指令',{operationId:m.id});
    const card=h.e.progress.cards()[0];assert.ok(card.links.some(l=>l.url===codexThreadUrl(target)));assert.ok(card.links.some(l=>l.url===codexThreadUrl(n.thread)));
    const follow=h.message('补充修改');h.e.progress.db.prepare('UPDATE operations SET parent=? WHERE id=?').run(m.id,follow.id);assert.ok(h.e.progress.cards().find(w=>w.id===follow.id).links.some(l=>l.url===codexThreadUrl(target)&&l.label.startsWith('原任务目标')));
    assert.match(await h.e.handleSettingCommand(parseCommand('/归档任务 1')),/已归档/);assert.match(await h.e.handleSettingCommand(parseCommand('/恢复任务 1')),/已恢复/);assert.equal(h.s.queuedTasks().length,0);
  }finally{h.s.close();}
});
