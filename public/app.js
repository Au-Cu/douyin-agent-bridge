const $=id=>document.getElementById(id);let state=null,targets=[],threads=[],dirty=false,busy=false;
let catalog=null,preferencesDirty=false;
const panelPending=new Set();let refreshAgain=false;
const archiveButton=(kind,item)=>`<button class="secondary" data-archive-kind="${kind}" data-archive-id="${escape(item.id)}" data-archive-value="${!item.archived}">${item.archived?'恢复显示':'归档'}</button>`+(kind==='task'&&item.kind!=='control'?`<button class="interrupt-button" data-interrupt-task="${escape(item.id)}" aria-label="中断任务 ${item.number||''}" ${item.canInterrupt?'':'disabled'}>中断</button>`:'');
const chatLink=(url,label='需求对话')=>/^codex:\/\/threads\/[a-f\d-]{36}$/i.test(url||'')?`<a class="chat-link" href="${escape(url)}">Codex · ${escape(label)}</a>`:'';
const effortLabels={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanError=s=>String(s||'').replace(/\x1b\[[\d;]*[A-Za-z]/g,'');
const openedDetails=new Set();
document.addEventListener('toggle',e=>{const key=e.target.dataset?.foldKey;if(!key||!e.target.isConnected)return;if(e.target.open)openedDetails.add(key);else openedDetails.delete(key);},true);
function restoreDetails(){for(const detail of document.querySelectorAll('[data-fold-key]'))detail.open=openedDetails.has(detail.dataset.foldKey);}
function deliveryError(s){s=cleanError(s);return /intercepts pointer events|OVERLAY_BLOCKED/.test(s)?'抖音弹层遮挡原消息，尚未点击表情。关闭视频预览或弹窗后可恢复。':/locator\.click: Timeout/.test(s)?'原消息暂不可操作，未确认贴表情。请检查弹层遮挡或消息位置。':s.length>220?s.slice(0,220)+'…':s;}
function renderWorkCard(w){
  const labels={roger:'收到',active:'运行',done:'完成'};
  const receipt=w.receipts.map(r=>{const text=!r.total?'未生成回执':r.uncertain?'送达需核实':r.sent===r.total?'已送达'+(r.total>1?' '+r.sent+'/'+r.total:''):r.pending?'等待发送':r.unavailable?'未送达':'待确认';return `<span class="receipt-state ${r.uncertain||r.unavailable?'error':''}">${labels[r.stage]}：${escape(text)}</span>`;}).join('');
  const errors=[...new Set(w.receipts.flatMap(r=>r.errors||[]))],results=w.replies.filter(r=>!r.notification),sent=results.filter(r=>r.status==='sent').length,uncertain=w.replies.filter(r=>r.status==='uncertain');
  const details=errors.length?`<details class="work-details" data-fold-key="${escape('receipts:'+w.id)}"><summary>表情发送详情${errors.length?'（'+errors.length+'）':''}</summary>${errors.map((e,i)=>`<p>${escape(deliveryError(e))}</p>${cleanError(e).length>240?`<details data-fold-key="${escape('technical:'+w.id+':'+i)}"><summary>技术详情</summary><pre>${escape(cleanError(e).slice(0,1800))}</pre></details>`:''}`).join('')}</details>`:'';
  return `<article class="work-card" data-operation="${escape(w.id)}"><div class="work-head"><strong>${w.kind==='control'?'命令：':'任务 '+(w.number||'待登记')+'：'}${escape(w.title)}</strong><span class="pill ${['uncertain','failed_delivery','failed','blocked'].includes(w.status)?'error':''}">${statuses[w.status]||escape(w.status)}</span>${w.archived?'<span class="pill">已归档</span>':''}</div><p>${escape(w.detail)}</p>${w.targets?.length?`<small>目标：${w.targets.map(t=>escape(t.alias)+'（'+(statuses[t.status]||escape(t.status))+'）').join('、')}</small>`:''}<div class="work-receipts">${receipt}</div>${results.length?`<p class="work-meta">结果回复：已送达 ${sent}/${results.length} 段</p>`:''}${uncertain.map(r=>`<div class="reply-review">回复送达需核实 <button data-delivered="${r.id}">已在抖音收到</button> <button data-resend="${r.id}">确认未收到，重新发送</button></div>`).join('')}${details}<div class="card-actions">${archiveButton('task',w)}${(w.links||[]).map(l=>chatLink(l.url,l.label)).join('')}</div></article>`;
}
const statuses={queued:'排队中',blocked:'调度受阻',running:'执行中',done:'已完成',failed:'处理失败',cancelled:'已取消',waiting:'等待恢复',failed_delivery:'送达需核实',unavailable:'表情暂不可用',waiting_auth:'等待账号恢复',waiting_route:'等待选择需求',uncertain:'需要核实',pending:'待发送',sent:'已送达',sending:'发送中',new:'等待处理',processing:'处理中'};
statuses.stopping='中断中';
$('workStatus').add(new Option('中断中','stopping'),$('workStatus').querySelector('[value="sending"]'));
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data;}
function notice(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';$('notice').style.display='block';}
function action(id,fn){$(id).addEventListener('click',async()=>{const button=$(id);button.disabled=true;try{await fn();await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}});}
function renderTargets(){$('targetList').innerHTML=targets.map((t,i)=>`<div class="target">${escape(t.alias)} <small>${escape(t.name)}</small><button data-remove="${i}" aria-label="移除目标">×</button></div>`).join('');}
let targetTail=Promise.resolve();
function changeTargets(change){const task=targetTail.catch(()=>{}).then(async()=>{const next=change(targets);await api('targets',{targets:next});targets=next;state.config.targets=next;renderTargets();notice('授权名单已即时保存，重启后会恢复。');});targetTail=task;return task;}
function renderEfforts(value=$('defaultEffort').value){
  const id=$('defaultModel').value||catalog?.defaults?.model,model=catalog?.models?.find(m=>m.model===id);
  $('defaultEffort').innerHTML='<option value="">使用默认强度</option>'+(model?.supportedReasoningEfforts||[]).map(e=>`<option value="${escape(e.reasoningEffort)}">${escape(effortLabels[e.reasoningEffort]||e.reasoningEffort)}</option>`).join('');
  $('defaultEffort').value=Array.from($('defaultEffort').options).some(o=>o.value===value)?value:'';
  const fast=!!model?.serviceTiers?.some(t=>/fast/i.test(t.name)||['fast','priority'].includes(t.id));$('fastMode').disabled=!!catalog&&!fast;
  if(catalog&&!fast)$('fastMode').checked=false;
}
async function loadModels(){
  const selected=$('defaultModel').value||state?.config.model||'',effort=$('defaultEffort').value||state?.config.reasoningEffort||'';
  const data=await api('models');if(!Array.isArray(data.models))return;
  catalog=data;$('defaultModel').innerHTML='<option value="">Codex 默认'+(data.defaults?.model?'（'+escape(data.defaults.model)+'）':'')+'</option>'+data.models.map(m=>`<option value="${escape(m.model)}">${escape(m.displayName)} · ${escape(m.model)}</option>`).join('');
  if(selected&&!data.models.some(m=>m.model===selected))$('defaultModel').add(new Option(selected+'（当前账号不可用）',selected));
  $('defaultModel').value=selected;renderEfforts(effort);
  $('effectiveModel').textContent='Codex 当前默认：'+(data.defaults?.model||'未返回')+'；默认强度：'+(effortLabels[data.defaults?.effort]||data.defaults?.effort||'按模型默认')+'。配置从下一次调用起生效，正在执行的调用不切换。';
}
function renderNeeds(){
  const sessions=state.conversations,list=sessions?.needs||[],active=sessions?.current||list.find(n=>n.id===sessions.activeNeed);
  $('currentNeed').textContent=active?`当前需求${active.number?' '+active.number:''}：${active.title}\n第 ${active.seq} 个续接会话 · ${active.contextTokens>=sessions.budget?'下次处理前将交接续开':`上下文约 ${active.contextTokens} / ${sessions.budget} tokens`}`:'发送消息后按需求自动判断；旧对话会保留为历史记录。';
  $('needList').innerHTML=list.map(n=>`<div class="need-item"><strong>${n.number?'需求 '+n.number+'：':''}${escape(n.title)}</strong><small>第 ${n.seq} 个会话${n.archived?' · 已归档':''}</small><div>${escape(n.summary.slice(0,150))}</div>${n.archiveState&&n.archiveState!=='done'?`<p class="error">归档同步需核对：${escape(n.archiveError||'正在处理')}</p>`:''}<div class="card-actions">${!n.archived&&(!n.archiveState||n.archiveState==='done')?`<button data-switch-need="${escape(n.id)}" ${n.id===sessions.activeNeed?'disabled':''}>${n.id===sessions.activeNeed?'当前需求':'切换到此需求'}</button>`:''}${archiveButton('need',n)}${!n.archived&&n.archiveState&&n.archiveState!=='done'?`<button data-archive-kind="need" data-archive-id="${escape(n.id)}" data-archive-value="false">恢复显示并核对 Codex</button>`:''}${chatLink(n.url)}</div></div>`).join('')||'<p class="empty">此范围没有需求。</p>';
}
function renderPanels(){
  const c=state.config,r=state.runtime,n=state.conversations?.current||state.conversations?.needs?.find(n=>n.id===state.conversations.activeNeed);
  $('setupSummary').textContent=c.enabled?'已连接 · 正在监听':r.browser==='ready'?'已连接 · 可展开管理':'展开连接或恢复助手';
  $('modelSummary').textContent=(c.model||'Codex 默认模型')+' · '+(effortLabels[c.reasoningEffort]||'默认强度')+(n?' · 当前需求 '+(n.number||'')+'：'+n.title:'');
  $('targetsSummary').textContent='已授权 '+c.targets.length+' 个聊天 · '+(c.visualFps||4)+' 帧/秒';
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
  select.innerHTML='<option value="">选择一个允许接收任务的聊天</option>'+threads.filter(t=>t.id!==state.config.coordinator).map(t=>`<option value="${escape(t.id)}" title="${escape(t.name)}">${escape(label(t))}</option>`).join('');
  select.value=threads.some(t=>t.id===selected)?selected:'';select.title=threads.find(t=>t.id===select.value)?.name||'选择聊天；长名称显示开头，完整名称可悬停查看';
}
$('threadSelect').addEventListener('change',()=>{$('threadSelect').title=threads.find(t=>t.id===$('threadSelect').value)?.name||'';});
window.addEventListener('resize',()=>{if(threads.length)requestAnimationFrame(renderThreadOptions);});
async function refresh(){
  if(busy){refreshAgain=true;return;}busy=true;try{
    const q=new URLSearchParams();for(const [key,id] of [['needs','needScope'],['knowledge','knowledgeScope'],['work','workScope']])if($(id).value!=='current')q.set(key,$(id).value);if($('workStatus').value!=='all')q.set('status',$('workStatus').value);
    state=await api('state'+(q.size?'?'+q:''));const r=state.runtime;
    for(const el of document.querySelectorAll('[data-fold-key]'))if(el.open)openedDetails.add(el.dataset.foldKey);else openedDetails.delete(el.dataset.foldKey);
    if(state.storage){$('storagePath').textContent='固定数据目录：'+state.storage.dataRoot;$('backupInfo').textContent=(state.storage.recovery?state.storage.recovery+'。':'')+(state.storage.backup?'最近状态快照：'+new Date(state.storage.backup.created).toLocaleString('zh-CN',{hour12:false})+'。':'尚未生成状态快照。')+' 原视频、连续画面和登录态保留在上述目录；自动备份配置、需求与任务记录，退出程序时也会生成快照。';}
    $('liveBadge').textContent=state.config.enabled?'正在监听':'尚未监听';$('liveBadge').className='badge'+(state.config.enabled?' active':'');
    if(state.config.ignoreMessages)$('liveBadge').textContent='忽略新消息 · /结束忽略 恢复';
    $('browserStatus').textContent=({closed:'未打开',waiting_login:'等待登录',select_chat:'请选择会话',ready:'已连接',blocked:'被弹层遮挡'})[r.browser]||r.browser;
    $('ownerStatus').textContent=state.config.owner?'已绑定：'+state.config.owner.displayName:'尚未绑定用户会话';
    $('codexStatus').textContent=r.auth?.reconnectPending?'等待切换连接':r.auth?.status==='login'?'请重新登录':r.auth?.status==='quota'?'额度暂不可用':r.codex?'已连接':'等待连接';$('coordinatorStatus').textContent=state.config.coordinator?'当前需求对话已就绪':state.config.uiConfigured?.setup?'收到新需求时创建对话':'尚未建立调度聊天';
    $('asrStatus').textContent=r.asrReady?'已就绪':r.asrInstalling?'正在安装':'尚未安装';$('setupAsr').disabled=r.asrInstalling||r.asrReady;
    $('createCoordinator').disabled=!!state.config.coordinator;
    $('knowledgeCount').textContent=state.counts.knowledge;$('taskCount').textContent='执行中 '+state.counts.runningTasks+' · 排队 '+state.counts.queuedTasks;
    $('toggleListen').textContent=state.config.enabled?'暂停监听':'开始监听';$('listenTitle').textContent=r.processing?'正在处理视频或指令':state.config.enabled?'手机里直接分享给助手即可':'准备好后开始监听';
    $('scanInfo').textContent=r.scan?`当前：${r.scan.title||'未选会话'} · 识别消息 ${r.scan.diagnostics?.parsed||0} 条`:'浏览器打开后会检查当前会话';
    if(!dirty){targets=state.config.targets;$('maxMinutes').value=state.config.maxVideoSeconds/60;$('visualFps').value=state.config.visualFps||4;$('ackMode').value='auto';renderTargets();}
    if(!preferencesDirty){const c=state.config;$('defaultModel').value=c.model||'';renderEfforts(c.reasoningEffort||'');$('fastMode').checked=!!c.fastMode;$('autoRoute').checked=c.autoRoute!==false;$('contextBudget').value=c.contextBudget||48000;}
    renderNeeds();renderPanels();
    $('knowledgeList').innerHTML=state.knowledge.map(k=>`<div class="item"><strong>${escape(k.title)}</strong>${k.archived?'<span class="pill">已归档</span>':''}<p>${escape(r.processing&&r.visualProgress?.id===k.id?'正在按完整时间轴分析视觉内容，等待本次结论。':k.visualStatus==='partial'?`视觉已完成 ${k.visualCompleted}/${k.visualTotal} 段，尚未覆盖全片，可继续重分析。`:k.visualStatus==='legacy'?'此视频尚未完成连续视觉分析，请重新分析后查看完整结论。':k.summary?.slice(0,150)||'视频已保存，等待连续视觉分析完成。')}</p><div class="button-row"><button data-note="${escape(k.id)}" class="secondary">学习笔记</button><button data-visual="${escape(k.id)}" class="secondary">查看连续画面</button><button data-reanalyze="${escape(k.id)}" ${r.processing?'disabled':''}>重新分析视觉</button>${archiveButton('knowledge',k)}</div></div>`).join('')||'<p class="empty">此范围没有学习资料。</p>';
    if(r.processing&&r.visualProgress){const p=r.visualProgress;$('listenTitle').textContent=`连续视觉分析 ${p.completed}/${p.total||'…'} 段 · ${p.fps} 帧/秒`;}
    if(state.config.ignoreMessages)$('listenTitle').textContent='新消息已静默忽略；发送 /结束忽略 恢复接收';
    const work=state.work||[],business=work.filter(w=>w.kind!=='control'),commands=work.filter(w=>w.kind==='control');
    $('taskList').innerHTML=business.map(renderWorkCard).join('')||'<p class="empty">收到任务后，这里会把执行进度、文字回复和表情回执放在同一张卡片内。</p>';
    const legacy=state.outbox.filter(o=>!['sent','superseded'].includes(o.status)&&!JSON.parse(o.payload||'{}').operationId);
    $('outboxList').innerHTML=(commands.length?`<details data-fold-key="commands"><summary>命令回执（${commands.length}）</summary>${commands.map(renderWorkCard).join('')}</details>`:'')+(legacy.length?`<details data-fold-key="legacy"><summary>历史回复回执（${legacy.length}）</summary>${legacy.map(o=>`<div class="item"><p>${escape(o.body.slice(0,100))}</p><small>${escape(deliveryError(o.error))}</small>${o.status==='uncertain'?`<button data-delivered="${o.id}">已在抖音收到</button> <button data-resend="${o.id}">确认未收到，重新发送</button>`:''}</div>`).join('')}</details>`:'');
    const failed=state.messages.filter(m=>['failed','waiting_auth'].includes(m.status)&&m.kind==='video'&&work.some(w=>w.id===m.id));
    $('outboxList').innerHTML+=failed.slice(0,3).map(m=>`<div class="item"><small>视频处理失败：${escape(m.result)}</small><button data-retry="${escape(m.id)}">重试这条视频</button></div>`).join('');
    restoreDetails();
    $('eventList').innerHTML=state.events.map(e=>`<div class="event ${escape(e.level)}">${new Date(e.created).toLocaleTimeString('zh-CN',{hour12:false})}　${escape(e.message)}</div>`).join('');
    const approvals=await api('approvals');$('approvalList').innerHTML=approvals.map(a=>`<div class="approval"><strong>待确认操作 #${escape(a.id)}</strong><pre>${escape(a.description)}</pre><button data-approve="${escape(a.id)}">同意本次</button> <button data-decline="${escape(a.id)}">拒绝</button></div>`).join('');
  }catch(e){notice(e.message,true);}finally{busy=false;if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}}
}
action('openBrowser',async()=>{notice('正在恢复已保存的抖音登录态和绑定会话。只有平台要求重新验证时才需登录。');await api('browser/open',{});});
action('backupNow',async()=>{await api('storage/backup',{});notice('配置、需求记忆和任务记录已生成状态快照。原视频和登录态保留在固定数据目录。');});
action('bindOwner',async()=>{const r=await api('bind',{});notice('已绑定：'+r.owner.displayName);});
action('createCoordinator',async()=>{await api('coordinator',{});notice('固定调度聊天已建立。');});
action('reconnectCodex',async()=>{const r=await api('codex/reconnect',{});notice(r.deferred?'当前任务仍在执行，结束后会重新连接。':r.auth.status==='ready'?'已读取本机当前 Codex 登录，视频进度和目标名单已保留。':r.auth.message,!r.deferred&&r.auth.status!=='ready');});
action('reloadModels',async()=>{await loadModels();notice('已读取当前 Codex 的模型与推理档位。');});
action('savePreferences',async()=>{await api('preferences',{model:$('defaultModel').value,reasoningEffort:$('defaultEffort').value,fastMode:$('fastMode').checked,autoRoute:$('autoRoute').checked,contextBudget:Number($('contextBudget').value)});preferencesDirty=false;notice('默认配置已保存，从下一次调用起生效。');});
action('newNeed',async()=>{const n=await api('needs/new',{title:$('newNeedTitle').value.trim()});$('newNeedTitle').value='';notice('已新建并切换到需求 '+(n.number||'')+'：'+n.title);});
$('defaultModel').addEventListener('change',()=>{preferencesDirty=true;renderEfforts('');});
for(const id of ['defaultEffort','fastMode','autoRoute','contextBudget'])$(id).addEventListener('change',()=>preferencesDirty=true);
action('setupAsr',async()=>{await api('asr/setup',{});notice('转写模型正在后台安装，可在运行记录查看进度。');});
action('toggleListen',async()=>{await api('listen',{enabled:!state.config.enabled});notice(state.config.enabled?'已暂停接收新指令。':'监听已启动。请从手机分享一条新视频。');});
action('loadThreads',async()=>{threads=await api('threads');renderThreadOptions();notice('已读取 '+threads.length+' 个本机聊天。');});
action('addTarget',async()=>{const t=threads.find(t=>t.id===$('threadSelect').value);if(!t)throw new Error('请先选择聊天');const alias=$('targetAlias').value.trim();if(!alias)throw new Error('请填写别名');await changeTargets(list=>{if(list.some(x=>x.id===t.id||x.alias===alias))throw new Error('此聊天或别名已在名单中');return [...list,{id:t.id,name:t.name,alias}];});});
action('saveConfig',async()=>{await api('config',{targets,maxVideoSeconds:Number($('maxMinutes').value)*60,visualFps:Number($('visualFps').value),ackMode:$('ackMode').value});dirty=false;notice('配置已保存。');});
$('maxMinutes').addEventListener('input',()=>dirty=true);
$('visualFps').addEventListener('change',()=>dirty=true);
$('ackMode').addEventListener('change',()=>dirty=true);
$('targetList').addEventListener('click',e=>{const index=e.target.dataset.remove,id=targets[Number(index)]?.id;if(index!==undefined&&id)changeTargets(list=>list.filter(t=>t.id!==id)).catch(e=>notice(e.message,true));});
document.addEventListener('click',async e=>{try{
  const d=e.target.dataset;
  if(d.interruptTask){const button=e.target;button.disabled=true;try{const r=await api('tasks/interrupt',{id:d.interruptTask});notice(r.state==='stopped'?'任务 '+r.number+' 已中断。':r.state==='finished'?r.error:'本地处理已切断；Codex 停止情况需要核实，不会自动重跑。',r.state==='uncertain');await refresh();}finally{button.disabled=false;}}
  if(d.archiveKind){const button=e.target;button.disabled=true;try{const archived=d.archiveValue==='true';await api('archive',{kind:d.archiveKind,id:d.archiveId,archived});notice(archived?(d.archiveKind==='need'?'需求和对应的 Codex 需求对话已归档。':'已归档，记录和原始资料仍保留。'):'已恢复显示；暂停任务需要明确重试后才执行。');await refresh();}finally{button.disabled=false;}}
  if(d.switchNeed){const n=await api('needs/switch',{id:d.switchNeed});notice('已切换到：'+n.title);await refresh();}
  if(d.note){const k=await api('knowledge/'+encodeURIComponent(d.note));$('noteText').textContent=k.note;$('noteDialog').showModal();}
  if(d.visual){const v=await api('knowledge/'+encodeURIComponent(d.visual)+'/visual');$('visualInfo').textContent=`${v.fps} 帧/秒 · 已分析 ${v.completedSegments}/${v.totalSegments} 段 · 覆盖至 ${v.coveredUntil.toFixed(1)}/${v.duration.toFixed(1)} 秒。每组按左上、右上、左下、右下阅读。`;$('visualSheets').innerHTML=Array.from({length:v.sheetCount},(_,i)=>`<img loading="lazy" src="/api/knowledge/${encodeURIComponent(d.visual)}/sheet/${i}" alt="第 ${i+1} 组连续画面">`).join('');$('visualNotes').textContent=v.segments.map(s=>`${s.start.toFixed(1)}–${s.end.toFixed(1)} 秒\n${s.text}`).join('\n\n');$('visualDialog').showModal();}
  if(d.reanalyze){await api('knowledge/reanalyze',{id:d.reanalyze});notice('开始按完整时间轴重分析视觉内容，已完成的片段会复用。');}
  if(d.delivered||d.resend)await api('outbox/resolve',{id:d.delivered||d.resend,status:d.delivered?'sent':'pending'});
  if(d.retry)await api('retry/video',{id:d.retry});
  if(d.approve||d.decline)await api('approval',{id:d.approve||d.decline,allow:!!d.approve});
}catch(err){notice(err.message,true);}});
$('closeNote').addEventListener('click',()=>$('noteDialog').close());
$('closeVisual').addEventListener('click',()=>$('visualDialog').close());
await refresh();loadModels().catch(e=>notice('模型名单暂未读取：'+e.message,true));api('commands').then(r=>{if(r.text)$('commandHelp').textContent=r.text;}).catch(()=>{});setInterval(refresh,2500);
