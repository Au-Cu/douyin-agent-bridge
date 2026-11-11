// Isolated UI acceptance sandbox. No Store, account, Codex client, browser
// adapter or production API is imported. All mutations affect demo memory only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { commandHelp } from '../src/commands.mjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version;
const link = 'codex://threads/00000000-0000-0000-0000-000000000001';
const stages = (active = true, done = false) => ['roger', 'active', 'done'].map((stage, i) => ({ stage, total: i === 0 || i === 1 && active || i === 2 && done ? 1 : 0, sent: i === 0 || i === 1 && active || i === 2 && done ? 1 : 0, pending: 0, uncertain: 0, unavailable: 0, errors: [] }));
export function demoState() {
  const now = Date.now();
  const needs = [
    { id: 'demo-need-9', number: 9, title: '优化助手控制台', seq: 2, contextTokens: 14620, summary: '根据视频中的排版方法，让当前需求、任务进度和交付结果更容易查看。先在独立分支验收，再决定是否合并。', url: link },
    { id: 'demo-need-8', number: 8, title: '整理交互设计参考', seq: 1, contextTokens: 8210, summary: '按触发条件、变化过程和结束状态整理视频里的交互方法。', url: link },
    { id: 'demo-need-7', number: 7, title: '历史需求 · 归档示例', seq: 1, contextTokens: 1700, summary: '已经结束的独立需求，可以恢复显示。', url: link, archived: true }
  ];
  const base = { kind: 'text', archived: false, canInterrupt: true, links: [{ url: link, label: '本轮对话' }], receipts: stages(), replies: [], targets: [], retries: [], visuals: [] };
  const knowledge = [
    { id: '1000000000000000001', title: '让 AI 理解布局、留白和交互反馈', summary: '先确定内容主角，再通过有规则的留白、字号与面积建立主次。\n\n把交互写清楚：由什么触发、改变哪个对象、如何变化、最终停在哪里。\n\n学习边界：画面支持主要状态变化，不能据此确认精确缓动曲线和时间参数。', visualStatus: 'partial', visualCompleted: 4, visualTotal: 17 },
    { id: '1000000000000000002', title: '八种常见控件的交互细节', summary: '标签筛选、分段控制器和弹性抽屉可以采用一致的选中反馈；保持操作对象的位置稳定。', visualStatus: 'complete', visualCompleted: 14, visualTotal: 14 },
    { id: '1000000000000000003', title: '仪表盘中的内容层级', summary: '把日常工作放在中心位置，配置按需展开。正文采用清晰底色，提高长时间阅读的舒适度。', visualStatus: 'complete', visualCompleted: 11, visualTotal: 11 },
    { id: '1000000000000000004', title: '历史学习资料 · 可恢复归档', summary: '原始资料保留，归档只影响可见范围。', visualStatus: 'complete', visualCompleted: 5, visualTotal: 5, archived: true }
  ];
  return {
    preview: true,
    config: { enabled: true, owner: { displayName: '演示用户', chatKey: 'demo-owner', peerUid: '111111', selfUid:'999999' },agentBindings:{self:{displayName:'演示用户',chatKey:'demo-self',peerUid:'111111',selfUid:'111111',selfChat:true},assistant:{displayName:'演示用户',chatKey:'demo-owner',peerUid:'111111',selfUid:'999999'}}, coordinator: 'demo-coordinator', targets: [{ alias: '界面项目', name: '控制台界面优化', thread: 'demo-target' }], maxVideoSeconds: 1800, visualFps: 4, model: 'gpt-6.1-sol', reasoningEffort: 'high', fastMode: false, autoRoute: true, contextBudget: 48000, chatModel: 'gpt-6-luna', chatReasoningEffort: 'medium', chatWebSearch: true, chatCodeSandbox: false, uiPanels: { setup: true, model: true, targets: true, storage: true, chats: true }, uiConfigured: { setup: true } },
    runtime: { harness: { active: 'codex', configured: 'codex', chat: 'codex' }, taskCodex: { ready: true }, codex: true, auth: { status: 'ready' }, asrReady: true, browser: 'ready', browserLoggedIn:true, browserEngine: process.platform === 'darwin' ? 'safari' : 'edge', processing: true, visualProgress: { id: knowledge[0].id, operationId: 'demo-task-27', completed: 4, total: 17, fps: 4 } },
    storage: { dataRoot: '独立演示数据（仅在内存中）', backup: { created: now - 600000 } },
    conversations: { current: needs[0], activeNeed: needs[0].id, needs, budget: 48000 }, knowledge,
    aiChats: { chats: [{chatKey:'demo-owner',displayName:'演示用户',type:'single',mode:'agent',peerUid:'demo-user',enabled:true},{ chatKey: 'demo-group', displayName: '设计讨论 · 演示群聊', type: 'group', mode: 'chat', enabled: true, groupReplyMode: 'mentions',videoOverview:true,sessions:{budget:16000,current:{id:'demo-session',harness:'codex',seq:2,tokens:3200,state:'ready'}} },{chatKey:'demo-single',displayName:'读书搭子 · 演示单聊',type:'single',mode:'chat',enabled:false}], messages: [
      {id:'demo-group-reply',peer:'demo-group',name:'设计讨论',input:'这段视频的关键交互是什么？',result:'切换分类后，卡片按新分类重新排列。',status:'done',created:now},
      {id:'demo-single-reply',peer:'demo-single',name:'读书搭子',input:'帮我找一下这本书的作者',result:'这是一条独立的演示单聊记录。',status:'replying',deliveryIssue:'原消息暂不可操作',created:now}
    ] },
    counts: { knowledge: 3, runningTasks: 1, queuedTasks: 1 },
    work: [
      { ...base, id: 'demo-task-27', number: '27', title: '学习视频中的排版方法', kind: 'video', status: 'running', phase: '分析视频', detail: '按完整时间轴读取画面，已保存的片段会继续保留。', visuals: [{ id: knowledge[0].id, source: 'running', status: 'running', completed: 4, total: 17, fps: 4, duration: 132.5, coveredUntil: 32 }] },
      { ...base, id: 'demo-task-26', number: '26', title: '整理面板的优化建议', status: 'sending', detail: '结果已生成，正在发送第 3 / 3 段。全部文字和回执完成后归档。', replies: [{ id: 'demo-reply-1', status: 'sent' }, { id: 'demo-reply-2', status: 'sent' }, { id: 'demo-reply-3', status: 'pending' }] },
      { ...base, id: 'demo-task-28', number: '28', title: '根据反馈改进界面', status: 'queued', detail: '已保存补充要求，等待当前工作结束。', receipts: stages(false) },
      { ...base, id: 'demo-task-24', number: '24', title: '恢复目标聊天的写入', status: 'blocked', detail: 'Codex 目标聊天已有 active writer，尚未提交执行。处理冲突后可明确重试。', receipts: stages(false), retries: [{ label: '目标：界面项目', taskStatus: 'blocked', wait: { paused: true, nextAttempt: now + 20000 }, events: [{ attempt: 1, at: now - 180000, outcome: 'blocked', reason: 'Codex 目标聊天已有 active writer，尚未提交。' }, { attempt: 2, at: now - 120000, outcome: 'blocked', reason: '等待原聊天写入结束；保留任务，不自动重跑。' }] }] },
      { ...base, id: 'demo-task-23', number: '23', title: '确认上一轮回复是否送达', status: 'failed_delivery', detail: '最后一段送达尚未确认，保留原聊天现场，等待核验。', replies: [{ id: 'demo-reply-4', status: 'sent' }, { id: 'demo-reply-5', status: 'uncertain' }], receipts: stages().map(r => r.stage === 'active' ? { ...r, sent: 0, uncertain: 1, errors: ['原消息暂不可操作，未确认贴表情。'] } : r) },
      { ...base, id: 'demo-task-22', number: '22', title: '整理交互设计参考', status: 'done', canInterrupt: false, archived: true, detail: '完整分析已完成，回复全部送达。', receipts: stages(true, true), replies: [{ id: 'demo-reply-6', status: 'sent' }] },
      { ...base, id: 'demo-control-1', number: null, title: '/状态', kind: 'control', status: 'done', canInterrupt: false, receipts: stages(true, true), detail: '当前状态已回复。', replies: [{ id: 'demo-reply-7', status: 'sent' }] }
    ],
    events: [{ id: 'demo-event-1', created: now - 15000, level: 'info', message: '演示视觉记录已保存：4 / 17 段。' }, { id: 'demo-event-2', created: now - 30000, level: 'attention', message: '目标聊天写入受阻，尚未提交执行。' }], outbox: [], messages: [], tasks: []
  };
}
const scoped = (list, scope) => list.filter(item => scope === 'all' || (scope === 'archived' ? !!item.archived : !item.archived));
export function createPreviewServer() {
  const state = demoState(),deletions=new Map();
  const server = http.createServer(async (req, res) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== '127.0.0.1:' + server.address().port) return json({ error: '无效 Host' }, 403);
      if (req.headers.origin && req.headers.origin !== origin) return json({ error: '来源校验失败' }, 403);
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && ['/','/index.html','/classic.html','/style.css','/classic.css','/app.js','/dom.js','/views.js','/ui-layout.js','/group-settings.js'].includes(path)) {
        const name = path === '/' ? 'index.html' : path.slice(1);
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
        return res.end(await readFile(join(project, 'public', name)));
      }
      if (req.method === 'GET' && path === '/api/instance') return json({ app: 'douyin-codex-bridge', version, preview: true });
      if (req.method === 'GET' && path === '/api/state') return json({ ...state,
        conversations: { ...state.conversations, needs: scoped(state.conversations.needs, url.searchParams.get('needs')) },
        knowledge: scoped(state.knowledge, url.searchParams.get('knowledge')), recentKnowledge: state.knowledge.filter(k => !k.archived).slice(0,3),
        chatWork:url.searchParams.get('chat')===state.config.owner?.chatKey?state.work:undefined,
        aiChats:{...state.aiChats,messages:state.aiChats.messages.filter(m=>!url.searchParams.has('chat')||m.peer===url.searchParams.get('chat'))},
        work: scoped(state.work, url.searchParams.get('work')).filter(w => !url.searchParams.has('status') || w.status === url.searchParams.get('status')) });
      if (req.method === 'GET' && path === '/api/commands') return json({ text: commandHelp });
      if (req.method === 'GET' && path === '/api/approvals') return json([]);
      if (req.method === 'GET' && path === '/api/models') return json({ harness: url.searchParams.get('mode') === 'chat' ? state.runtime.harness.chat : state.runtime.harness.active, defaults: { model: 'gpt-6.1-sol', effort: 'high' }, models: ['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-luna'].map(model => ({ model, displayName: model.replace('gpt-','GPT-'), supportedReasoningEfforts: ['low','medium','high','max'].map(reasoningEffort => ({ reasoningEffort })), serviceTiers: [{ id: 'priority', name: 'fast' }] })) });
      if (req.method === 'GET' && path === '/api/threads') return json([{ id: 'demo-target', name: '控制台界面优化' }, { id: 'demo-long', name: '非常长的项目名称，用来检查下拉列表不会溢出，所有聊天名称都应该保留开头并可以正常选择。'.repeat(8) }]);
      const note = path.match(/^\/api\/knowledge\/(\d+)$/);
      if (req.method === 'GET' && note) {
        const item = state.knowledge.find(k => k.id === note[1]);
        return item ? json({ ...item, note: '演示学习笔记\n\n' + item.title + '\n\n' + item.summary }) : json({ error: '资料不存在' },404);
      }
      if (req.method !== 'POST') return json({ error: '验收预览不加载真实视频、账号或聊天。' },404);
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw Error('请求过大'); }
      const body = JSON.parse(raw || '{}');
      if (path === '/api/ui/panels') Object.assign(state.config.uiPanels, body);
      else if (path === '/api/archive/delete/prepare'||path === '/api/archive/delete') {
        const list=body.kind==='task'?state.work:body.kind==='need'?state.conversations.needs:body.kind==='knowledge'?state.knowledge:[],item=list.find(i=>i.id===body.id);
        if(!item?.archived)return json({error:'请先归档记录'},400);
        if(['running','sending','uncertain','failed_delivery'].includes(item.status))return json({error:'结果尚未核实，不能删除'},400);
        if(path.endsWith('/prepare')){const token='demo-'+Date.now()+'-'+Math.random();deletions.set(token,item);if(body.kind==='knowledge')return json({token,label:item.title,counts:{knowledge:1},warning:'演示：删除本地原视频、转写、画面和分析笔记。'});return json({token,label:(body.kind==='need'?'需求 ':'任务 ')+item.number+'：'+item.title,counts:{operations:1,tasks:0,messages:1,replies:1,receipts:3},warning:'演示：永久删除本机桥接记录；原聊天、学习资料与备份保留。'});}
        if(deletions.get(body.token)!==item)return json({error:'删除确认失效'},400);
        deletions.delete(body.token);list.splice(list.indexOf(item),1);return json({deleted:true});
      }
      else if (path === '/api/archive') {
        const list = body.kind === 'task' ? state.work : body.kind === 'need' ? state.conversations.needs : body.kind === 'knowledge' ? state.knowledge : [];
        const item = list.find(i => i.id === body.id); if (!item) return json({ error: '记录不存在' },404);
        item.archived = !!body.archived;
      }
      else if (path === '/api/tasks/interrupt') { const w=state.work.find(i=>i.id===body.id); if(!w)return json({error:'任务不存在'},404);w.status='cancelled';w.canInterrupt=false;w.detail='演示任务已中断。';return json({state:'stopped',number:w.number}); }
      else if (path === '/api/needs/switch') { const n=state.conversations.needs.find(n=>n.id===body.id&&!n.archived);if(!n)return json({error:'需求不存在'},404);state.conversations.current=n;state.conversations.activeNeed=n.id;return json(n); }
      else if (path === '/api/needs/new') { const n={id:'demo-new-'+Date.now(),number:10+state.conversations.needs.length,title:body.title||'新的演示需求',summary:'验收预览中新建的需求。未创建真实助手聊天。',seq:1,contextTokens:0};state.conversations.needs.unshift(n);state.conversations.current=n;state.conversations.activeNeed=n.id;return json(n); }
      else if (path === '/api/preferences') Object.assign(state.config,body);
      else if (path === '/api/chat-preferences') Object.assign(state.config,{chatModel:body.model,chatReasoningEffort:body.reasoningEffort,chatFastMode:body.fastMode,chatWebSearch:body.webSearch,chatCodeSandbox:body.codeSandbox,chatContextBudget:body.contextBudget});
      else if (path === '/api/codex/login') return json({url:'https://auth.openai.com/',preview:true});
      else if (path === '/api/douyin/mode') {
        const previous=state.config.douyinMode||(state.config.owner?(state.config.owner.selfChat?'self':'assistant'):'');
        if(!['self','assistant'].includes(body.mode)||previous&&previous!==body.mode&&body.confirmed!==true)return json({error:'请确认切换模式'},400);
        state.config.douyinMode=body.mode;
        if(previous&&previous!==body.mode){state.config.douyinRebindRequired=true;state.runtime.browserLoggedIn=false;state.runtime.browser='waiting_login';state.runtime.loginCompletedAt=0;}
        return json({mode:body.mode});
      }
      else if (path === '/api/browser/open'&&body.guided) {
        state.runtime.browser='waiting_login';
        return json({ok:true,preview:true});
      }
      else if (path === '/api/coordinator') {
        if(state.runtime.auth.status!=='ready')return json({error:'请先完成登录'},400);
        state.config.coordinator='demo-coordinator';
      }
      else if (path === '/api/asr/setup') {
        state.runtime.asrInstalling=true;
        state.runtime.asrProgress='正在解压转写模型…';
      }
      else if (path === '/api/bind/select') {if(state.config.enabled)return json({error:'请先暂停监听'},400);state.runtime.selfBinding=true;}
      else if (path === '/api/bind/cancel') state.runtime.selfBinding=false;
      else if (path === '/api/bind/inspect') {
        if(!state.runtime.selfBinding)return json({error:'请先开始绑定'},400);
        const mode=state.demoBindMode||'assistant',peer=state.config.agentBindings[mode];
        return json({mode,chatKey:peer.chatKey,selfUid:peer.selfUid,mainUid:peer.peerUid,displayName:peer.displayName,replaceMain:false});
      }
      else if (path === '/api/bind'&&body.mode==='auto') {
        const mode=state.demoBindMode||'assistant',owner=state.config.agentBindings[mode];
        if(!state.runtime.selfBinding||body.chatKey!==owner.chatKey||body.selfUid!==owner.selfUid)return json({error:'请选择并核验会话'},400);
        if(state.config.douyinMode&&state.config.douyinMode!==mode&&body.acceptModeMismatch!==true)return json({error:'请确认切换模式'},400);
        Object.assign(state.config,{owner,douyinMode:mode,douyinRebindRequired:false});state.runtime.selfBinding=false;
        state.aiChats.chats=state.aiChats.chats.filter(c=>c.mode!=='agent');
        state.aiChats.chats.unshift({...owner,type:'single',mode:'agent',enabled:true});
        return json({mode,owner});
      }
      else if (path === '/api/conversation-preferences') {
        const peer=body.mode==='chat'?state.aiChats.chats.find(c=>c.chatKey===body.peer):state.config.agentBindings[body.mode];
        if(!peer||peer.chatKey!==body.peer)return json({error:'请选择演示会话'},400);
        const key='conversation:'+JSON.stringify([body.mode==='chat'?'chat':'agent',peer.chatKey,peer.selfUid||'']);
        const old=state.config.conversationOverrides?.[key]||{};
        const overrides={...Object.fromEntries(['contextBudget','maxVideoSeconds','visualFps','autoRoute'].filter(k=>body[k]!=null).map(k=>[k,body[k]])),models:{...old.models,[body.harness]:Object.fromEntries(['model','reasoningEffort','fastMode'].filter(k=>body[k]!=null).map(k=>[k,body[k]]))}};
        state.config.conversationOverrides={...state.config.conversationOverrides,[key]:overrides};return json({overrides});
      }
      else if (path === '/api/targets') state.config.targets=body.targets;
      else if (path === '/api/config'||path === '/api/video-preferences') Object.assign(state.config,body);
      else if (path === '/api/listen') state.config.enabled=!!body.enabled;
      else if (path === '/api/harness') { state.runtime.harness.configured=body.harness;return json({restartRequired:body.harness!==state.runtime.harness.active}); }
      else if (path === '/api/chat-harness') state.runtime.harness.chat=body.harness;
      else if (path === '/api/ai-chats/save') {const c=state.aiChats.chats.find(c=>c.chatKey===body.chatKey);if(c)Object.assign(c,body);}
      else return json({ error: '这是独立验收预览；此操作需要真实助手，预览不会执行。' },409);
      return json({ ok: true, preview: true });
    } catch (error) { json({ error: error.message },400); }
  });
  return { server, state };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.UI_PREVIEW_PORT || 39362);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 39361) throw Error('验收预览需要独立端口，默认 39362。');
  const { server } = createPreviewServer();
  server.listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port + '/ — isolated demo, no real accounts'));
}
