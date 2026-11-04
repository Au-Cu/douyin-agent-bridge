import {attachmentBatch,addAttachmentCaption,bufferAttachmentCaption} from './attachment-batch.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {toPlainChatText} from './chat-text.mjs';
import {splitReply} from './engine.mjs';
import {progressEmoji} from './progress.mjs';
import {operationContext} from './execution.mjs';
import {matchesPeer} from './douyin.mjs';

export function chatFailureText(error,{model}={}){
  const suffix=model?'（模型：'+model+'）':'';
  if(error.authKind==='quota')return '普通聊天连接报告额度限制'+suffix+'；可在面板重新连接。新消息会重新核验登录，已提交任务不会自动重跑';
  if(error.authKind==='login')return '普通聊天连接认证失效'+suffix+'；新消息会重新读取本机登录，已提交任务不会自动重跑';
  if(error.authKind==='pending')return '本机登录已变更，正在等待当前任务结束后重新连接'+suffix;
  return String(error.message).slice(0,400);
}

export const sameChat=matchesPeer;
export function acceptsChatMessage(message,chat,since){
  return chat.enabled&&chat.mode==='chat'&&message.direction==='in'&&message.conversation===chat.chatKey&&message.sender&&message.sender!==chat.selfUid&&message.created>0&&message.created>=Math.max(since,chat.enabledAt||0,chat.replyModeChangedAt||0,chat.contextReset?.at||0,chat.deliveryResumedAt||0)-1500&&['text','video'].includes(message.kind)&&(chat.type==='group'?!!chat.selfUid&&(chat.groupReplyMode==='all'||Array.isArray(message.mentionedUids)&&message.mentionedUids.includes(chat.selfUid)):message.sender===chat.peerUid);
}
export class Chats {
  constructor({store,adapter,sandbox,preferences,account,canChangeAgent=()=>true}){
    Object.assign(this,{store,adapter,sandbox,preferences,account,canChangeAgent});this.running=new Map();this.controllers=new Map();this.resetting=new Set();this.scanning=false;this.cursor=0;this.armedAt=0;this.observations=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,peer TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',thread TEXT NOT NULL DEFAULT '',turn TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_seen(peer TEXT NOT NULL,platform_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(peer,platform_id));
      CREATE INDEX IF NOT EXISTS bot_peer_history ON bot_messages(peer,created);
      UPDATE bot_messages SET status='new' WHERE status='preparing';
      UPDATE bot_messages SET status='uncertain',result='上次已提交但结果未核实，不会自动重跑' WHERE status='submitted';`);
    if(!Array.isArray(store.config.aiChats))store.saveConfig({aiChats:[]});this.refreshBrowserMode();
  }
  all(){const chats=[...this.store.config.aiChats],owner=this.store.config.owner;if(owner&&!chats.some(c=>c.chatKey===owner.chatKey))chats.unshift({...owner,type:'single',mode:'agent',enabled:true,revision:'legacy-owner',legacy:true});return chats;}
  list(){const uid=this.account?.();return this.all().filter(c=>c.mode!=='chat'||!this.account||!!uid&&c.selfUid===uid);}
  get(key){return this.list().find(c=>c.chatKey===key);}
  inactiveKeys(){const uid=this.account?.();return this.account?this.store.config.aiChats.filter(c=>!uid||c.selfUid!==uid).map(c=>c.chatKey):[];}
  isInactive(key){return this.inactiveKeys().includes(key);}
  scopedPeer(peer){
    if(!this.account)return peer;
    const saved=this.store.config.aiChats.find(c=>c.selfUid===peer.selfUid&&(c.platformChatKey||c.chatKey)===peer.chatKey),owner=this.store.config.owner;
    if(saved)return {...peer,chatKey:saved.chatKey,...(saved.platformChatKey?{platformChatKey:saved.platformChatKey}:{})};
    if(owner?.selfUid===peer.selfUid&&owner.chatKey===peer.chatKey)return peer;
    return {...peer,platformChatKey:peer.chatKey,chatKey:'chat:'+createHash('sha256').update(JSON.stringify([peer.selfUid,peer.chatKey])).digest('hex')};
  }
  agentEnabled(){const owner=this.store.config.owner;return !!owner&&this.get(owner.chatKey)?.enabled&&this.get(owner.chatKey)?.mode==='agent';}
  bots(){return this.list().filter(c=>c.enabled&&c.mode==='chat');}
  refreshBrowserMode(){this.adapter.multiple=this.all().some(c=>c.mode==='chat'&&c.enabled);}
  state(historyPeer=''){
    const chats=this.list(),inactive=new Set(this.inactiveKeys()),keys=JSON.stringify(chats.filter(c=>!inactive.has(c.chatKey)).map(c=>c.chatKey));
    return {chats:chats.map(c=>({...c,...(c.type==='group'&&this.sessions?{sessions:this.sessions.state(c.chatKey)}:{})})),accountVerified:!this.account||!!this.account(),selecting:!!this.adapter.selecting&&this.adapter.selectionKind!=='self',messages:this.store.db.prepare("SELECT id,peer,status,result,thread,turn,created,updated,body FROM bot_messages WHERE status<>'merged_attachment' AND (?='' OR peer=?) AND (?=0 OR peer IN (SELECT value FROM json_each(?))) ORDER BY created DESC LIMIT 25").all(historyPeer,historyPeer,Number(!!this.account),keys).map(({body,...r})=>({...r,...(historyPeer?{input:JSON.parse(body).text||JSON.parse(body).title||''}:{}),sessionId:this.sessions?.forMessage(r.id)?.id,recipientVisibility:this.recipientVisibility(r.id),canRetry:r.status==='failed'&&!r.thread&&!r.turn,name:this.get(r.peer)?.displayName||'已停用聊天',deliveryIssue:r.status==='replying'?this.store.db.prepare("SELECT error FROM outbox WHERE status='pending' AND kind='text' AND error<>'' AND json_extract(payload,'$.botId')=? ORDER BY rowid LIMIT 1").get(r.id)?.error?.split('\n')[0]:undefined,uncertainReplies:this.store.db.prepare("SELECT id FROM outbox WHERE kind='text' AND status='uncertain' AND json_extract(payload,'$.botId')=?").all(r.id).map(o=>o.id)}))};
  }
  beginSelection(){return this.adapter.selection?.(true);}
  endSelection(){this.adapter.selection?.(false);}
  async observe(){
    const scan=await this.adapter.scan(),peer=scan.peer,owner=this.store.config.owner;
    if(!peer||!peer.chatKey||!peer.peerUid||scan.loginRequired)throw new Error('请先在抖音窗口打开目标聊天');
    if(peer.selfChat)throw new Error('自聊请使用连接助手中的「绑定自己」');
    if(peer.chatKey.startsWith('peer:'))throw new Error('没有取得稳定的抖音聊天 ID，暂不允许启用');
    const legacy=owner?.chatKey===peer.chatKey&&owner.peerUid===peer.peerUid&&peer.type==='unknown';
    if(!['single','group'].includes(peer.type)&&!legacy)throw new Error('未能核验单聊或群聊类型，暂不允许启用；请在该聊天发一条普通消息后重新读取');
    if(!peer.selfUid)throw new Error('无法核验助手账号身份，请从助手账号在该聊天手动发一条普通消息，再重新读取');
    const token=randomUUID(),value={...this.scopedPeer(peer),type:legacy?'single':peer.type,...(legacy?{legacy:true}:{}),token};this.observations.set(token,{value,seen:scan.messages.map(m=>m.id),expires:Date.now()+5*60*1000});
    for(const [key,v] of this.observations)if(v.expires<Date.now())this.observations.delete(key);return value;
  }
  configure({token,chatKey,mode,enabled,groupReplyMode,videoOverview,videoMaxSeconds}){
    if(!['agent','chat'].includes(mode)||typeof enabled!=='boolean')throw new Error('请选择个人 Agent 或普通聊天 AI，并明确启用状态');
    const observed=token&&this.observations.get(token),old=this.get(String(chatKey||observed?.value.chatKey||''));
    if(token&&(!observed||observed.expires<Date.now()))throw new Error('聊天身份已过期，请重新读取当前聊天');
    const peer=observed?.value||old;if(!peer)throw new Error('请先从实际打开的抖音聊天读取身份');
    if(mode==='chat'&&this.account&&(!peer.selfUid||peer.selfUid!==this.account()))throw new Error('抖音登录账号已退出或变化，请重新读取聊天');
    if(groupReplyMode!==undefined&&(!['mentions','all'].includes(groupReplyMode)||peer.type!=='group'))throw new Error('群聊回复范围只能选择仅被 @ 时回复或回复所有新消息');
    const replyMode=peer.type==='group'?(groupReplyMode??old?.groupReplyMode??'mentions'):'mentions';
    if(videoOverview!==undefined&&(typeof videoOverview!=='boolean'||peer.type!=='group'||mode!=='chat'))throw new Error('轻量看视频仅能在普通群聊中配置');
    const videoLimit=Number(videoMaxSeconds??old?.videoMaxSeconds??120);if(!Number.isInteger(videoLimit)||videoLimit<15||videoLimit>300)throw new Error('群聊视频上限为 15–300 秒');
    const videoSettings={videoOverview:videoOverview??old?.videoOverview??false,videoMaxSeconds:videoLimit};
    const owner=this.store.config.owner,isOwner=owner?.chatKey===peer.chatKey&&owner?.peerUid===peer.peerUid;
    if(mode==='agent'&&(!isOwner||peer.type==='group'))throw new Error('个人 Agent 使用现有绑定用户的单聊；其他单聊或群聊请选择普通聊天 AI');
    if(enabled&&mode==='chat'&&(!peer.selfUid||!['single','group'].includes(peer.type)))throw new Error('普通聊天的账号或聊天类型尚未核验，请重新读取');
    if(isOwner&&(old?.mode!==mode||old?.enabled!==enabled)&&!this.canChangeAgent())throw new Error('个人 Agent 仍有任务或回复正在执行，请先完成或中断后更改模式');
    if(enabled&&!old?.enabled&&this.list().filter(c=>c.enabled).length>=20)throw new Error('最多同时启用 20 个聊天，请先停用不需要的聊天');
    if(old&&old.mode===mode&&old.enabled===enabled&&sameChat(peer,old)){
      // A trigger-policy change affects future messages only. Keep the current
      // reply, revision and context instead of cancelling work already running.
      const entry={...old,...videoSettings,groupReplyMode:replyMode,...((old.groupReplyMode||'mentions')!==replyMode?{replyModeChangedAt:Date.now()}:{})};
      this.store.saveConfig({aiChats:[...this.store.config.aiChats.filter(c=>c.chatKey!==entry.chatKey),entry]});this.endSelection();return entry;
    }
    const revision=randomUUID(),entry={chatKey:peer.chatKey,...(peer.platformChatKey?{platformChatKey:peer.platformChatKey}:{}),peerUid:peer.peerUid,displayName:String(peer.displayName||'抖音聊天').slice(0,150),type:peer.type,selfUid:peer.selfUid||'',deliveryPaused:old?.deliveryPaused===true,deliveryPauseReason:old?.deliveryPauseReason||'',deliveryResumedAt:old?.deliveryResumedAt||0,contextReset:old?.contextReset,legacy:!!peer.legacy,mode,enabled,...videoSettings,groupReplyMode:replyMode,enabledAt:enabled?Date.now():old?.enabledAt||0,revision};
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
  fenceContext(peer){
    const old=this.get(peer);if(!old||old.type!=='group'||old.mode!=='chat')throw new Error('只能清空已配置的普通群聊');
    const revision=randomUUID(),at=Date.now(),contextReset={id:randomUUID(),at,previousRevision:old.revision};
    const chat={...old,revision,contextReset};this.store.saveConfig({aiChats:this.store.config.aiChats.map(c=>c.chatKey===peer?chat:c)});
    // The durable revision fence precedes interruption and any new native chat.
    // Old uncertain sends remain intact; they can be reviewed without replay.
    this.store.db.prepare("UPDATE bot_messages SET status='cancelled',updated=? WHERE peer=? AND revision<>? AND status IN ('new','preparing','replying','delivery_uncertain','held','blocked')").run(at,peer,revision);
    this.store.db.prepare("UPDATE bot_messages SET status='uncertain',updated=? WHERE peer=? AND revision<>? AND status='submitted'").run(at,peer,revision);
    for(const o of this.store.db.prepare("SELECT id,status,payload FROM outbox WHERE peer=? AND json_extract(payload,'$.chatbot')=1 AND status IN ('pending','held','sending','uncertain')").all(peer)){
      if(JSON.parse(o.payload).chatRevision===revision)continue;this.store.mergeOutboxPayload(o.id,{contextReset});if(['pending','held'].includes(o.status))this.store.delivery(o.id,'superseded','用户清空上下文，旧回复停止发送；原文保留');
    }
    const work=this.running.get(peer);this.controllers.get(peer)?.abort();this.controllers.delete(peer);if(work)this.running.delete(peer);return {chat,work};
  }
  deliveryTarget(payload,peer){const chat=this.get(peer);return payload.chatbot&&chat?.enabled&&chat.mode==='chat'&&chat.revision===payload.chatRevision?chat:null;}
  guard(payload,peer){
    if(this.isInactive(peer))throw Object.assign(new Error('所属抖音账号当前未登录'),{code:'CHAT_ACCOUNT_INACTIVE',notSubmitted:true});
    if(!this.deliveryTarget(payload,peer))throw Object.assign(new Error('此普通聊天已停用或切换模式，回复已停止'),{code:'CHAT_DISABLED',notSubmitted:true});
  }
  pauseDelivery(peer,paused,reason='用户暂停本群自动回复'){
    const chat=this.get(peer);if(!chat||chat.type!=='group'||chat.mode!=='chat'||typeof paused!=='boolean')throw new Error('只能暂停或恢复已配置的普通群聊');
    const next={...chat,deliveryPaused:paused,deliveryPauseReason:paused?String(reason).slice(0,250):'',...(paused?{deliveryPausedAt:Date.now()}:{deliveryResumedAt:Date.now()})};this.store.saveConfig({aiChats:this.store.config.aiChats.map(c=>c.chatKey===peer?next:c)});
    if(paused){this.store.db.prepare("UPDATE outbox SET status='held',error='本群自动回复已暂停，原文保留' WHERE peer=? AND status='pending' AND json_extract(payload,'$.chatbot')=1").run(peer);this.store.db.prepare("UPDATE bot_messages SET status='held',updated=? WHERE peer=? AND status IN ('new','replying')").run(Date.now(),peer);}return next;
  }
  async delivery(payload,peer,fn){const guard=()=>{this.guard(payload,peer);if(this.get(peer)?.deliveryPaused)throw Object.assign(new Error('本群自动回复已暂停，保留发送现场'),{code:'CHAT_DELIVERY_PAUSED',notSubmitted:true});};guard();const target=this.deliveryTarget(payload,peer);return operationContext.run({signal:this.controller(target).signal,guard,delivery:{submitted:false}},fn);}
  receipt(row,stage){
    const chat=this.get(row.peer);if(!chat||chat.revision!==row.revision)return;
    const message=JSON.parse(row.body);
    for(const [i,part] of [message,...(message.attachmentCaptions||[])].entries()){
      if(stage==='roger'&&part.rogerQueued)continue;
      this.store.enqueueReply(row.peer,'',{kind:'progress_reaction',priority:100,payload:{chatbot:true,botId:row.id,chatRevision:row.revision,messageId:part.id,stage,emojis:progressEmoji[stage]},dedupe:'bot-reaction:'+row.id+':'+stage+(i?':'+part.id:'')});
    }
  }
  mergeAttachmentCaption(chat,id,body){
    if(body.kind!=='text'||!body.sender)return false;
    const db=this.store.db,root=db.prepare("SELECT * FROM bot_messages WHERE peer=? AND revision=? AND status<>'merged_attachment' AND json_extract(body,'$.sender')=? ORDER BY created DESC,rowid DESC LIMIT 1").get(chat.chatKey,chat.revision,body.sender);
    if(!root||root.status!=='new')return false;
    const merged=addAttachmentCaption(JSON.parse(root.body),body);
    if(!merged)return false;
    db.exec('BEGIN IMMEDIATE');
    try{
      root.body=JSON.stringify(merged);
      db.prepare('UPDATE bot_messages SET body=? WHERE id=?').run(root.body,root.id);
      db.prepare("INSERT OR IGNORE INTO bot_messages VALUES(?,?,?,?,'merged_attachment',?,'','',?,?)").run(id,chat.chatKey,chat.revision,JSON.stringify(body),root.id,Date.now(),Date.now());
      this.receipt(root,'roger');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return true;
  }
  ingest(chat,m,{since=this.armedAt,recover=false}={}){
    if(!acceptsChatMessage(m,chat,since)||this.get(chat.chatKey)?.revision!==chat.revision)return false;
    if(chat.deliveryPaused){this.seen(chat.chatKey,m.id);return false;}
    const id=chat.chatKey+':'+m.id;if(this.store.wasDeletedMessage(id)||this.store.db.prepare('SELECT 1 FROM bot_messages WHERE id=?').get(id))return false;
    const fresh=this.seen(chat.chatKey,m.id);if(!fresh&&!recover)return false;
    const queue=this.store.db.prepare("SELECT count(*) n FROM bot_messages WHERE peer=? AND status IN ('new','preparing','submitted','replying')").get(chat.chatKey).n;
    const status=queue>=30?'blocked':'new',attachment=attachmentBatch({id:m.id,kind:m.kind,created:m.created,text:String(m.text||'').slice(0,6000),title:String(m.title||'').slice(0,800),sender:m.sender,replyTo:m.replyTo||null,...(m.kind==='video'&&/^\d{12,24}$/.test(m.awemeId||'')?{awemeId:m.awemeId,...(m.nativeImageUrls?.length?{nativeImageUrls:m.nativeImageUrls}:{}),...(m.nativeLive?{nativeLive:true}:{})}:{})});
    const body=chat.videoOverview?bufferAttachmentCaption(attachment):attachment;
    if(this.mergeAttachmentCaption(chat,id,body))return true;
    const added=this.store.db.prepare('INSERT OR IGNORE INTO bot_messages VALUES(?,?,?,?,?,?,\'\',\'\',?,?)').run(id,chat.chatKey,chat.revision,JSON.stringify(body),status,status==='blocked'?'本聊天待处理消息过多，已停止追加模型调用':'',Date.now(),Date.now()).changes;
    if(added){
      const root={id,peer:chat.chatKey,revision:chat.revision,body:JSON.stringify(body)};
      if(body.kind==='video'&&status==='new')this.mergeEarlierAttachmentCaption(root,body);
      this.receipt(root,'roger');
    }
    return !!added;
  }
  mergeEarlierAttachmentCaption(root,body){
    const db=this.store.db,prior=db.prepare("SELECT * FROM bot_messages WHERE peer=? AND revision=? AND id<>? AND status<>'merged_attachment' AND json_extract(body,'$.sender')=? ORDER BY created DESC,rowid DESC LIMIT 1").get(root.peer,root.revision,root.id,body.sender);
    if(prior?.status!=='new')return;
    const caption=JSON.parse(prior.body);
    if(!(caption.attachmentTextWaitUntil>=Date.now()))return;
    const merged=addAttachmentCaption(body,caption,Date.now(),{early:true,rogerQueued:true});
    if(!merged)return;
    db.exec('BEGIN IMMEDIATE');
    try{
      root.body=JSON.stringify(merged);
      db.prepare('UPDATE bot_messages SET body=? WHERE id=?').run(root.body,root.id);
      this.set(prior.id,'merged_attachment',root.id);
      db.prepare("UPDATE outbox SET payload=json_set(payload,'$.botId',?) WHERE kind='progress_reaction' AND json_extract(payload,'$.botId')=?").run(root.id,prior.id);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
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
    try{const scan=await this.adapter.scanPeer(chat,{background:true});if(!scan)return;if(!sameChat(scan.peer,chat)){this.warn(chat,'聊天身份、类型或助手账号不一致，普通聊天保持暂停');return;}this.deliveryReview?.observe(scan);for(const m of [...scan.messages].sort((a,b)=>a.created-b.created)){
      this.ingest(chat,m);
    }}catch(e){this.warn(chat,'普通聊天暂未连接：'+e.message);}finally{this.scanning=false;}
  }
  warn(chat,reason){this.warnings||=new Map();if(this.warnings.get(chat.chatKey)?.reason===reason&&Date.now()-this.warnings.get(chat.chatKey).at<60000)return;this.warnings.set(chat.chatKey,{reason,at:Date.now()});this.store.event(reason,'attention');}
  async process(){
    this.reconcile();if(!this.store.config.enabled||this.running.size>=2)return;
    const rows=this.store.db.prepare("SELECT * FROM bot_messages WHERE status='new' AND peer IN (SELECT value FROM json_each(?)) ORDER BY created LIMIT 30").all(JSON.stringify(this.list().map(c=>c.chatKey)));
    for(const row of rows){if(this.running.size>=2)break;const body=JSON.parse(row.body);if(this.running.has(row.peer)||this.resetting.has(row.peer)||(body.attachmentWaitUntil||body.attachmentTextWaitUntil)>Date.now())continue;const chat=this.get(row.peer);if(!chat?.enabled||chat.mode!=='chat'||chat.revision!==row.revision){this.set(row.id,'cancelled','聊天配置已变更');continue;}if(chat.deliveryPaused)continue;const work=this.run(row,chat);this.running.set(row.peer,work);work.catch(e=>this.warn(chat,'普通聊天未完成：'+e.message)).finally(()=>{if(this.running.get(row.peer)===work)this.running.delete(row.peer);});}
  }
  set(id,status,result){if(result===undefined)this.store.db.prepare('UPDATE bot_messages SET status=?,updated=? WHERE id=?').run(status,Date.now(),id);else this.store.db.prepare('UPDATE bot_messages SET status=?,result=?,updated=? WHERE id=?').run(status,String(result).slice(0,12000),Date.now(),id);}
  context(row){const history=this.store.db.prepare("SELECT body,result FROM bot_messages WHERE peer=? AND revision=? AND status='done' AND id<>? ORDER BY created DESC LIMIT 6").all(row.peer,row.revision,row.id).reverse().map(r=>({user:JSON.parse(r.body),reply:r.result.slice(0,2000)}));while(JSON.stringify(history).length>10000)history.shift();const body=JSON.parse(row.body);let quoted;
    if(body.replyTo?.messageId){const link=this.store.db.prepare("SELECT o.payload FROM outgoing_message_links l JOIN outbox o ON o.id=l.outbox_id WHERE l.peer=? AND l.platform_id=?").get(row.peer,body.replyTo.messageId);if(link){const p=JSON.parse(link.payload);if(p.chatbot&&p.chatRevision===row.revision){const origin=this.store.db.prepare("SELECT body,result FROM bot_messages WHERE id=? AND peer=? AND status='done'").get(p.botId,row.peer);if(origin)quoted={user:JSON.parse(origin.body),reply:origin.result.slice(0,8000)};}}}
    const hideUrls=({nativeImageUrls,...visible})=>visible;
    const chat=this.get(row.peer);return {conversation:chat?.type==='group'?(chat.groupReplyMode==='all'?'群聊中的新消息，已由本机用户配置为回复所有新消息':'群聊中直接 @ 助手的交流'):'普通单聊',recent:history.map(item=>({...item,user:hideUrls(item.user)})),...(quoted?{quotedFeedback:{...quoted,user:hideUrls(quoted.user)}}:{}),message:hideUrls(body),...(body.kind==='video'?{attachmentNote:'只收到视频分享卡片的标题，没有观看画面或口播。不得冒充已看过视频。此模式无下载或视频分析工具。'}:{})};
  }
  async run(row,chat){
    this.set(row.id,'preparing');let submitted=false,config,session,resultText='';
    try{const harness=this.store.config.chatHarness||'codex',signal=this.controller(chat).signal;config=await this.preferences.chatWork(harness,chat);this.guard({chatbot:true,chatRevision:row.revision},row.peer);const material=await this.media?.prepare(row,chat,harness,config,signal);this.guard({chatbot:true,chatRevision:row.revision},row.peer);let input=this.context(row);
      if(material){delete input.attachmentNote;input.video=material.summary;}
      if(chat.type==='group'&&this.sessions)delete input.recent;
      const inputTokens=Buffer.byteLength(JSON.stringify(input),'utf8')+(material?.images.length||0)*700;
      if(chat.type==='group'&&this.sessions){session=await this.sessions.prepare(row,chat,harness,config,inputTokens);if(!session.tokens&&session.handoff)input.handoff=session.handoff;}
      const result=await this.sandbox.reply(input,{...config,harness,session,images:material?.images||[],signal,onSubmitted:({thread})=>{this.guard({chatbot:true,chatRevision:row.revision},row.peer);if(session)this.sessions.guard(session,chat);this.store.db.prepare("UPDATE bot_messages SET status='submitted',thread=?,updated=? WHERE id=?").run(thread,Date.now(),row.id);submitted=true;},onStarted:({turn})=>{this.store.db.prepare('UPDATE bot_messages SET turn=?,updated=? WHERE id=?').run(turn,Date.now(),row.id);this.receipt(row,'active');}});
      resultText=result.text;if(session)this.sessions.complete(session,result,inputTokens);
      this.queueResult(row,chat,result);
    }catch(e){const valid=this.get(row.peer)?.revision===row.revision,unknown=submitted&&e.uncertain;
      if(!unknown&&this.isInactive(row.peer)){
        this.set(row.id,submitted?'held':'new',resultText?toPlainChatText(resultText):'所属抖音账号已退出，本轮保留。');
        return;
      }
      if(session&&unknown)this.sessions.uncertain(session,e.message);this.set(row.id,unknown?'uncertain':!valid?'cancelled':'failed',unknown?'原回合状态尚未核实，保留现场，不自动重跑':!valid?resultText?'旧上下文的生成结果已保留，停止发送。\n\n'+toPlainChatText(resultText):'旧上下文已停止，不交付本轮结果':chatFailureText(e,config));if(session&&!valid&&(resultText||e.nativeTerminalStatus))this.sessions.settleRetired(session);}
  }
  queueResult(row,chat,result){
      this.guard({chatbot:true,chatRevision:row.revision},row.peer);const text=toPlainChatText(result.text).slice(0,10000),parts=splitReply(text),group=randomUUID();if(!parts.length)throw new Error('模型没有返回文字');
      this.store.db.exec('BEGIN IMMEDIATE');try{const currentChat=this.get(row.peer),paused=currentChat?.deliveryPaused||row.created<(currentChat?.deliveryResumedAt||0);this.set(row.id,paused?'held':'replying',text);for(const [i,part] of parts.entries()){const id=this.store.enqueueReply(row.peer,(parts.length>1?`回复 ${i+1}/${parts.length} 段${i===parts.length-1?'（末段）':''}\n\n`:'')+part,{payload:{chatbot:true,botId:row.id,chatRevision:row.revision,plainText:true,...(chat.type==='group'?{replyToMessageId:JSON.parse(row.body).id}:{}),group,segment:i+1,totalSegments:parts.length},dedupe:'bot-result:'+row.id+':'+i});if(paused)this.store.delivery(id,'held','本群自动回复已暂停，原文保留');}this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  recipientVisibility(id){const rows=this.store.db.prepare("SELECT payload FROM outbox WHERE kind='text' AND json_extract(payload,'$.botId')=?").all(id).map(o=>JSON.parse(o.payload).recipientVisibility?.state||'unknown');return rows.includes('reported_invisible')?'reported_invisible':rows.length&&rows.every(s=>s==='confirmed')?'confirmed':'unknown';}
  retryUnsubmitted(id){
    const row=this.store.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(String(id)),chat=row&&this.get(row.peer);
    if(!row||row.status!=='failed'||row.thread||row.turn)throw new Error('仅能重试有记录证明尚未提交给模型的失败消息');
    if(!chat?.enabled||chat.mode!=='chat'||chat.revision!==row.revision)throw new Error('原聊天已停用或配置变化，不能重试旧消息');
    this.set(row.id,'new','用户重试已确认未提交的消息，复用已完成的视频预处理');this.store.event('已恢复一条确认未提交的普通聊天消息；已提交或结果不明的消息未重跑。');return {ok:true};
  }
  reconcile(){for(const row of this.store.db.prepare("SELECT * FROM bot_messages WHERE status IN ('replying','delivery_uncertain','held') AND peer NOT IN (SELECT value FROM json_each(?))").all(JSON.stringify(this.inactiveKeys()))){const sent=this.store.db.prepare("SELECT status,payload FROM outbox WHERE kind='text' AND json_extract(payload,'$.botId')=?").all(row.id);if(sent.length&&sent.every(s=>s.status==='sent')){this.set(row.id,'done');this.receipt(row,'done');}else if(sent.some(s=>s.status==='uncertain'))this.set(row.id,'delivery_uncertain');else if(sent.some(s=>s.status==='held'))this.set(row.id,'held');else if(sent.some(s=>['pending','sending'].includes(s.status))&&row.status==='delivery_uncertain')this.set(row.id,'replying');else if(sent.some(s=>JSON.parse(s.payload||'{}').deliveryReview?.resolution==='abandoned'))this.set(row.id,'cancelled');}}
  stop(){for(const c of this.controllers.values())c.abort();this.sandbox.close();}
}
