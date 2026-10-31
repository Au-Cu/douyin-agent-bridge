import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { coordinatorTools } from './codex.mjs';
import { isOwnerMessage } from './douyin.mjs';
import { buildVideoContext,videoContextInstructions } from './video-context.mjs';
import { toPlainChatText } from './chat-text.mjs';
import {authFailure} from './codex-auth.mjs';
import {parseCommand,onOff,commandHelp} from './commands.mjs';
import {effortNames} from './preferences.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));

export function splitReply(text,max=450) {
  const normalized=String(text).trim();if(!normalized)return [];
  const chars=Array.from(normalized);const chunks=[];
  while(chars.length){
    let end=Math.min(max,chars.length);
    if(chars.length>max){
      const candidate=chars.slice(0,max).join('');const boundaries=[candidate.lastIndexOf('\n\n'),candidate.lastIndexOf('\n'),Math.max(candidate.lastIndexOf('。')+1,candidate.lastIndexOf('！')+1,candidate.lastIndexOf('？')+1)];
      const boundary=boundaries.find(b=>b>0&&Array.from(candidate.slice(0,b)).length>=max*.45)||0;
      if(boundary>0&&Array.from(candidate.slice(0,boundary)).length>=max*.45)end=Array.from(candidate.slice(0,boundary)).length;
    }
    const chunk=chars.splice(0,end).join('').trim();if(chunk)chunks.push(chunk);
  }
  return chunks;
}
export function parseDispatch(text,targets) {
  const match=String(text).match(/^\/(?:派|派给|dispatch)\s+([\s\S]+)$/i);if(!match)return null;
  const tail=match[1];
  const target=[...targets].sort((a,b)=>b.alias.length-a.alias.length).find(t=>tail.startsWith(t.alias+' '));
  if(!target)throw new Error('找不到目标别名。格式：/派给 控制台中设置的别名 具体任务');
  const instruction=tail.slice(target.alias.length).trim();if(!instruction)throw new Error('请补充具体任务');return {target,instruction};
}
export function mayDispatch(text) { return /派给|交给|发给|转交|安排|让.+(?:聊天|项目)|转发.*(?:任务|指令)/.test(String(text)); }

