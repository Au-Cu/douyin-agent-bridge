import {matchesPeer} from './douyin.mjs';
import {checkWork} from './execution.mjs';
// Serialize complete native UI operations, including selection and verification.
// Without this mutex another chat scan could switch the composer during a send.
export class PeerBrowser {
  constructor(adapter){this.adapter=adapter;this.tail=Promise.resolve();this.multiple=false;this.selectionUntil=0;}
  get status(){return this.adapter.status;}get page(){return this.adapter.page;}get lastScan(){return this.adapter.lastScan;}get lastReceipt(){return this.adapter.lastReceipt;}get lastReactionDiagnostic(){return this.adapter.lastReactionDiagnostic;}
  get lastSelectionDiagnostic(){return this.adapter.lastSelectionDiagnostic;}
  get sending(){return !!this.pending||!!this.adapter.sending;}
  serial(fn){this.pending=(this.pending||0)+1;const p=this.tail.catch(()=>{}).then(fn).finally(()=>this.pending--);this.tail=p;return p;}
  async select(peer){checkWork();const r=await this.adapter.scan();if(matchesPeer(r.peer,peer))return r;await this.adapter.restoreOwner(peer);checkWork();const after=await this.adapter.scan();if(!matchesPeer(after.peer,peer))throw new Error('未核验到选定的抖音聊天，操作已停止');return after;}
  selection(active){this.selectionUntil=active?Date.now()+5*60*1000:0;}
  get selecting(){return this.selectionUntil>Date.now();}
  open(...args){return this.serial(()=>this.adapter.open(...args));}
  scan(){return this.serial(()=>this.adapter.scan());}
  scanPeer(peer){if(this.selecting)return Promise.reject(new Error('正在面板中选择抖音聊天，轮询暂时暂停'));if(!this.multiple)return this.adapter.scan();return this.serial(()=>{if(this.selecting)throw new Error('正在面板中选择抖音聊天，轮询暂时暂停');return this.select(peer);});}
  send(peer,...args){return this.serial(async()=>{if(this.selecting)throw new Error('正在面板中选择聊天，发送暂时暂停');if(this.multiple)await this.select(peer);return this.adapter.send(peer,...args);});}
  react(peer,...args){return this.serial(async()=>{checkWork();if(this.selecting)throw new Error('正在面板中选择聊天，贴表情暂时暂停');if(this.multiple)await this.select(peer);return this.adapter.react(peer,...args);});}
  acknowledge(peer,...args){return this.serial(async()=>{if(this.multiple)await this.select(peer);return this.adapter.acknowledge(peer,...args);});}
  resolveVideo(...args){return this.serial(()=>this.adapter.resolveVideo(...args));}
  download(...args){return this.adapter.download(...args);}
  uiDiagnostics(){return this.serial(()=>this.adapter.uiDiagnostics());}
  composerState(){return this.serial(()=>this.adapter.composerState());}
  close(){return this.serial(()=>this.adapter.close());}
}
