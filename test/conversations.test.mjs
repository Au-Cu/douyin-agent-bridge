import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {Preferences} from '../src/preferences.mjs';import {Conversations} from '../src/conversations.mjs';import {BridgeEngine} from '../src/engine.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const catalog={defaults:{model:'test-sol',effort:'max'},models:[{id:'test-sol',model:'test-sol',displayName:'Test Sol',defaultReasoningEffort:'low',inputModalities:['text','image'],supportedReasoningEfforts:['low','max'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]},{id:'test-luna',model:'test-luna',displayName:'Test Luna',defaultReasoningEffort:'low',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[]}]};
function setup(existingRoot){
  const store=new Store(existingRoot||mkdtempSync(join(base,'needs-')));store.saveConfig({enabled:true,owner:{chatKey:'owner-chat'},targets:[{id:'project-chat',alias:'网站'}]});
  const codex=new EventEmitter();codex.calls=[];codex.decisions=[];codex.threads=[];codex.models=async()=>catalog;codex.ensureAuthenticated=async()=>{};codex.authState={status:'ready'};
  codex.createCoordinator=async(tools,ephemeral,options)=>{const id='need-thread-'+(codex.threads.length+1);codex.threads.push({id,tools,ephemeral,options});return id;};
  codex.request=async()=>({thread:{status:{type:'idle'},turns:[{type:'fixture-history'}]}});
  codex.runEphemeral=async(input,options)=>{
    const payload=JSON.parse(input[0].text);codex.calls.push({payload,options});
    if(options.role==='router'){const decision=codex.decisions.shift();if(!decision)throw new Error('fixture missing route');return {text:JSON.stringify(decision)};}
    if(codex.failMemory)throw new Error('fixture summary unavailable');
    const previous=payload.previous;return {text:JSON.stringify({...previous,title:previous.title||'网站',goal:previous.goal||payload.exchanges[0]?.owner||'',constraints:[...new Set([...(previous.constraints||[]),...payload.exchanges.filter(e=>e.owner.includes('不得')).map(e=>e.owner)])],progress:payload.exchanges.at(-1)?.assistant||previous.progress})};
  };
  codex.run=async(thread,input,options)=>{codex.calls.push({thread,input,options});return {text:'实际回复',turnId:'fixture-turn'};};
  const preferences=new Preferences({store,codex}),manager=new Conversations({store,codex,preferences});
  return {store,codex,preferences,manager};
}
const decision=(action,needId='',title='独立网站')=>({action,needId,title,reason:'合成路由依据',question:''});
const text=(id,value)=>({id,peer:'owner-chat',kind:'text',text:value,created:Date.now()});
function video(h,id,title){
  const folder=join(h.store.root,'knowledge',id);mkdirSync(folder,{recursive:true});const learned={id,title,path:join(folder,'note.md'),seconds:10,transcript:'引用口播',visual:{status:'complete',fps:4,notes:'完整视觉事实',segments:[{start:0,end:5,text:'网站首页布局'},{start:5,end:10,text:'页面过渡效果'}]}};
  writeFileSync(learned.path,'原始完整笔记');h.store.addKnowledge(learned);return learned;
}

test('文本新需求、补充视频、独立视频、找回旧需求分别路由，临时判定只收到四项轻量输入',async()=>{
  const h=setup();try{
    const a=text('msg-a','做一个网站，不得使用红色');h.codex.decisions.push(decision('new'));let route=await h.manager.prepare(a);const website=route.needId;
    h.manager.record(a.id,'已确认使用绿色');await h.manager.refreshMemory(website);
    const learned=video(h,'9000000000000000001','网站过渡参考'),v={...text('msg-video',''),kind:'video',awemeId:learned.id,title:learned.title};
    h.codex.decisions.push(decision('continue',website));route=await h.manager.prepare(v,{learned});assert.equal(route.needId,website);
    h.manager.record(v.id,'补充同一网站的过渡效果');await h.manager.refreshMemory(website);
    const cooking=video(h,'9000000000000000002','独立烹饪演示'),b={...v,id:'msg-other',awemeId:cooking.id,title:cooking.title};
    h.codex.decisions.push(decision('new','','烹饪需求'));const separate=await h.manager.prepare(b,{learned:cooking});assert.notEqual(separate.needId,website);
    h.manager.record(b.id,'学习烹饪参考');await h.manager.refreshMemory(separate.needId);
    h.codex.decisions.push(decision('recall',website));const recalled=await h.manager.prepare(text('msg-recall','继续昨天那个网站'));assert.equal(recalled.needId,website);assert.equal(h.store.config.activeNeed,website);
    assert.deepEqual(h.manager.related(website).map(k=>k.id),[learned.id]);assert.deepEqual(h.manager.related(separate.needId).map(k=>k.id),[cooking.id]);
    const routes=h.codex.calls.filter(c=>c.options.role==='router');assert.equal(routes.length,4);
    for(const c of routes){assert.deepEqual(Object.keys(c.payload),['newMessage','recentExchanges','currentNeed','needDirectory']);assert.equal(c.options.effort,'low');assert.equal(c.options.serviceTier,'default');assert.equal(c.options.role,'router');assert.ok(!('transcript'in c.payload));}
    assert.equal(h.codex.threads.length,2);assert.equal(routes[1].payload.newMessage.observedContent.at(-1).end,10);
  }finally{h.store.close();}
});

