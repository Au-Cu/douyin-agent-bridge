import net from 'node:net';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {chmod,unlink} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';

const terminal=new Set(['completed','failed','interrupted']);
const allowedBridge=/^(?:thread\/(?:start|resume|read|archive|unarchive|turns\/list|items\/list|loaded\/list|list|unsubscribe|name\/set)|turn\/(?:start|interrupt)|model\/list|account\/read|config\/read|getAuthStatus)$/;

// Both frontends share ONE real app-server. RPC IDs are connection-local, so
// every request and server callback is translated; no raw byte broadcast.
export class SharedCodexBroker {
  constructor({endpoint,token,command,args=[],cwd,env=process.env,spawnCore=spawn,idleMs=1000}){Object.assign(this,{endpoint,token,command,args,cwd,env,spawnCore,idleMs});this.clients=new Set();this.requests=new Map();this.callbacks=new Map();this.callbackIds=new Map();this.threadOwners=new Map();this.toolOwners=new Map();this.active=new Map();this.ephemeral=new Set();this.seq=0;this.callbackSeq=1000000000;this.initializers=[];}
  async listen(){
    this.server=net.createServer(socket=>this.accept(socket));
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.endpoint,resolve);});
    if(process.platform!=='win32')await chmod(this.endpoint,0o600);
    this.proc=this.spawnCore(this.command,this.args,{cwd:this.cwd,env:this.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.proc.stderr.on('data',()=>{}); // Never relay credentials or diagnostics.
    this.lines=createInterface({input:this.proc.stdout});this.lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch{this.close();}});
    this.proc.once('error',()=>this.close());this.proc.once('exit',()=>this.close());return this;
  }
  sendCore(message){if(!this.proc?.stdin?.writable)throw new Error('Shared Codex disconnected');this.proc.stdin.write(JSON.stringify(message)+'\n');}
  send(client,message){if(!client.socket.destroyed)client.socket.write(JSON.stringify(message)+'\n');}
  reject(client,id,message,code=-32000){this.send(client,{id,error:{code,message}});}
  accept(socket){
    const client={socket,ready:false,role:'',initialized:false,optOut:new Set()};let bytes=0;
    const timeout=setTimeout(()=>socket.destroy(),3000),lines=createInterface({input:socket});
    lines.on('line',line=>{bytes=Buffer.byteLength(line);if(bytes>8*1024*1024)return socket.destroy();let m;try{m=JSON.parse(line);}catch{return socket.destroy();}
      if(!client.ready){const token=Buffer.from(String(m.token||'')),expected=Buffer.from(this.token);if(m.sharedCodex!==1||token.length!==expected.length||!timingSafeEqual(token,expected)||!['desktop','bridge'].includes(m.role))return socket.destroy();if(m.role==='bridge'&&![...this.clients].some(c=>c.role==='desktop'))return socket.end('{"ready":false}\n');clearTimeout(timeout);client.ready=true;client.role=m.role;this.clients.add(client);clearTimeout(this.idleTimer);this.send(client,{ready:true});return;}
      try{this.forward(client,m);}catch{if(m.id!==undefined)this.reject(client,m.id,'Shared Codex disconnected');}
    });
    socket.on('error',()=>{});socket.once('close',()=>{clearTimeout(timeout);lines.close();this.clients.delete(client);this.checkIdle();});
  }
  forward(client,m){
    if(m.id!==undefined&&!m.method){const cb=this.callbacks.get(String(m.id));if(!cb||!cb.recipients.has(client)||cb.answered)return;cb.answered=true;this.sendCore({id:cb.coreId,...('error'in m?{error:m.error}:{result:m.result})});return;}
    if(m.method==='initialize'){
      if(client.initialized)return this.reject(client,m.id,'Already initialized');client.initialized=true;client.optOut=new Set(m.params?.capabilities?.optOutNotificationMethods||[]);
      if(this.initResult)return this.send(client,{id:m.id,result:this.initResult});
      if(client.role==='bridge'||this.initializing){this.initializers.push({client,id:m.id});return;}
      this.initializing=true;const params={...m.params,capabilities:{...m.params?.capabilities,experimentalApi:true,optOutNotificationMethods:[]}};return this.request(client,{...m,params});
    }
    if(!client.initialized)return this.reject(client,m.id,'Not initialized');if(m.method==='initialized')return;
    if(m.method==='bridge/toolOwner'&&client.role==='bridge'){this.toolOwners.set(m.params?.threadId,m.params?.enabled===true?client:null);return this.send(client,{id:m.id,result:{}});}
    if(client.role==='bridge'&&!allowedBridge.test(m.method||''))return this.reject(client,m.id,'Method is not available to the bridge',-32601);
    if(m.method==='turn/start'){
      if(client.role==='bridge'&&![...this.clients].some(c=>c.role==='desktop'))return this.reject(client,m.id,'Desktop disconnected; task was not submitted',-32011);
      const id=m.params?.threadId;if(this.active.has(id))return this.reject(client,m.id,'thread already active; another turn owns this chat',-32009);
      this.active.set(id,{client,turnId:null});this.threadOwners.set(id,client);
    }
    if(m.method==='turn/interrupt'&&client.role==='bridge'){
      const active=this.active.get(m.params?.threadId);if(!active||active.client.role!=='bridge'||active.turnId!==m.params?.turnId)return this.reject(client,m.id,'Cannot interrupt a turn not owned by this bridge',-32010);
    }
    if(m.id!==undefined)return this.request(client,m);this.sendCore(m);
  }
  request(client,m){const id=++this.seq;this.requests.set(id,{client,id:m.id,method:m.method,threadId:m.params?.threadId});this.sendCore({...m,id});}
  receive(m){
    if(m.id!==undefined&&!m.method){
      const p=this.requests.get(m.id);if(!p)return;this.requests.delete(m.id);
      if(p.method==='initialize'){if(!m.error){this.initResult=m.result;this.sendCore({method:'initialized'});}else this.initializing=false;for(const pending of this.initializers.splice(0))this.send(pending.client,{...m,id:pending.id});}
      if(['thread/start','thread/resume'].includes(p.method)&&!m.error){const id=m.result?.thread?.id||p.threadId;if(id){if(!this.active.has(id))this.threadOwners.set(id,p.client);if(m.result?.thread?.ephemeral)this.ephemeral.add(id);}}
      if(p.method==='turn/start'){const active=this.active.get(p.threadId);if(m.error){if(active?.client===p.client)this.active.delete(p.threadId);}else if(active){active.turnId=m.result?.turn?.id;if(terminal.has(m.result?.turn?.status))this.active.delete(p.threadId);}}
      this.send(p.client,{...m,id:p.id});return;
    }
    if(m.id!==undefined&&m.method){
      const thread=m.params?.threadId,owner=this.active.get(thread)?.client||this.threadOwners.get(thread),desktop=[...this.clients].filter(c=>c.role==='desktop'),approval=/requestApproval$/.test(m.method);
      const callbackOwner=m.method==='item/tool/call'?(this.toolOwners.get(thread)||desktop[0]):owner||desktop[0];
      const recipients=new Set(approval?[owner,...desktop].filter(Boolean):[m.method==='attestation/generate'||m.method==='item/tool/requestUserInput'?desktop[0]:callbackOwner].filter(Boolean));
      const id=++this.callbackSeq,cb={coreId:m.id,recipients,answered:false};this.callbacks.set(String(id),cb);this.callbackIds.set(String(m.id),id);
      if(!recipients.size){cb.answered=true;this.sendCore({id:m.id,error:{code:-32000,message:'The owning frontend is disconnected; no tool was executed'}});}else for(const client of recipients)this.send(client,{...m,id});return;
    }
    const thread=m.params?.threadId||m.params?.thread?.id;
    if(m.method==='turn/started'){const a=this.active.get(thread);if(a)a.turnId=m.params?.turn?.id;}
    if(m.method==='turn/completed'){const a=this.active.get(thread);if(a&&(!a.turnId||a.turnId===m.params?.turn?.id))this.active.delete(thread);this.checkIdle();}
    if(m.method==='serverRequest/resolved'){const key=String(m.params?.requestId),id=this.callbackIds.get(key);if(id!==undefined){m={...m,params:{...m.params,requestId:id}};this.callbacks.delete(String(id));this.callbackIds.delete(key);}}
    for(const client of this.clients){if(client.optOut.has(m.method))continue;if(this.ephemeral.has(thread)&&this.threadOwners.get(thread)!==client)continue;this.send(client,m);}
  }
  checkIdle(){clearTimeout(this.idleTimer);if(this.closing)return;if(![...this.clients].some(c=>c.role==='desktop')&&!this.active.size)this.idleTimer=setTimeout(()=>this.close(),this.idleMs);}
  async close(){if(this.closing)return this.closed;this.closing=true;clearTimeout(this.idleTimer);this.lines?.close();for(const c of this.clients)c.socket.destroy();this.proc?.stdin.destroy();this.proc?.kill();return this.closed=new Promise(resolve=>{if(!this.server?.listening)return resolve();this.server.close(async()=>{if(process.platform!=='win32')await unlink(this.endpoint).catch(()=>{});resolve();});});}
}
