import {updateHTML,updateOptions} from './dom.js';
import {initViews,openSettingsSection,renderVisuals,renderLearning} from './views.js';
import {initGroupSettings} from './group-settings.js';
function normalizeAgentRoute(){
  const hash=location.hash.replace(/^#chats\/agent\/(self|assistant)(?=\/|$)/,'#chats/agent');
  if(hash!==location.hash)history.replaceState(history.state,'',hash);
}
normalizeAgentRoute();
initViews();
const classic=document.documentElement.dataset.layout==='classic';
const $=id=>document.getElementById(id);let state=null,targets=[],threads=[],dirty=false,busy=false;
let catalog=null,chatCatalog=null,preferencesDirty=false,chatPreferencesDirty=false,observedAiChat=null,agentHarnessDirty=false;
const backendName=value=>value==='dsh'?'DeepSeek Harness':'Codex';
const panelPending=new Set();let refreshAgain=false;
window.addEventListener('bridge-layout-change',event=>{if(dirty||preferencesDirty||chatPreferencesDirty||agentHarnessDirty||groupUI.dirty()||instanceDrafts.size||panelPending.size||$('newNeedTitle').value.trim()||$('targetAlias').value.trim()){event.preventDefault();notice('请先保存未保存的配置或清空输入草稿，再切换界面。');}});
const archiveButton=(kind,item)=>`<button class="secondary" data-archive-kind="${kind}" data-archive-id="${escape(item.id)}" data-archive-value="${!item.archived}">${item.archived?'恢复显示':'归档'}</button>`+(['task','need'].includes(kind)&&(item.archived||item.receipts?.some(r=>r.uncertain)||item.replies?.some(r=>r.status==='uncertain'))?`<button class="secondary" data-review-kind="${kind}" data-review-id="${escape(item.id)}">核实送达</button>`:'')+(item.archived&&['task','need','knowledge'].includes(kind)?`<button class="delete-record" data-delete-kind="${kind}" data-delete-id="${escape(item.id)}">彻底删除</button>`:'')+(kind==='task'&&item.kind!=='control'?`<button class="interrupt-button" data-interrupt-task="${escape(item.id)}" aria-label="中断任务 ${item.number||''}" ${item.canInterrupt?'':'disabled'}>中断</button>`:'');
const chatLink=(url,label='需求对话')=>/^(?:codex:\/\/threads|dsh:\/\/session)\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(url||'')?`<a class="chat-link" href="${escape(url)}">${url.startsWith('dsh:')?'DSH':'Codex'} · ${escape(label)}</a>`:'';
const effortLabels={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanError=s=>String(s||'').replace(/\x1b\[[\d;]*[A-Za-z]/g,'');
const openedDetails=new Set();
try{for(const key of JSON.parse(localStorage.getItem('bridge-ui-details')||'[]'))if(typeof key==='string')openedDetails.add(key);}catch{}
restoreDetails();
document.addEventListener('toggle',e=>{const key=e.target.dataset?.foldKey;if(!key||!e.target.isConnected)return;if(e.target.open)openedDetails.add(key);else openedDetails.delete(key);try{localStorage.setItem('bridge-ui-details',JSON.stringify([...openedDetails]));}catch{}},true);
function restoreDetails(){for(const detail of document.querySelectorAll('[data-fold-key]'))detail.open=openedDetails.has(detail.dataset.foldKey);}
function chatDestination(){
  const path=location.hash.slice(1).split('/');
  if(classic||path[0]!=='chats')return '';
  if(path[1]==='peer'&&path[2])try{return decodeURIComponent(path[2]);}catch{}
  return ['add','agent'].includes(path[1])?path[1]:'';
}
const activeAgent=()=>state?.config.douyinRebindRequired?null:state?.config.owner;
const selectedMode=()=>state?.config.douyinMode||(state?.config.owner?(state.config.owner.selfChat?'self':'assistant'):'');
const modeName=mode=>mode==='assistant'?'助手代收模式':'主号自聊模式';
const instanceFields=['instanceModel','instanceEffort','instanceFast','instanceBudget','instanceVideoMinutes','instanceVisualFps','instanceAutoRoute'];
const instanceDrafts=new Map();let instanceForm=null,verifiedBinding=null;
function renderInstance(peer,mode){
  $('instancePreferences').hidden=!peer;
  $('unboundAgentNotice').hidden=!!peer||mode==='chat';
  if(!peer){instanceForm=null;return;}
  const isChat=mode==='chat',harness=(isChat?state.runtime.harness?.chat:state.runtime.harness?.active)||'codex';
  const key='conversation:'+JSON.stringify([isChat?'chat':'agent',peer.chatKey,peer.selfUid||'']);
  const draftKey=key+':'+harness,stored=state.config.conversationOverrides?.[key]||{},model=stored.models?.[harness]||{};
  const list=(isChat?chatCatalog:catalog)?.models||[];
  instanceForm={draftKey,peer:peer.chatKey,mode,harness};
  const values=instanceDrafts.get(draftKey)||[model.model??'__inherit',model.reasoningEffort??'__inherit',model.fastMode===undefined?'':model.fastMode?'on':'off',stored.contextBudget??'',stored.maxVideoSeconds==null?'':stored.maxVideoSeconds/60,stored.visualFps??'',stored.autoRoute===undefined?'':stored.autoRoute?'on':'off'];
  const options=(selected,entries,placeholder)=>'<option value="__inherit">继承默认</option><option value="">'+placeholder+'</option>'+entries.map(([id,label])=>'<option value="'+escape(id)+'">'+escape(label)+'</option>').join('')+(!['','__inherit'].includes(selected)&&!entries.some(([id])=>id===selected)?'<option value="'+escape(selected)+'">'+escape(selected)+'</option>':'');
  const configuredModel=values[0]==='__inherit'?(isChat?state.config.chatModel:state.config.model):values[0];
  const info=list.find(m=>m.model===configuredModel)||list.find(m=>m.model===(isChat?chatCatalog:catalog)?.defaults?.model);
  updateOptions($('instanceModel'),options(values[0],list.map(m=>[m.model,m.displayName||m.model]),'后端默认模型'));
  updateOptions($('instanceEffort'),options(values[1],(info?.supportedReasoningEfforts||[]).map(e=>[e.reasoningEffort,effortLabels[e.reasoningEffort]||e.reasoningEffort]),'模型默认强度'));
  for(const [i,id] of instanceFields.entries())if($(id).value!==String(values[i]))$(id).value=values[i];
  $('instanceRouting').hidden=isChat;$('instanceVideoDuration').hidden=isChat;$('instanceVideoDensity').hidden=isChat;
  $('instanceContextRow').hidden=isChat&&peer.type!=='group';
  $('instanceBudget').max=isChat?'96000':'200000';
  $('instanceSystemDefaults').href=isChat?'#settings/chat-defaults':'#settings/agent-defaults';
  const defaults=isChat?{model:state.config.chatModel,effort:state.config.chatReasoningEffort,fast:state.config.chatFastMode}:{model:state.config.model,effort:state.config.reasoningEffort,fast:state.config.fastMode};
  const effectiveModel=model.model??defaults.model,effectiveEffort=model.reasoningEffort??defaults.effort,effectiveFast=model.fastMode??defaults.fast;
  $('instancePreferenceHelp').textContent='当前配置：'+backendName(harness)+' · '+(effectiveModel||'后端默认模型')+' · '+(effortLabels[effectiveEffort]||effectiveEffort||'默认强度')+' · 快速模式'+(effectiveFast?'开':'关')+'。保存后从下一轮开始使用。';
}
function renderChatDirectory(data,owner){
  const destination=chatDestination(),view=$('chatsView');
  view.dataset.detail=String(!!destination);
  const mode=owner?.selfChat?'self':'assistant',ownerIsAgent=destination==='agent',binding=activeAgent();
  const selected=ownerIsAgent?(binding?data.chats.find(c=>c.chatKey===binding.chatKey)||binding:null):data.chats.find(c=>c.chatKey===destination);
  const ordinary=data.chats.filter(c=>!(c.chatKey===owner?.chatKey&&c.mode==='agent'));
  const search=$('chatSearch').value.trim().toLocaleLowerCase();
  const row=(route,title,description)=>'<a class="conversation-row" data-ui-key="chat-nav:'+escape(route)+'" href="#chats/'+escape(route)+'" '+((route===destination||route.startsWith('peer/')&&selected?.chatKey===decodeURIComponent(route.slice(5))&&destination!=='agent')?'aria-current="true"':'')+'><strong>'+escape(title)+'</strong><small>'+escape(description)+'</small></a>';
  const visible=ordinary.filter(c=>c.displayName.toLocaleLowerCase().includes(search));
  const matchesAgent=!search||owner?.displayName?.toLocaleLowerCase().includes(search)||'个人 agent 自聊'.includes(search);
  updateHTML($('chatDirectory'),(matchesAgent?row('agent','个人 Agent',binding?modeName(mode)+' · '+binding.displayName:'尚未绑定'):'')+
    '<p class="section-caption">普通聊天</p>'+visible.map(c=>row('peer/'+encodeURIComponent(c.chatKey),c.displayName,(c.type==='group'?'群聊':'单聊')+' · '+(c.enabled?(c.deliveryPaused?'回复已暂停':'已启用'):'已停用'))).join('')+
    (visible.length?'':'<p class="empty">'+(search?'没有匹配的聊天':'尚未配置普通聊天')+'</p>'));
  const pane=selected||ownerIsAgent?'detail':destination==='add'?'add':'empty';
  for(const el of view.querySelectorAll('[data-chat-pane]'))el.hidden=el.dataset.chatPane!==pane;
  $('conversationTitle').textContent=(ownerIsAgent?'个人 Agent':selected?.displayName)||({add:'添加聊天',empty:'选择会话'})[pane];
  $('conversationDescription').textContent=ownerIsAgent?(selected?modeName(mode)+' · '+binding.displayName:'前往「添加聊天」绑定个人 Agent。'):selected?(selected.type==='group'?'群聊':'单聊')+' · 普通聊天 AI · 仅回复':({empty:'左侧目录包含个人 Agent、单聊和群聊。',add:'从抖音窗口核验身份后启用。'})[pane];
  const showSettings=location.hash.endsWith('/settings')||ownerIsAgent&&!selected;
  const destinationPath=ownerIsAgent?'agent':'peer/'+encodeURIComponent(selected?.chatKey||'');
  $('conversationTabs').hidden=!selected;
  $('conversationHistoryTab').href='#chats/'+destinationPath;
  $('conversationSettingsTab').href='#chats/'+destinationPath+'/settings';
  $('conversationHistoryTab').setAttribute('aria-current',String(!showSettings));
  $('conversationSettingsTab').setAttribute('aria-current',String(showSettings));
  $('activeChatSettings').hidden=!showSettings;
  $('activeChatReplyOptions').hidden=!selected;
  $('activeChatRecords').hidden=showSettings;
  renderInstance(selected,ownerIsAgent?mode:'chat');
  $('activeChatModelLink').hidden=ownerIsAgent;
  $('activeChatModelSummary').hidden=ownerIsAgent;
  $('activeChatModelSummary').textContent='系统默认配置 · '+backendName(state.runtime.harness?.chat)+' · '+(state.config.chatModel||'默认模型')+' · '+(effortLabels[state.config.chatReasoningEffort]||'默认强度')+' · 快速模式'+(state.config.chatFastMode?'开':'关');
  $('conversationWorkLink').hidden=!ownerIsAgent;
  $('botHistory').hidden=ownerIsAgent;
  $('agentChatHistory').hidden=!ownerIsAgent;
  updateHTML($('conversationRecordActions'),selected?.type==='group'?groupUI.recordControls(selected):'');
  updateHTML($('agentChatHistory'),ownerIsAgent?(state.chatWork||[]).map(w=>'<article class="item" data-ui-key="agent-message:'+escape(w.id)+'"><strong>'+escape(w.title)+'</strong><p>'+escape(w.detail)+'</p><small>文字回复 '+w.replies.filter(r=>r.status==='sent').length+' / '+w.replies.length+' 段 · '+escape(w.phase)+'</small>'+(w.request||w.replies.length?'<details data-fold-key="agent-reply:'+escape(w.id)+'"><summary>查看原消息和回复</summary>'+(w.request?'<p><strong>收到</strong><br>'+escape(w.request)+'</p>':'')+w.replies.map(r=>'<p><strong>'+escape(({sent:'已发出',pending:'待发送',sending:'发送中',uncertain:'需核实'})[r.status]||'已保留')+'</strong><br>'+escape(r.body||'')+'</p>').join('')+'</details>':'')+'<div class="button-row">'+w.links.map(l=>chatLink(l.url,l.label)).join('')+(w.replies.some(r=>['sending','uncertain'].includes(r.status))?'<button class="secondary" data-review-kind="task" data-review-id="'+escape(w.id)+'">核实送达</button>':'')+'</div></article>').join('')||'<p class="empty">此会话还没有桥接记录。</p>':'');
  return selected;
}
if(!classic){
  $('chatSearch').addEventListener('input',()=>{if(state)renderAiChats();});
  for(const id of instanceFields)$(id).addEventListener('input',()=>{if(!instanceForm)return;instanceDrafts.set(instanceForm.draftKey,instanceFields.map(field=>$(field).value));if(id==='instanceModel')renderAiChats();});
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-chat-destination]');
    if(button)location.hash='chats/'+button.dataset.chatDestination;
  });
  window.addEventListener('hashchange',event=>{
    normalizeAgentRoute();
    if(state)renderAiChats();
    if(matchMedia('(max-width: 720px)').matches){
      const previous=new URL(event.oldURL).hash;
      if(previous==='#chats'&&location.hash.startsWith('#chats/'))$('conversationTitle').focus({preventScroll:true});
      if(previous.startsWith('#chats/')&&location.hash==='#chats')$('chatSearch').focus({preventScroll:true});
    }
    refresh();
  });
}
function renderAiChats(){
  groupUI.render(state);
  const data=state.aiChats||{chats:[],messages:[]},owner=state.config.owner;
  const selected=classic?null:renderChatDirectory(data,owner);
  const backend=backendName(state.runtime.harness?.chat);
  $('chatsSummary').textContent='已启用 '+data.chats.filter(c=>c.enabled).length+' 个聊天 · '+backend+' · '+(state.config.chatModel||'默认模型')+(data.selecting?' · 正在选择聊天':'');
  $('chatEffectiveModel').textContent='已保存的普通聊天配置：'+backend+' · '+(state.config.chatModel||chatCatalog?.defaults?.model||'默认模型')+' · '+(effortLabels[state.config.chatReasoningEffort]||state.config.chatReasoningEffort||'模型默认强度')+' · 快速模式'+(state.config.chatFastMode?'开':'关')+'。从下一轮起生效，与个人 Agent 分开保存。';
  $('aiChatSelection').hidden=!data.selecting;$('finishAiSelection').hidden=!data.selecting;
  updateHTML($('aiChatList'),(classic?data.chats:selected&&data.chats.some(c=>c.chatKey===selected.chatKey&&c.mode===selected.mode)?[selected]:[]).map(c=>{const agentAllowed=c.type==='single'&&c.chatKey===owner?.chatKey&&c.peerUid===owner?.peerUid;return `<div class="ai-chat-item" data-ui-key="chat:${escape(c.chatKey)}">${classic?`<strong>${escape(c.displayName)}</strong> `:''}<span class="pill">${c.type==='group'?'群聊':'单聊'} · ${c.enabled?'已启用':'已停用'}</span><small>${c.mode==='agent'?'个人 Agent · 现有用户授权模式':c.type==='group'?(c.groupReplyMode==='all'?'普通聊天 · 回复所有新消息':'普通聊天 · 仅原生 @ 助手时回复'):'普通聊天 · 仅回复本聊天'}</small><div class="button-row"><label>使用方式 <select data-ai-mode="${escape(c.chatKey)}"><option value="chat" ${c.mode==='chat'?'selected':''}>普通聊天 AI</option>${agentAllowed?`<option value="agent" ${c.mode==='agent'?'selected':''}>个人 Agent · 现有模式</option>`:''}</select></label>${c.type==='group'&&c.mode==='chat'?`<label>回复范围 <select data-ai-reply="${escape(c.chatKey)}"><option value="mentions" ${c.groupReplyMode!=='all'?'selected':''}>仅被 @ 时回复</option><option value="all" ${c.groupReplyMode==='all'?'selected':''}>回复所有新消息</option></select></label>`:''}<button class="secondary" data-ai-toggle="${escape(c.chatKey)}">${c.enabled?'停用此聊天':'启用此聊天'}</button></div>${groupUI.controls(c,{showRecords:classic})}</div>`;}).join('')||'<p class="empty">选择需要启用 AI 的单聊或群聊。其他聊天保持静默。</p>');
  const names={new:'排队中',preparing:'准备聊天',submitted:'正在回复',replying:'结果已生成，等待送达',delivery_uncertain:'送达需核实，不自动重发',done:'助手端已发出',held:'暂停保留',cancelled:'已停止',failed:'处理失败',uncertain:'需要核实',blocked:'队列已满'};
  updateHTML($('botHistory'),(classic?data.messages:data.messages.filter(m=>m.peer===selected?.chatKey)).map(m=>`<div class="item" data-ui-key="bot:${escape(m.id)}"><strong>${escape(m.name)}</strong> <span class="pill">${m.deliveryIssue?'发送受阻，等待重试':names[m.status]||escape(m.status)}</span>${m.deliveryIssue?`<small>${escape(deliveryError(m.deliveryIssue))}</small>`:''}<small>${new Date(m.created).toLocaleString('zh-CN',{hour12:false})}</small>${!classic&&m.input?`<p><strong>收到</strong><br>${escape(m.input)}</p>`:''}${!classic&&m.result?.length>300?`<details data-fold-key="chat-reply:${escape(m.id)}"><summary>查看完整回复</summary><p>${escape(m.result)}</p></details>`:`<p>${escape(m.result?.slice(0,300)||'尚未生成回复')}</p>`}<small>${m.recipientVisibility==='confirmed'?'用户已确认接收方可见':m.recipientVisibility==='reported_invisible'?'群成员反馈不可见，待核实':m.status==='done'?'仅确认助手端状态，接收方可见性未确认':'尚未确认送达'}</small>${m.canRetry?`<button class="secondary" data-chat-retry="${escape(m.id)}">重试未提交的消息</button>`:''}${m.sessionId?`<button class="secondary" data-group-sessions="${escape(m.peer)}" data-session-id="${escape(m.sessionId)}">查看对应会话</button>`:''}${(m.uncertainReplies||[]).map(id=>`<div class="button-row"><button class="secondary" data-reconcile-reply="${escape(id)}">核验原聊天</button><button class="secondary" data-delivered="${escape(id)}">这段已在抖音收到</button>${m.recipientVisibility!=='reported_invisible'?`<button class="secondary" data-resend="${escape(id)}">确认这段未收到，重新发送</button>`:''}</div>`).join('')}</div>`).join('')||'<p class="empty">普通聊天尚无新交流记录。</p>');
}
function deliveryError(s){s=cleanError(s);return /intercepts pointer events|OVERLAY_BLOCKED/.test(s)?'抖音弹层遮挡原消息，尚未点击表情。关闭视频预览或弹窗后可恢复。':/locator\.click: Timeout/.test(s)?'原消息暂不可操作，未确认贴表情。请检查弹层遮挡或消息位置。':s.length>220?s.slice(0,220)+'…':s;}
function renderRetries(w){
  const clock=at=>Number.isFinite(at)&&at>0?new Date(at).toLocaleString('zh-CN',{hour12:false}):'时间未记录';
  const outcome={blocked:'受阻，尚未提交',started:'已开始执行',failed:'本次未能启动',uncertain:'运行结果需要核实'};
  return (w.retries||[]).map((group,index)=>{const latest=group.events.at(-1);if(!latest)return '';
    const describe=e=>`${clock(e.at)} · 第 ${e.attempt} 次 · ${outcome[e.outcome]||'状态未知'}${e.reason?'：'+e.reason:''}`;
    const legacy=group.events.find(e=>e.legacy&&e.attempt>1),schedule=group.wait?(group.wait.paused?'自动重试已暂停；处理阻塞后可使用 /重试 '+w.number:'计划下次重试：'+clock(group.wait.nextAttempt)):latest.outcome==='blocked'?(group.taskStatus==='queued'?'已恢复调度，等待处理':'当前没有自动重试计划'):'';
    return `<div class="retry-summary"><strong>写入调度 · ${escape(group.label)}</strong><p>最近：${escape(describe(latest))}</p>${schedule?`<p>${escape(schedule)}</p>`:''}<details class="retry-details" data-fold-key="${escape('retry:'+w.id+':'+index)}"><summary>查看调度记录（${group.events.length} 条）</summary>${legacy?`<p class="work-meta">升级前的 ${legacy.attempt-1} 次详细时间和结果未保存。</p>`:''}<ol>${group.events.map(e=>`<li>${escape(describe(e))}</li>`).join('')}</ol></details></div>`;
  }).join('');
}
function renderWorkCard(w){
  const labels={roger:'👌 收到',active:'奋斗 · 运行',done:'🎉 完成'};
  const receipt=w.receipts.map(r=>{const verified=!!r.total&&r.sent===r.total;const text=!r.total?'未生成回执':r.uncertain?'送达需核实':verified?'已送达'+(r.total>1?' '+r.sent+'/'+r.total:''):r.pending?'等待发送':r.abandoned?'已放弃 '+r.abandoned+' 条，不再发送':r.unavailable?'表情暂不可用':'待确认';return `<div data-ui-key="receipt:${r.stage}" class="receipt-state ${r.uncertain||r.unavailable?'error':verified?'verified':''}"><span class="receipt-label">${labels[r.stage]}</span>${escape(text)}</div>`;}).join('');
  const errors=[...new Set(w.receipts.flatMap(r=>r.errors||[]))],results=w.replies.filter(r=>!r.notification),sent=results.filter(r=>r.status==='sent').length,uncertain=w.replies.filter(r=>r.status==='uncertain');
  const details=errors.length?`<details class="work-details" data-fold-key="${escape('receipts:'+w.id)}"><summary>表情发送详情（${errors.length}）</summary>${errors.map((e,i)=>`<p>${escape(deliveryError(e))}</p>${cleanError(e).length>240?`<details data-fold-key="${escape('technical:'+w.id+':'+i)}"><summary>技术详情</summary><pre>${escape(cleanError(e).slice(0,1800))}</pre></details>`:''}`).join('')}</details>`:'';
  const long=(w.detail||'').length>210,detail=long?`<details class="work-full-detail" data-fold-key="${escape('detail:'+w.id)}"><summary>查看完整处理说明</summary><p class="work-detail">${escape(w.detail)}</p></details>`:'';
  return `<article class="work-card" data-operation="${escape(w.id)}"><div class="work-head"><div class="work-title"><div class="work-kicker">${w.kind==='control'?'命令回执':'任务 '+(w.number||'待登记')}${w.archived?' · 已归档':''}</div><strong>${escape(w.title)}</strong></div><span class="pill ${['uncertain','failed_delivery','failed','blocked'].includes(w.status)?'error':''}">${statuses[w.status]||escape(w.status)}</span></div><p data-ui-key="phase" class="work-detail">${escape(long?w.detail.slice(0,210)+'…':w.detail)}</p>${detail}${renderVisuals(w)}${w.targets?.length?`<small class="work-meta" data-ui-key="targets">目标：${w.targets.map(t=>escape(t.alias)+'（'+(statuses[t.status]||escape(t.status))+'）').join('、')}</small>`:''}${renderRetries(w)}<div class="delivery-summary" data-ui-key="delivery"><span>文字回复</span><strong>${results.length?'已送达 '+sent+' / '+results.length+' 段':'尚未生成'}${uncertain.length?' · 待核实':''}</strong></div><div class="work-receipts" data-ui-key="receipts">${receipt}</div>${uncertain.map(r=>`<div class="reply-review" data-ui-key="review:${r.id}">回复送达需核实<div class="button-row"><button data-delivered="${r.id}">已在抖音收到</button><button data-resend="${r.id}">确认未收到，重新发送</button></div></div>`).join('')}${details}<div class="card-actions" data-ui-key="actions">${archiveButton('task',w)}${(w.links||[]).map(l=>chatLink(l.url,l.label)).join('')}</div></article>`;
}