test('关闭自动分聊仍按预算换新会话，交接保留主人约束及完整历史入口',async()=>{
  const h=setup();try{
    const n=await h.manager.create('网站');h.store.saveConfig({autoRoute:false,contextBudget:4000});
    const first=text('first','不得使用红色；保留原有导航');await h.manager.prepare(first);h.manager.record(first.id,'已确认约束');await h.manager.refreshMemory(n.id);
    const old=h.manager.needs.get(n.id).thread;h.manager.needs.usage(old,3900);
    const route=await h.manager.prepare(text('next','继续调整间距'));assert.equal(route.needId,n.id);assert.notEqual(route.threadId,old);assert.equal(h.codex.calls.filter(c=>c.options.role==='router').length,0);
    const handoff=JSON.parse(readFileSync(h.store.db.prepare('SELECT handoff FROM need_threads WHERE thread=?').get(route.threadId).handoff,'utf8'));
    assert.ok(handoff.memory.constraints.some(s=>s.includes('不得使用红色')));assert.equal(handoff.summaryIncomplete,false);assert.ok(existsSync(handoff.historyPath));assert.match(readFileSync(handoff.historyPath,'utf8'),/保留原有导航/);
    assert.equal(h.store.config.coordinator,route.threadId);
  }finally{h.store.close();}
});

test('摘要失败不冒充完整；超长输入落盘保留尾部要求并强制给出完整读取入口',async()=>{
  const h=setup();try{
    const n=await h.manager.create('长需求');h.store.saveConfig({autoRoute:false,contextBudget:4000});
    const msg=text('long-input','要求'.repeat(3000)+'最后一项：不得删除原始资料');const route=await h.manager.prepare(msg);
    const prepared=await h.manager.prepareInput(route,[{type:'text',text:msg.text}],msg);assert.match(prepared.input[0].text,/先读取完整指示/);
    const full=JSON.parse(readFileSync(join(h.manager.needs.root,n.id,'input-long-input.json'),'utf8'));assert.ok(full.ownerMessage.text.endsWith('不得删除原始资料'));
    h.manager.record(msg.id,'这轮结果');h.codex.failMemory=true;await h.manager.refreshMemory(n.id);const next=await h.manager.rollover(h.manager.needs.get(n.id));
    const p=h.store.db.prepare('SELECT handoff FROM need_threads WHERE thread=?').get(next.thread).handoff;const handoff=JSON.parse(readFileSync(p,'utf8'));assert.equal(handoff.summaryIncomplete,true);assert.match(readFileSync(handoff.historyPath,'utf8'),/不得删除原始资料/);
  }finally{h.store.close();}
});

test('路由找不到确切旧需求时停止，不向不存在的会话或执行目标提交任务',async()=>{
  const h=setup();try{
    await h.manager.create('网站');h.codex.decisions.push(decision('recall','invented-id'));
    await assert.rejects(h.manager.prepare(text('bad-recall','继续那个项目')),/有效的旧需求/);assert.equal(h.codex.calls.filter(c=>c.thread).length,0);
    h.codex.decisions.push({...decision('clarify'),question:'是网站甲还是网站乙？'});const route=await h.manager.prepare(text('ambiguous','继续那个网站'));assert.equal(route.clarify,true);assert.match(route.question,/网站甲/);
    assert.equal(h.store.queuedTasks().length,0);
  }finally{h.store.close();}
});

