import {EventEmitter} from 'node:events';

export const harnessNames={codex:'Codex',dsh:'DeepSeek Harness'};
export function harnessValue(value){const key=String(value||'codex').toLowerCase();if(!harnessNames[key])throw new Error('助手只能是 codex 或 dsh');return key;}
export const threadHarness=id=>String(id||'').startsWith('dsh:')?'dsh':'codex';
export const dshThread=id=>'dsh:'+String(id).replace(/^dsh:/,'');
export const nativeDshThread=id=>String(id||'').replace(/^dsh:/,'');

// Existing Codex IDs remain unchanged. DSH IDs are explicitly namespaced, so a
// backend switch never submits a Codex conversation to a different provider.
export class HarnessClient extends EventEmitter{
  constructor({clients,active='codex',approvalPrefixes={},mutedApprovals=[]}){
    super();this.clients=clients;this.harnessName=harnessValue(active);this.approvalPrefixes=approvalPrefixes;this.mutedApprovals=new Set(mutedApprovals);
    for(const [name,client]of Object.entries(clients)){
      client.on('notification',m=>this.emit('notification',m));
      client.on('approval',request=>{if(!this.mutedApprovals.has(name))this.emit('approval',{...request,id:(this.approvalPrefixes[name]||name)+':'+request.id});});
      client.on('disconnected',e=>this.emit('disconnected',e));
      client.on('auth-reconnected',()=>this.emit('auth-reconnected',{harness:name}));
    }
  }
  get active(){return this.forHarness(this.harnessName);}
  forHarness(name){const client=this.clients[harnessValue(name)];if(!client)throw new Error('此运行入口尚未配置 '+harnessNames[name]);return client;}
  forThread(id){return this.forHarness(threadHarness(id));}
  get ready(){return this.active.ready;}
  get authState(){return this.active.authState;}
  get approvals(){return new Map(Object.entries(this.clients).filter(([name])=>!this.mutedApprovals.has(name)).flatMap(([name,c])=>[...(c.approvals||[])].map(([id,r])=>[(this.approvalPrefixes[name]||name)+':'+id,r])));}
  get threadLocks(){return new Map(Object.values(this.clients).flatMap(c=>[...(c.threadLocks||[])]));}
  get runs(){return new Map(Object.entries(this.clients).flatMap(([name,c])=>[...(c.runs||[])].map(([id,r])=>[name+':'+id,r])));}
  get usage(){return new Map(Object.values(this.clients).flatMap(c=>[...(c.usage||[])]));}
  connect(){return this.active.connect();}
  ensureAuthenticated(){return this.active.ensureAuthenticated();}
  async reconnect(){const settled=await Promise.all(Object.values(this.clients).filter(c=>c.ready||c===this.active).map(c=>c.reconnect()));return {deferred:settled.some(r=>r.deferred),auth:this.authState};}
  startAuthWatcher(){this.active.startAuthWatcher();}
  models(name=this.harnessName){return this.forHarness(name).models();}
  threads(query='',name=this.harnessName){return this.forHarness(name).threads(query);}
  threadUrl(id){return this.forThread(id).threadUrl?.(id)||null;}
  async request(method,params={},timeout){const client=params.threadId?this.forThread(params.threadId):this.active;await client.connect();return client.request(method,params,timeout);}
  createCoordinator(tools,ephemeral=false,{harness=this.harnessName,...options}={}){return this.forHarness(harness).createCoordinator(tools,ephemeral,options);}
  run(id,input,options){return this.forThread(id).run(id,input,options);}
  runReadOnly(input,options){return this.active.runReadOnly(input,options);}
  runEphemeral(input,options){return this.active.runEphemeral(input,options);}
  interrupt(id,options){return this.forThread(id).interrupt(id,options);}
  approve(id,allow){const at=String(id).indexOf(':');if(at<0){const found=Object.entries(this.clients).filter(([name,c])=>!this.mutedApprovals.has(name)&&c.approvals?.has(String(id)));if(found.length!==1)throw new Error('确认编号不唯一或已过期，请使用面板显示的完整编号');return found[0][1].approve(String(id),allow);}const prefix=String(id).slice(0,at),name=Object.keys(this.clients).find(n=>(this.approvalPrefixes[n]||n)===prefix),native=String(id).slice(at+1);if(!name||this.mutedApprovals.has(name))throw new Error('确认编号不属于此连接');return this.forHarness(name).approve(native,allow);}
  async close(){await Promise.allSettled([...new Set(Object.values(this.clients))].map(c=>c.close()));}
}