export class BridgeEngine {
  constructor({store,adapter,media,codex,visual,preferences=null,conversations=null}) {
    Object.assign(this,{store,adapter,media,codex,visual,preferences,conversations});this.armedAt=0;this.seen=new Set();this.busy=false;this.taskBusy=false;this.outboxBusy=false;this.visualProgress=null;
    codex.on('approval',request=>{this.store.event('Codex 有待确认操作，编号 '+request.id,'attention');this.reply('Codex 需要确认一项操作。请在本机控制台查看，或回复 /同意 '+request.id+'、/拒绝 '+request.id+'。');});
    this.authRecoveryPending=true;
    codex.on('auth-reconnected',()=>{this.authRecoveryPending=true;});
  }
  async createCoordinator() {
    if(this.conversations){const need=await this.conversations.create();return need.thread;}
    const id=await this.codex.createCoordinator(coordinatorTools);this.store.saveConfig({coordinator:id});this.store.event('已建立固定的 Codex 调度聊天');return id;
  }
  async arm(enabled,{resumeSince}={}) {
    if(!enabled){this.store.saveConfig({enabled:false});this.store.event('已暂停接收新指令；正在执行的任务保持原状态');return;}
    if(!this.store.config.owner)throw new Error('请先绑定主人的抖音会话');
    if(!this.store.config.coordinator)throw new Error('请先创建 Codex 调度聊天');
    const scan=await this.adapter.scan();
    if(scan.peer?.chatKey!==this.store.config.owner.chatKey||scan.peer?.peerUid!==this.store.config.owner.peerUid)throw new Error('请在抖音浏览器里选中主人的私信会话');
    if(resumeSince!==undefined&&(!Number.isFinite(resumeSince)||resumeSince<=0||resumeSince>Date.now()||Date.now()-resumeSince>30*60*1000))throw new Error('恢复监听的时间范围无效');
    this.armedAt=resumeSince??Date.now();
    this.seen=new Set(scan.messages.filter(m=>resumeSince===undefined||m.created<resumeSince-1500).map(m=>m.id));
    this.store.saveConfig({enabled:true});this.store.event(resumeSince===undefined?'监听已启动，现有历史消息已跳过':'监听已恢复，将补收本次更新期间的新消息');
  }
  reply(text,options) {
    const owner=this.store.config.owner;if(!owner)return;
    const plainOptions={...options,payload:{...options?.payload,plainText:true}};
    for(const part of splitReply(toPlainChatText(text)))this.store.enqueueReply(owner.chatKey,part,plainOptions);
  }
  notifyVideo(message,phase,{key}={}){
    const owner=this.store.config.owner;if(!owner||message.peer!==owner.chatKey)return;
    const titleChars=Array.from(String(message.title||'这条视频').replace(/\s+/g,' '));const title=titleChars.slice(0,28).join('')+(titleChars.length>28?'…':'');
    const body=phase==='queued'?`📥 已收到视频，已加入队列\n${title}\n\n前面的内容处理完后会开始分析。\n开始时会在这里告诉你。`:
      phase==='started'?`👌 已开始分析视频\n${title}\n\n正在逐段看画面，并结合口播。\n完成后会在这里回复。`:
      `👌 已收到视频\n${title}\n\n正在准备分析画面和口播。\n完成后会在这里回复。`;
    const dedupe=key||'video-receipt:'+message.id;
    const payload={phase,messageId:message.platformId||String(message.id).replace(owner.chatKey+':',''),awemeId:message.awemeId,mode:phase==='queued'?'text':this.store.config.ackMode||'auto'};
    const existing=this.store.outboxByDedupe(dedupe);
    if(existing){
      if(existing.status==='pending'){this.store.updatePendingOutbox(existing.id,{body,payload,priority:100});return;}
      if(phase!=='started'||JSON.parse(existing.payload).phase!=='queued')return;
      payload.mode='text';
      return this.store.enqueueReply(owner.chatKey,body,{kind:'video_ack',payload,priority:100,dedupe:dedupe+':started'});
    }
    return this.store.enqueueReply(owner.chatKey,body,{kind:'video_ack',payload,priority:100,dedupe});
  }
  async scan() {
    if(!this.store.config.enabled||this.scanBusy||this.adapter.sending)return;
    this.scanBusy=true;
    try{
    const scan=await this.adapter.scan();const owner=this.store.config.owner;
    for(const m of scan.messages) {
      if(this.seen.has(m.id))continue;this.seen.add(m.id);
      if(!isOwnerMessage(m,owner,this.armedAt))continue;
      const message={...m,platformId:m.id,id:owner.chatKey+':'+m.id,peer:owner.chatKey};
      if(this.store.incoming(message)){
        this.store.event('收到主人'+(m.kind==='video'?'分享的视频：'+(m.title||m.awemeId):'的私信指令'));
        if(m.kind==='video')this.notifyVideo(message,this.busy||this.store.pendingMessages().length>1?'queued':'received');
        this.handleControl(message);
      }
    }
    if(this.seen.size>10000)this.seen=new Set(scan.messages.map(m=>m.id));
    // Delivery has no dependency on downloading, transcription or model completion.
    this.deliver().catch(e=>this.store.event(e.message,'error'));
    }finally{this.scanBusy=false;}
  }
  handleControl(message) {
    if(message.kind!=='text')return false;
    const command=parseCommand(message.text);
    if(command&&((['approve','decline'].includes(command.name)&&!/^\d+$/.test(command.arg))||(['status','reconnect','help','settings'].includes(command.name)&&command.arg)||(command.name==='resume'&&command.arg&&!/^\d{12,24}$/.test(command.arg))||(command.name==='dispatch'&&!command.arg))){this.reply('命令参数不正确。发送 /帮助 查看用法；批准或拒绝需带操作编号。',{priority:90});this.store.messageStatus(message.id,'failed','命令参数无效');return true;}
    if(command&&!['status','approve','decline','resume','reconnect','dispatch'].includes(command.name)){
      this.store.messageStatus(message.id,'processing');
      this.controlTail=(this.controlTail||Promise.resolve()).catch(()=>{}).then(()=>this.handleSettingCommand(command)).then(text=>{this.reply(text,{priority:90});this.store.messageStatus(message.id,'done',text);}).catch(e=>{this.reply('指令未完成：'+e.message,{priority:90});this.store.messageStatus(message.id,'failed',e.message);});return true;
    }
    const approval=command&&['approve','decline'].includes(command.name)?['',command.name==='approve'?'同意':'拒绝',command.arg]:null;
    const status=command?.name==='status';
    const resume=command?.name==='resume'?['',command.arg]:null;
    const reconnect=command?.name==='reconnect';
    if(!approval&&!status&&!resume&&!reconnect)return false;
    try {
      if(approval){this.codex.approve(approval[2],approval[1]==='同意');this.reply('已处理该项确认。');}
      else if(reconnect){
        this.reply('正在重新读取本机 Codex 登录，抖音绑定和目标聊天保持原配置。',{priority:100});
        this.codex.reconnect().then(r=>this.reply(r.deferred?'当前任务仍在执行，将在结束后切换连接。':r.auth.status==='ready'?'已连接本机当前 Codex 登录。因登录或额度暂停的视频将从保存的进度续做。':r.auth.message,{priority:100})).catch(e=>this.reply(this.failureNotice(e,{video:false}),{priority:100}));
      }
      else if(resume){
        if(this.busy)this.reply('当前视频仍在分析，无需重复提交。发送 /状态 可以查看进度。',{priority:100});
        else{
          const item=this.findIncompleteVideo(resume[1]);
          if(!item)this.reply('没有找到需要续做的视频。你可以直接发来新视频或具体需求。',{priority:100});
          else{
            this.reply(`已安排继续分析「${item.title.slice(0,32)}」。${item.progress.status==='complete'?'全片视觉记录已保存，将继续整理总结。':`已完成的 ${item.progress.completedSegments}/${item.progress.totalSegments} 段会复用，接着看剩余画面。`}`,{priority:100});
            this.reanalyze(item.id,{notify:false,refreshAuth:true}).catch(()=>{});
          }
        }
      }
      else{
        const {counts}=this.store.snapshot();const v=this.visualProgress,partial=!this.busy&&this.findIncompleteVideo();
        const processing=this.busy?(v?`正在分析视频画面：${v.completed}/${v.total||'…'} 段。\n`:'正在处理视频或指令。\n'):partial?`最近视频尚未完成：${partial.progress.completedSegments}/${partial.progress.totalSegments} 段。发送 /继续视频 可续做。\n`:'';
        const auth=this.codex.authState,need=this.conversations?.needs.get(this.store.config.activeNeed);
        this.reply(`${need?'当前需求：'+need.title+' ('+need.id+')\n':''}${auth&&auth.status!=='ready'?(auth.message||'Codex 尚未连接')+'。\n':''}${processing}已保存视频 ${counts.knowledge} 条；任务排队 ${counts.queuedTasks} 条；执行中 ${counts.runningTasks} 条。${this.preferences?'\n\n'+this.preferences.describe():''}`,{priority:90});
      }
      this.store.messageStatus(message.id,'done');
    }catch(e){this.store.messageStatus(message.id,'failed',e.message);this.reply('指令未完成：'+e.message);}
    return true;
  }
  async handleSettingCommand(command){
    const {name,arg}=command;if(name==='help')return commandHelp;if(name==='unknown')return '未识别的命令，发送 /帮助 查看完整用法。';
    if(!this.preferences)throw new Error('此运行入口未启用配置服务');
    if(name==='settings')return this.preferences.describe();
    if(name==='find'){
      await this.conversations.ensureLegacy();const list=this.conversations.needs.directory(arg);
      return list.length?'需求目录\n'+list.map(n=>`${n.id}  ${n.title}\n${n.summary.slice(0,75)}`).join('\n\n')+'\n\n发送 /切换 需求ID 找回。':'还没有保存的需求。';
    }
    if(name==='new'){const n=await this.conversations.create(arg||'新需求'),resolved=this.conversations.resolveWaiting(n);return `已新建并切换：${n.title}\n需求 ID：${n.id}${resolved?'\n刚才待选择的消息会归入新需求继续处理。':''}`;}
    if(name==='switch'){
      if(!arg)throw new Error('格式：/切换 需求ID；用 /找 查看目录');const n=await this.conversations.switchTo(arg);
      const waiting=this.conversations.resolveWaiting(n);
      return `已切换：${n.title} (${n.id})${waiting?'\n刚才待选择的消息会归入此需求继续处理。':''}`;
    }
    if(!arg){
      if(name==='model'){const c=await this.preferences.catalog();return this.preferences.describe()+'\n\n可用模型\n'+c.models.map(m=>m.model+'  '+m.displayName).join('\n')+'\n\n用 /模型 完整ID 选择；/模型 默认 恢复默认。';}
      if(name==='effort'){const c=await this.preferences.catalog(),m=c.models.find(m=>m.model===(this.store.config.model||c.defaults.model));return '当前强度：'+(effortNames[this.store.config.reasoningEffort]||this.store.config.reasoningEffort||'Codex 默认')+'\n可用：'+m.supportedReasoningEfforts.map(e=>`${effortNames[e.reasoningEffort]||e.reasoningEffort} (${e.reasoningEffort})`).join('、');}
      return this.preferences.describe();
    }
    const patch=name==='model'?{model:arg,reasoningEffort:''}:name==='effort'?{reasoningEffort:arg}:name==='fast'?{fastMode:onOff(arg)}:name==='density'?{visualFps:Number(arg)}:name==='routing'?{autoRoute:onOff(arg)}:name==='budget'?{contextBudget:Number(arg)}:null;
    if(!patch)throw new Error('命令格式不正确，发送 /帮助 查看');await this.preferences.update(patch);return '设置已保存，从下一次调用起生效。\n'+this.preferences.describe();
  }
  async processNext() {
    if(!this.store.config.enabled)return;
    // Approval replies must be handled while the model is paused awaiting approval.
    for(const row of this.store.pendingMessages())if(this.handleControl(JSON.parse(row.body)))return;
    if(this.busy)return;
    this.resumeWaitingVideos();
    const row=this.store.pendingMessages()[0];if(!row)return;
    this.busy=true;let processing=false,route=null,phase='prepare';
    try {
      await this.codex.ensureAuthenticated?.();
      processing=true;this.store.messageStatus(row.id,'processing');
      const message=JSON.parse(row.body);
      if(this.conversations)await this.conversations.ensureLegacy();
      const capture=this.conversations?.capture();
      let learned=null;
      if(message.kind==='video') {
        this.notifyVideo(message,'started');
        await this.deliver();
        const existing=this.store.knowledge(message.awemeId);
        if(existing){learned=JSON.parse(await readFile(join(dirname(existing.path),'metadata.json'),'utf8'));learned.path=existing.path;this.store.event('复用已保存的视频资料，无需重复下载');}
        else {
          learned=await this.media.process(message,this.store.config.maxVideoSeconds);
          this.store.addKnowledge({...learned,summary:''});
        }
        await this.analyzeVisual(learned);
      }
      if(this.conversations){
        phase='routing';route=await this.conversations.prepare(message,{learned,capture});
        if(route.clarify){this.store.messageStatus(row.id,'waiting_route',route.question);this.reply(route.question+'\n可用 /找 查看目录，再用 /切换 需求ID 明确选择，或 /新建 标题。',{priority:90});return;}
      }
      phase='work';
      const direct=message.kind==='text'?parseDispatch(message.text,this.store.config.targets):null;
      if(direct) {
        const id=this.dispatch(direct.target.alias,direct.instruction,message.text,{needId:route?.needId});
        const queued='任务已排队给「'+direct.target.alias+'」，编号 '+id.slice(0,8)+'。执行完成后会回到这里。';this.reply(queued);
        if(route){const needId=this.conversations.record(row.id,queued);await this.conversations.refreshMemory(needId);}
        this.store.messageStatus(row.id,'done',id);return;
      }
      const related=learned?[learned]:route?this.conversations.related(route.needId,'',3):this.store.search('',3);
      const instruction=message.kind==='video'?'学习这条视频，综合完整视觉记录与口播。':message.text;
      const allowDispatch=message.kind==='text'&&mayDispatch(message.text);
      const references=related.map(k=>({id:k.id,title:k.title,path:k.path,visualPath:join(dirname(k.path),'visual-analysis.md'),...(learned?{source:k.source,transcript:k.transcript,visualObservations:k.visual?.notes}:{summary:k.summary?.slice(0,1800)})}));
      const prompt=`主人指示：${instruction}\n允许派发：${allowDispatch?'是':'否'}${allowDispatch?'\n可用目标：'+JSON.stringify(this.store.config.targets.map(t=>t.alias)):''}${references.length?'\n本轮资料：\n'+JSON.stringify(references):''}`;
      let input=[{type:'text',text:prompt}],inputTokens=0;
      if(route){const prepared=await this.conversations.prepareInput(route,input,message);route=prepared.route;input=prepared.input;inputTokens=prepared.inputTokens;}
      const result=await this.codex.run(route?.threadId||this.store.config.coordinator,input,{assistant:true,...(this.preferences?await this.preferences.work():{effort:learned?'medium':undefined}),toolHandler:async call=>{
        if(call.tool==='need_context')return route?this.conversations.context(route):{notice:'尚未按需求分组'};
        if(call.tool==='knowledge_search')return (route?this.conversations.related(route.needId,call.arguments.query):this.store.search(call.arguments.query)).map(k=>({...k,transcript:k.transcript.slice(0,16000),visualAnalysis:this.visualText(k).slice(0,24000),visualPath:join(dirname(k.path),'visual-analysis.md')}));
        if(call.tool==='dispatch_task'){
          if(!allowDispatch)throw new Error('本轮没有主人明确的派发指示');
          const id=this.dispatch(call.arguments.alias,call.arguments.instruction,message.text,{needId:route?.needId});return {status:'queued',taskId:id,alias:call.arguments.alias};
        }
        throw new Error('未知工具');
      }});
      if(learned){this.store.addKnowledge({...learned,summary:result.text});await appendFile(learned.path,'\n## Codex 学习整理\n\n'+result.text+'\n');}
      this.reply(result.text,learned?{payload:{videoId:learned.id,phase:'summary'}}:undefined);this.store.messageStatus(row.id,'done',result.text);
      if(route){const needId=this.conversations.record(row.id,result.text,result.tokenUsage,inputTokens);await this.conversations.refreshMemory(needId);const n=this.conversations.needs.get(needId);if(n.context_tokens>=this.store.config.contextBudget)await this.conversations.rollover(n).catch(()=>{});}
    } catch(e){
      const auth=authFailure(e);
      if(!processing&&auth){
        const key=row.id+':'+auth;if(this.authNoticeKey!==key){this.authNoticeKey=key;this.reply(this.failureNotice(e,{video:row.kind==='video'}),{priority:90});}
      }else{
        this.store.messageStatus(row.id,row.kind==='video'&&auth?'waiting_auth':phase==='routing'&&!auth?'waiting_route':'failed',e.message);
        if(route?.needId)this.conversations.needs.complete(row.id,e.message,e.uncertain?'uncertain':'failed');
        this.store.event(auth?'Codex 登录或额度暂不可用，进度已保留':e.message,'error');this.reply(this.failureNotice(e,{video:row.kind==='video'}));
      }
    }
    finally {this.busy=false;}
  }
  visualText(item){try{return readFileSync(join(dirname(item.path),'visual-analysis.md'),'utf8');}catch{return '';}}
  findIncompleteVideo(id){
    const items=id?[this.store.knowledge(id)].filter(Boolean):this.store.search('',35);
    for(const item of items){try{const progress=JSON.parse(readFileSync(join(dirname(item.path),'visual-report.json'),'utf8'));const waiting=this.store.db.prepare("SELECT 1 FROM messages WHERE kind='video' AND status='waiting_auth' AND json_extract(body,'$.awemeId')=? LIMIT 1").get(item.id);if(progress.status!=='complete'||waiting)return {...item,progress};}catch{}}
    return null;
  }
  failureNotice(error,{video=true}={}){
    const v=video?this.visualProgress:null;const progress=v?`已完成的 ${v.completed}/${v.total||'…'} 段视觉记录已保存。\n`:'';
    const kind=authFailure(error);
    if(kind)return `${kind==='quota'?'Codex 当前可用额度不足。':kind==='pending'?'正在等待当前任务结束，以切换 Codex 登录。':'Codex 登录已失效，可能刚在本机切换了账号。'}\n${progress}\n请在本机 Codex 完成登录。检测到登录更新后会自动连接${video?'并续做视频':''}；也可在这里发送 /重新连接${video?' 或 /继续视频':''}。${video?'无需再次转发。':'已经提交的任务不会自动重复执行。'}`;
    return `这次处理未完成：${String(error.message).slice(0,450)}\n${progress}${v?'发送 /继续视频 可以续做。':''}`.trim();
  }
  notifyVideoStatus(id){
    const item=this.findIncompleteVideo(id);if(!item)throw new Error('此视频不需要发送未完成提示');
    const p=item.progress;const quota=/usage limit|quota|insufficient_quota/i.test(p.error||'');
    const body=`视频「${item.title.replace(/\s+/g,' ').slice(0,34)}」\n已分析 ${p.completedSegments}/${p.totalSegments} 段，覆盖至 ${p.coveredUntil.toFixed(1)}/${p.duration.toFixed(1)} 秒。\n\n${quota?'上次因 Codex 额度不足暂停，进度已保存。':'分析暂未完成，已完成进度已保存。'}\n在这里发送 /继续视频，即可尝试接着看剩余画面。`;
    return this.store.enqueueReply(this.store.config.owner.chatKey,body,{priority:100,dedupe:'video-status:'+id+':'+p.updated});
  }
  async analyzeVisual(learned){
    if(!this.visual)throw new Error('全时段视觉分析组件未连接，不能只根据口播完成学习');
    const fps=this.store.config.visualFps||4;
    this.visualProgress={id:learned.id,fps,completed:0,total:0};
    learned.visual=await this.visual.analyze(learned,{fps,onProgress:(completed,total)=>{this.visualProgress={id:learned.id,fps,completed,total};}});
    if(learned.visual.status!=='complete')throw new Error('视觉观察没有覆盖全片，暂不生成完整学习结论');
  }
  resumeWaitingVideos(){
    if(!this.authRecoveryPending||this.codex.authState?.status!=='ready')return;
    this.authRecoveryPending=false;
    const rows=this.store.db.prepare("SELECT id FROM messages WHERE kind='video' AND status='waiting_auth' ORDER BY created").all();
    for(const row of rows)this.store.messageStatus(row.id,'new');
    if(rows.length){this.store.event('Codex 登录已恢复，将继续未完成的视频');this.reply('已连接本机当前 Codex 登录。继续分析暂停的视频，已完成片段会复用。',{priority:90});}
  }
  async reanalyze(id,{notify=true,refreshAuth=false}={}){
    if(this.busy)throw new Error('当前仍有视频或指令处理，请稍后重分析');
    const item=this.store.knowledge(id);if(!item)throw new Error('未找到已经保存的视频');
    this.busy=true;let resumeRoute=null;
    try{
      if(refreshAuth)await this.codex.reconnect?.();
      const message=this.store.latestVideoMessage(id);
      if(message&&notify){this.notifyVideo(message,'started',{key:'video-reanalysis:'+message.id+':'+Date.now()});await this.deliver();}
      const learned=JSON.parse(await readFile(join(dirname(item.path),'metadata.json'),'utf8'));learned.path=item.path;
      await this.analyzeVisual(learned);
      let input=[{type:'text',text:`主人指示：继续学习这条视频，以完整视觉记录为准。\n允许派发：否\n本轮资料：${JSON.stringify({title:learned.title,source:learned.source,path:item.path,transcript:learned.transcript,visualPath:join(dirname(item.path),'visual-analysis.md'),visualObservations:learned.visual.notes})}`}],inputTokens=0;
      if(this.conversations&&message){resumeRoute=await this.conversations.resumeRoute(message,learned);if(resumeRoute.clarify)throw new Error(resumeRoute.question);const prepared=await this.conversations.prepareInput(resumeRoute,input,message);resumeRoute=prepared.route;input=prepared.input;inputTokens=prepared.inputTokens;}
      const result=await this.codex.run(resumeRoute?.threadId||this.store.config.coordinator,input,{assistant:true,...(this.preferences?await this.preferences.work():{effort:'medium'}),toolHandler:async call=>{
        if(call.tool==='need_context'&&resumeRoute)return this.conversations.context(resumeRoute);
        if(call.tool==='knowledge_search')return resumeRoute?this.conversations.related(resumeRoute.needId,call.arguments.query):this.store.search(call.arguments.query);
        throw new Error('本次续看没有授权派发任务');
      }});
      this.store.addKnowledge({...learned,summary:result.text});await appendFile(item.path,'\n## 全时段视觉重分析 '+new Date().toISOString()+'\n\n'+result.text+'\n');
      if(message)this.store.messageStatus(message.id,'done',result.text);
      if(resumeRoute&&message){const needId=this.conversations.record(message.id,result.text,result.tokenUsage,inputTokens);await this.conversations.refreshMemory(needId);}
      this.reply(result.text,{payload:{videoId:learned.id,phase:'summary'}});this.store.event('全时段视觉重分析已完成：'+learned.title.slice(0,60));return result.text;
    }catch(e){if(authFailure(e)){const message=this.store.latestVideoMessage(id);if(message)this.store.messageStatus(message.id,'waiting_auth',e.message);}this.store.event(authFailure(e)?'等待 Codex 登录或额度恢复':e.message,'error');this.reply(this.failureNotice(e));throw e;}finally{this.busy=false;}
  }
  dispatch(alias,instruction,ownerInstruction,{needId=this.store.config.activeNeed}={}) {
    const target=this.store.config.targets.find(t=>t.alias===alias);
    if(!target)throw new Error('该目标聊天未加入授权名单');
    if(target.id===this.store.config.coordinator)throw new Error('不能把任务派回调度聊天本身');
    if(this.conversations?.needs.db.prepare('SELECT 1 FROM need_threads WHERE thread=?').get(target.id))throw new Error('需求助手会话不能作为派发目标');
    const items=needId&&this.conversations?this.conversations.related(needId,'',3):this.store.search('',3),context={...buildVideoContext(items,{project}),needId};
    if(needId&&this.conversations)context.need=this.conversations.context({needId,historyPath:this.conversations.needs.history(needId)});
    const brief=items.map(k=>({id:k.id,title:k.title,summary:k.summary?.slice(0,1000)}));
    const prompt=`主人的原话：${ownerInstruction}\n具体任务：${instruction}\n${videoContextInstructions(context)}${brief.length?'\n资料摘要：'+JSON.stringify(brief):''}`;
    const id=this.store.createTask(alias,target.id,prompt,context);this.store.event('已排队到「'+alias+'」：'+id.slice(0,8));return id;
  }
  async runTask() {
    if(this.taskBusy||!this.store.config.enabled)return;
    const task=this.store.queuedTasks()[0];if(!task)return;
    this.taskBusy=true;let started=false;
    try {
      if(this.codex.ensureAuthenticated)await this.codex.ensureAuthenticated();else await this.codex.connect();
      // Never forcibly take over a live writer from the desktop app.
      const read=await this.codex.request('thread/read',{threadId:task.thread});
      if(read.thread?.status?.type==='active')return;
      const context=JSON.parse(task.context||'{}');const input=[{type:'text',text:task.prompt}];
      for(const image of context.images||[])if(existsSync(image.path))input.push({type:'text',text:`原视频 ${image.videoId}，约 ${image.seconds.toFixed(2)} 秒起的连续画面组（初始定位附件，可回看完整原片）：`},{type:'localImage',path:image.path});
      const result=await this.codex.run(task.thread,input,{
        ...(this.preferences?await this.preferences.work():{}),
        onSubmitted:()=>{started=true;this.store.taskStatus(task.id,'running');},
        onStarted:id=>{started=true;this.store.taskStatus(task.id,'running','',id);}
      });
      this.store.taskStatus(task.id,'done',result.text,result.turnId);this.store.event('「'+task.alias+'」已返回执行结果');
      if(context.needId&&this.conversations){const need=this.conversations.needs.get(context.needId);if(need){const message={id:'task-result:'+task.id,kind:'text',text:'已授权任务执行结果，原指令：'+task.prompt,created:Date.now()};this.conversations.needs.reserve(message,need);this.conversations.record(message.id,result.text);await this.conversations.refreshMemory(need.id);}}
      this.reply('「'+task.alias+'」任务 '+task.id.slice(0,8)+' 的执行结果：\n'+result.text);
    } catch(e) {
      if(!started&&authFailure(e)){this.store.taskStatus(task.id,'queued','等待本机 Codex 登录或额度恢复');return;}
      if(!started&&/active writer|already.*(?:active|running)|another.*(?:session|process)|busy/i.test(e.message))return;
      this.store.taskStatus(task.id,started||e.uncertain?'uncertain':'failed',e.message);this.store.event('任务未完成：'+e.message,'error');
      this.reply('「'+task.alias+'」任务暂未完成：'+e.message+(started?'。执行可能已经开始，请在原聊天查看；不会自动重做。':''));
    } finally{this.taskBusy=false;}
  }
  async deliver() {
    if(this.outboxBusy||!this.store.config.enabled)return;
    const out=this.store.pendingOutbox()[0];if(!out)return;
    if(out.peer!==this.store.config.owner?.chatKey)return;
    this.outboxBusy=true;this.store.delivery(out.id,'sending');
    try{
      let method='text';
      if(out.kind==='video_ack'&&this.adapter.acknowledge){const result=await this.adapter.acknowledge(this.store.config.owner,JSON.parse(out.payload),out.body);method=result.method;this.store.mergeOutboxPayload(out.id,{receiptResult:result});}
      else await this.adapter.send(this.store.config.owner,out.body,{plainText:JSON.parse(out.payload||'{}').plainText===true});
      this.store.delivery(out.id,'sent');
      if(out.kind==='video_ack')this.store.event('已在抖音确认收到视频（'+(method==='reaction'?'消息表情回应':'私信文字')+'）');
    }
    catch(e){this.store.delivery(out.id,e.uncertain?'uncertain':'pending',e.message);}
    finally{this.outboxBusy=false;}
  }
  start(){this.timer=setInterval(()=>{this.scan().catch(e=>this.store.event(e.message,'error'));this.processNext();this.runTask();this.deliver();},3000);}
  stop(){clearInterval(this.timer);this.store.saveConfig({enabled:false});}
}