test('重启和登录恢复复用已保存的路由；不同需求的任务不会混入最近的其他视频',async()=>{
  const h=setup();const root=h.store.root;let website;
  try{
    const v=video(h,'9000000000000000003','网站参考');h.codex.decisions.push(decision('new'));const r=await h.manager.prepare({...text('stable-msg',''),kind:'video',awemeId:v.id,title:v.title},{learned:v});website=r.needId;
    const other=await h.manager.create('其他需求');const v2=video(h,'9000000000000000004','不相关原片');h.manager.needs.attach(other.id,v2.id);
    const engine=new BridgeEngine({store:h.store,codex:h.codex,adapter:{},media:{},preferences:h.preferences,conversations:h.manager});
    engine.dispatch('网站','按参考实现','交给网站',{needId:website});const task=h.store.queuedTasks()[0];assert.match(task.prompt,/9000000000000000003/);assert.doesNotMatch(task.prompt,/9000000000000000004/);assert.match(task.prompt,/needId/);
    assert.throws(()=>{h.store.saveConfig({targets:[{id:r.threadId,alias:'助手'}]});engine.dispatch('助手','做事','派给助手',{needId:website});},/助手会话/);
  }finally{h.store.close();}
  const fresh=setup(root);try{const r=await fresh.manager.prepare({...text('stable-msg',''),kind:'video',awemeId:'9000000000000000003'});assert.equal(r.needId,website);assert.equal(fresh.codex.calls.length,0);}finally{fresh.store.close();}
});

test('迁移旧长对话保留原始记录、目标名单和原视频，首次续做创建交接而不删除历史',async()=>{
  const h=setup();try{
    h.store.saveConfig({coordinator:'legacy-chat'});const old=text('old-message','网站不得使用红色');h.store.incoming(old);h.store.messageStatus(old.id,'done','已确认');video(h,'9000000000000000005','旧参考');
    await h.manager.ensureLegacy();const before=h.manager.needs.get(h.store.config.activeNeed);assert.equal(before.thread,'legacy-chat');assert.equal(h.store.config.targets[0].id,'project-chat');
    assert.match(readFileSync(join(h.manager.needs.root,before.id,'legacy-thread.json'),'utf8'),/网站不得使用红色/);
    h.store.saveConfig({autoRoute:false});const route=await h.manager.prepare(text('after-upgrade','继续上次的网站'));assert.notEqual(route.threadId,'legacy-chat');assert.equal(route.needId,before.id);assert.equal(h.manager.related(route.needId)[0].id,'9000000000000000005');
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM need_threads WHERE need_id=?').get(before.id).n,2);
  }finally{h.store.close();}
});

test('模型判断期间主人手动切换需求不会被迟到的自动路由覆盖，实际消息仍回到已捕获的需求',async()=>{
  const h=setup();try{
    const a=await h.manager.create('网站甲');const msg=text('in-flight','继续调整首页');const captured=h.manager.capture();
    const b=await h.manager.create('网站乙');h.codex.decisions.push(decision('continue',a.id));
    const routed=await h.manager.prepare(msg,{capture:captured});assert.equal(routed.needId,a.id);assert.equal(h.store.config.activeNeed,b.id);
    const waiting=text('waiting-video','请处理待选择需求');h.store.incoming(waiting);h.store.messageStatus(waiting.id,'waiting_route','请选需求');assert.equal(h.manager.resolveWaiting(b),true);assert.equal(h.store.pendingMessages()[0].id,waiting.id);
    assert.equal((await h.manager.prepare(waiting)).needId,b.id);
  }finally{h.store.close();}
});

test('抖音配置命令在分析忙时顺序保存，不调用路由模型，未知命令或含糊参数不变成任务',async()=>{
  const h=setup();try{
    const engine=new BridgeEngine({store:h.store,codex:h.codex,adapter:{},media:{},preferences:h.preferences,conversations:h.manager});engine.busy=true;
    const execute=async(value,id)=>{const m=text(id,value);h.store.incoming(m);assert.equal(engine.handleControl(m),true);await engine.controlTail;return h.store.db.prepare('SELECT status FROM messages WHERE id=?').get(id).status;};
    for(const [i,value] of ['/密度 8','/模型 test-sol','/强度 Max','/快 开','/分聊 关','/预算 18000','/设置','/帮助'].entries())assert.equal(await execute(value,'command-'+i),'done');
    assert.equal(h.store.config.visualFps,8);assert.equal(h.store.config.reasoningEffort,'max');assert.equal(h.store.config.fastMode,true);assert.equal(h.store.config.autoRoute,false);assert.equal(h.store.config.contextBudget,18000);
    assert.equal(await execute('/快 也许','bad-switch'),'failed');assert.equal(await execute('/同意','missing-id'),'failed');assert.equal(await execute('/状态 派任务','status-args'),'failed');assert.equal(await execute('/不认识','unknown-command'),'done');
    assert.equal(h.codex.calls.length,0);assert.equal(h.store.queuedTasks().length,0);assert.equal(engine.busy,true);
  }finally{h.store.close();}
});
