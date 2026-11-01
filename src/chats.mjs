import {randomUUID} from 'node:crypto';
import {toPlainChatText} from './chat-text.mjs';
import {splitReply} from './engine.mjs';
import {progressEmoji} from './progress.mjs';
import {operationContext} from './execution.mjs';
import {matchesPeer} from './douyin.mjs';

export const sameChat=matchesPeer;
export function acceptsChatMessage(message,chat,since){
  return chat.enabled&&chat.mode==='chat'&&message.direction==='in'&&message.conversation===chat.chatKey&&message.sender&&message.sender!==chat.selfUid&&message.created>0&&message.created>=Math.max(since,chat.enabledAt||0)-1500&&['text','video'].includes(message.kind)&&(chat.type==='group'?!!chat.selfUid&&Array.isArray(message.mentionedUids)&&message.mentionedUids.includes(chat.selfUid):message.sender===chat.peerUid);
}
export class Chats {
  constructor({store,adapter,sandbox,preferences,canChangeAgent=()=>true}){
    Object.assign(this,{store,adapter,sandbox,preferences,canChangeAgent});this.running=new Map();this.controllers=new Map();this.scanning=false;this.cursor=0;this.armedAt=0;this.observations=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,peer TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',thread TEXT NOT NULL DEFAULT '',turn TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_seen(peer TEXT NOT NULL,platform_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(peer,platform_id));
      CREATE INDEX IF NOT EXISTS bot_peer_history ON bot_messages(peer,created);
      UPDATE bot_messages SET status='new' WHERE status='preparing';
      UPDATE bot_messages SET status='uncertain',result='上次已提交但结果未核实，不会自动重跑' WHERE status='submitted';`);
    if(!Array.isArray(store.config.aiChats))store.saveConfig({aiChats:[]});this.refreshBrowserMode();
  }
  list(){const chats=[...this.store.config.aiChats],owner=this.store.config.owner;if(owner&&!chats.some(c=>c.chatKey===owner.chatKey))chats.unshift({...owner,type:'single',mode:'agent',enabled:true,revision:'legacy-owner',legacy:true});return chats;}
  get(key){return this.list().find(c=>c.chatKey===key);}
  agentEnabled(){const owner=this.store.config.owner;return !!owner&&this.get(owner.chatKey)?.enabled&&this.get(owner.chatKey)?.mode==='agent';}
  bots(){return this.list().filter(c=>c.enabled&&c.mode==='chat');}
  refreshBrowserMode(){this.adapter.multiple=this.bots().length>0;}
  state(){return {chats:this.list(),selecting:!!this.adapter.selecting,messages:this.store.db.prepare('SELECT id,peer,status,result,thread,turn,created,updated FROM bot_messages ORDER BY created DESC LIMIT 25').all().map(r=>({...r,name:this.get(r.peer)?.displayName||'已停用聊天',uncertainReplies:this.store.db.prepare("SELECT id FROM outbox WHERE kind='text' AND status='uncertain' AND json_extract(payload,'$.botId')=?").all(r.id).map(o=>o.id)}))};}
  beginSelection(){this.adapter.selection?.(true);}
  endSelection(){this.adapter.selection?.(false);}
  async observe(){
    const scan=await this.adapter.scan(),peer=scan.peer,owner=this.store.config.owner;
    if(!peer||!peer.chatKey||!peer.peerUid||scan.loginRequired)throw new Error('请先在抖音窗口打开目标聊天');
    if(peer.chatKey.startsWith('peer:'))throw new Error('没有取得稳定的抖音聊天 ID，暂不允许启用');
    const legacy=owner?.chatKey===peer.chatKey&&owner.peerUid===peer.peerUid&&peer.type==='unknown';
    if(!['single','group'].includes(peer.type)&&!legacy)throw new Error('未能核验单聊或群聊类型，暂不允许启用；请在该聊天发一条普通消息后重新读取');
    if(!peer.selfUid)throw new Error('无法核验助手账号身份，请从助手账号在该聊天手动发一条普通消息，再重新读取');
    const token=randomUUID(),value={...peer,type:legacy?'single':peer.type,...(legacy?{legacy:true}:{}),token};this.observations.set(token,{value,seen:scan.messages.map(m=>m.id),expires:Date.now()+5*60*1000});
    for(const [key,v] of this.observations)if(v.expires<Date.now())this.observations.delete(key);return value;
  }
  configure({token,chatKey,mode,enabled}){
    if(!['agent','chat'].includes(mode)||typeof enabled!=='boolean')throw new Error('请选择个人 Agent 或普通聊天 AI，并明确启用状态');
    const observed=token&&this.observations.get(token),old=this.get(String(chatKey||observed?.value.chatKey||''));
    if(token&&(!observed||observed.expires<Date.now()))throw new Error('聊天身份已过期，请重新读取当前聊天');
    const peer=observed?.value||old;if(!peer)throw new Error('请先从实际打开的抖音聊天读取身份');
    const owner=this.store.config.owner,isOwner=owner?.chatKey===peer.chatKey&&owner?.peerUid===peer.peerUid;
    if(mode==='agent'&&(!isOwner||peer.type==='group'))throw new Error('个人 Agent 使用现有绑定用户的单聊；其他单聊或群聊请选择普通聊天 AI');
    if(enabled&&mode==='chat'&&(!peer.selfUid||!['single','group'].includes(peer.type)))throw new Error('普通聊天的账号或聊天类型尚未核验，请重新读取');
    if(isOwner&&(old?.mode!==mode||old?.enabled!==enabled)&&!this.canChangeAgent())throw new Error('个人 Agent 仍有任务或回复正在执行，请先完成或中断后更改模式');
    if(enabled&&!old?.enabled&&this.list().filter(c=>c.enabled).length>=20)throw new Error('最多同时启用 20 个聊天，请先停用不需要的聊天');
    const revision=randomUUID(),entry={chatKey:peer.chatKey,peerUid:peer.peerUid,displayName:String(peer.displayName||'抖音聊天').slice(0,150),type:peer.type,selfUid:peer.selfUid||'',legacy:!!peer.legacy,mode,enabled,enabledAt:enabled?Date.now():old?.enabledAt||0,revision};
    if(observed)for(const id of observed.seen)this.seen(entry.chatKey,id);
    const list=this.store.config.aiChats.filter(c=>c.chatKey!==entry.chatKey);this.store.saveConfig({aiChats:[...list,entry]});
    this.controllers.get(entry.chatKey)?.abort();this.controllers.delete(entry.chatKey);
    this.store.db.prepare("UPDATE bot_messages SET status='cancelled',updated=? WHERE peer=? AND status IN ('new','preparing','replying')").run(Date.now(),entry.chatKey);
    this.store.db.prepare("UPDATE outbox SET status='superseded',error='聊天配置已更改，未发送的旧回复已停止' WHERE peer=? AND status='pending' AND json_extract(payload,'$.chatbot')=1").run(entry.chatKey);
    this.endSelection();this.refreshBrowserMode();this.store.event('已保存抖音聊天模式：'+(mode==='agent'?'个人 Agent':'普通聊天 AI')+(enabled?'，已启用':'，已停用'));return entry;
  }
  arm(since=Date.now()){this.armedAt=since;}
  seen(peer,id){return this.store.db.prepare('INSERT OR IGNORE INTO bot_seen VALUES(?,?,?)').run(peer,id,Date.now()).changes>0;}
  async baseline({resumeSince}={}){for(const chat of this.bots()){try{const scan=await this.adapter.scanPeer(chat);if(!sameChat(scan.peer,chat))throw new Error('普通聊天身份未通过核验，请重新读取该聊天');for(const m of scan.messages)if(resumeSince===undefined||m.created<resumeSince-1500)this.seen(chat.chatKey,m.id);}catch(e){this.warn(chat,'此聊天暂未恢复，其他聊天继续监听：'+e.message);}}}
  controller(chat){let c=this.controllers.get(chat.chatKey);if(!c||c.signal.aborted){c=new AbortController();this.controllers.set(chat.chatKey,c);}return c;}
  deliveryTarget(payload,peer){const chat=this.get(peer);return payload.chatbot&&chat?.enabled&&chat.mode==='chat'&&chat.revision===payload.chatRevision?chat:null;}
  guard(payload,peer){if(!this.deliveryTarget(payload,peer))throw Object.assign(new Error('此普通聊天已停用或切换模式，回复已停止'),{code:'CHAT_DISABLED',notSubmitted:true});}
  async delivery(payload,peer,fn){const target=this.deliveryTarget(payload,peer);if(!target)throw Object.assign(new Error('普通聊天配置已变更'),{code:'CHAT_DISABLED',notSubmitted:true});return operationContext.run({signal:this.controller(target).signal,guard:()=>this.guard(payload,peer),delivery:{submitted:false}},fn);}
  receipt(row,stage){const chat=this.get(row.peer);if(!chat||chat.revision!==row.revision)return;const message=JSON.parse(row.body);this.store.enqueueReply(row.peer,'',{kind:'progress_reaction',priority:100,payload:{chatbot:true,botId:row.id,chatRevision:row.revision,messageId:message.id,stage,emojis:progressEmoji[stage]},dedupe:'bot-reaction:'+row.id+':'+stage});}
  ingest(chat,m,{since=this.armedAt,recover=false}={}){
    if(!acceptsChatMessage(m,chat,since)||this.get(chat.chatKey)?.revision!==chat.revision)return false;
    const id=chat.chatKey+':'+m.id;if(this.store.db.prepare('SELECT 1 FROM bot_messages WHERE id=?').get(id))return false;
    const fresh=this.seen(chat.chatKey,m.id);if(!fresh&&!recover)return false;
    const queue=this.store.db.prepare("SELECT count(*) n FROM bot_messages WHERE peer=? AND status IN ('new','preparing','submitted','replying')").get(chat.chatKey).n;
    const status=queue>=30?'blocked':'new',body={id:m.id,kind:m.kind,text:String(m.text||'').slice(0,6000),title:String(m.title||'').slice(0,800),sender:m.sender,replyTo:m.replyTo||null};
    const added=this.store.db.prepare('INSERT OR IGNORE INTO bot_messages VALUES(?,?,?,?,?,?,\'\',\'\',?,?)').run(id,chat.chatKey,chat.revision,JSON.stringify(body),status,status==='blocked'?'本聊天待处理消息过多，已停止追加模型调用':'',Date.now(),Date.now()).changes;
    if(added)this.receipt({id,peer:chat.chatKey,revision:chat.revision,body:JSON.stringify(body)},'roger');return !!added;
  }
  async recover(key){
    const chat=this.get(String(key));if(!this.store.config.enabled||!chat?.enabled||chat.mode!=='chat')throw new Error('请先开启该普通聊天的监听');
    const scan=await this.adapter.scanPeer(chat);if(!sameChat(scan.peer,chat))throw new Error('未能核验已启用的聊天身份，未补收');
    let recovered=0;const since=Math.max(chat.enabledAt||Date.now(),Date.now()-30*60*1000);
    for(const m of scan.messages)if(this.ingest(chat,m,{since,recover:true}))recovered++;
    return {recovered};
  }
  async scan(){
    if(!this.store.config.enabled||!this.armedAt||this.scanning||this.adapter.selecting)return;const bots=this.bots();if(!bots.length)return;const chat=bots[this.cursor++%bots.length];this.scanning=true;
    try{const scan=await this.adapter.scanPeer(chat);if(!sameChat(scan.peer,chat)){this.warn(chat,'聊天身份、类型或助手账号不一致，普通聊天保持暂停');return;}for(const m of [...scan.messages].sort((a,b)=>a.created-b.created)){
      this.ingest(chat,m);
    }}catch(e){this.warn(chat,'普通聊天暂未连接：'+e.message);}finally{this.scanning=false;}
  }
  warn(chat,reason){this.warnings||=new Map();if(this.warnings.get(chat.chatKey)?.reason===reason&&Date.now()-this.warnings.get(chat.chatKey).at<60000)return;this.warnings.set(chat.chatKey,{reason,at:Date.now()});this.store.event(reason,'attention');}
  async process(){
    this.reconcile();if(!this.store.config.enabled||this.running.size>=2)return;
    const rows=this.store.db.prepare("SELECT * FROM bot_messages WHERE status='new' ORDER BY created LIMIT 30").all();
    for(const row of rows){if(this.running.size>=2)break;if(this.running.has(row.peer))continue;const chat=this.get(row.peer);if(!chat?.enabled||chat.mode!=='chat'||chat.revision!==row.revision){this.set(row.id,'cancelled','聊天配置已变更');continue;}const work=this.run(row,chat);this.running.set(row.peer,work);work.catch(e=>this.warn(chat,'普通聊天未完成：'+e.message)).finally(()=>this.running.delete(row.peer));}
  }
  set(id,status,result){if(result===undefined)this.store.db.prepare('UPDATE bot_messages SET status=?,updated=? WHERE id=?').run(status,Date.now(),id);else this.store.db.prepare('UPDATE bot_messages SET status=?,result=?,updated=? WHERE id=?').run(status,String(result).slice(0,12000),Date.now(),id);}
  context(row){const history=this.store.db.prepare("SELECT body,result FROM bot_messages WHERE peer=? AND revision=? AND status='done' AND id<>? ORDER BY created DESC LIMIT 6").all(row.peer,row.revision,row.id).reverse().map(r=>({user:JSON.parse(r.body),reply:r.result.slice(0,2000)}));while(JSON.stringify(history).length>10000)history.shift();const body=JSON.parse(row.body);let quoted;
    if(body.replyTo?.messageId){const link=this.store.db.prepare("SELECT o.payload FROM outgoing_message_links l JOIN outbox o ON o.id=l.outbox_id WHERE l.peer=? AND l.platform_id=?").get(row.peer,body.replyTo.messageId);if(link){const p=JSON.parse(link.payload);if(p.chatbot&&p.chatRevision===row.revision){const origin=this.store.db.prepare("SELECT body,result FROM bot_messages WHERE id=? AND peer=? AND status='done'").get(p.botId,row.peer);if(origin)quoted={user:JSON.parse(origin.body),reply:origin.result.slice(0,8000)};}}}
    return {conversation:this.get(row.peer)?.type==='group'?'群聊中直接 @ 助手的交流':'普通单聊',recent:history,...(quoted?{quotedFeedback:quoted}:{}),message:body,...(body.kind==='video'?{attachmentNote:'只收到视频分享卡片的标题，没有观看画面或口播。不得冒充已看过视频。此模式无下载或视频分析工具。'}:{})};
  }
  async run(row,chat){
    this.set(row.id,'preparing');let submitted=false;
    try{const config=await this.preferences.chatWork();const result=await this.sandbox.reply(this.context(row),{...config,signal:this.controller(chat).signal,onSubmitted:({thread})=>{this.guard({chatbot:true,chatRevision:row.revision},row.peer);this.store.db.prepare("UPDATE bot_messages SET status='submitted',thread=?,updated=? WHERE id=?").run(thread,Date.now(),row.id);submitted=true;},onStarted:({turn})=>{this.store.db.prepare('UPDATE bot_messages SET turn=?,updated=? WHERE id=?').run(turn,Date.now(),row.id);this.receipt(row,'active');}});
      this.guard({chatbot:true,chatRevision:row.revision},row.peer);const text=toPlainChatText(result.text).slice(0,10000),parts=splitReply(text),group=randomUUID();if(!parts.length)throw new Error('模型没有返回文字');
      this.store.db.exec('BEGIN IMMEDIATE');try{this.set(row.id,'replying',text);for(const [i,part] of parts.entries())this.store.enqueueReply(row.peer,(parts.length>1?`回复 ${i+1}/${parts.length} 段${i===parts.length-1?'（末段）':''}\n\n`:'')+part,{payload:{chatbot:true,botId:row.id,chatRevision:row.revision,plainText:true,group,segment:i+1,totalSegments:parts.length},dedupe:'bot-result:'+row.id+':'+i});this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }catch(e){const valid=this.get(row.peer)?.revision===row.revision;this.set(row.id,!valid?'cancelled':submitted&&e.uncertain?'uncertain':'failed',!valid?'聊天已停用，未交付本轮结果':submitted&&e.uncertain?'暂时无法确认运行状态，不会自动重跑':e.authKind?'本机 Codex 登录或额度暂不可用；处理结果保留在面板':String(e.message).slice(0,400));}
  }
  reconcile(){for(const row of this.store.db.prepare("SELECT * FROM bot_messages WHERE status IN ('replying','delivery_uncertain')").all()){const sent=this.store.db.prepare("SELECT status FROM outbox WHERE kind='text' AND json_extract(payload,'$.botId')=?").all(row.id);if(sent.length&&sent.every(s=>s.status==='sent')){this.set(row.id,'done');this.receipt(row,'done');}else if(sent.some(s=>s.status==='uncertain'))this.set(row.id,'delivery_uncertain');else if(sent.some(s=>s.status==='pending')&&row.status==='delivery_uncertain')this.set(row.id,'replying');}}
  stop(){for(const c of this.controllers.values())c.abort();this.sandbox.close();}
}
