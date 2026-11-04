import {AsyncLocalStorage} from 'node:async_hooks';
import {matchesPeer} from './douyin.mjs';
import {checkWork} from './execution.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const platformPeer=peer=>peer?.platformChatKey?{...peer,chatKey:peer.platformChatKey}:peer;
function localScan(scan,peer){
  if(!peer.platformChatKey||!matchesPeer(scan.peer,platformPeer(peer)))return scan;
  return {...scan,peer:{...scan.peer,chatKey:peer.chatKey},messages:(scan.messages||[]).map(message=>message.conversation===peer.platformChatKey?{...message,conversation:peer.chatKey}:message)};
}

// One lease covers selection, stable collection and the complete native send /
// reaction verification. Inference uses copied messages and never holds it.
export class PeerBrowser {
  constructor(adapter,{now=Date.now,wait=sleep,settleMs=750,quietMs=300,readTimeoutMs=2500,reconcileMs=60000}={}){
    Object.assign(this,{adapter,now,wait,settleMs,quietMs,readTimeoutMs,reconcileMs});this.multiple=false;this.selectionUntil=0;this.queue=[];this.polls=new Map();this.media=new Set();this.visited=new Map();this.writeBurst=0;this.stats={completed:0,coalesced:0,switches:0,skippedIdle:0,inboxChecks:0,maxWaitMs:0,maxOperationMs:0};
  }
  get status(){return this.adapter.status;}get page(){return this.adapter.page;}get lastScan(){return this.adapter.lastScan;}get lastReceipt(){return this.adapter.lastReceipt;}get lastReactionDiagnostic(){return this.adapter.lastReactionDiagnostic;}
  get lastSelectionDiagnostic(){return this.adapter.lastSelectionDiagnostic;}
  get lastQuoteDiagnostic(){return this.adapter.lastQuoteDiagnostic;}
  get sending(){return !!this.active||this.queue.length>0||!!this.adapter.sending;}
  get diagnostics(){return {...this.stats,active:this.active?.kind||'',activeForMs:this.active?this.now()-this.active.started:0,queued:this.queue.length,queuedKinds:this.queue.map(j=>j.kind),mediaActive:this.media.size};}
  serial(fn,{kind='inspect',priority=0,peer,allowClosing=false}={}){
    if(this.closing&&!allowClosing)return Promise.reject(new Error('浏览器连接正在关闭'));
    const scope=AsyncLocalStorage.snapshot();
    return new Promise((resolve,reject)=>{this.queue.push({run:()=>scope(fn),resolve,reject,kind,priority,peer,queued:this.now()});this.pump();});
  }
  pump(){
    if(this.active||!this.queue.length)return;
    // Prefer pending replies to routine navigation. After three writes, serve
    // the oldest waiting read so a busy group cannot starve other inboxes.
    const read=this.queue.findIndex(j=>j.priority<20);let index=this.writeBurst>=3&&read>=0?read:0;
    if(!(this.writeBurst>=3&&read>=0))for(let i=1;i<this.queue.length;i++)if(this.queue[i].priority>this.queue[index].priority)index=i;
    const job=this.active=this.queue.splice(index,1)[0];job.started=this.now();this.stats.maxWaitMs=Math.max(this.stats.maxWaitMs,job.started-job.queued);this.writeBurst=job.priority>=20?this.writeBurst+1:0;
    Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{this.stats.completed++;this.stats.maxOperationMs=Math.max(this.stats.maxOperationMs,this.now()-job.started);this.active=null;this.pump();});
  }
  async select(peer){
    if(this.selecting)throw new Error('正在手动选择抖音聊天，自动切换暂时暂停');
    const native=platformPeer(peer);
    checkWork();const before=await this.adapter.scan();if(matchesPeer(before.peer,native))return localScan(before,peer);
    await this.adapter.restoreOwner(native);checkWork();let snapshot=await this.adapter.scan();
    if(!matchesPeer(snapshot.peer,native))throw new Error('未核验到选定的抖音聊天，操作已停止');
    this.stats.switches++;
    const start=this.now(),messages=new Map(),fingerprint=s=>JSON.stringify((s.messages||[]).map(m=>[m.id,m.text,m.awemeId]));let signature=fingerprint(snapshot),changed=start;
    for(;;){
      for(const m of snapshot.messages||[])if(!m.conversation||m.conversation===native.chatKey)messages.set(m.id,m);
      const elapsed=this.now()-start;if(elapsed>=this.readTimeoutMs||elapsed>=this.settleMs&&this.now()-changed>=this.quietMs)break;
      await this.wait(Math.min(150,this.readTimeoutMs-elapsed));checkWork();snapshot=await this.adapter.scan();
      if(!matchesPeer(snapshot.peer,native))throw Object.assign(new Error('采集消息时会话或账号发生变化，已停止读取'),{code:'CHAT_CHANGED',notSubmitted:true});
      const next=fingerprint(snapshot);if(next!==signature){signature=next;changed=this.now();}
    }
    return localScan({...snapshot,messages:[...messages.values()].sort((a,b)=>(a.created||0)-(b.created||0))},peer);
  }
  selection(active,kind='chat'){
    if(this.selecting&&this.selectionKind!==kind){
      if(active)throw new Error('请先完成或取消当前的聊天选择');
      return;
    }
    this.selectionMode=active?kind:'';
    this.selectionUntil=active?this.now()+5*60*1000:0;
    if(active)return this.serial(()=>{}, {kind:'selection',priority:30});
  }
  get selecting(){return this.selectionUntil>this.now();}
  get selectionKind(){return this.selecting?this.selectionMode:'';}
  open(owner,options){return this.serial(()=>this.adapter.open(this.selecting?undefined:owner,options),{kind:'open',priority:10});}
  focus(){return this.serial(()=>this.adapter.focus?.(),{kind:'focus',priority:10});}
  logout(){return this.serial(()=>this.adapter.logout(),{kind:'logout',priority:30});}
  scan(){return this.serial(()=>this.adapter.scan(),{kind:'inspect'});}
  async wantsRead(peer,{agent=false}={}){
    const native=platformPeer(peer);
    if(peer.selfChat||matchesPeer(this.adapter.lastScan?.peer,native))return true;
    if((this.pollBackoff?.get(peer.chatKey)||0)>this.now())return false;
    if(!this.adapter.inbox)return true;
    if(!this.inboxCache||this.now()-this.inboxCache.at>=1000){try{this.inboxCache={at:this.now(),value:await this.adapter.inbox()};this.stats.inboxChecks++;}catch{return true;}}
    const rows=this.inboxCache.value?.entries?.filter(e=>e.ids?.includes(native.chatKey))||[];
    if(rows.length!==1||rows[0].unread===null||rows[0].unread===undefined)return true;
    if(rows[0].unread>0)return true;
    const interval=agent?Math.min(this.reconcileMs,5000):this.reconcileMs;
    if(!this.visited.has(peer.chatKey)||this.now()-this.visited.get(peer.chatKey)>=interval)return true;
    this.stats.skippedIdle++;return false;
  }
  scanPeer(peer,{background=false,agent=false}={}){
    if(this.closing)return Promise.reject(new Error('浏览器连接正在关闭'));
    if(this.selecting)return Promise.reject(new Error('正在面板中选择抖音聊天，轮询暂时暂停'));
    const key=JSON.stringify([peer,background,agent]),shared=this.polls.get(key);if(shared){this.stats.coalesced++;return shared;}
    // Reading the already selected owner must remain available to /中断 while
    // a reply awaits confirmation. observeOnly never changes cached UI handles.
    if((!this.multiple&&!peer.selfChat)||['send','reaction','acknowledge'].includes(this.active?.kind)&&matchesPeer(this.active.peer,peer)&&matchesPeer(this.adapter.lastScan?.peer,platformPeer(peer)))return this.adapter.scan({observeOnly:true}).then(scan=>localScan(scan,peer));
    const pending=this.serial(async()=>{if(this.selecting)throw new Error('正在面板中选择抖音聊天，轮询暂时暂停');if(background&&!await this.wantsRead(peer,{agent}))return null;try{const scan=await this.select(peer);this.visited.set(peer.chatKey,this.now());this.pollBackoff?.delete(peer.chatKey);return scan;}catch(error){if(background&&!peer.selfChat){this.pollBackoff??=new Map();this.pollBackoff.set(peer.chatKey,this.now()+(agent?5000:30000));}throw error;}},{kind:'poll',peer});this.polls.set(key,pending);
    pending.then(()=>this.polls.delete(key),()=>this.polls.delete(key));return pending;
  }
  mutate(kind,peer,fn){return this.serial(async()=>{checkWork();if(this.selecting)throw new Error('正在面板中选择聊天，操作暂时暂停');if(this.multiple||peer.selfChat)await this.select(peer);checkWork();return fn();},{kind,peer,priority:20});}
  send(peer,...args){return this.mutate('send',peer,()=>this.adapter.send(platformPeer(peer),...args));}
  react(peer,...args){return this.mutate('reaction',peer,()=>this.adapter.react(platformPeer(peer),...args));}
  acknowledge(peer,...args){return this.mutate('acknowledge',peer,()=>this.adapter.acknowledge(platformPeer(peer),...args));}
  async resolveVideo(...args){
    // Both native adapters resolve media only in their own validated video tab.
    // Release the chat lease after starting it, while retaining lifecycle cleanup.
    const {task}=await this.serial(()=>{checkWork();const task=Promise.resolve().then(()=>this.adapter.resolveVideo(...args));this.media.add(task);task.then(()=>this.media.delete(task),()=>this.media.delete(task));return {task};},{kind:'video'});return task;
  }
  download(...args){return this.adapter.download(...args);}
  uiDiagnostics(peer){return this.serial(async()=>{if(peer)await this.select(peer);return this.adapter.uiDiagnostics();},{kind:'inspect',peer});}
  composerState(){return this.serial(()=>this.adapter.composerState(),{kind:'inspect'});}
  inbox(){return this.serial(()=>this.adapter.inbox?.()||{entries:[],rows:0},{kind:'inspect'});}
  quoteSchema(peer){return this.serial(async()=>{if(peer)await this.select(peer);return this.adapter.quoteSchema?.()||null;},{kind:'inspect'});}
  close(){if(this.closing)return this.closed;this.closing=true;return this.closed=this.serial(async()=>{await Promise.allSettled([...this.media]);return this.adapter.close();},{kind:'close',priority:-10,allowClosing:true});}
}
