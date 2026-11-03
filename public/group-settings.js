import {updateHTML} from './dom.js';

export function initGroupSettings({api,notice,escape,getState,refresh}){
  const $=id=>document.getElementById(id),backend=value=>value==='dsh'?'DSH':'Codex';
  let retentionDirty=false,peer='',selected='',loading=false;
  const dialog=document.createElement('dialog');dialog.id='chatSessionsDialog';dialog.setAttribute('aria-labelledby','chatSessionsHeading');
  dialog.innerHTML='<div class="section-title"><h2 id="chatSessionsHeading">群聊会话</h2><button id="closeChatSessions" class="secondary">关闭</button></div><p class="hint">会话保持隔离，在此查看原始记录。恢复归档只恢复显示，不会切回当前上下文；清空上下文会另建空白会话。</p><div class="button-row"><label>会话范围 <select id="chatSessionScope"><option value="all">全部</option><option value="current">未归档</option><option value="archived">已归档</option></select></label><button id="reloadChatSessions" class="secondary">刷新会话记录</button></div><p id="chatSessionsError" role="alert"></p><div id="chatSessionList"></div><section id="chatSessionTranscript" aria-live="polite"></section>';
  document.body.append(dialog);$('closeChatSessions').onclick=()=>dialog.close();
  const archiveLabel=s=>s.consoleArchiveState==='attention'?'原生归档待核实：'+(s.consoleArchiveError||s.error||'原现场继续保留'):s.archive_state==='unsupported'?'DSH ACP 不支持原生归档 · 仅控制台归档':s.archive_state==='done'?(s.archived?'控制台与 Codex 均已归档':'已恢复显示及 Codex 会话'):['submitted','uncertain','failed'].includes(s.archive_state)?'Agent 端归档需核实'+(s.error?'：'+s.error:''):'';
  async function loadTranscript(id){
    const result=await api('chat-sessions/read?id='+encodeURIComponent(id));if(!dialog.open||id!==selected)return;
    const turns=result.source==='native'?result.turns.flatMap(t=>(t.items||[]).map(i=>({user:i.type==='userMessage',text:i.text,status:t.status}))):result.exchanges.flatMap(e=>[{user:true,text:e.user},{user:false,text:e.assistant,status:e.status}]);
    updateHTML($('chatSessionTranscript'),'<h3>会话 '+escape(result.session?.seq||'')+' · '+backend(result.session?.harness)+'</h3><p class="hint">'+escape(result.notice)+'</p>'+turns.map((m,i)=>'<article class="session-exchange" data-ui-key="exchange:'+i+'"><strong>'+(m.user?'用户消息':'AI 回复')+'</strong>'+(m.status?'<small>'+escape(m.status)+'</small>':'')+'<pre>'+escape(m.text||'尚无文字结果')+'</pre></article>').join('')+(turns.length?'':'<p class="empty">尚无交流记录。</p>'));
  }
  async function loadSessions(){
    if(!peer||loading)return;loading=true;$('chatSessionsError').textContent='';
    try{const response=await api('chat-sessions?'+new URLSearchParams({peer,scope:$('chatSessionScope').value}));
      updateHTML($('chatSessionList'),response.sessions.map(s=>'<article class="session-row" data-ui-key="session:'+escape(s.id)+'"><strong>会话 '+s.seq+' · '+backend(s.harness)+(s.current?' · 当前使用':s.archived?' · 已归档':' · 历史')+'</strong><small>'+new Date(s.created).toLocaleString('zh-CN',{hour12:false})+'</small><p>'+escape(archiveLabel(s)||s.error||'会话已独立保存')+'</p><div class="button-row">'+(s.state==='uncertain'?'<button class="secondary" data-session-reconcile="'+escape(s.id)+'">核实原回合</button>':'')+'<button data-session-read="'+escape(s.id)+'">查看完整记录</button><button class="secondary" data-review-kind="chat_session" data-review-id="'+escape(s.id)+'">核实与处理</button>'+(!s.current&&s.thread&&(s.state!=='uncertain'||s.archived)?'<button class="secondary" data-session-archive="'+escape(s.id)+'" data-session-value="'+!s.archived+'">'+(s.archived?'恢复显示'+(s.harness==='codex'?'及 Codex 会话':''):s.archive_state==='uncertain'?'核实上次归档':'归档')+'</button>':'')+'</div></article>').join('')||'<p class="empty">此范围还没有群聊会话。</p>');
      if(selected&&response.sessions.some(s=>s.id===selected))await loadTranscript(selected);else{selected='';$('chatSessionTranscript').textContent='选择一项会话查看记录。';}
    }catch(e){$('chatSessionsError').textContent=e.message;}finally{loading=false;}
  }
  async function openSessions(key,id=''){
    peer=key;selected=id;$('chatSessionsHeading').textContent=(getState()?.aiChats?.chats.find(c=>c.chatKey===key)?.displayName||'群聊')+' · 会话';
    $('chatSessionScope').value='all';$('chatSessionTranscript').textContent='正在读取会话…';if(!dialog.open)dialog.showModal();await loadSessions();
  }
  $('chatSessionScope').onchange=loadSessions;$('reloadChatSessions').onclick=loadSessions;
  dialog.addEventListener('click',async event=>{
    const button=event.target.closest('button'),read=button?.dataset.sessionRead,id=button?.dataset.sessionArchive;const reconcile=button?.dataset.sessionReconcile;if(!read&&!id&&!reconcile)return;button.disabled=true;
    try{if(reconcile){const result=await api('chat-sessions/reconcile',{id:reconcile});await loadSessions();await refresh();$('chatSessionsError').textContent=result.reason;}else if(read){selected=read;await loadTranscript(read);}else{await api('chat-sessions/archive',{id,archived:button.dataset.sessionValue==='true'});await loadSessions();await refresh();}}
    catch(e){$('chatSessionsError').textContent=e.message;}finally{button.disabled=false;}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button'),key=button?.dataset.groupSessions||button?.dataset.groupReset||button?.dataset.groupPause;
    if(button?.dataset.chatRetry){if(!confirm('确认重试这条尚未提交给模型的消息？已完成的视频预处理会复用。'))return;button.disabled=true;try{await api('ai-chats/retry',{id:button.dataset.chatRetry,confirmed:true});notice('已恢复这条确认未提交的消息，不重跑已提交的回合。');await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}return;}if(!key)return;if(button.dataset.groupPause){const chat=getState().aiChats.chats.find(c=>c.chatKey===key),paused=!chat.deliveryPaused;if(!paused&&!confirm('恢复本群的新消息回复？暂停期间的旧队列不会自动补发，仍可在核实与处理中查看。'))return;button.disabled=true;try{await api('ai-chats/pause-delivery',{peer:key,paused});await refresh();notice(paused?'已暂停本群自动回复，保留旧记录；其他聊天继续运行。':'已恢复本群新消息回复，旧积压不会自动补发。');}catch(e){notice(e.message,true);}finally{button.disabled=false;}return;}if(button.dataset.groupSessions){await openSessions(key,button.dataset.sessionId||'');return;}
    const context=getState().aiChats.chats.find(c=>c.chatKey===key)?.sessions,stopPending=!!(context?.busy||context?.pending||context?.current?.state==='uncertain');if(!confirm(stopPending?'停止旧回复并清空上下文？将中断本群旧任务，停止待发回复，切换全新空白会话。状态不明的执行和回执保留在旧记录里，不会标成成功或自动重发；原生归档待核实后补做。':'清空此群的 AI 上下文？将建立全新的空白会话，不转接旧摘要；旧会话会自动归档，之后仍可查看。'))return;
    button.disabled=true;try{await api('chat-sessions/reset',{peer:key,confirmed:true,stopPending});notice('已切换到空白群聊会话。旧会话的归档结果可在“会话与归档”查看。');await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}
  });
  $('aiChatList').addEventListener('change',async event=>{
    const select=event.target,key=select.dataset.groupVideo||select.dataset.groupVideoLimit;if(!key)return;select.disabled=true;
    const chat=getState().aiChats.chats.find(c=>c.chatKey===key);
    try{await api('ai-chats/save',{chatKey:key,mode:'chat',enabled:chat.enabled,...(select.dataset.groupVideo?{videoOverview:select.checked}:{videoMaxSeconds:Number(select.value)})});notice('本群视频设置已保存，仅对下一轮消息生效。');}
    catch(e){notice(e.message,true);}finally{select.disabled=false;await refresh();}
  });
  for(const id of ['retentionEnabled','retentionAge','retentionUnit'])$(id).addEventListener('change',()=>{retentionDirty=true;$('retentionAge').max=$('retentionUnit').value==='days'?'3650':'87600';});
  $('saveRetention').onclick=async()=>{
    const enabled=$('retentionEnabled').checked,hours=Number($('retentionAge').value)*($('retentionUnit').value==='days'?24:1),old=getState()?.retention?.policy;
    if(enabled&&(!old?.enabled||hours<old.hours)&&!confirm('启用归档到期永久清理？已归档且超过保留时间的桥接记录和专属缓存将被删除，不能恢复。仍在执行、送达或原生归档尚未核实的记录会保留。原生会话和备份不删除。'))return;
    $('saveRetention').disabled=true;try{await api('archive/retention',{enabled,hours});retentionDirty=false;notice(enabled?'归档保留策略已保存。程序每分钟检查一次，到期且通过安全检查的记录会清理。':'自动清理已关闭，归档记录继续保留。');await refresh();}
    catch(e){notice(e.message,true);}finally{$('saveRetention').disabled=false;}
  };
  return {
    dirty:()=>retentionDirty,
    recordControls(chat){
      const current=chat.sessions?.current;
      return '<button class="secondary" data-group-sessions="'+escape(chat.chatKey)+'" '+(current?'data-session-id="'+escape(current.id)+'"':'')+'>会话与归档</button><button class="secondary" data-review-kind="chat" data-review-id="'+escape(chat.chatKey)+'">核实与处理</button>';
    },
    controls(chat,{showRecords=true}={}){
      if(chat.type!=='group'||chat.mode!=='chat')return '';
      const s=chat.sessions||{},current=s.current,limit=chat.videoMaxSeconds||120,busy=s.busy||s.pending||current?.state==='uncertain';
      return '<div class="group-settings" data-ui-key="group-settings"><div class="button-row"><label class="check-label"><input type="checkbox" data-group-video="'+escape(chat.chatKey)+'" '+(chat.videoOverview?'checked':'')+'>轻量看视频</label><label>视频上限 <select data-group-video-limit="'+escape(chat.chatKey)+'">'+[30,60,120,180,300,...([30,60,120,180,300].includes(limit)?[]:[limit])].sort((a,b)=>a-b).map(n=>'<option value="'+n+'" '+(limit===n?'selected':'')+'>'+n+' 秒</option>').join('')+'</select></label></div><p class="hint">沿整段视频低密度取样，最多约 48 帧，并在本机转写口播。超限不分析；不进入个人学习资料库。</p><p class="group-context-status">'+(chat.deliveryPaused?'已暂停自动回复：'+escape(chat.deliveryPauseReason||'用户暂停')+'。':'')+(current?'当前：'+backend(current.harness)+' 会话 '+current.seq+' · '+Number(current.tokens).toLocaleString()+' / '+Number(s.budget||16000).toLocaleString()+' tokens'+(current.error?' · '+escape(current.error):''):'新消息将建立本群的独立会话')+'</p><div class="button-row">'+(showRecords?this.recordControls(chat):'')+'<button class="secondary" data-group-pause="'+escape(chat.chatKey)+'">'+(chat.deliveryPaused?'恢复自动回复':'暂停自动回复')+'</button><button class="secondary" data-group-reset="'+escape(chat.chatKey)+'" '+(!chat.enabled||s.clearing?'disabled':'')+'>'+(busy?'停止旧回复并清空':'清空上下文')+'</button></div>'+(busy?'<small>旧回复可以停止；未核实的现场继续保留，不阻止切换空白会话。</small>':'')+'</div>';
    },
    render(state){
      const r=state.retention||{policy:{enabled:false,hours:720}},p=r.policy;
      if(!retentionDirty){$('retentionEnabled').checked=!!p.enabled;const days=p.hours%24===0;$('retentionUnit').value=days?'days':'hours';$('retentionAge').value=days?p.hours/24:p.hours;$('retentionAge').max=days?'3650':'87600';}
      $('retentionStatus').textContent=(p.enabled?'已启用，每分钟检查一次。':'默认关闭，归档记录持续保留。')+(r.last?' 最近检查：'+new Date(r.last.at).toLocaleString('zh-CN',{hour12:false})+'，已清理 '+r.last.deleted+' 项，暂保留 '+r.last.blocked.length+' 项。':'');
      updateHTML($('retentionBlocked'),(r.last?.blocked||[]).map((b,i)=>'<p data-ui-key="blocked:'+i+'">'+escape(({need:'需求',task:'任务',knowledge:'资料',chat_session:'群聊会话'})[b.kind]||'记录')+'：'+escape(b.reason)+'</p>').join(''));
    }
  };
}
