import {Needs,memoryText} from './needs.mjs';
import {coordinatorTools} from './codex.mjs';
import {assistantInstructions} from './prompts.mjs';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {authFailure} from './codex-auth.mjs';
const schema=(properties)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string'},strings={type:'array',items:str};
export const routeSchema=schema({action:{type:'string',enum:['continue','new','recall','clarify']},needId:str,title:str,reason:str,question:str});
export const memorySchema=schema({title:str,goal:str,constraints:strings,decisions:strings,pending:strings,progress:str});
const parse=text=>{try{return JSON.parse(text);}catch{throw new Error('需求判断未返回有效结果，暂不执行；可用 /新建 或 /切换 明确指定。');}};
export const tokenEstimate=text=>Buffer.byteLength(String(text||''),'utf8');
export function validMemory(m){return !!m&&['title','goal','progress'].every(k=>typeof m[k]==='string')&&['constraints','decisions','pending'].every(k=>Array.isArray(m[k])&&m[k].every(s=>typeof s==='string'))&&JSON.stringify(m).length<=6000;}

export class Conversations{
  constructor({store,codex,preferences}){
    Object.assign(this,{store,codex,preferences});this.needs=new Needs(store);
    codex.on('notification',m=>{if(m.method==='thread/tokenUsage/updated'){const u=m.params.tokenUsage;this.needs.usage(m.params.threadId,Number(u?.last?.totalTokens||0),Number(u?.modelContextWindow||0));}});
  }
  capture(){return {needId:this.store.config.activeNeed,epoch:this.store.config.needEpoch||0,recent:this.needs.recent(null,4).map(r=>({owner:r.owner_text.slice(0,500),assistant:r.reply.slice(0,700)}))};}
  async lightCall(role,payload,outputSchema){
    const input=[{type:'text',text:JSON.stringify(payload)}],settings=await this.preferences.light();
    try{return await this.codex.runEphemeral(input,{role,...settings,outputSchema,timeoutMs:60000,interruptOnTimeout:true});}
    catch(e){
      if(authFailure(e)||!/model.*(?:not|unavailable|unsupported|access|context)|(?:access|supported).*model/i.test(e.message))throw e;
      const fallback=await this.preferences.light(true);if(fallback.model===settings.model)throw e;
      this.store.event('轻量模型暂不可用，改用当前工作模型的低强度临时会话','attention');
      return this.codex.runEphemeral(input,{role,...fallback,outputSchema,timeoutMs:60000,interruptOnTimeout:true});
    }
  }
  async ensureLegacy(){
    if(this.initializing)return this.initializing;
    this.initializing=this.initializeLegacy().finally(()=>{this.initializing=null;});return this.initializing;
  }
  async initializeLegacy(){
    if(this.needs.list().length)return;
    if(!this.store.config.coordinator)return;
    const n=this.needs.create('历史对话',this.store.config.coordinator);
    const rows=this.store.db.prepare("SELECT * FROM messages WHERE status='done' ORDER BY created DESC LIMIT 6").all().reverse();
    for(const row of rows){const m=JSON.parse(row.body);if(m.kind==='text'&&m.text?.startsWith('/'))continue;this.needs.reserve(m,n);this.needs.complete(m.id,row.result||'历史回复请查原会话');}
    for(const k of this.store.search('',1000))this.needs.attach(n.id,k.id);
    if(rows.length){
      const bridgeMessages=this.store.db.prepare('SELECT * FROM messages ORDER BY created').all(),tasks=this.store.db.prepare('SELECT * FROM tasks ORDER BY created').all();
      let history=null;try{history=await this.codex.request('thread/read',{threadId:n.thread,includeTurns:true});}catch(e){this.store.event('旧会话导出暂不可用，旧聊天仍保留，可重新连接后读取','attention');}
      this.needs.json(n.id,'legacy-thread.json',{thread:history,bridgeMessages,tasks,notice:'旧对话的简短摘要只覆盖最近交流，较早要求须查本记录。历史待办不构成重做授权。'});
      this.needs.usage(n.thread,this.store.config.contextBudget);await this.refreshMemory(n.id);
    }
    this.needs.activate(n.id);
  }
  async create(title='新需求',{activate=true}={}){
    const settings=await this.preferences.work(),n=this.needs.create(String(title||'新需求').slice(0,60));
    const thread=await this.codex.createCoordinator(coordinatorTools,false,{name:'抖音 · '+n.title,...settings});
    const result=this.needs.bindThread(n.id,thread);if(activate)this.needs.activate(n.id);return result;
  }
  async switchTo(id){await this.ensureLegacy();const n=this.needs.lookup(id);if(!n.thread)throw new Error('该需求尚未完成会话创建，请重新新建需求。');this.needs.activate(n.id);return n;}
  resolveWaiting(need){
    const waiting=this.store.db.prepare("SELECT * FROM messages WHERE status='waiting_route' AND created>? ORDER BY created DESC LIMIT 1").get(Date.now()-30*60*1000);
    if(waiting){this.needs.saveRoute(waiting.id,need,'recall','用户明确选择需求');this.store.messageStatus(waiting.id,'new');}
    return !!waiting;
  }
  async prepare(message,{learned,capture=this.capture()}={}){
    await this.ensureLegacy();
    const saved=this.needs.route(message.id);
    if(saved){const n=this.needs.get(saved.need_id);this.needs.attach(n.id,learned?.id);return this.ready(message,n,saved.action,saved.reason);}
    const current=this.needs.get(capture.needId||this.store.config.activeNeed),directory=this.needs.directory(message.text||message.title||'');
    let decision={action:'continue',needId:current?.id||'',title:current?.title||'新需求',reason:'自动分聊已关闭'};
    if(this.store.config.autoRoute){
      const segments=learned?.visual?.segments||[];
      const indices=Array.from({length:Math.min(20,segments.length)},(_,i)=>Math.round(i*(segments.length-1)/Math.max(1,Math.min(20,segments.length)-1)));
      const newMessage=message.kind==='video'?{kind:'video',title:learned?.title||message.title,videoId:message.awemeId,visualCoverage:learned?.visual?{status:learned.visual.status,seconds:learned.seconds,fps:learned.visual.fps}:null,observedContent:indices.length?indices.map(i=>({start:segments[i].start,end:segments[i].end,observation:segments[i].text.slice(0,160)})):learned?.visual?.notes?.slice(0,2200),narration:learned?.transcript?.slice(0,500)}:{kind:'text',text:message.text};
      const payload={newMessage,recentExchanges:capture.recent,currentNeed:current?{id:current.id,title:current.title,summary:memoryText(current.memory).slice(0,1800),summaryIncomplete:current.version!==current.summary_version}:null,needDirectory:directory};
      const result=await this.lightCall('router',payload,routeSchema);
      decision=parse(result.text);
      if(!['continue','new','recall','clarify'].includes(decision.action))throw new Error('需求路由类型无效，暂不执行。');
      if(decision.action==='clarify')return {clarify:true,question:String(decision.question||'请用 /切换 需求ID 指定要继续的需求，或 /新建 标题 开始独立需求。').slice(0,350)};
      if(decision.action==='recall'&&!directory.some(n=>n.id===decision.needId))throw new Error('路由未定位到有效的旧需求，暂不执行，请用 /找 核对。');
      if(decision.action==='continue'&&decision.needId&&decision.needId!==current?.id)throw new Error('路由的继续目标与当前需求不一致，暂不执行。');
    }
    let need=decision.action==='recall'?this.needs.get(decision.needId):current;
    if(decision.action==='new'||!need){
      if(need&&need.version===0&&!this.needs.knowledge(need.id).length){this.needs.rename(need.id,decision.title||'新需求');need=this.needs.get(need.id);}
      else need=await this.create(decision.title||message.title||'新需求',{activate:false});
    }
    if((this.store.config.needEpoch||0)===capture.epoch||!this.store.config.activeNeed)this.needs.activate(need.id);
    this.needs.attach(need.id,learned?.id);this.needs.saveRoute(message.id,need,decision.action,decision.reason||'');
    this.store.event(`需求路由：${decision.action} → ${need.title.slice(0,40)} (${need.id})`);
    return this.ready(message,need,decision.action,decision.reason);
  }
  async ready(message,need,action,reason){
    const bytes=tokenEstimate(message.text||message.title||'')+1500;
    const budget=Math.min(this.store.config.contextBudget,need.model_window?Math.floor(need.model_window*.8):Infinity);
    if(need.context_tokens+bytes>budget)need=await this.rollover(need);
    this.needs.reserve(message,need);return {needId:need.id,threadId:need.thread,action,reason,memory:need.memory,historyPath:this.needs.history(need.id)};
  }
  async prepareInput(route,input,message){
    let n=this.needs.get(route.needId),context={type:'text',text:'当前需求记录：'+JSON.stringify(this.context(route))};
    const budget=Math.min(this.store.config.contextBudget,n.model_window?Math.floor(n.model_window*.8):Infinity),reserve=Math.min(4000,Math.floor(budget*.15));
    let outgoing=[context,...input],size=tokenEstimate(JSON.stringify(outgoing))+tokenEstimate(assistantInstructions);
    if(n.context_tokens>0&&n.context_tokens+size+reserve>budget){n=await this.rollover(n);route={...route,threadId:n.thread};context={type:'text',text:'当前需求交接：'+JSON.stringify(this.context(route))};outgoing=[context,...input];size=tokenEstimate(JSON.stringify(outgoing))+tokenEstimate(assistantInstructions);}
    if(size+reserve>budget){
      const path=this.needs.json(n.id,'input-'+message.id.replace(/[^\w-]/g,'').slice(-80)+'.json',{ownerMessage:message,input});
      outgoing=[{type:'text',text:`本轮完整用户指示和资料位于 ${path}。请先读取完整指示再处理，不得根据摘要猜测。\n需求 ID：${n.id}；完整交接记录：${this.needs.history(n.id)}。`}];
    }
    this.store.db.prepare('UPDATE need_turns SET thread=? WHERE message_id=?').run(n.thread,message.id);
    this.needs.saveRoute(message.id,n,route.action,route.reason||'');
    return {route,input:outgoing,inputTokens:tokenEstimate(JSON.stringify(outgoing))+tokenEstimate(assistantInstructions)};
  }
  async rollover(need){
    if(need.version!==need.summary_version)await this.refreshMemory(need.id);
    need=this.needs.get(need.id);const history=this.needs.history(need.id);
    const references=this.needs.knowledge(need.id,'',1000).map(k=>({id:k.id,title:k.title,path:k.path}));
    const handoff=this.needs.json(need.id,`handoff-${need.seq+1}.json`,{needId:need.id,previousThread:need.thread,memory:need.memory,summaryIncomplete:need.version!==need.summary_version,historyPath:history,legacyHistoryPath:this.needs.root+'/'+need.id+'/legacy-thread.json',references});
    const thread=await this.codex.createCoordinator(coordinatorTools,false,{name:`抖音 · ${need.title} · ${need.seq+1}`,...await this.preferences.work()});
    const next=this.needs.bindThread(need.id,thread,handoff);await this.codex.request('thread/unsubscribe',{threadId:need.thread},5000).catch(()=>{});this.store.event('上下文预算触发交接：'+need.title.slice(0,40));return next;
  }
  context(route){const n=this.needs.get(route.needId),thread=this.store.db.prepare('SELECT handoff FROM need_threads WHERE thread=?').get(n.thread),legacy=join(this.needs.root,n.id,'legacy-thread.json'),hasOperations=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operations'").get(),requests=hasOperations?this.store.db.prepare("SELECT number,title,status,phase FROM operations WHERE need_id=? AND kind<>'control' AND status<>'merged' ORDER BY number DESC LIMIT 8").all(n.id):[];return {needId:n.id,needNumber:n.number,title:n.title,memory:n.memory,summaryIncomplete:n.version!==n.summary_version,historyPath:route.historyPath,handoffPath:thread?.handoff||undefined,requests,tasks:this.needs.taskState(n.id).map(t=>({...t,result:t.result.slice(0,1000)})),...(existsSync(legacy)?{legacyHistoryPath:legacy,legacySummaryScope:'较早要求请核对完整历史记录'}:{})};}
  related(id,query='',limit=6){return this.needs.knowledge(id,query,limit);}
  record(messageId,reply,usage,inputTokens=0){
    const n=this.needs.complete(messageId,reply);if(!n)return;
    const row=this.store.db.prepare('SELECT * FROM need_turns WHERE message_id=?').get(messageId);
    if(usage?.last?.totalTokens)this.needs.usage(row.thread,usage.last.totalTokens,usage.modelContextWindow);
    else this.needs.estimate(n.id,(inputTokens||tokenEstimate(row.owner_text))+tokenEstimate(reply)+800);
    this.needs.history(n.id);return n.id;
  }
  async refreshMemory(id){
    try{for(let batch=0;batch<12;batch++){
      const n=this.needs.get(id),recent=this.store.db.prepare('SELECT * FROM need_turns WHERE need_id=? AND revision>? ORDER BY revision LIMIT 3').all(id,n.summary_version);if(!recent.length)return;
      const payload={previous:n.memory,exchanges:recent.map(r=>({owner:r.owner_text,assistant:r.reply,status:r.status})),references:this.related(id,'',12).map(k=>({id:k.id,title:k.title,path:k.path}))};
      const result=await this.lightCall('memory',payload,memorySchema);const memory=parse(result.text);if(!validMemory(memory))throw new Error('交接摘要格式或长度无效');
      if(!this.needs.saveMemory(id,memory,recent.at(-1).revision,n.version))return;
    }}
    catch(e){this.store.event('需求摘要未更新，完整原文已保留，续接时会标记待核对','attention');}
  }
  async resumeRoute(message,learned){
    await this.ensureLegacy();const saved=this.needs.route(message.id);
    let need=saved?this.needs.get(saved.need_id):null;
    if(!need){const refs=this.store.db.prepare('SELECT need_id FROM need_assets WHERE video_id=?').all(learned.id);if(refs.length===1)need=this.needs.get(refs[0].need_id);}
    if(need){this.needs.saveRoute(message.id,need,'continue','继续已保存视频');return this.ready(message,need,'continue','继续已保存视频');}
    return this.prepare(message,{learned});
  }
  state(){return this.needs.state();}
}
