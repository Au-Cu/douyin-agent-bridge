import { updateHTML } from './dom.js';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const saved = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
export function openSettingsSection(){
  const section={runtime:'runtimeSection',transcription:'transcriptionSection','agent-defaults':'modelPanel','chat-defaults':'chatsPanel',appearance:'appearanceSection'}[location.hash.split('/')[1]];
  if(!location.hash.startsWith('#settings/')||!section)return;
  const target=$(section);
  if(!target)return;
  if(target.tagName==='DETAILS')target.open=true;
  target.scrollIntoView({block:'start'});
}
export function initViews() {
  if (!$('themeToggle')) return;
  const views = ['workbench', 'chats', 'library', 'dispatch', 'settings'];
  let setupOrigin='',directoryScroll=0;
  const viewFor=hash=>{const page=hash.slice(1).split('/')[0];return views.includes(page)?page:'workbench';};
  function updateReturnLinks(){for(const link of document.querySelectorAll('[data-setup-return]'))link.hidden=location.hash!==setupOrigin||link.dataset.setupReturn!==setupOrigin;}
  function show() {
    const view=viewFor(location.hash);
    updateReturnLinks();
    for (const el of document.querySelectorAll('[data-view-panel]')) el.hidden = el.dataset.viewPanel !== view;
    for (const el of document.querySelectorAll('[data-view]')) {
      if (el.dataset.view === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', event=>{
    const from=new URL(event.oldURL).hash,to=location.hash;
    const previousView=viewFor(from),nextView=viewFor(to);
    if(setupOrigin!==to)setupOrigin='';
    if(previousView==='chats'&&from==='#chats')directoryScroll=window.scrollY;
    show();
    if(previousView!==nextView)window.scrollTo(0,0);
    requestAnimationFrame(()=>{
      if(location.hash!==to)return;
      if(nextView==='settings')openSettingsSection();
      if(previousView==='chats'&&to==='#chats'&&matchMedia('(max-width: 720px)').matches)window.scrollTo(0,directoryScroll);
    });
  });
  show();
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href^="#"]');
    if(!link||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    if(link.classList.contains('skip-link')){
      event.preventDefault();$('mainContent').focus();return;
    }
    setupOrigin=link.hasAttribute('data-setup-jump')?link.hash:'';
    updateReturnLinks();
  });
  function theme(value) {
    document.documentElement.dataset.theme = value;
    $('themeToggle').setAttribute('aria-label', value === 'dark' ? '切换浅色外观' : '切换深色外观');
    $('themeToggle').setAttribute('aria-pressed', String(value === 'dark'));
    if($('themeValue'))$('themeValue').textContent=value==='dark'?'深色':'浅色';
  }
  theme(saved('bridge-ui-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    theme(next); try { localStorage.setItem('bridge-ui-theme', next); } catch {}
  });
}
export function renderVisuals(work) {
  return (work.visuals || []).map(v => {
    const counted = Number.isFinite(v.completed) && Number.isFinite(v.total) && v.total > 0;
    const coverage = Number.isFinite(v.coveredUntil) && Number.isFinite(v.duration) ? `已覆盖 ${v.coveredUntil.toFixed(1)} / ${v.duration.toFixed(1)} 秒` : '等待本次覆盖记录';
    const title = v.source === 'running' ? '连续视觉分析' : v.status === 'complete' ? '视频资料 · 已完整覆盖' : '视频资料 · 最新保存记录';
    return `<div class="visual-progress" data-ui-key="visual:${esc(v.id)}"><div class="visual-progress-head"><strong>${title}</strong><span>${counted ? `已完成 ${v.completed} / ${v.total} 段` : '正在准备画面'}</span></div>${counted ? `<progress max="${v.total}" value="${v.completed}" aria-label="已分析视频片段"></progress>` : ''}<div class="visual-facts"><span>${coverage}</span>${v.fps ? `<span>${v.fps} 帧 / 秒</span>` : ''}</div></div>`;
  }).join('');
}
export function renderLearning(state, archiveButton) {
  const runtime = state.runtime;
  if (document.documentElement.dataset.layout === 'classic') {
    updateHTML($('knowledgeList'), state.knowledge.map(k => `<div class="item" data-ui-key="knowledge:${esc(k.id)}"><strong>${esc(k.title)}</strong>${k.archived ? '<span class="pill">已归档</span>' : ''}<p>${esc(runtime.processing && runtime.visualProgress?.id === k.id ? '正在按完整时间轴分析视觉内容，等待本次结论。' : k.visualStatus === 'partial' ? `视觉已完成 ${k.visualCompleted}/${k.visualTotal} 段，尚未覆盖全片。` : k.visualStatus === 'legacy' ? '此视频尚未完成连续视觉分析，请重新分析后查看完整结论。' : k.summary?.slice(0,150) || '视频已保存，等待连续视觉分析。')}</p><div class="button-row"><button data-note="${esc(k.id)}" class="secondary">学习笔记</button><button data-visual="${esc(k.id)}" class="secondary">查看连续画面</button><button data-reanalyze="${esc(k.id)}" ${runtime.processing ? 'disabled' : ''}>重新分析视觉</button>${archiveButton('knowledge',k)}</div></div>`).join('') || '<p class="empty">此范围没有学习资料。</p>');
    return;
  }
  updateHTML($('knowledgeList'), state.knowledge.map(k => {
    const active = runtime.processing && runtime.visualProgress?.id === k.id;
    const status = active ? '正在分析' : k.visualStatus === 'complete' ? '视觉已覆盖全片' : k.visualStatus === 'partial' ? `已分析 ${k.visualCompleted} / ${k.visualTotal} 段` : '待连续视觉分析';
    return `<article class="item" data-ui-key="knowledge:${esc(k.id)}"><strong>${esc(k.title)}</strong><small>${status}${k.archived ? ' · 已归档' : ''}</small><details class="knowledge-summary" data-fold-key="knowledge:${esc(k.id)}"><summary>学习摘要</summary><p>${esc(active ? '正在按完整时间轴分析，等待本次结论。' : k.summary || '视频已保存，等待分析完成。')}</p></details><div class="knowledge-actions"><button data-note="${esc(k.id)}" class="secondary">学习笔记</button><button data-visual="${esc(k.id)}" class="secondary">连续画面</button><button data-reanalyze="${esc(k.id)}" ${runtime.processing ? 'disabled' : ''}>重新分析视觉</button>${archiveButton('knowledge',k)}</div></article>`;
  }).join('') || '<p class="empty">此范围没有学习资料。</p>');
  const recent = (state.recentKnowledge || state.knowledge).filter(k => !k.archived).slice(0, 3);
  updateHTML($('recentKnowledgeList'), recent.map((k,i) => `<article class="recent-item" data-ui-key="recent:${esc(k.id)}"><span class="recent-index" aria-hidden="true">${String(i + 1).padStart(2,'0')}</span><div class="recent-content"><strong>${esc(k.title.replace(/\s+/g,' ').slice(0,62))}${k.title.length > 62 ? '…' : ''}</strong><span class="recent-meta">${k.visualStatus === 'complete' ? '视觉记录完整' : '资料已保存'}</span><div class="button-row"><button data-note="${esc(k.id)}">笔记</button><button data-visual="${esc(k.id)}">画面</button></div></div></article>`).join('') || '<p class="empty">转发视频后，最近资料会出现在这里。</p>');
  $('libraryNavCount').textContent = state.counts.knowledge;
}
