import {EventEmitter} from 'node:events';
// Login/catalog and disposable analysis may work before desktop cutover.
// Persistent needs must never fall back to the independent local writer.
export class PersonalCodexClient extends EventEmitter{
  constructor(local,desktop){super();Object.assign(this,{local,desktop});for(const c of [local,desktop])for(const event of ['notification','approval','disconnected','auth-reconnected'])c.on(event,value=>this.emit(event,value));}
  get ready(){return this.local.ready;}get authState(){return this.local.authState;}
  get approvals(){return new Map([...this.local.approvals,...this.desktop.approvals]);}
  get threadLocks(){return new Map([...this.local.threadLocks,...this.desktop.threadLocks]);}get runs(){return new Map([...this.local.runs,...this.desktop.runs]);}
  get usage(){return new Map([...this.local.usage,...this.desktop.usage]);}
  connect(){return this.local.connect();}ensureAuthenticated(){return this.local.ensureAuthenticated();}
  startAuthWatcher(){return this.local.startAuthWatcher();}
  async reconnect(){const a=await this.local.reconnect();if(this.desktop.ready)await this.desktop.reconnect();return a;}
  models(){return this.local.models();}threads(query){return this.local.threads(query);}threadUrl(id){return this.desktop.threadUrl(id);}
  temporary(id){return this.local.ephemeral.has(id)||[...this.local.runs.values()].some(r=>r.threadId===id);}
  async request(method,params={},timeout){const c=params.threadId&&this.temporary(params.threadId)?this.local:method.startsWith('thread/')||method.startsWith('turn/')?this.desktop:this.local;await c.connect();return c.request(method,params,timeout);}
  createCoordinator(tools,ephemeral=false,options){return (ephemeral?this.local:this.desktop).createCoordinator(tools,ephemeral,options);}
  run(id,input,options){return (this.temporary(id)?this.local:this.desktop).run(id,input,options);}interrupt(id,options){return (this.temporary(id)?this.local:this.desktop).interrupt(id,options);}
  runReadOnly(input,options){return this.local.runReadOnly(input,options);}runEphemeral(input,options){return this.local.runEphemeral(input,options);}
  approve(id,allow){const a=this.desktop.approvals.has(String(id)),b=this.local.approvals.has(String(id));if(a&&b)throw new Error('确认编号冲突，请等待临时分析结束后重试');return (a?this.desktop:this.local).approve(id,allow);}
  async close(){await Promise.allSettled([this.local.close(),this.desktop.close()]);}
}
