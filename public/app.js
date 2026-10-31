const $=id=>document.getElementById(id);let state=null,targets=[],threads=[],dirty=false,busy=false;
let catalog=null,preferencesDirty=false;
const effortLabels={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses={queued:'排队中',blocked:'调度受阻',running:'执行中',done:'已完成',failed:'处理失败',unavailable:'表情暂不可用',waiting_auth:'等待账号恢复',waiting_route:'等待选择需求',uncertain:'需要核实',pending:'待发送',sent:'已送达',sending:'发送中',new:'等待处理',processing:'处理中'};
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
  const sessions=state.conversations,list=sessions?.needs||[],active=list.find(n=>n.id===sessions.activeNeed);
  $('currentNeed').textContent=active?`当前需求：${active.title} (${active.id})\n第 ${active.seq} 个续接会话 · ${active.contextTokens>=sessions.budget?'下次处理前将交接续开':`上下文约 ${active.contextTokens} / ${sessions.budget} tokens`}`:'发送消息后按需求自动判断；旧对话会保留为历史记录。';
  $('needList').innerHTML=list.map(n=>`<div class="need-item"><strong>${escape(n.title)}</strong><small>${escape(n.id)} · 第 ${n.seq} 个会话</small><div>${escape(n.summary.slice(0,150))}</div><button data-switch-need="${escape(n.id)}" ${n.id===sessions.activeNeed?'disabled':''}>${n.id===sessions.activeNeed?'当前需求':'切换到此需求'}</button></div>`).join('');
}
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
  if(busy)return;busy=true;try{
    state=await api('state');const r=state.runtime;
    if(state.storage){$('storagePath').textContent='固定数据目录：'+state.storage.dataRoot;$('backupInfo').textContent=(state.storage.recovery?state.storage.recovery+'。':'')+(state.storage.backup?'最近状态快照：'+new Date(state.storage.backup.created).toLocaleString('zh-CN',{hour12:false})+'。':'尚未生成状态快照。')+' 原视频、连续画面和登录态保留在上述目录；自动备份配置、需求与任务记录，退出程序时也会生成快照。';}
    $('liveBadge').textContent=state.config.enabled?'正在监听':'尚未监听';$('liveBadge').className='badge'+(state.config.enabled?' active':'');
    $('browserStatus').textContent=({closed:'未打开',waiting_login:'等待登录',select_chat:'请选择会话',ready:'已连接'})[r.browser]||r.browser;
    $('ownerStatus').textContent=state.config.owner?'已绑定：'+state.config.owner.displayName:'尚未绑定用户会话';
    $('codexStatus').textContent=r.auth?.reconnectPending?'等待切换连接':r.auth?.status==='login'?'请重新登录':r.auth?.status==='quota'?'额度暂不可用':r.codex?'已连接':'等待连接';$('coordinatorStatus').textContent=state.config.coordinator?'固定调度聊天已建立':'尚未建立调度聊天';
    $('asrStatus').textContent=r.asrReady?'已就绪':r.asrInstalling?'正在安装':'尚未安装';$('setupAsr').disabled=r.asrInstalling||r.asrReady;
    $('createCoordinator').disabled=!!state.config.coordinator;
    $('knowledgeCount').textContent=state.counts.knowledge;$('taskCount').textContent='执行中 '+state.counts.runningTasks+' · 排队 '+state.counts.queuedTasks;
    $('toggleListen').textContent=state.config.enabled?'暂停监听':'开始监听';$('listenTitle').textContent=r.processing?'正在处理视频或指令':state.config.enabled?'手机里直接分享给助手即可':'准备好后开始监听';
    $('scanInfo').textContent=r.scan?`当前：${r.scan.title||'未选会话'} · 识别消息 ${r.scan.diagnostics?.parsed||0} 条`:'浏览器打开后会检查当前会话';
    if(!dirty){targets=state.config.targets;$('maxMinutes').value=state.config.maxVideoSeconds/60;$('visualFps').value=state.config.visualFps||4;$('ackMode').value='auto';renderTargets();}
    if(!preferencesDirty){const c=state.config;$('defaultModel').value=c.model||'';renderEfforts(c.reasoningEffort||'');$('fastMode').checked=!!c.fastMode;$('autoRoute').checked=c.autoRoute!==false;$('contextBudget').value=c.contextBudget||48000;}
    renderNeeds();
    $('knowledgeList').innerHTML=state.knowledge.map(k=>`<div class="item"><strong>${escape(k.title)}</strong><p>${escape(r.processing&&r.visualProgress?.id===k.id?'正在按完整时间轴分析视觉内容，等待本次结论。':k.visualStatus==='partial'?`视觉已完成 ${k.visualCompleted}/${k.visualTotal} 段，尚未覆盖全片，可继续重分析。`:k.visualStatus==='legacy'?'此视频尚未完成连续视觉分析，请重新分析后查看完整结论。':k.summary?.slice(0,150)||'视频已保存，等待连续视觉分析完成。')}</p><div class="button-row"><button data-note="${escape(k.id)}" class="secondary">学习笔记</button><button data-visual="${escape(k.id)}" class="secondary">查看连续画面</button><button data-reanalyze="${escape(k.id)}" ${r.processing?'disabled':''}>重新分析视觉</button></div></div>`).join('')||'<p class="empty">分享第一条视频后，资料会出现在这里。</p>';
    if(r.processing&&r.visualProgress){const p=r.visualProgress;$('listenTitle').textContent=`连续视觉分析 ${p.completed}/${p.total||'…'} 段 · ${p.fps} 帧/秒`;}
    $('taskList').innerHTML=state.tasks.map(t=>`<div class="item"><strong>${escape(t.alias)}</strong><span class="pill ${['failed','uncertain'].includes(t.status)?'error':''}">${statuses[t.status]||escape(t.status)}</span><p>${escape(t.result?.slice(0,200)||('编号 '+t.id.slice(0,8)))}</p></div>`).join('')||'<p class="empty">你指示派发的任务会出现在这里。</p>';
    $('outboxList').innerHTML=state.outbox.filter(o=>!['sent','superseded'].includes(o.status)).slice(0,5).map(o=>`<div class="item"><span class="pill ${o.status==='uncertain'?'error':''}">回复：${statuses[o.status]}</span><p>${escape(o.body.slice(0,100))}</p><small>${escape(o.error)}</small>${o.status==='uncertain'?`<button data-delivered="${o.id}">已在抖音收到</button> <button data-resend="${o.id}">确认未收到，重新发送</button>`:''}</div>`).join('');
    $('outboxList').innerHTML+=(state.operations||[]).slice(0,8).map(o=>`<div class="item"><strong>要求 ${escape(o.shortId)}</strong><p>${escape(o.detail)}</p></div>`).join('');
    const failed=state.messages.filter(m=>['failed','waiting_auth'].includes(m.status)&&m.kind==='video');
    $('outboxList').innerHTML+=failed.slice(0,3).map(m=>`<div class="item"><small>视频处理失败：${escape(m.result)}</small><button data-retry="${escape(m.id)}">重试这条视频</button></div>`).join('');
    $('eventList').innerHTML=state.events.map(e=>`<div class="event ${escape(e.level)}">${new Date(e.created).toLocaleTimeString('zh-CN',{hour12:false})}　${escape(e.message)}</div>`).join('');
    const approvals=await api('approvals');$('approvalList').innerHTML=approvals.map(a=>`<div class="approval"><strong>待确认操作 #${escape(a.id)}</strong><pre>${escape(a.description)}</pre><button data-approve="${escape(a.id)}">同意本次</button> <button data-decline="${escape(a.id)}">拒绝</button></div>`).join('');
  }catch(e){notice(e.message,true);}finally{busy=false;}
}
action('openBrowser',async()=>{notice('正在恢复已保存的抖音登录态和绑定会话。只有平台要求重新验证时才需登录。');await api('browser/open',{});});
action('backupNow',async()=>{await api('storage/backup',{});notice('配置、需求记忆和任务记录已生成状态快照。原视频和登录态保留在固定数据目录。');});
action('bindOwner',async()=>{const r=await api('bind',{});notice('已绑定：'+r.owner.displayName);});
action('createCoordinator',async()=>{await api('coordinator',{});notice('固定调度聊天已建立。');});
action('reconnectCodex',async()=>{const r=await api('codex/reconnect',{});notice(r.deferred?'当前任务仍在执行，结束后会重新连接。':r.auth.status==='ready'?'已读取本机当前 Codex 登录，视频进度和目标名单已保留。':r.auth.message,!r.deferred&&r.auth.status!=='ready');});
action('reloadModels',async()=>{await loadModels();notice('已读取当前 Codex 的模型与推理档位。');});
action('savePreferences',async()=>{await api('preferences',{model:$('defaultModel').value,reasoningEffort:$('defaultEffort').value,fastMode:$('fastMode').checked,autoRoute:$('autoRoute').checked,contextBudget:Number($('contextBudget').value)});preferencesDirty=false;notice('默认配置已保存，从下一次调用起生效。');});
action('newNeed',async()=>{const n=await api('needs/new',{title:$('newNeedTitle').value.trim()});$('newNeedTitle').value='';notice('已新建并切换到：'+n.title+' ('+n.id+')');});
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