const statuses={queued:'排队中',blocked:'调度受阻',running:'执行中',done:'已完成',failed:'处理失败',cancelled:'已取消',waiting:'等待恢复',failed_delivery:'送达需核实',unavailable:'表情暂不可用',waiting_auth:'等待账号恢复',waiting_route:'等待选择需求',uncertain:'需要核实',pending:'待发送',sent:'已送达',sending:'发送中',new:'等待处理',processing:'处理中'};
statuses.stopping='中断中';
$('workStatus').add(new Option('中断中','stopping'),$('workStatus').querySelector('[value="sending"]'));
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error||'请求失败'),{code:data.code});return data;}
const noticeBox=$('notice');noticeBox.setAttribute('popover','manual');
noticeBox.innerHTML='<span id="noticeText"></span><button id="closeNotice" aria-label="关闭提示" title="关闭提示">×</button>';
let lastNotice='',noticeTimer;
function hideNotice(){clearTimeout(noticeTimer);if(noticeBox.matches(':popover-open'))noticeBox.hidePopover();noticeBox.style.display='none';}
function expireNotice(){clearTimeout(noticeTimer);noticeTimer=setTimeout(hideNotice,noticeBox.classList.contains('error')?10000:6000);}
noticeBox.addEventListener('pointerenter',()=>clearTimeout(noticeTimer));noticeBox.addEventListener('pointerleave',expireNotice);noticeBox.addEventListener('focusin',()=>clearTimeout(noticeTimer));noticeBox.addEventListener('focusout',expireNotice);
$('closeNotice').addEventListener('click',()=>{hideNotice();lastNotice='';});
function notice(text,error=false){const key=String(error)+':'+text;if(key===lastNotice&&noticeBox.style.display!=='none')return;lastNotice=key;$('noticeText').textContent=text;noticeBox.className=error?'error':'';noticeBox.setAttribute('role',error?'alert':'status');noticeBox.setAttribute('aria-live',error?'assertive':'polite');noticeBox.style.display='flex';if(noticeBox.showPopover&&!noticeBox.matches(':popover-open'))noticeBox.showPopover();expireNotice();}
let lastDouyinLogin=0,offeredChatSetup=false,douyinModeDirty=false;
function hideSetupPrompt(){$('setupPrompt').hidden=true;}
function showSetupPrompt(title,message,actions=[],error=false){
  const panel=$('setupPrompt'),text=$('setupPromptText'),controls=$('setupPromptActions');
  $('setupPromptTitle').textContent=title;
  panel.classList.toggle('setup-error',error);
  text.replaceChildren(...(Array.isArray(message)?message:[message]));
  controls.replaceChildren();
  for(const [label,handler] of [...actions,['关闭',hideSetupPrompt]]){
    const control=document.createElement(typeof handler==='string'?'a':'button');
    control.textContent=label;control.className=typeof handler==='string'?'panel-link':'secondary';
    if(typeof handler==='string'){control.href=handler;control.addEventListener('click',hideSetupPrompt);}
    else control.addEventListener('click',async()=>{
      control.disabled=true;
      try{await handler();await refresh();}catch(e){notice(e.message,true);}finally{control.disabled=false;}
    });
    controls.append(control);
  }
  panel.hidden=false;
}
function promptDouyinLogin(mode){
  const account=document.createElement('strong');account.textContent='助手账号';account.className='setup-emphasis';
  showSetupPrompt('登录抖音',mode==='assistant'?['请点击「打开抖音窗口」以登录',account,'。']:'请点击「打开抖音窗口」以登录。');
}
function renderOnboarding(runtime,agentReady){
  const mode=selectedMode(),loggedIn=runtime.browserLoggedIn===true,owner=activeAgent();
  $('setupAccountLink').hidden=!!mode;
  $('setupAccountLink').textContent=loggedIn?'选择使用模式':'连接抖音账号';
  $('openBrowser').hidden=loggedIn||!mode;
  $('setupAgentLink').hidden=agentReady;
  $('setupAsrLink').hidden=!!runtime.asrReady;
  $('accountCard').classList.toggle('needs-setup',!loggedIn);
  $('agentStatusCard').classList.toggle('needs-setup',!agentReady);
  $('asrStatusCard').classList.toggle('needs-setup',!runtime.asrReady);
  $('safariSetupHint').hidden=runtime.browserEngine!=='safari'||loggedIn||!mode;
  $('browserStatus').textContent=loggedIn?'已登录':runtime.browser==='open_error'?'打开失败，可重试':runtime.browser==='waiting_login'?'等待登录':'未连接';
  $('ownerStatus').textContent=loggedIn?(owner?'已绑定 · '+owner.displayName:'已登录，可前往会话添加聊天'):(mode?modeName(mode):'选择账号使用方式后登录');
  if(!douyinModeDirty)$('douyinMode').value=mode;
  $('douyinModeStatus').textContent=mode?'当前设置 · '+modeName(mode):'尚未选择使用模式';
  $('agentBindingForm').hidden=!loggedIn;
  $('agentBindingLogin').hidden=loggedIn;
  $('bindingSelectionHint').textContent=mode==='assistant'?'在助手账号的抖音窗口打开与主号的私信，并从主号发一条消息。':'在抖音窗口打开自己和自己的私信，保留一条手动发出的消息。';
  const justLoggedIn=runtime.loginCompletedAt&&runtime.loginCompletedAt!==lastDouyinLogin;
  if(justLoggedIn){
    lastDouyinLogin=runtime.loginCompletedAt;
    showSetupPrompt('抖音登录成功',owner?'已恢复抖音连接。':'已登录抖音，可以继续准备其他组件。');
  }
  const noChats=!owner&&!(state.aiChats?.chats||[]).some(c=>c.mode==='chat');
  if(!noChats)offeredChatSetup=false;
  if(loggedIn&&agentReady&&runtime.asrReady&&noChats&&!offeredChatSetup&&(!location.hash||location.hash==='#workbench')){
    offeredChatSetup=true;
    showSetupPrompt(justLoggedIn?'抖音登录成功，可以添加会话了':'可以添加会话了','抖音账号、个人 Agent 和口播转写均已就绪。请选择要添加的个人 Agent 或普通聊天。',[['前往添加会话 ↗','#chats/add']]);
  }
}
let deleting=null;
const deleteDialog=document.createElement('dialog');deleteDialog.id='deleteDialog';deleteDialog.setAttribute('aria-labelledby','deleteHeading');
deleteDialog.innerHTML='<h2 id="deleteHeading">彻底删除归档记录</h2><p id="deleteLabel"></p><p id="deleteCounts"></p><p id="deleteWarning"></p><label class="delete-check"><input id="deleteAcknowledge" type="checkbox">我理解这是永久删除，不能恢复显示</label><p id="deleteError" role="alert"></p><div class="button-row"><button id="cancelDelete" class="secondary">取消</button><button id="confirmDelete" class="delete-record" disabled>确认彻底删除</button></div>';
document.body.append(deleteDialog);
const reviewDialog=document.createElement('dialog');reviewDialog.id='deliveryReviewDialog';reviewDialog.setAttribute('aria-labelledby','reviewHeading');reviewDialog.innerHTML='<div class="section-title"><h2 id="reviewHeading">核实送达</h2><button id="closeDeliveryReview" class="secondary">关闭</button></div><p class="hint">自动核验读取助手端原聊天，不重发或补点表情。助手端有消息气泡不代表群成员可见；请在接收方确认后再人工标记。旧回复可以停止发送，原文仍保留。</p><div class="button-row"><button id="reconcileReviewBatch" class="secondary">一键核实本组</button></div><p id="reviewBatchStatus" role="status"></p><p id="reviewError" role="alert"></p><div id="deliveryReviewRows"></div>';
document.body.append(reviewDialog);$('closeDeliveryReview').addEventListener('click',()=>reviewDialog.close());let reviewSelection=null;
let reviewBatchTimer;
async function followReviewBatch(){
  clearTimeout(reviewBatchTimer);try{const {batch}=await api('outbox/reconcile-batch');if(!batch)return;const summary='只读核实：'+batch.checked+'/'+batch.total+' 条，已确认 '+batch.verified+' 条，仍需核实 '+batch.unresolved+' 条'+(batch.waiting?'；'+batch.waiting+' 条正在发送，本次未干预':'')+'。'+(batch.status==='running'?'正在核实…':batch.status==='done'?'核实结束；未重发文字或点击表情。':'检查已停止，未确认的记录继续保留。');$('reviewBatchStatus').textContent=summary;$('allDeliveryBatchStatus').textContent=summary;$('reconcileAllDeliveries').disabled=batch.status==='running';$('reconcileReviewBatch').disabled=batch.status==='running';if(batch.status==='running')reviewBatchTimer=setTimeout(followReviewBatch,1500);else{if(reviewDialog.open)await loadDeliveryReview();notice(summary);await refresh();}}catch(e){$('reviewBatchStatus').textContent=e.message;$('reconcileAllDeliveries').disabled=false;$('reconcileReviewBatch').disabled=false;}
}
async function startReviewBatch(selection={}){const {batch}=await api('outbox/reconcile-batch',selection);if(!batch)return;notice('已开始一键只读核实，结果会保存在各条回执中。');await followReviewBatch();}
$('reconcileAllDeliveries').addEventListener('click',()=>startReviewBatch().catch(e=>notice(e.message,true)));
$('reconcileReviewBatch').addEventListener('click',()=>startReviewBatch(reviewSelection||{}).catch(e=>notice(e.message,true)));
function renderDeliveryReviewRow(r){
  const id=escape(r.id),sent=r.status==='sent',queued=['pending','held'].includes(r.status),visibility=r.recipientVisibility==='confirmed'?'用户已确认接收方可见':r.recipientVisibility==='reported_invisible'?'接收方反馈不可见；助手端气泡不能解除此状态':sent?'助手端显示已发出，接收方可见性未确认':r.status==='held'?'暂停保留，未自动补发':'';
  const actions=r.status==='sending'?'<span>正在发送，等待本次结果；可在群聊卡片停止旧回复并清空。</span>':(r.status==='uncertain'?'<button class="secondary" data-review-reconcile="'+id+'">核验助手端原聊天</button>':'')+(!queued?'<button class="secondary" data-review-resolve="'+id+'" data-review-status="sent">'+(r.kind==='progress_reaction'?'我已看到此表情':r.isChat?'已确认接收方可见':'我已收到此段文字')+'</button>':'')+(!sent?'<button class="secondary" data-review-resolve="'+id+'" data-review-status="abandoned">'+(queued?'停止此回执，保留记录':'放弃此回执，不再发送')+'</button>':'')+(r.canReportVisibility?'<button class="secondary" data-review-invisible="'+id+'">接收方看不到，暂停本群回复</button>':'')+(r.canResend?'<button class="secondary" data-review-resolve="'+id+'" data-review-status="pending">确认未收到，重发此段</button>':'');
  return '<article class="delivery-review-row" data-ui-key="review:'+id+'"><strong>'+(r.number?'任务 '+escape(r.number):r.isChat?'聊天回执':'命令回执')+' · '+escape(r.label)+'</strong><small>'+escape(r.title)+' · '+new Date(r.created).toLocaleString('zh-CN',{hour12:false})+'</small><details><summary>查看完整'+(r.kind==='text'?'文字':'原消息')+'</summary><p>'+escape(r.body)+'</p></details><p>'+escape(visibility||r.error||'送达状态尚未核实')+'</p>'+(visibility&&r.error?'<p>'+escape(r.error)+'</p>':'')+(r.lastCheck?'<small>最近核验：'+new Date(r.lastCheck.at).toLocaleString('zh-CN',{hour12:false})+' · '+escape(r.lastCheck.reason||'未取得确定证据')+'</small>':'')+'<div class="button-row">'+actions+'</div></article>';
}
async function loadDeliveryReview(){
  if(!reviewSelection)return;const d=await api('outbox/review?'+new URLSearchParams(reviewSelection));
  updateHTML($('deliveryReviewRows'),d.rows.map(renderDeliveryReviewRow).join('')||'<p class="empty">没有需要处理的回执。</p>');
}
async function openDeliveryReview(kind,id){reviewSelection={kind,id};$('reviewError').textContent='';await loadDeliveryReview();if(!reviewDialog.open)reviewDialog.showModal();}
$('deleteAcknowledge').addEventListener('change',()=>{$('confirmDelete').disabled=!$('deleteAcknowledge').checked;});
$('cancelDelete').addEventListener('click',()=>deleteDialog.close());
deleteDialog.addEventListener('close',()=>{deleting=null;});
$('confirmDelete').addEventListener('click',async()=>{
  if(!deleting||!$('deleteAcknowledge').checked)return;
  const selection=deleting;$('confirmDelete').disabled=true;$('cancelDelete').disabled=true;
  try{const result=await api('archive/delete',selection);deleteDialog.close();notice(result.cleanupPending?'记录已删除；部分历史缓存待清理，重启后会继续。':selection.kind==='knowledge'?'已彻底删除所选学习资料及本地文件。':'已彻底删除所选归档记录，原有编号不会复用。');await refresh();}
  catch(e){$('deleteError').textContent=e.message;$('deleteAcknowledge').checked=false;}
  finally{$('cancelDelete').disabled=false;}
});
function action(id,fn){$(id).addEventListener('click',async()=>{const button=$(id);button.disabled=true;try{await fn();}catch(e){notice(e.message,true);}finally{button.disabled=false;}await refresh();});}
const groupUI=initGroupSettings({api,notice,escape,getState:()=>state,refresh});
function renderTargets(){updateHTML($('targetList'),targets.map((t,i)=>`<div class="target" data-ui-key="target:${escape(t.thread||t.alias)}">${escape(t.alias)} <small>${escape(t.name)}</small><button data-remove="${i}" aria-label="移除目标">×</button></div>`).join(''));}
let targetTail=Promise.resolve();
function changeTargets(change){const task=targetTail.catch(()=>{}).then(async()=>{const next=change(targets);await api('targets',{targets:next});targets=next;state.config.targets=next;renderTargets();notice('授权名单已即时保存，重启后会恢复。');});targetTail=task;return task;}
function renderEfforts(value=$('defaultEffort').value){
  renderModeEfforts('defaultModel','defaultEffort','fastMode',value);
}
function renderChatEfforts(value=$('chatEffort').value){renderModeEfforts('chatModel','chatEffort','chatFast',value,chatCatalog);}
function renderModeEfforts(modelId,effortId,fastId,value,data=catalog){const model=data?.models?.find(m=>m.model===($(modelId).value||data?.defaults?.model));updateOptions($(effortId),'<option value="">使用默认强度</option>'+(model?.supportedReasoningEfforts||[]).map(e=>`<option value="${escape(e.reasoningEffort)}">${escape(effortLabels[e.reasoningEffort]||e.reasoningEffort)}</option>`).join(''));$(effortId).value=Array.from($(effortId).options).some(o=>o.value===value)?value:'';const fast=!!model?.serviceTiers?.some(t=>/fast/i.test(t.name)||['fast','priority'].includes(t.id));$(fastId).disabled=!!data&&!fast;if(data&&!fast)$(fastId).checked=false;}
async function loadModeModels(chat=false){
  const select=$(chat?'chatModel':'defaultModel'),effortSelect=$(chat?'chatEffort':'defaultEffort'),isDirty=chat?chatPreferencesDirty:preferencesDirty,selected=isDirty?select.value:state?.config[chat?'chatModel':'model']||'',effort=isDirty?effortSelect.value:state?.config[chat?'chatReasoningEffort':'reasoningEffort']||'';
  const backend=state?.runtime.harness?.[chat?'chat':'active']||'codex',data=await api(chat?'models?mode=chat':'models');if(!Array.isArray(data.models))return;
  if(data.harness&&data.harness!==backend)return;
  if((state?.runtime.harness?.[chat?'chat':'active']||'codex')!==backend)return;
  if(chat)chatCatalog=data;else catalog=data;
  // A user can edit while a catalog request is in flight. Read the live dirty
  // form once more before replacing its options.
  const keep=(chat?chatPreferencesDirty:preferencesDirty)?select.value:selected,keepEffort=(chat?chatPreferencesDirty:preferencesDirty)?effortSelect.value:effort;
  updateOptions(select,'<option value="">'+backendName(backend)+' 默认'+(data.defaults?.model?'（'+escape(data.defaults.model)+'）':'')+'</option>'+data.models.map(m=>`<option value="${escape(m.model)}">${escape(m.displayName)} · ${escape(m.model)}</option>`).join(''));
  if(keep&&!Array.from(select.options).some(o=>o.value===keep))select.add(new Option(keep+'（当前账号不可用）',keep));select.value=keep;
  if(chat)renderChatEfforts(keepEffort);else{renderEfforts(keepEffort);$('effectiveModel').textContent=backendName(backend)+' 当前默认：'+(data.defaults?.model||'未返回')+'；默认强度：'+(effortLabels[data.defaults?.effort]||data.defaults?.effort||'按模型默认')+'。配置从下一次调用起生效。'+(backend==='dsh'?'视觉输入会按所选模型实际能力校验，不支持时保留视频与未完成进度。':'');}
}
async function loadModels(){const result=await Promise.allSettled([loadModeModels(),loadModeModels(true)]);for(const [i,r]of result.entries())if(r.status==='rejected')notice((i?'普通聊天':'个人 Agent')+'模型名单暂未读取：'+r.reason.message,true);}
function renderNeeds(){
  const sessions=state.conversations,list=sessions?.needs||[],active=sessions?.current||list.find(n=>n.id===sessions.activeNeed);
  if(!classic){$('currentNeedTitle').textContent=active?(active.number?'需求 '+active.number+' · ':'')+active.title:'尚未开始需求';
    $('currentNeedSummary').textContent=active?.summary||'收到消息后，助手会判断是继续已有需求，还是开始新的工作。';
    $('currentNeedSession').textContent=active?'第 '+active.seq+' 个会话':'';}
  $('currentNeed').textContent=(classic&&active?'当前需求 '+(active.number||'')+'：'+active.title+'\n第 '+active.seq+' 个续接会话 · ':'')+(active?(active.contextTokens>=sessions.budget?'下次处理前将保存交接记录，续开会话。':'上下文约 '+(active.contextTokens||0).toLocaleString()+' / '+sessions.budget.toLocaleString()+' tokens'):'旧需求和历史记录会保留，可随时找回。');
  updateHTML($('needList'),list.map(n=>`<div class="need-item" data-ui-key="need:${escape(n.id)}"><strong>${n.number?'需求 '+n.number+'：':''}${escape(n.title)}</strong><small>第 ${n.seq} 个会话${n.archived?' · 已归档':''}</small><div>${escape(n.summary.slice(0,150))}</div>${n.archiveState&&n.archiveState!=='done'?`<p class="error">归档同步需核对：${escape(n.archiveError||'正在处理')}</p>`:''}<div class="card-actions">${!n.archived&&(!n.archiveState||n.archiveState==='done')?`<button data-switch-need="${escape(n.id)}" ${n.id===sessions.activeNeed?'disabled':''}>${n.id===sessions.activeNeed?'当前需求':'切换到此需求'}</button>`:''}${archiveButton('need',n)}${!n.archived&&n.archiveState&&n.archiveState!=='done'?`<button data-archive-kind="need" data-archive-id="${escape(n.id)}" data-archive-value="false">恢复显示并核对助手</button>`:''}${chatLink(n.url)}</div></div>`).join('')||'<p class="empty">此范围没有需求。</p>');
}
function renderPanels(){
  const c=state.config,r=state.runtime,n=state.conversations?.current||state.conversations?.needs?.find(n=>n.id===state.conversations.activeNeed);
  if(classic)$('setupSummary').textContent=c.enabled?'已连接 · 正在监听':r.browser==='ready'?'已连接 · 可展开管理':'展开连接或恢复助手';
  $('modelSummary').textContent=(c.model||backendName(state.runtime.harness?.active)+' 默认模型')+' · '+(effortLabels[c.reasoningEffort]||'默认强度')+(classic&&n?' · 当前需求 '+(n.number||'')+'：'+n.title:'');
  $('targetsSummary').textContent='已授权 '+c.targets.length+' 个聊天'+(classic?' · '+(c.visualFps||4)+' 帧/秒':'');
  for(const el of document.querySelectorAll('[data-panel]'))if(!panelPending.has(el.dataset.panel))el.open=!c.uiPanels?.[el.dataset.panel];
}
for(const el of document.querySelectorAll('[data-panel]'))el.addEventListener('toggle',async()=>{
  const key=el.dataset.panel,collapsed=!el.open;if(!state||panelPending.has(key)||collapsed===!!state.config.uiPanels?.[key])return;
  const previous=!!state.config.uiPanels?.[key];state.config.uiPanels={...state.config.uiPanels,[key]:collapsed};panelPending.add(key);
  try{await api('ui/panels',{[key]:collapsed});}catch(e){state.config.uiPanels[key]=previous;el.open=!previous;notice('展开状态未保存：'+e.message,true);}finally{panelPending.delete(key);}
});
for(const id of ['needScope','knowledgeScope','workScope','workStatus'])$(id).addEventListener('change',()=>{if(id==='workStatus'&&$('workStatus').value==='done')$('workScope').value='all';refresh();});
function renderThreadOptions(){
  const select=$('threadSelect'),selected=select.value;
  const context=document.createElement('canvas').getContext('2d');context.font=getComputedStyle(select).font;
  const width=Math.max(80,Math.min(select.clientWidth||320,innerWidth-32)-48);
  const label=t=>{
    const chars=Array.from(String(t.name||t.id).replace(/\s+/g,' ')),suffix=' · '+String(t.id).slice(0,6);
    let low=0,high=Math.min(chars.length,80);
    while(low<high){const mid=Math.ceil((low+high)/2),text=chars.slice(0,mid).join('')+(mid<chars.length?'…':'')+suffix;if(context.measureText(text).width<=width)low=mid;else high=mid-1;}
    return chars.slice(0,low).join('')+(low<chars.length?'…':'')+suffix;
  };
  updateOptions(select,'<option value="">选择一个允许接收任务的聊天</option>'+threads.filter(t=>t.id!==state.config.coordinator).map(t=>`<option value="${escape(t.id)}" title="${escape(t.name)}">${escape(label(t))}</option>`).join(''));
  select.value=threads.some(t=>t.id===selected)?selected:'';select.title=threads.find(t=>t.id===select.value)?.name||'选择聊天；长名称显示开头，完整名称可悬停查看';
}
$('threadSelect').addEventListener('change',()=>{$('threadSelect').title=threads.find(t=>t.id===$('threadSelect').value)?.name||'';});
window.addEventListener('resize',()=>{if(threads.length)requestAnimationFrame(renderThreadOptions);});
function stateQuery(){const q=new URLSearchParams();const chat=chatDestination();if(chat==='agent'&&activeAgent()?.chatKey)q.set('chat',activeAgent().chatKey);else if(chat&&!['agent','account','defaults','add'].includes(chat))q.set('chat',chat);for(const [key,id] of [['needs','needScope'],['knowledge','knowledgeScope'],['work','workScope']])if($(id).value!=='current')q.set(key,$(id).value);if($('workStatus').value!=='all')q.set('status',$('workStatus').value);return q.toString();}
async function refresh(){
  if(busy){refreshAgain=true;return;}busy=true;try{
    const query=stateQuery();
    const oldChat=state?.runtime.harness?.chat||'codex';const incoming=await api('state'+(query?'?'+query:''));if(query!==stateQuery()){refreshAgain=true;return;}state=incoming;const r=state.runtime;
    $('previewNotice').hidden=!state.preview;
    if($('syncStatus'))$('syncStatus').textContent='已同步 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
    const agentBackend=r.harness?.active||'codex',chatBackend=r.harness?.chat||'codex';
    $('agentBackendLabel').textContent='个人 Agent · '+backendName(agentBackend);
    if(!agentHarnessDirty)$('agentHarness').value=r.harness?.configured||agentBackend;
    $('chatHarness').value=chatBackend;
    $('harnessState').textContent='正在使用：'+backendName(agentBackend)+'。已保存：'+backendName(r.harness?.configured||agentBackend)+'。'+(r.harness?.environmentOverride?'BRIDGE_HARNESS 环境变量优先，需修改该变量并重启。':r.harness?.configured&&r.harness.configured!==agentBackend?'重启助手后切换。':'保存其他后端后重启生效。')+' 旧需求与目标聊天继续使用原后端；DSH 需求仅作可恢复的本地归档。';
    if(oldChat!==chatBackend){chatCatalog=null;chatPreferencesDirty=false;loadModeModels(true).catch(e=>notice('普通聊天模型名单暂未读取：'+e.message,true));}
    for(const el of document.querySelectorAll('[data-fold-key]'))if(el.open)openedDetails.add(el.dataset.foldKey);else openedDetails.delete(el.dataset.foldKey);
    if(state.storage){$('storagePath').textContent='固定数据目录：'+state.storage.dataRoot;$('backupInfo').textContent=(state.storage.recovery?state.storage.recovery+'。':'')+(state.storage.backup?'最近状态快照：'+new Date(state.storage.backup.created).toLocaleString('zh-CN',{hour12:false})+'。':'尚未生成状态快照。')+(r.browserEngine==='safari'?' 原视频和连续画面保存在上述目录；Safari 登录态由 Safari 管理。':' 原视频、连续画面和登录态保留在上述目录；')+'自动备份配置、需求与任务记录，退出程序时也会生成快照。';}
    if(classic)$('browserInstructions').textContent=r.browserEngine==='safari'?'使用 Safari 登录助手账号；需要时先切换到助手专用的 Safari 个人资料，再与主号互关并发送私信。':'首次登录专用 Edge 窗口；后续自动恢复保存的会话。主号与它互关后，从手机给它发一条私信。';
    $('liveBadge').textContent=state.config.enabled?'正在监听':'尚未监听';$('liveBadge').className='badge'+(state.config.enabled?' active':'');
    if(state.config.ignoreMessages)$('liveBadge').textContent='忽略新消息 · /结束忽略 恢复';
    $('browserStatus').textContent=({closed:'未打开',waiting_login:'等待登录',select_chat:'请选择会话',ready:'已连接',blocked:'被弹层遮挡',open_error:'打开失败，可重试'})[r.browser]||r.browser;
    $('startSelfBinding').hidden=!!r.selfBinding;$('selfBindingControls').hidden=!r.selfBinding;
    const authReady=r.codex&&r.auth?.status==='ready'&&!r.auth.reconnectPending;
    const hasCoordinator=!!(state.config.coordinator||state.conversations?.current);
    if(!classic){
      renderOnboarding(r,authReady&&hasCoordinator);
      const needsLogin=agentBackend==='codex'&&r.auth?.status==='login';
      $('beginCodexLogin').hidden=!needsLogin;
      const loginLink=$('codexLoginLink');
      if(!needsLogin)loginLink.removeAttribute('href');
      loginLink.hidden=!needsLogin||!loginLink.hasAttribute('href');
      $('agentSetupStatus').textContent=authReady?(hasCoordinator?'个人 Agent 已就绪。返回工作台继续。':'已连接本机助手。点击「创建调度聊天」完成个人 Agent 设置。'):needsLogin?(loginLink.hidden?'点击「准备 ChatGPT 登录」，再打开登录页。':'在登录页完成登录后回到这里，连接状态会自动更新。也可以点「检查连接」。'):r.auth?.message||'正在检查本机助手。若持续等待，点击「检查连接」。';
      $('asrSetupStatus').textContent=r.asrReady?'口播转写已就绪。返回工作台继续。':r.asrInstalling?r.asrProgress||'正在准备安装…':r.asrError?'安装未完成。'+r.asrError+'。处理后点「重试安装」。':'点击「安装转写模型」，在此查看下载、校验和解压进度。';
      $('setupAsr').textContent=r.asrError&&!r.asrInstalling?'重试安装':'安装转写模型';
    }else $('ownerStatus').textContent=state.config.owner?'已绑定：'+state.config.owner.displayName+(state.config.owner.selfChat?'（自聊）':''):'尚未绑定用户会话';
    $('codexStatus').textContent=r.auth?.reconnectPending?'等待切换连接':r.auth?.status==='login'?'请重新登录':r.auth?.status==='quota'?'额度暂不可用':r.codex?'已连接':'等待连接';$('coordinatorStatus').textContent=state.config.coordinator?'当前需求对话已就绪':state.config.uiConfigured?.setup?'收到新需求时创建对话':'尚未建立调度聊天';
    if(r.taskCodex){$('coordinatorStatus').textContent+=' · Codex 项目派发'+(r.taskCodex.ready?'已连接':'等待共享连接');}
    $('asrStatus').textContent=r.asrReady?'已就绪':r.asrInstalling?'正在安装':'尚未安装';$('setupAsr').disabled=r.asrInstalling||r.asrReady;
    $('createCoordinator').disabled=classic?!!state.config.coordinator:!authReady||hasCoordinator;
    $('knowledgeCount').textContent=state.counts.knowledge;$('taskCount').textContent='执行中 '+state.counts.runningTasks+' · 排队 '+state.counts.queuedTasks;
    $('toggleListen').textContent=state.config.enabled?'暂停监听':'开始监听';$('listenTitle').textContent=r.processing?'正在处理视频或指令':state.config.enabled?'手机里直接分享给助手即可':'准备好后开始监听';
    $('scanInfo').textContent=r.scan?`当前：${r.scan.title||'未选会话'} · 识别消息 ${r.scan.diagnostics?.parsed||0} 条`:'浏览器打开后会检查当前会话';
    if(!dirty){targets=state.config.targets;$('maxMinutes').value=state.config.maxVideoSeconds/60;$('visualFps').value=state.config.visualFps||4;$('ackMode').value='auto';renderTargets();}
    if(!preferencesDirty){const c=state.config;$('defaultModel').value=c.model||'';$('fastMode').checked=!!c.fastMode;renderEfforts(c.reasoningEffort||'');$('autoRoute').checked=c.autoRoute!==false;$('contextBudget').value=c.contextBudget||48000;}
    if(!chatPreferencesDirty){const c=state.config;$('chatModel').value=c.chatModel||'';$('chatFast').checked=!!c.chatFastMode;$('chatWeb').checked=c.chatWebSearch!==false;$('chatCode').checked=c.chatCodeSandbox===true;$('chatContextBudget').value=c.chatContextBudget||16000;renderChatEfforts(c.chatReasoningEffort||'');}
    renderNeeds();renderPanels();renderAiChats();
    renderLearning(state,archiveButton);
    if(state.config.ignoreMessages)$('listenTitle').textContent='新消息已静默忽略；发送 /结束忽略 恢复接收';
    const work=state.work||[],business=work.filter(w=>w.kind!=='control'),commands=work.filter(w=>w.kind==='control');
    if($('visibleTaskCount'))$('visibleTaskCount').textContent=business.length;
    updateHTML($('taskList'),business.map(renderWorkCard).join('')||'<p class="empty">此范围没有任务。收到新任务后，执行进度、文字回复和表情回执会出现在同一张卡片内。</p>',{animate:true});
    const legacy=state.outbox.filter(o=>!['sent','superseded'].includes(o.status)&&!JSON.parse(o.payload||'{}').operationId&&!JSON.parse(o.payload||'{}').chatbot);
    let outgoingHTML=(commands.length?`<details class="command-records" data-fold-key="commands"><summary>命令回执（${commands.length}）</summary>${commands.map(renderWorkCard).join('')}</details>`:'')+(legacy.length?`<details class="legacy-records" data-fold-key="legacy"><summary>历史回复回执（${legacy.length}）</summary>${legacy.map(o=>`<div class="item"><p>${escape(o.body.slice(0,100))}</p><small>${escape(deliveryError(o.error))}</small>${o.status==='uncertain'?`<button data-delivered="${o.id}">已在抖音收到</button> <button data-resend="${o.id}">确认未收到，重新发送</button>`:''}</div>`).join('')}</details>`:'');
    const failed=state.messages.filter(m=>['failed','waiting_auth'].includes(m.status)&&m.kind==='video'&&work.some(w=>w.id===m.id));
    outgoingHTML+=failed.slice(0,3).map(m=>`<div class="item"><small>视频处理失败：${escape(m.result)}</small><button data-retry="${escape(m.id)}">重试这条视频</button></div>`).join('');
    updateHTML($('outboxList'),outgoingHTML);
    if(state.deliveryReviewBatch){const b=state.deliveryReviewBatch;$('allDeliveryBatchStatus').textContent=(b.status==='running'?'正在核实':b.status==='done'?'上次核实':'核实已停止')+'：'+b.checked+'/'+b.total+' 条，已确认 '+b.verified+' 条，仍需核实 '+b.unresolved+' 条。';$('reconcileAllDeliveries').disabled=b.status==='running';}
    restoreDetails();
    updateHTML($('eventList'),state.events.map(e=>`<div data-ui-key="event:${escape(e.id||e.created+e.message)}" class="event ${escape(e.level)}">${new Date(e.created).toLocaleTimeString('zh-CN',{hour12:false})}　${escape(e.message)}</div>`).join(''));
    const approvals=await api('approvals');updateHTML($('approvalList'),approvals.map(a=>`<div class="approval" data-ui-key="approval:${escape(a.id)}"><strong>待确认操作 #${escape(a.id)}</strong><pre>${escape(a.description)}</pre><button data-approve="${escape(a.id)}">同意本次</button> <button data-decline="${escape(a.id)}">拒绝</button></div>`).join(''));
  }catch(e){if($('syncStatus'))$('syncStatus').textContent='同步中断';notice('暂时无法确认最新状态：'+e.message,true);}finally{busy=false;if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}}
}
action('prepareDesktopShared',async()=>{const r=await api('desktop/prepare',{});$('desktopSharedState').textContent='入口已准备。先结束桌面中的工作并完全退出，再运行：'+r.launcher+'。之后点击检查共享连接。';notice('共享入口已准备，当前聊天和任务未被中断。');});
action('recoverDesktopTasks',async()=>{const r=await api('desktop/recover',{});notice('已恢复 '+r.recovered+' 项可证明未提交的写入受阻任务；结果不明、归档及中断的任务保持原状态。');});
action('checkDesktopShared',async()=>{const r=await api('desktop/check',{});$('desktopSharedState').textContent=r.message;notice(r.message,!r.ready);});
const openDouyin=async()=>{notice('正在恢复已保存的抖音登录态和绑定会话。只有平台要求重新验证时才需登录。');await api('browser/open',{});};
if(!classic){
  action('setupAccountLink',async()=>{
    showSetupPrompt('是否使用助手账号？','请选择你要使用的账号模式。',[
      ['是，我有小号作为助手账号',()=>chooseDouyinMode('assistant')],
      ['否，我只有一个账号',()=>chooseDouyinMode('self')]
    ]);
  });
  $('douyinMode').addEventListener('change',()=>{douyinModeDirty=true;});
  action('saveDouyinMode',async()=>{
    const mode=$('douyinMode').value,old=selectedMode();
    if(!mode)throw new Error('请选择抖音使用模式');
    if(mode===old){douyinModeDirty=false;return;}
    if(!old){await chooseDouyinMode(mode);return;}
    showSetupPrompt('确认切换抖音使用模式','切换会退出当前抖音账号，需要重新登录另一个账号并绑定会话。',[
      ['确认切换',()=>chooseDouyinMode(mode,true)],
      ['取消',()=>{douyinModeDirty=false;hideSetupPrompt();}]
    ],true);
  });
}
async function chooseDouyinMode(mode,confirmed=false){
  await api('douyin/mode',{mode,confirmed});
  douyinModeDirty=false;
  if(location.hash!=='#workbench')location.hash='workbench';
  if(!confirmed&&state.runtime.browserLoggedIn)showSetupPrompt('抖音已登录','可前往会话核验个人 Agent 的目标私信。',[['前往添加会话 ↗','#chats/add']]);
  else promptDouyinLogin(mode);
}
action('openBrowser',async()=>{
  if(classic)return openDouyin();
  await api('browser/open',{guided:true});
  if(!state.runtime.browserLoggedIn)showSetupPrompt('登录抖音','请在打开的抖音窗口完成登录，成功后会打开工作台。');
});
action('selectAiChat',async()=>{await api('ai-chats/select',{});observedAiChat=null;$('enableAiChat').disabled=true;$('observedChat').textContent='在抖音窗口打开目标聊天后，点击读取。';notice('轮询与发送已暂时暂停，请在抖音窗口选择需要配置的单聊或群聊。');});
action('finishAiSelection',async()=>{await api('ai-chats/cancel',{});observedAiChat=null;notice('已恢复聊天轮询。');});
action('observeAiChat',async()=>{const c=observedAiChat=await api('ai-chats/current',{});$('observedChat').textContent=`已核验：${c.displayName} · ${c.type==='group'?'群聊':'单聊'}`;const option=$('observedChatMode').querySelector('[value="agent"]');option.disabled=c.type!=='single'||c.chatKey!==state.config.owner?.chatKey||c.peerUid!==state.config.owner?.peerUid;$('observedChatMode').value=option.disabled?'chat':state.aiChats?.chats.find(v=>v.chatKey===c.chatKey)?.mode||'chat';$('observedGroupReplyLabel').hidden=c.type!=='group';$('observedGroupReply').value=state.aiChats?.chats.find(v=>v.chatKey===c.chatKey)?.groupReplyMode||'mentions';$('enableAiChat').disabled=false;});
action('enableAiChat',async()=>{if(!observedAiChat)throw new Error('请先读取当前聊天');const saved=await api('ai-chats/save',{token:observedAiChat.token,mode:$('observedChatMode').value,enabled:true,...(observedAiChat.type==='group'?{groupReplyMode:$('observedGroupReply').value}:{})});observedAiChat=null;if(!classic&&saved.chatKey)location.hash=saved.mode==='agent'?'chats/agent/settings':'chats/peer/'+encodeURIComponent(saved.chatKey)+'/settings';notice('聊天模式已保存。监听开启后，只接收启用后的新消息。');});
$('aiChatList').addEventListener('change',async e=>{const select=e.target,key=select.dataset.aiMode||select.dataset.aiReply;if(!key)return;const chat=state.aiChats.chats.find(c=>c.chatKey===key),scope=!!select.dataset.aiReply;select.disabled=true;try{await api('ai-chats/save',{chatKey:key,mode:scope?chat.mode:select.value,enabled:chat.enabled,...(scope?{groupReplyMode:select.value}:{})});notice(scope?'群聊回复范围已保存，从新消息起生效；当前回复继续完成。':'聊天方式已保存，仅影响此聊天；旧任务保留，不会交给普通聊天。');}catch(e){notice(e.message,true);}finally{select.disabled=false;await refresh();}});
action('backupNow',async()=>{await api('storage/backup',{});notice(state?.runtime?.browserEngine==='safari'?'配置、需求记忆和任务记录已生成状态快照。原视频保留在固定数据目录；登录态由 Safari 管理。':'配置、需求记忆和任务记录已生成状态快照。原视频和登录态保留在固定数据目录。');});
action('bindOwner',async()=>{
  if(classic){const r=await api('bind',{});notice('已绑定：'+r.owner.displayName);return;}
  verifiedBinding=null;$('bindSelf').disabled=true;
  const expected=selectedMode(),binding={...await api('bind/inspect',{}),expectedMode:expected};
  if(expected&&binding.mode!==expected){
    const self=binding.mode==='self';
    showSetupPrompt('绑定模式不一致',self?'检测到绑定了自己账号作为个人 Agent，是否切换为主号自聊模式？':'检测到绑定了其他账号作为个人 Agent，是否切换为助手代收模式？',[
      ['是，切换模式',()=>commitAgentBinding(binding,true)],
      ['否，重新绑定',()=>showSetupPrompt('重新绑定',self?'请在抖音窗口打开助手账号与主号的私信，重新核验。':'请在抖音窗口打开自己和自己的私信重新绑定。')]
    ],true);
    return;
  }
  verifiedBinding=binding;
  $('agentBindingResult').textContent='主号 '+binding.displayName+' · '+modeName(binding.mode)+(binding.replaceMain?'。此操作会更换已绑定的主号。':'');
  $('bindSelf').disabled=false;
});
action('startSelfBinding',async()=>{await api('bind/select',{guided:!classic});if(!classic){hideSetupPrompt();verifiedBinding=null;$('agentBindingResult').textContent='';$('bindSelf').disabled=true;}$('startSelfBinding').hidden=true;$('selfBindingControls').hidden=false;notice(classic?'已暂停自动切换。请在抖音窗口打开自聊，再点「确认绑定自己」。':'已暂停自动切换。请按会话绑定说明打开私信，再点「核验当前会话」。');});
action('cancelSelfBinding',async()=>{await api('bind/cancel',{});$('startSelfBinding').hidden=false;$('selfBindingControls').hidden=true;notice('已取消自聊选择。');});
action('bindSelf',async()=>{
  if(classic){const r=await api('bind',{selfChat:true});notice('已绑定自聊：'+r.owner.displayName+'。');return;}
  if(!verifiedBinding)throw new Error('请先核验当前会话');
  await commitAgentBinding(verifiedBinding,false);
});
async function commitAgentBinding(binding,acceptModeMismatch){
  if(binding.replaceMain&&!confirm('将主号更换为「'+binding.displayName+'」？旧的任务和聊天记录仍会保留。'))return;
  const r=await api('bind',{mode:'auto',chatKey:binding.chatKey,selfUid:binding.selfUid,mainUid:binding.mainUid,detectedMode:binding.mode,expectedMode:binding.expectedMode,replaceMain:binding.replaceMain,acceptModeMismatch});
  verifiedBinding=null;$('bindSelf').disabled=true;
  hideSetupPrompt();
  notice(acceptModeMismatch?'已切换到'+modeName(r.mode)+'。':r.mode==='self'?'主号自聊已绑定。开始监听后，文字以「/助手」开头。':'主号与代收助手已绑定。开始监听后，用主号给助手发消息。');
}
if(!classic)action('saveInstancePreferences',async()=>{
  const form=instanceForm;if(!form)return;
  const [model,effort,fast,budget,minutes,fps,autoRoute]=instanceFields.map(id=>$(id).value);
  await api('conversation-preferences',{peer:form.peer,mode:form.mode,harness:form.harness,model:model==='__inherit'?null:model,reasoningEffort:effort==='__inherit'?null:effort,fastMode:fast?fast==='on':null,contextBudget:budget?Number(budget):null,maxVideoSeconds:minutes?Number(minutes)*60:null,visualFps:fps?Number(fps):null,autoRoute:autoRoute?autoRoute==='on':null});
  instanceDrafts.delete(form.draftKey);notice('会话覆盖已保存，从下一轮开始使用。');
});
action('createCoordinator',async()=>{await api('coordinator',{});notice('固定调度聊天已建立。');});
if(!classic)action('beginCodexLogin',async()=>{
  const result=await api('codex/login',{});
  if(!result.ready){
    const url=new URL(result.url);
    if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(url.host))throw new Error('无法识别登录页');
    const link=$('codexLoginLink');link.href=url.href;link.hidden=false;
  }
});
action('reconnectCodex',async()=>{const r=await api('codex/reconnect',{});notice(r.deferred?'当前任务仍在执行，结束后会重新连接。':r.auth.status==='ready'?'已读取本机当前助手登录，视频进度和目标名单已保留。':r.auth.message,!r.deferred&&r.auth.status!=='ready');});
action('reloadModels',async()=>{await loadModels();});
action('saveHarness',async()=>{const r=await api('harness',{harness:$('agentHarness').value});agentHarnessDirty=false;notice(r.environmentOverride?'已保存；BRIDGE_HARNESS 环境变量仍有优先权，修改该变量并重启才会切换。':r.restartRequired?'后端已保存，重启助手后生效。旧需求、任务与模型组合已保留。':'后端已保存。');});
$('agentHarness').addEventListener('change',()=>agentHarnessDirty=true);
$('chatHarness').addEventListener('change',async()=>{const select=$('chatHarness'),next=select.value;if(chatPreferencesDirty){select.value=state.runtime.harness?.chat||'codex';notice('请先保存当前普通聊天的模型配置，再切换后端。',true);return;}select.disabled=true;try{await api('chat-harness',{harness:next});await refresh();await loadModeModels(true);notice('普通聊天后端已保存，从下一轮起使用 '+backendName(next)+'；各后端模型组合分开保留。');}catch(e){select.value=state.runtime.harness?.chat||'codex';notice(e.message,true);}finally{select.disabled=false;}});
action('savePreferences',async()=>{await api('preferences',{model:$('defaultModel').value,reasoningEffort:$('defaultEffort').value,fastMode:$('fastMode').checked,autoRoute:$('autoRoute').checked,contextBudget:Number($('contextBudget').value)});preferencesDirty=false;notice('默认配置已保存，从下一次调用起生效。');});
action('saveChatPreferences',async()=>{await api('chat-preferences',{model:$('chatModel').value,reasoningEffort:$('chatEffort').value,fastMode:$('chatFast').checked,webSearch:$('chatWeb').checked,codeSandbox:$('chatCode').checked,contextBudget:Number($('chatContextBudget').value)});chatPreferencesDirty=false;notice('普通聊天配置已保存，从下一轮起生效。');});
$('chatModel').addEventListener('change',()=>{chatPreferencesDirty=true;renderChatEfforts('');});for(const id of ['chatEffort','chatFast','chatWeb','chatCode','chatContextBudget'])$(id).addEventListener('change',()=>chatPreferencesDirty=true);
action('checkCodeSandbox',async()=>{const r=await api('code-sandbox/check',{});$('codeSandboxState').textContent=r.message;notice(r.message,!r.ready);});
action('setupCodeSandbox',async()=>{await api('code-sandbox/setup',{});notice('已开始准备 Python 容器镜像。完成后点“检查代码沙箱”，再保存启用；模型不会自行安装镜像。');});
action('newNeed',async()=>{const n=await api('needs/new',{title:$('newNeedTitle').value.trim()});$('newNeedTitle').value='';notice('已新建并切换到需求 '+(n.number||'')+'：'+n.title);});
$('defaultModel').addEventListener('change',()=>{preferencesDirty=true;renderEfforts('');});
for(const id of ['defaultEffort','fastMode','autoRoute','contextBudget'])$(id).addEventListener('change',()=>preferencesDirty=true);
action('setupAsr',async()=>{await api('asr/setup',{});notice('转写模型正在后台安装，可在运行记录查看进度。');});
action('toggleListen',async()=>{await api('listen',{enabled:!state.config.enabled});notice(state.config.enabled?'已暂停接收新指令。':'监听已启动。请从手机分享一条新视频。');});
action('loadThreads',async()=>{threads=await api('threads?harness='+encodeURIComponent($('targetHarness').value));renderThreadOptions();notice('已读取 '+threads.length+' 个 '+backendName($('targetHarness').value)+' 本机聊天。');});
$('targetHarness').addEventListener('change',()=>{threads=[];renderThreadOptions();});
action('addTarget',async()=>{const t=threads.find(t=>t.id===$('threadSelect').value);if(!t)throw new Error('请先选择聊天');const alias=$('targetAlias').value.trim();if(!alias)throw new Error('请填写别名');await changeTargets(list=>{if(list.some(x=>x.id===t.id||x.alias===alias))throw new Error('此聊天或别名已在名单中');return [...list,{id:t.id,name:t.name,alias}];});});
action('saveConfig',async()=>{await api(classic?'config':'video-preferences',{...(classic?{targets}:{}),maxVideoSeconds:Number($('maxMinutes').value)*60,visualFps:Number($('visualFps').value),ackMode:$('ackMode').value});dirty=false;notice('配置已保存。');});
$('maxMinutes').addEventListener('input',()=>dirty=true);
$('visualFps').addEventListener('change',()=>dirty=true);
$('ackMode').addEventListener('change',()=>dirty=true);
$('targetList').addEventListener('click',e=>{const index=e.target.dataset.remove,id=targets[Number(index)]?.id;if(index!==undefined&&id)changeTargets(list=>list.filter(t=>t.id!==id)).catch(e=>notice(e.message,true));});
document.addEventListener('click',async e=>{try{
  const control=e.target.closest('button,a');if(!control)return;const d=control.dataset;
  if(d.reviewKind)await openDeliveryReview(d.reviewKind,d.reviewId);
  if(d.reviewReconcile){control.disabled=true;try{const r=await api('outbox/reconcile',{id:d.reviewReconcile});$('reviewError').textContent=r.reason||'当前未取得确定证据，保持待核实。';await loadDeliveryReview();await refresh();}catch(e){$('reviewError').textContent=e.message;}finally{control.disabled=false;}}
  if(d.reviewInvisible){if(confirm('确认这条回复在群成员一侧看不到？将标记可见性待核实并暂停本群自动回复，其他聊天继续；不重发此消息。')){await api('outbox/recipient-invisible',{id:d.reviewInvisible,confirmed:true});await loadDeliveryReview();await refresh();}}
  if(d.reviewResolve){const status=d.reviewStatus,prompt=status==='sent'?'文字请确认接收方账号能看到本段；表情请确认原消息上显示助手所贴表情。仅看到助手自己的文字气泡不能确认接收方可见。确认后保存人工记录，不重发。':status==='pending'?'请确认此段文字在抖音没有收到，并授权重新发送这一段。':'确定放弃这条回执？它不会再发送，也不会被标记为已送达。执行结果和其他回复保留。';if(confirm(prompt)){control.disabled=true;try{await api('outbox/resolve',{id:d.reviewResolve,status,confirmed:true});$('reviewError').textContent=status==='sent'?'已记录人工确认送达。':status==='pending'?'已按你的明确确认排入这一段文字。':'已放弃此回执，未将其标记为送达。';await loadDeliveryReview();await refresh();}catch(e){$('reviewError').textContent=e.message;}finally{control.disabled=false;}}}
  if(d.deleteKind){control.disabled=true;try{const p=await api('archive/delete/prepare',{kind:d.deleteKind,id:d.deleteId});deleting={kind:d.deleteKind,id:d.deleteId,token:p.token};$('deleteLabel').textContent=p.label;$('deleteCounts').textContent=d.deleteKind==='knowledge'?'将删除 1 条学习资料及其本地文件。':`将删除 ${p.counts.operations} 项任务记录、${p.counts.tasks} 项执行记录、${p.counts.messages} 条原始请求、${p.counts.replies} 段回复及 ${p.counts.receipts} 条回执。`;$('deleteWarning').textContent=p.warning;$('deleteError').textContent='';$('deleteAcknowledge').checked=false;$('confirmDelete').disabled=true;deleteDialog.showModal();$('cancelDelete').focus();}catch(e){if(e.code==='DELIVERY_UNCONFIRMED')await openDeliveryReview(d.deleteKind,d.deleteId);throw e;}finally{control.disabled=false;}}
  if(d.reconcileReply){const r=await api('outbox/reconcile',{id:d.reconcileReply});notice(r.reason||'当前未取得确定证据，保留待核实。',!r.verified);await refresh();}
  if(d.aiToggle){const chat=state.aiChats.chats.find(c=>c.chatKey===d.aiToggle);control.disabled=true;try{await api('ai-chats/save',{chatKey:chat.chatKey,mode:chat.mode,enabled:!chat.enabled});notice(chat.enabled?'此聊天已停用，未发送的旧回复已停止。':'此聊天已启用，从新消息开始处理。');await refresh();}finally{control.disabled=false;}}
  if(d.interruptTask){const button=control;button.disabled=true;try{const r=await api('tasks/interrupt',{id:d.interruptTask});notice(r.state==='stopped'?'任务 '+r.number+' 已中断。':r.state==='finished'?r.error:'本地处理已切断；助手停止情况需要核实，不会自动重跑。',r.state==='uncertain');await refresh();}finally{button.disabled=false;}}
  if(d.archiveKind){const button=control;button.disabled=true;try{const archived=d.archiveValue==='true',r=await api('archive',{kind:d.archiveKind,id:d.archiveId,archived});notice(archived?(d.archiveKind==='need'?r.localOnlyThreads?'需求已本地归档，可恢复；DSH 未提供原生归档。':'需求和对应的 Codex 需求对话已归档。':'已归档，记录和原始资料仍保留。'):'已恢复显示；暂停任务需要明确重试后才执行。');await refresh();}finally{button.disabled=false;}}
  if(d.switchNeed){const n=await api('needs/switch',{id:d.switchNeed});notice('已切换到：'+n.title);await refresh();}
  if(d.note){const k=await api('knowledge/'+encodeURIComponent(d.note));$('noteText').textContent=k.note;$('noteDialog').showModal();}
  if(d.visual){const v=await api('knowledge/'+encodeURIComponent(d.visual)+'/visual');$('visualInfo').textContent=`${v.fps} 帧/秒 · 已分析 ${v.completedSegments}/${v.totalSegments} 段 · 覆盖至 ${v.coveredUntil.toFixed(1)}/${v.duration.toFixed(1)} 秒。每组按左上、右上、左下、右下阅读。`;$('visualSheets').innerHTML=Array.from({length:v.sheetCount},(_,i)=>`<img loading="lazy" src="/api/knowledge/${encodeURIComponent(d.visual)}/sheet/${i}" alt="第 ${i+1} 组连续画面">`).join('');$('visualNotes').textContent=v.segments.map(s=>`${s.start.toFixed(1)}–${s.end.toFixed(1)} 秒\n${s.text}`).join('\n\n');$('visualDialog').showModal();}
  if(d.reanalyze){await api('knowledge/reanalyze',{id:d.reanalyze});notice('开始按完整时间轴重分析视觉内容，已完成的片段会复用。');}
  if(d.delivered||d.resend){if(confirm(d.delivered?'请确认已在抖音收到这一段文字。':'请确认这一段没有收到，并授权重新发送。')){await api('outbox/resolve',{id:d.delivered||d.resend,status:d.delivered?'sent':'pending',confirmed:true});await refresh();}}
  if(d.retry)await api('retry/video',{id:d.retry});
  if(d.approve||d.decline)await api('approval',{id:d.approve||d.decline,allow:!!d.approve});
}catch(err){notice(err.message,true);}});
$('closeNote').addEventListener('click',()=>$('noteDialog').close());
$('closeVisual').addEventListener('click',()=>$('visualDialog').close());
await refresh();if(!classic)openSettingsSection();loadModels().catch(e=>notice('模型名单暂未读取：'+e.message,true));api('instance').then(r=>{if($('consoleVersion'))$('consoleVersion').textContent='v'+r.version+(r.preview?' · 预览':'');}).catch(()=>{});api('commands').then(r=>{if(r.text)$('commandHelp').textContent=r.text;}).catch(()=>{});setInterval(refresh,2500);
