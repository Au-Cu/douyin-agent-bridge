import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolveCodexCommand } from './codex-command.mjs';
import {credentialRevision,defaultCodexHome,authFailure,authError} from './codex-auth.mjs';
import {assistantInstructions,instructionRevision,roleInstructions} from './prompts.mjs';
import {writerConflict} from './progress.mjs';
import {operationContext,checkWork,workSignal,raceWork,trackStop,interruptedError} from './execution.mjs';

export function approvalResponse(request,allow) {
  if(request.method==='item/permissions/requestApproval')return {permissions:allow?(request.params.permissions||{}):{},scope:'turn'};
  return {decision:allow?'accept':'decline'};
}

export class CodexClient extends EventEmitter {
  constructor({ cwd, executable=process.env.CODEX_BIN||'codex', spawnArgs=['app-server'], log=()=>{},codexHome=defaultCodexHome() }={}) {
    super(); Object.assign(this,{cwd,executable,spawnArgs,log,codexHome}); this.seq=0; this.pending=new Map(); this.runs=new Map(); this.early=new Map(); this.approvals=new Map();
    this.generation=0;this.ephemeral=new Map();this.profiles=new Map();this.loaded=new Set();this.threadLocks=new Map();this.interrupting=new Map();this.usage=new Map();this.auth={status:'unknown',message:''};
  }
  async connect() {
    if(this.closed)throw Object.assign(new Error('Codex 客户端已关闭'),{code:'CODEX_CLIENT_CLOSED'});
    if(this.connecting) return this.connecting;
    this.connecting=this.#ensureConnection().finally(()=>{this.connecting=null;}); return this.connecting;
  }
  async #ensureConnection(){
    const revision=await credentialRevision(this.codexHome),changed=this.loadedRevision!==undefined&&revision!==this.loadedRevision;
    if(this.closed)throw Object.assign(new Error('Codex 客户端已关闭'),{code:'CODEX_CLIENT_CLOSED'});
    if(this.ready&&!changed&&!this.needsReconnect)return;
    if(this.runs.size||this.pending.size)throw authError('pending');
    const recovered=this.generation>0&&(changed||this.needsReconnect);
    const old=this.proc;this.proc=null;this.ready=false;this.lines?.close();old?.kill();
    this.early.clear();this.approvals.clear();this.profiles.clear();this.loaded.clear();this.usage.clear();
    this.loadedRevision=revision;this.needsReconnect=false;
    try{
      await this.#connect();
      const result=await this.request('account/read',{refreshToken:false});
      this.auth=result.requiresOpenaiAuth===true&&result.account===null?{status:'login',message:authError().message}:{status:'ready',message:'已读取本机 Codex 登录'};
      if(recovered&&this.auth.status==='ready'){this.log('已重新连接本机 Codex，保留原聊天与视频进度');this.emit('auth-reconnected');}
    }catch(e){this.#disconnect(e);throw e;}
  }
  async ensureAuthenticated(){
    await this.connect();if(['login','quota'].includes(this.auth.status))throw authError(this.auth.status);
  }
  async reconnect(){
    this.needsReconnect=true;this.lastFallbackRevision=this.loadedRevision;
    if(this.runs.size||this.pending.size)return {deferred:true,auth:this.authState};
    await this.connect();return {deferred:false,auth:this.authState};
  }
  get authState(){return {...this.auth,reconnectPending:!!this.needsReconnect};}
  startAuthWatcher(intervalMs=3000){
    clearInterval(this.authTimer);
    this.authTimer=setInterval(()=>this.connect().catch(e=>{
      if(!['CODEX_AUTH_PENDING','CODEX_CLIENT_CLOSED'].includes(e.code)&&Date.now()-(this.lastAuthWarning||0)>60000){this.lastAuthWarning=Date.now();this.log('本机 Codex 暂未连接，可在重新登录后点“重新连接”','attention');}
    }),intervalMs);this.authTimer.unref();
  }
  #noteFailure(error){
    const kind=authFailure(error);if(!kind||kind==='pending')return error;
    error.authKind=kind;this.auth={status:kind,message:authError(kind).message};
    // One fallback reload per credential revision also covers OS-keyring logins.
    // Failed turns are never replayed here; only explicit read-only analysis may retry.
    if(kind==='login'&&this.lastFallbackRevision!==this.loadedRevision){this.lastFallbackRevision=this.loadedRevision;this.needsReconnect=true;}
    return error;
  }
  async #connect() {
    const command=resolveCodexCommand(this.executable);
    const proc=this.proc=spawn(command.executable,[...command.prefix,...this.spawnArgs],{cwd:this.cwd,env:{...process.env,CODEX_HOME:this.codexHome},windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.generation++;
    proc.on('error',e=>this.#disconnect(e,proc));
    proc.on('exit',()=>this.#disconnect(Object.assign(new Error('Codex 连接已关闭'),{uncertain:true}),proc));
    this.proc.stderr.on('data',()=>{}); // Do not copy auth diagnostics or credentials to app logs.
    this.lines=createInterface({input:this.proc.stdout});
    this.lines.on('line',line=>{if(proc!==this.proc)return;try { this.#receive(JSON.parse(line)).catch(e=>this.log('Codex 消息处理失败：'+e.message,'error')); } catch(e) { this.log('Codex 消息解析失败：'+e.message,'error'); } });
    await this.request('initialize',{clientInfo:{name:'douyin_codex_bridge',title:'抖音 Codex 助手',version:'0.7.0'},capabilities:{experimentalApi:true}},20000);
    this.send({method:'initialized'}); this.ready=true;
  }
  send(message) { if(!this.proc?.stdin?.writable) throw new Error('Codex 未连接'); this.proc.stdin.write(JSON.stringify(message)+'\n'); }
  request(method,params={},timeoutMs=30000) {
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id); reject(new Error(`${method} 超时`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method,threadId:params.threadId});
      try { this.send({id,method,params}); } catch(e) {clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  #disconnect(error,proc=this.proc) {
    if(proc!==this.proc)return;
    this.ready=false;
    this.loaded.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);} this.pending.clear();
    for(const r of this.runs.values()){clearTimeout(r.timer);r.turnReady?.resolve(null);r.completion?.resolve(null);r.reject(error);} this.runs.clear();
    this.approvals.clear();
    this.emit('disconnected',error);
  }
  async #receive(msg) {
    if(msg.id!==undefined&&!msg.method) {
      const p=this.pending.get(msg.id); if(!p)return;
      clearTimeout(p.timer);this.pending.delete(msg.id);
      if(!msg.error){if(['thread/start','thread/resume'].includes(p.method)&&(msg.result?.thread?.id||p.threadId))this.loaded.add(msg.result?.thread?.id||p.threadId);if(['thread/unsubscribe','thread/archive'].includes(p.method))this.loaded.delete(p.threadId);}
      msg.error?p.reject(this.#noteFailure(Object.assign(new Error(msg.error.message||JSON.stringify(msg.error)),{remote:true,code:msg.error.code,rpcMethod:p.method,notSubmitted:writerConflict(msg.error.message)&&['thread/resume','turn/start'].includes(p.method)}))):p.resolve(msg.result); return;
    }
    if(msg.id!==undefined&&msg.method) {
      if(msg.method==='item/tool/call') {
        try {
          const run=[...this.runs.values()].find(r=>r.threadId===msg.params.threadId);
          const call=()=>{checkWork();if(run?.cancelled)throw interruptedError();return run?.toolHandler?.(msg.params)||Promise.reject(new Error('此会话没有绑定可用工具'));};
          const result=await (run?.scope?operationContext.run(run.scope,call):call());
          const output=result&&Array.isArray(result.contentItems)?result:{success:true,contentItems:[{type:'inputText',text:typeof result==='string'?result:JSON.stringify(result)}]};
          this.send({id:msg.id,result:output});
        } catch(e) { this.send({id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:e.message}]}}); }
      } else if(/requestApproval$/.test(msg.method)) {
        if([...this.runs.values()].some(r=>r.threadId===msg.params?.threadId&&r.cancelled)){this.send({id:msg.id,result:approvalResponse(msg,false)});return;}
        const id=String(msg.id);this.approvals.set(id,msg);this.emit('approval',{id,method:msg.method,params:msg.params});
      } else if(msg.method==='item/tool/requestUserInput') {
        this.send({id:msg.id,error:{code:-32000,message:'请直接在 Codex 或抖音对话补充需求后继续；桥接不会自动代选用户答案。'}});
      } else this.send({id:msg.id,error:{code:-32601,message:'Unsupported client request'}});
      return;
    }
    if(msg.method==='item/completed'&&msg.params?.item?.type==='agentMessage') {
      const p=msg.params; const r=[...this.runs.values()].find(r=>r.threadId===p.threadId);
      if(r)r.text=p.item.text||r.text;
    }
    if(msg.method==='thread/tokenUsage/updated'){
      const p=msg.params;this.usage.set(p.threadId,{turnId:p.turnId,...p.tokenUsage});
      if(this.usage.size>256)this.usage.delete(this.usage.keys().next().value);
    }
    if(msg.method==='turn/completed') {
      const turn=msg.params?.turn;const r=this.runs.get(turn?.id);
      if(!r){this.early.set(turn?.id,msg.params); if(this.early.size>30)this.early.delete(this.early.keys().next().value);return;}
      this.#finish(r,turn);
    }
    if(msg.method==='turn/started'){
      const r=[...this.runs.values()].find(r=>r.threadId===msg.params?.threadId);if(r){r.turnId=msg.params.turn.id;r.turnReady?.resolve(r.turnId);}
    }
    if(msg.method==='serverRequest/resolved')this.approvals.delete(String(msg.params?.requestId));
    this.emit('notification',msg);
  }
  #finish(r,turn) {
    clearTimeout(r.timer);this.runs.delete(turn.id);
    this.runs.delete('starting:'+r.threadId);r.terminal=turn;r.completion?.resolve(turn);r.cleanup?.();
    if(r.cancelled){this.interrupting.delete(r.threadId);r.reject(interruptedError());return;}
    if(turn.status!=='completed')r.reject(this.#noteFailure(new Error(turn.error?.message||`Codex 执行状态：${turn.status}`)));
    else {
      const items=(turn.items||[]).filter(i=>i.type==='agentMessage');
      const usage=this.usage.get(r.threadId);
      r.resolve({text:items.at(-1)?.text||r.text||'任务已结束，未返回文字结果。',turnId:turn.id,tokenUsage:usage?.turnId===turn.id?usage:undefined});
    }
  }
  approve(id,allow) {
    const request=this.approvals.get(String(id));if(!request)throw new Error('确认请求已过期');
    // Preserve native approval policies; never auto-approve arbitrary operations.
    this.send({id:request.id,result:approvalResponse(request,allow)});this.approvals.delete(String(id));
  }
  async threads(searchTerm='') {
    await this.connect(); const out=await this.request('thread/list',{limit:60,searchTerm:searchTerm||null,archived:false});
    return [...new Map((out.data||[]).map(t=>[t.id,t])).values()].map(t=>({id:t.id,name:t.name||t.preview?.slice(0,60)||t.id,cwd:t.cwd,status:t.status?.type}));
  }
  async models(){
    await this.connect();if(this.modelCatalog?.generation===this.generation&&Date.now()-this.modelCatalog.loaded<60000)return this.modelCatalog.value;
    const result=await this.request('model/list',{limit:100,includeHidden:false});
    const models=(result.data||[]).filter(m=>!m.hidden).map(m=>({id:m.id,model:m.model||m.id,displayName:m.displayName||m.id,inputModalities:m.inputModalities||['text','image'],supportedReasoningEfforts:m.supportedReasoningEfforts||[],defaultReasoningEffort:m.defaultReasoningEffort,serviceTiers:m.serviceTiers||[],isDefault:m.isDefault}));
    let configured={};try{configured=(await this.request('config/read',{includeLayers:false})).config||{};}catch{}
    const preferred=models.find(m=>m.isDefault)||models[0];
    const value={models,defaults:{model:configured.model||preferred?.model,effort:configured.model_reasoning_effort||preferred?.defaultReasoningEffort}};
    this.modelCatalog={generation:this.generation,loaded:Date.now(),value};return value;
  }
  async createCoordinator(tools,ephemeral=false,{visual=false,role=visual?'visual':'assistant',name='抖音视频助手',model,serviceTier}={}) {
    checkWork();
    await this.ensureAuthenticated();
    const out=await this.request('thread/start',{cwd:this.cwd,ephemeral,serviceName:'douyin-codex-bridge',dynamicTools:tools,
      developerInstructions:roleInstructions[role]||assistantInstructions,...(model?{model}:{}),...(serviceTier?{serviceTier:serviceTier==='default'?null:serviceTier}:{}),...(role!=='assistant'?{sandbox:'read-only',approvalPolicy:'never'}:{})});
    if(ephemeral){this.ephemeral.set(out.thread.id,this.generation);if(this.ephemeral.size>128)this.ephemeral.delete(this.ephemeral.keys().next().value);}
    else this.profiles.set(out.thread.id,instructionRevision);
    if(!ephemeral)await this.request('thread/name/set',{threadId:out.thread.id,name}).catch(()=>{});
    checkWork();
    return out.thread.id;
  }
  async runReadOnly(input,{tools=[],...options}={}){
    return this.runEphemeral(input,{...options,tools,role:'visual'});
  }
  async runEphemeral(input,{tools=[],role='router',...options}={}){
    for(let attempt=0;attempt<2;attempt++){
      let thread,generation;
      try{thread=await this.createCoordinator(tools,true,{role,model:options.model,serviceTier:options.serviceTier});generation=this.generation;return await this.run(thread,input,{...options,resume:false});}
      catch(e){
        if(attempt||!(authFailure(e)==='login'||e.code==='CODEX_AUTH_CHANGED'))throw e;
        if(e.code!=='CODEX_AUTH_CHANGED'){const result=await this.reconnect();if(result.deferred)throw authError('pending');}
      }
      finally{if(thread&&generation===this.generation&&this.ready&&!this.interrupting.has(thread))await this.request('thread/unsubscribe',{threadId:thread},5000).catch(()=>{});if(thread){this.ephemeral.delete(thread);this.usage.delete(thread);}}
    }
  }
  async run(threadId,input,options={}){
    checkWork();if(this.threadLocks.has(threadId)||this.interrupting.has(threadId))throw Object.assign(new Error('目标聊天已有任务运行或中断结果仍需核实，正在等待同一聊天的写入权'),{code:'THREAD_BUSY',notSubmitted:true,threadId});
    const token=Symbol(threadId);this.threadLocks.set(threadId,token);try{return await raceWork(this.runThread(threadId,input,options));}catch(e){e.threadId||=threadId;throw e;}finally{if(this.threadLocks.get(threadId)===token)this.threadLocks.delete(threadId);}
  }
  async runThread(threadId,input,{toolHandler,onStarted,onSubmitted,timeoutMs=15*60*1000,resume=true,effort,model,serviceTier,outputSchema,interruptOnTimeout=false,assistant=false}={}) {
    await this.ensureAuthenticated();
    checkWork();
    if(this.ephemeral.has(threadId)&&this.ephemeral.get(threadId)!==this.generation)throw Object.assign(new Error('登录更新后需重新建立只读分析会话'),{code:'CODEX_AUTH_CHANGED'});
    if([...this.runs.values()].some(r=>r.threadId===threadId))throw new Error('该 Codex 聊天仍在工作，请稍后再试');
    if(resume&&!this.loaded.has(threadId)){
      const update=assistant&&this.profiles.get(threadId)!==instructionRevision;
      await this.request('thread/resume',{threadId,excludeTurns:true,...(update?{developerInstructions:assistantInstructions}:{})});
      if(update)this.profiles.set(threadId,instructionRevision);
    }
    let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    promise.catch(()=>{}); // A disconnect can reject this before turn/start itself rejects.
    // Register before turn/start so a fast tool call or final event cannot race the response.
    const r={threadId,resolve,reject,text:'',toolHandler,timer:null,turnReady:Promise.withResolvers(),completion:Promise.withResolvers(),submitted:false,ephemeral:this.ephemeral.has(threadId)};const provisional='starting:'+threadId;this.runs.set(provisional,r);
    const signal=workSignal(),scope=operationContext.getStore();
    r.scope=scope;
    if(scope){scope.nativeRuns||=new Set();scope.nativeRuns.add(r);}
    const abort=()=>{if(r.cancelled)return;r.cancelled=true;r.reject(interruptedError());this.interrupting.set(threadId,r);trackStop(this.interrupt(threadId,{run:r}).then(result=>({...result,kind:'codex'})),scope);};
    r.cleanup=()=>signal?.removeEventListener('abort',abort);signal?.addEventListener('abort',abort,{once:true});
    try {
      checkWork();
      onSubmitted?.();
      checkWork();r.submitted=true;
      const out=await this.request('turn/start',{threadId,input,...(effort?{effort}:{}),...(model?{model}:{}),...(serviceTier?{serviceTierForTurn:serviceTier}:{}),...(outputSchema?{outputSchema}:{})});const turn=out.turn;
      this.runs.delete(provisional);this.runs.set(turn.id,r);r.turnId=turn.id;r.turnReady.resolve(turn.id);
      r.timer=setTimeout(()=>{
        this.runs.delete(turn.id);
        if(interruptOnTimeout)this.request('turn/interrupt',{threadId,turnId:turn.id}).catch(()=>{});
        reject(new Error(interruptOnTimeout?'本段只读视觉分析超时，已请求中断；已完成片段保留，可继续分析。':'Codex 任务超时；请在原聊天检查进展，系统不会自动重复执行。'));
      },timeoutMs);
      if(!r.cancelled)onStarted?.(turn.id);
      if(this.early.has(turn.id)){const event=this.early.get(turn.id);this.early.delete(turn.id);this.#finish(r,event.turn);}
      else if(turn.status==='completed'||turn.status==='failed'||turn.status==='interrupted')this.#finish(r,turn);
    } catch(e){this.runs.delete(provisional);r.turnReady.resolve(null);r.cleanup();if(!e.remote&&!e.notSubmitted&&!r.cancelled)e.uncertain=true;throw e;}
    return promise;
  }
  async interrupt(threadId,{turnId,run,verifyOwnership=false}={}) {
    const r=run||[...this.runs.values()].find(r=>r.threadId===threadId&&(!turnId||r.turnId===turnId));
    const bounded=async(p,ms)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('核验中断超时')),ms))]);}finally{clearTimeout(timer);}};
    let confirmed=false;
    try{
      if(r?.terminal){confirmed=true;return {confirmed};}
      turnId||=r?.turnId||await bounded(r?.turnReady.promise||Promise.resolve(null),5000);
      if(!turnId){confirmed=!!r&&!r.submitted;return {confirmed,error:confirmed?'':'提交中的 Codex 回合尚未返回编号'};}
      if(verifyOwnership){
        const read=await this.request('thread/read',{threadId,includeTurns:true},5000),turn=read.thread?.turns?.find(t=>t.id===turnId);
        if(!turn)return {confirmed:false,error:'无法核实原任务回合，未中断该聊天的其他工作'};
        if(['completed','failed','interrupted'].includes(turn.status)){confirmed=true;return {confirmed};}
      }
      for(let attempt=0;;attempt++){
        try{await this.request('turn/interrupt',{threadId,turnId},5000);break;}
        catch(e){if(r?.terminal){confirmed=true;return {confirmed};}if(!r||!e.remote||!/no active turn to interrupt/i.test(e.message)||attempt>=4)throw e;await new Promise(resolve=>setTimeout(resolve,100*2**attempt));}
      }
      if(r){const end=await bounded(r.completion.promise,3000).catch(()=>null);if(end&&['completed','failed','interrupted'].includes(end.status)){confirmed=true;return {confirmed};}}
      const read=await this.request('thread/read',{threadId,includeTurns:true},3000),turn=read.thread?.turns?.find(t=>t.id===turnId);
      confirmed=!!turn&&['completed','failed','interrupted'].includes(turn.status);return {confirmed,error:confirmed?'':'中断请求已发出，尚未核验到回合结束'};
    }catch(e){return {confirmed:false,error:e.message};}
    finally{if(confirmed){this.interrupting.delete(threadId);if(r){r.cleanup?.();clearTimeout(r.timer);this.runs.delete('starting:'+threadId);if(r.turnId)this.runs.delete(r.turnId);if(r.ephemeral&&this.ready)this.request('thread/unsubscribe',{threadId},3000).catch(()=>{});}}}
  }
  close(){this.closed=true;clearInterval(this.authTimer);this.#disconnect(Object.assign(new Error('Codex 连接已关闭'),{uncertain:true}));const old=this.proc;this.proc=null;this.lines?.close();old?.kill();}
}

export const coordinatorTools=[
  {name:'need_context',description:'取得当前需求的简短交接、完整交流记录路径和摘要是否待核对。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'knowledge_search',description:'查询此前从抖音视频保存的资料、文字稿和总结。',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
  {name:'dispatch_task',description:'仅在用户明确要求时，把带有视频资料的任务交给已授权的目标 Codex 聊天。返回排队编号，不能把排队说成执行完成。',inputSchema:{type:'object',properties:{alias:{type:'string'},instruction:{type:'string'}},required:['alias','instruction'],additionalProperties:false}}
];
