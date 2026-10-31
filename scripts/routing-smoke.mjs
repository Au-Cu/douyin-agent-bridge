import assert from 'node:assert/strict';import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {CodexClient} from '../src/codex.mjs';import {Preferences} from '../src/preferences.mjs';import {Conversations} from '../src/conversations.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));await mkdir(join(project,'data','test-runs'),{recursive:true});
const root=await mkdtemp(join(project,'data','test-runs','routing-live-')),store=new Store(root),codex=new CodexClient({cwd:project});
// Even the worker chats are ephemeral in this synthetic acceptance run.
const create=codex.createCoordinator.bind(codex);codex.createCoordinator=(tools,_ephemeral,options)=>create(tools,true,options);
const preferences=new Preferences({store,codex}),manager=new Conversations({store,codex,preferences});
const report={syntheticFixtures:true,realDouyinMessaged:false,realProjectChatsMessaged:false,actions:[],passed:false};
const message=(id,text)=>({id,kind:'text',text,created:Date.now()});
const learning=(id,title,observations)=>({id,title,path:join(root,id,'note.md'),transcript:'合成参考口播',seconds:10,visual:{status:'complete',fps:4,notes:observations,segments:[{start:0,end:10,text:observations}]}});
try{
  const settings=await preferences.light();store.saveConfig({model:settings.model,reasoningEffort:settings.effort});report.model=settings.model;
  const first=message('case-1','我要做一个宠物领养网站。主色绿色，不得使用红色，预算 2000 元。验收标识为 P7K-4826。');
  const a=await manager.prepare(first);assert.equal(a.action,'new');report.actions.push(a.action);manager.record(first.id,'已确认主色、禁用颜色、预算和验收标识。');await manager.refreshMemory(a.needId);
  const facts=JSON.stringify(manager.needs.get(a.needId).memory);assert.match(facts,/绿色/);assert.match(facts,/红色/);assert.match(facts,/2000/);
  const video=learning('9000000000000000011','宠物领养网站的申请页面参考','申请表按绿色卡片展示，选择宠物后底部出现确认按钮，切换页面有抽屉过渡。');
  const b=await manager.prepare({...message('case-2',''),kind:'video',awemeId:video.id,title:video.title},{learned:video});assert.equal(b.needId,a.needId);assert.equal(b.action,'continue');report.actions.push(b.action);manager.record('case-2','这段视频作为同一网站的补充视觉参考。');await manager.refreshMemory(a.needId);
  const cooking=learning('9000000000000000012','红烧牛肉烹饪步骤','锅内翻炒牛肉后加入调料炖煮，最后盛入碗中，与网站界面无关。');
  const c=await manager.prepare({...message('case-3',''),kind:'video',awemeId:cooking.id,title:cooking.title},{learned:cooking});assert.notEqual(c.needId,a.needId);assert.equal(c.action,'new');report.actions.push(c.action);manager.record('case-3','另一个独立的烹饪学习需求。');await manager.refreshMemory(c.needId);
  const d=await manager.prepare(message('case-4','继续之前那个宠物领养网站，调整首页留白'));assert.equal(d.action,'recall');assert.equal(d.needId,a.needId);report.actions.push(d.action);
  const ambiguous=await manager.prepare(message('case-5','请继续昨天的某个网站，昨天有两个网站需求，我记不清要继续哪一个，需要先确认。'));assert.equal(ambiguous.clarify,true);report.actions.push('clarify');
  // Force an incomplete summary: the new chat must recover exact source facts.
  manager.record('case-4','尚未开始修改，等待确认。');store.db.prepare('UPDATE needs SET summary_version=0 WHERE id=?').run(a.needId);
  const isolated=codex.runEphemeral.bind(codex);codex.runEphemeral=async(input,options)=>{if(options.role==='memory')throw new Error('Synthetic unavailable summary');return isolated(input,options);};
  const next=await manager.rollover(manager.needs.get(a.needId));const question=message('fact-check','主色、禁用颜色、预算和验收标识分别是什么？只回答这些信息，不执行项目任务。');
  const prepared=await manager.prepareInput({needId:a.needId,threadId:next.thread,historyPath:manager.needs.history(a.needId),action:'continue'},[{type:'text',text:'主人指示：'+question.text+'\n允许派发：否'}],question);
  const answer=await codex.run(prepared.route.threadId,prepared.input,{resume:false,assistant:true,...await preferences.work(),timeoutMs:90000});
  assert.match(answer.text,/绿色/);assert.match(answer.text,/红色/);assert.match(answer.text,/2000/);assert.match(answer.text,/P7K-4826/);report.sourceFactsRecoveredAfterHandoff=true;
  const catalog=await preferences.catalog(),model=catalog.models.find(m=>m.model===settings.model),tier=model.serviceTiers.find(t=>/fast/i.test(t.name)||['priority','fast'].includes(t.id));
  if(tier){const id=await create([],true,{model:model.model,serviceTier:tier.id});const result=await codex.run(id,[{type:'text',text:'This is an isolated connectivity check. Reply with exactly BRIDGE_FAST_OK. Do not call tools or modify files.'}],{resume:false,model:model.model,effort:settings.effort,serviceTier:tier.id,timeoutMs:90000});assert.match(result.text,/BRIDGE_FAST_OK/);report.fastTierAccepted=tier.id;}
  report.passed=true;console.log(JSON.stringify(report,null,2));
}catch(e){report.error=e.message;console.error('Routing/source-fact acceptance failed: '+e.message);process.exitCode=1;}
finally{await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));codex.close();store.close();}
