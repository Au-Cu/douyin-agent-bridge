import http from 'node:http';
import {attachVisualProgress} from './visual-progress-view.mjs';
import { readFile,stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join,extname,dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { CodexClient } from './codex.mjs';
import { DouyinAdapter } from './douyin.mjs';
import { SafariDouyinAdapter } from './safari.mjs';
import { MediaProcessor } from './media.mjs';
import { BridgeEngine } from './engine.mjs';
import { VisualAnalyzer } from './visual.mjs';
import { setupAsr,modelName } from '../scripts/setup-asr.mjs';
import {Preferences} from './preferences.mjs';
import {Conversations} from './conversations.mjs';
import {commandHelp} from './commands.mjs';
import {progressEmoji} from './progress.mjs';
import {prepareDataRoot} from './data-root.mjs';
import {existsSync} from 'node:fs';
import {archiveScope,taskStatuses} from './archive.mjs';
import {ArchivedDeletion} from './deletion.mjs';
import {configurePanel,updatePanels} from './ui-state.mjs';
import {PeerBrowser} from './peer-browser.mjs';
import {Chats} from './chats.mjs';
import {ChatSandbox} from './chat-sandbox.mjs';
import {CodeSandbox} from './code-sandbox.mjs';
import {DeliveryReview} from './delivery-review.mjs';
import {ChatSessions} from './chat-sessions.mjs';
import {ChatMedia} from './chat-media.mjs';
import {ArchiveRetention} from './retention.mjs';
import {prepareDesktopShared} from './desktop-shared-setup.mjs';
import {runtimeClients} from './runtime-clients.mjs';
import {DshChatSandbox} from './dsh/chat-sandbox.mjs';
import {ChatRuntime} from './chat-runtime.mjs';
import {harnessValue} from './harness.mjs';
import {visibleSettings} from './harness-settings.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const startupSince=Date.now();
const {values:args}=parseArgs({options:{port:{type:'string'},'data-dir':{type:'string'}}});
if(args['data-dir'])process.env.BRIDGE_DATA_DIR=args['data-dir'];
const dataRoot=await prepareDataRoot(project),store=new Store(dataRoot);
const log=(message,level)=>store.event(message,level);
const adapter=new PeerBrowser(process.platform==='darwin'?new SafariDouyinAdapter({root:store.root,log}):new DouyinAdapter({root:store.root,log}));
const {codex,taskCodex,localCodex,desktopCodex,dsh,active}=runtimeClients({store,cwd:project,log});
const media=new MediaProcessor({root:store.root,adapter,log});
const preferences=new Preferences({store,codex});
const conversations=new Conversations({store,codex,preferences});
const visual=new VisualAnalyzer({codex,log,settings:()=>preferences.work()});
const engine=new BridgeEngine({store,adapter,media,codex,taskCodex,visual,preferences,conversations});
const deletion=new ArchivedDeletion({store,engine,conversations});
const codeSandbox=new CodeSandbox({root:store.root}),chatCapabilities=()=>({webSearch:store.config.chatWebSearch,publicTools:true,codeSandbox:store.config.chatCodeSandbox}),chatSandbox=new ChatRuntime({store,sandboxes:{codex:new ChatSandbox({root:store.root,codex:localCodex,log,codeSandbox,capabilities:chatCapabilities}),dsh:new DshChatSandbox({root:store.root,dsh,log,codeSandbox,capabilities:chatCapabilities})}}),chats=new Chats({store,adapter,sandbox:chatSandbox,preferences,canChangeAgent:()=>!engine.busy&&!engine.taskBusy&&!engine.picking&&!engine.scanBusy&&!engine.outboxBusy&&![...engine.interrupts.scopes.values()].some(s=>s.users>0)});engine.chats=chats;
preferences.chatCatalogProvider=harness=>harness==='dsh'?chatSandbox.catalog(harness):codex.models('codex');
const deliveryReview=new DeliveryReview({store,adapter,engine,chats});engine.deliveryReview=deliveryReview;chats.deliveryReview=deliveryReview;
const chatSessions=new ChatSessions({store,chats,runtime:chatSandbox});chats.sessions=chatSessions;chats.media=new ChatMedia({store,media,preferences});
const retention=new ArchiveRetention({store,deletion,sessions:chatSessions});
let sandboxPreparing=false;
const token=randomBytes(32).toString('hex');let asrInstalling=false;let closing=false;
const port=Number(args.port||process.env.BRIDGE_PORT||store.config.port);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口必须为 1024–65535 的整数');
store.saveConfig({port});const origin='http://127.0.0.1:'+port;
async function jsonBody(req){let text='';for await(const b of req){text+=b;if(text.length>100000)throw new Error('请求过大');}return text?JSON.parse(text):{};}
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
  try {
    if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))return json(res,{error:'无效 Host'},403);
    const url=new URL(req.url,origin);const path=url.pathname;
    if(path.startsWith('/api/')){
      if(!String(req.headers.cookie||'').split(';').some(c=>c.trim()==='bridge_session='+token))return json(res,{error:'请先打开本机控制台'},401);
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,{error:'来源校验失败'},403);
      if(req.method==='GET'&&path==='/api/instance')return json(res,{app:'douyin-codex-bridge',version:JSON.parse(await readFile(join(project,'package.json'),'utf8')).version,projectRoot:project,dataRoot,port});
      if(req.method==='GET'&&path==='/api/state'){
        let asrReady=false;try{asrReady=(await stat(join(store.root,'models',modelName,'model.int8.onnx'))).size>200000000;}catch{}
        const needScope=archiveScope(url.searchParams.get('needs')),knowledgeScope=archiveScope(url.searchParams.get('knowledge')),workScope=archiveScope(url.searchParams.get('work')),status=url.searchParams.get('status')||'all';if(!taskStatuses.has(status))throw new Error('未知任务状态');
        if(store.config.enabled&&store.config.owner&&adapter.status==='ready'&&codex.ready&&codex.authState?.status==='ready'&&asrReady)configurePanel(store,'setup');
        const visualReports=new Map(),readVisualReport=item=>{if(!visualReports.has(item.id))visualReports.set(item.id,readFile(join(dirname(item.path),'visual-report.json'),'utf8').then(JSON.parse));return visualReports.get(item.id);};
        const knowledgeView=async k=>{try{const v=await readVisualReport(k);return {...k,visualStatus:v.status,visualCompleted:v.completedSegments,visualTotal:v.totalSegments};}catch{return {...k,visualStatus:'legacy'};}};
        const snapshot=store.snapshot();snapshot.config=visibleSettings(store.config,active);snapshot.tasks=snapshot.tasks.map(t=>{const op=engine.progress.get(JSON.parse(t.context||'{}').operationId);return {...t,number:op?.number,title:op?.title};});snapshot.knowledge=await Promise.all(store.knowledgeList({scope:knowledgeScope}).map(knowledgeView));
        snapshot.recentKnowledge=await Promise.all(store.knowledgeList({scope:'current'}).slice(0,3).map(knowledgeView));
        snapshot.retention=retention.state();const sessions=conversations.state({scope:needScope});sessions.needs=sessions.needs.map(n=>({...n,url:codex.threadUrl(n.thread)}));
        return json(res,{...snapshot,aiChats:chats.state(),storage:store.storageState(),conversations:sessions,operations:engine.progress.state(),work:await attachVisualProgress(engine.progress.cards({scope:workScope,status}),{store,live:engine.visualProgress,readReport:readVisualReport}),runtime:{harness:{active,configured:store.config.harness||'codex',chat:store.config.chatHarness||'codex',environmentOverride:!!process.env.BRIDGE_HARNESS},taskCodex:{ready:desktopCodex.ready,mode:'sharedDesktop'},codex:codex.ready,auth:codex.authState,asrReady,asrInstalling,browser:adapter.status,browserEngine:process.platform==='darwin'?'safari':'edge',visualProgress:engine.visualProgress,scan:adapter.lastScan?{title:adapter.lastScan.title,peer:adapter.lastScan.peer,diagnostics:adapter.lastScan.diagnostics,loginRequired:adapter.lastScan.loginRequired}:null,processing:engine.busy}});
      }
      if(req.method==='GET'&&path==='/api/models'){const chat=url.searchParams.get('mode')==='chat',harness=chat?store.config.chatHarness||'codex':active,data=await (chat?preferences.chatCatalog(harness):preferences.catalog(harness));return json(res,{...data,harness});}
      if(req.method==='GET'&&path==='/api/needs')return json(res,conversations.state({scope:archiveScope(url.searchParams.get('scope'))}));
      if(req.method==='GET'&&path==='/api/commands')return json(res,{text:commandHelp});
      if(req.method==='GET'&&path==='/api/outbox/review')return json(res,deliveryReview.view(url.searchParams.get('kind'),String(url.searchParams.get('id')||'')));
      if(req.method==='GET'&&path==='/api/outbox/reconcile-batch')return json(res,{batch:deliveryReview.batchState()});
      if(req.method==='GET'&&path==='/api/chat-sessions')return json(res,{sessions:chatSessions.list(String(url.searchParams.get('peer')||''),{scope:archiveScope(url.searchParams.get('scope')||'all')})});
      if(req.method==='GET'&&path==='/api/chat-sessions/read')return json(res,await chatSessions.transcript(String(url.searchParams.get('id')||'')));
      if(req.method==='GET'&&path==='/api/threads'){const internal=new Set(store.db.prepare('SELECT thread FROM need_threads').all().map(r=>r.thread));return json(res,(await codex.threads(url.searchParams.get('q')||'',harnessValue(url.searchParams.get('harness')||active))).filter(t=>!internal.has(t.id)));}
      if(req.method==='GET'&&path==='/api/approvals')return json(res,[...codex.approvals.entries(),...taskCodex.approvals.entries()].map(([id,r])=>({id,description:JSON.stringify(r.params,null,2)})));
      if(req.method==='GET'&&path==='/api/browser/reaction-diagnostics')return json(res,{lastReceipt:adapter.lastReceipt||null,menu:adapter.lastReactionDiagnostic||null});
      if(req.method==='GET'&&path==='/api/browser/ui-diagnostics')return json(res,await adapter.uiDiagnostics());
      if(req.method==='GET'&&path==='/api/browser/selection-diagnostics')return json(res,adapter.lastSelectionDiagnostic||null);
      if(req.method==='GET'&&path==='/api/browser/scheduler-diagnostics')return json(res,adapter.diagnostics);
      if(req.method==='GET'&&path==='/api/browser/inbox-diagnostics'){const v=await adapter.inbox();return json(res,{rows:v.rows,entries:v.entries.map(({unread,source,shape})=>({unread,source,shape}))});}
      if(req.method==='GET'&&path==='/api/browser/quote-diagnostics')return json(res,adapter.lastQuoteDiagnostic||null);
      if(req.method==='GET'&&path==='/api/browser/quote-schema'){const id=url.searchParams.get('chat'),peer=id?chats.get(id):null;if(id&&!peer)throw new Error('只能检查已配置的聊天');return json(res,await adapter.quoteSchema(peer));}
      const visualMatch=path.match(/^\/api\/knowledge\/([^/]+)\/visual$/);
      const sheetMatch=path.match(/^\/api\/knowledge\/([^/]+)\/sheet\/(\d+)$/);
      if(req.method==='GET'&&(visualMatch||sheetMatch)){
        const item=store.knowledge(decodeURIComponent((visualMatch||sheetMatch)[1]));if(!item)return json(res,{error:'资料不存在'},404);
        let report;try{report=JSON.parse(await readFile(join(dirname(item.path),'visual-report.json'),'utf8'));}catch{return json(res,{error:'此视频还没有连续视觉记录，请点击重新分析'},404);}
        if(!sheetMatch)return json(res,report);
        if(!/^visual-continuous-v[12]-(2|4|8)fps-[a-f0-9]{12}$/.test(report.cacheKey))throw new Error('视觉缓存目录无效');
        const folder=join(dirname(item.path),report.cacheKey);const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
        const name=manifest.sheets[Number(sheetMatch[2])];if(!name||!/^sheet-\d+\.jpg$/.test(name))return json(res,{error:'画面不存在'},404);
        res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'});res.end(await readFile(join(folder,name)));return;
      }
      if(req.method==='GET'&&path.startsWith('/api/knowledge/')){
        const item=store.knowledge(decodeURIComponent(path.split('/').at(-1)));if(!item)return json(res,{error:'资料不存在'},404);
        return json(res,{...item,note:await readFile(item.path,'utf8')});
      }
      if(req.method!=='POST')return json(res,{error:'未找到接口'},404);
      const body=await jsonBody(req);
      if(path==='/api/code-sandbox/check')return json(res,await codeSandbox.check());
      if(path==='/api/desktop/prepare')return json(res,await prepareDesktopShared(store.root));
      if(path==='/api/desktop/recover'){await desktopCodex.connect();await desktopCodex.request('thread/loaded/list',{},5000);let recovered=0;for(const task of store.db.prepare("SELECT t.*,w.reason FROM tasks t JOIN task_waits w ON w.task_id=t.id WHERE t.status IN ('queued','blocked') AND t.turn=''").all()){const op=JSON.parse(task.context||'{}').operationId;if(task.thread.startsWith('dsh:')||!/active writer|桌面共享连接尚未就绪/.test(task.reason)||engine.interrupts.record(op)||store.isArchived('task',op))continue;engine.progress.retry(task.id);recovered++;}return json(res,{recovered});}
      if(path==='/api/desktop/check'){try{await desktopCodex.connect();const loaded=await desktopCodex.request('thread/loaded/list',{},5000);return json(res,{ready:true,message:'已连接桌面共用服务；派发与中断使用原聊天',loadedThreads:loaded.data?.length||0});}catch(e){return json(res,{ready:false,message:e.code==='DESKTOP_NOT_CONNECTED'?e.message:'桌面共享连接暂不可用，保留未提交任务'});}}
      if(path==='/api/harness'){const next=harnessValue(body.harness);store.saveConfig({harness:next});return json(res,{active,configured:next,restartRequired:next!==active,environmentOverride:!!process.env.BRIDGE_HARNESS});}
      if(path==='/api/chat-harness'){const next=harnessValue(body.harness);store.saveConfig({chatHarness:next});chatSandbox.invalidate();return json(res,{harness:next});}
      if(path==='/api/code-sandbox/setup'){if(!sandboxPreparing){sandboxPreparing=true;codeSandbox.setup().catch(()=>log('代码沙箱准备失败，请检查 Docker 引擎与镜像下载','attention')).finally(()=>sandboxPreparing=false);}return json(res,{preparing:sandboxPreparing});}
      if(path==='/api/ai-chats/select'){chats.beginSelection();return json(res,{ok:true});}
      if(path==='/api/ai-chats/cancel'){chats.endSelection();return json(res,{ok:true});}
      if(path==='/api/ai-chats/current')return json(res,await chats.observe());
      if(path==='/api/ai-chats/recover')return json(res,await chats.recover(body.chatKey));
      if(path==='/api/ai-chats/save'){
        if(body.enabled===true&&body.mode==='chat')await chatSandbox.prepare();
        const saved=chats.configure(body);configurePanel(store,'chats');return json(res,saved);
      }
      if(path==='/api/tasks/interrupt')return json(res,await engine.interrupts.request(String(body.id||'')));
      if(path==='/api/archive/retention')return json(res,retention.configure(body));
      if(path==='/api/chat-sessions/reset'){if(body.confirmed!==true)throw new Error('请确认要清空群聊上下文');return json(res,await chatSessions.reset(String(body.peer||''),await preferences.chatWork(),store.config.chatHarness||'codex'));}
      if(path==='/api/chat-sessions/archive'){if(typeof body.archived!=='boolean')throw new Error('请选择归档或恢复');return json(res,await chatSessions.archive(String(body.id||''),body.archived));}
      if(path==='/api/chat-sessions/reconcile')return json(res,await chatSessions.reconcile(String(body.id||'')));
      if(path==='/api/archive/delete/prepare')return json(res,deletion.prepare(body.kind,String(body.id||'')));
      if(path==='/api/archive/delete')return json(res,deletion.remove(body));
      if(path==='/api/ui/panels')return json(res,{panels:updatePanels(store,body)});
      if(path==='/api/archive'){
        if(typeof body.archived!=='boolean')throw new Error('请明确指定归档或恢复');
        if(body.kind==='need')return json(res,await engine.archives.need(String(body.id||''),body.archived));
        if(body.kind==='task'){const op=body.archived?engine.archives.archiveTask(String(body.id||'')):engine.archives.restoreTask(String(body.id||''));return json(res,{number:op.number,title:op.title,archived:body.archived});}
        if(body.kind==='knowledge'){const k=engine.archives.knowledge(String(body.id||''),body.archived);return json(res,{id:k.id,archived:body.archived});}
        throw new Error('未知归档类型');
      }
      if(path==='/api/storage/backup')return json(res,await store.backup());
      if(path==='/api/codex/reconnect'){chatSandbox.invalidate();return json(res,await codex.reconnect());}
      if(path==='/api/preferences'){await preferences.update(body);let effective=null,effectiveError;try{effective=await preferences.work();}catch(e){effectiveError=e.message;}return json(res,{ok:true,config:store.config,effective,effectiveError});}
      if(path==='/api/chat-preferences'){if(body.codeSandbox===true&&!(await codeSandbox.check()).ready)throw new Error(codeSandbox.status.message);await preferences.updateChat(body);return json(res,{ok:true,effective:await preferences.chatWork()});}
      if(path==='/api/needs/new'){const n=await conversations.create(String(body.title||'新需求'));return json(res,{...n,resolvedWaiting:conversations.resolveWaiting(n)});}
      if(path==='/api/needs/switch'){const n=await conversations.switchTo(String(body.id||''));return json(res,{...n,resolvedWaiting:conversations.resolveWaiting(n)});}
      if(path==='/api/shutdown'){
        if((engine.busy||engine.taskBusy||chats.running.size)&&body.force!==true)throw new Error('仍有任务或聊天执行中，请先等待结束；强制停止会把执行结果标为需要核实');
        json(res,{ok:true});setTimeout(shutdown,100);return;
      }
      if(path==='/api/browser/open'){await adapter.open(store.config.owner);return json(res,{ok:true});}
      if(path==='/api/browser/scan')return json(res,await adapter.scan());
      if(path==='/api/browser/editor-state')return json(res,(await adapter.composerState()).map(({text,...c})=>({...c,draftLength:text.length,preview:text.slice(0,60)})));
      if(path==='/api/browser/reaction-probe'){
        const scan=await adapter.scan(),owner=store.config.owner;
        if(!owner||scan.peer?.peerUid!==owner.peerUid||scan.peer?.chatKey!==owner.chatKey)throw new Error('请选中绑定用户会话');
        const candidates=scan.messages.filter(m=>m.direction==='in'&&m.sender===owner.peerUid);
        let message=body.messageId?candidates.find(m=>m.id===String(body.messageId)):candidates.filter(m=>m.kind==='text').at(-1);
        if(!message&&body.messageId){
          const saved=store.db.prepare('SELECT body FROM messages WHERE id=? AND peer=?').get(owner.chatKey+':'+String(body.messageId),owner.chatKey);
          const value=saved?JSON.parse(saved.body):null;if(value?.sender===owner.peerUid)message={...value,id:value.platformId||String(body.messageId)};
        }
        if(!message)throw new Error('未找到用户的原消息');
        if(body.stage&&!Object.hasOwn(progressEmoji,body.stage))throw new Error('状态必须为 roger、active 或 done');
        return json(res,await adapter.react(owner,message.id,{probeOnly:true,...(body.stage?{emojis:progressEmoji[body.stage]}:{})}));
      }
      if(path==='/api/receipts/reaction'){
        const item=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(body.id));
        if(!item||item.kind!=='video_ack'||item.status!=='sent'||item.peer!==store.config.owner?.chatKey)throw new Error('只能核验已给绑定用户的视频确认贴表情');
        const p=JSON.parse(item.payload);
        if(p.receiptResult?.method==='reaction'||p.reactionRecheck?.status==='verified')return json(res,{alreadyVerified:true});
        if(p.receiptResult?.reactionStatus==='uncertain'||['submitted','uncertain'].includes(p.reactionRecheck?.status))throw new Error('上次表情回执需要人工核实，不会重复点击');
        store.mergeOutboxPayload(item.id,{reactionRecheck:{status:'submitted',created:Date.now()}});
        try{
          const result=await adapter.react(store.config.owner,p.messageId);
          store.mergeOutboxPayload(item.id,{reactionRecheck:{status:result.verified?'verified':'unavailable',...result}});return json(res,result);
        }catch(e){store.mergeOutboxPayload(item.id,{reactionRecheck:{status:e.uncertain?'uncertain':'blocked',error:e.message}});throw e;}
      }
      if(path==='/api/bind'){
        const scan=await adapter.scan();if(!scan.peer)throw new Error('请先在助手账号中打开用户的私信会话，并由用户发一条消息');
        if(scan.peer.type==='group')throw new Error('个人 Agent 绑定现有用户单聊；群聊请在 AI 聊天卡片启用普通聊天模式');
        if(!scan.messages.some(m=>m.direction==='in'&&m.sender===scan.peer.peerUid&&m.created>0))throw new Error('无法核实发信账号或时间，请让用户再发一条新私信');
        if(store.config.enabled||engine.busy||engine.taskBusy)throw new Error('请先暂停监听并等待当前任务结束，再更换绑定');
        if(store.config.owner&&store.config.owner.peerUid!==scan.peer.peerUid&&store.pendingOutbox().length)throw new Error('旧账号仍有待发送消息，请先处理发件箱');
        store.saveConfig({owner:scan.peer});store.event('已绑定用户会话：'+scan.peer.displayName);return json(res,{owner:scan.peer});
      }
      if(path==='/api/coordinator'){const id=await engine.createCoordinator();return json(res,{id});}
      if(path==='/api/listen'){await engine.arm(body.enabled===true,{resumeSince:body.resumeSince});return json(res,{enabled:store.config.enabled});}
      if(path==='/api/config'||path==='/api/targets'){
        if(!Array.isArray(body.targets)||body.targets.length>20)throw new Error('目标聊天列表格式错误');
        const targets=body.targets.map(t=>({id:String(t.id||''),alias:String(t.alias||'').trim(),name:String(t.name||'').slice(0,150)}));
        if(targets.some(t=>!/^(?:dsh:)?[\w-]{5,100}$/.test(t.id)||!t.alias||t.alias.length>60)||new Set(targets.map(t=>t.alias)).size!==targets.length)throw new Error('目标 ID 或别名无效，别名不能重复');
        if(targets.some(t=>t.id===store.config.coordinator))throw new Error('调度聊天不能作为派发目标');
        if(targets.some(t=>store.db.prepare('SELECT 1 FROM need_threads WHERE thread=?').get(t.id)))throw new Error('需求助手会话不能作为派发目标');
        if(path==='/api/targets'){store.saveConfig({targets});configurePanel(store,'targets');return json(res,{ok:true});}
        const seconds=Number(body.maxVideoSeconds||1800);if(!Number.isFinite(seconds)||seconds<30||seconds>7200)throw new Error('视频上限必须在 30–7200 秒之间');
        const visualFps=Number(body.visualFps||store.config.visualFps||4);if(![2,4,8].includes(visualFps))throw new Error('视觉读取密度只能是每秒 2、4 或 8 帧');
        const ackMode=body.ackMode||store.config.ackMode||'auto';if(!['auto','text'].includes(ackMode))throw new Error('收到视频的确认方式无效');
        store.saveConfig({targets,maxVideoSeconds:seconds,visualFps,ackMode});configurePanel(store,'targets');return json(res,{ok:true});
      }
      if(path==='/api/asr/setup'){
        if(!asrInstalling){asrInstalling=true;setupAsr(store.root,log).catch(e=>log(e.message,'error')).finally(()=>{asrInstalling=false;});}
        return json(res,{ok:true});
      }
      if(path==='/api/approval'){(taskCodex.approvals.has(String(body.id))?taskCodex:codex).approve(String(body.id),body.allow===true);return json(res,{ok:true});}
      if(path==='/api/outbox/reconcile')return json(res,await deliveryReview.reconcile(body.id));
      if(path==='/api/outbox/reconcile-batch')return json(res,{batch:deliveryReview.startBatch(body)});
      if(path==='/api/outbox/resolve'){
        return json(res,deliveryReview.resolve(body.id,body.status,{confirmed:body.confirmed}));
      }
      if(path==='/api/retry/video'){
        const m=store.db.prepare('SELECT * FROM messages WHERE id=?').get(String(body.id));
        if(!m||m.kind!=='video'||m.status!=='failed')throw new Error('仅支持重试处理失败的视频，不自动重放任务指令');
        store.messageStatus(m.id,'new');return json(res,{ok:true});
      }
      if(path==='/api/knowledge/notify-status'){
        if(!store.config.owner)throw new Error('请先绑定用户');
        const id=engine.notifyVideoStatus(String(body.id));await engine.deliver();return json(res,{id});
      }
      if(path==='/api/knowledge/reanalyze'){
        if(engine.busy)throw new Error('正在处理其他视频或指令，请稍后重分析');
        if(!store.knowledge(String(body.id)))throw new Error('视频资料不存在');
        // Keep outdated draft replies as audit records; they no longer represent
        // the user's requested full-visual analysis and must not be sent later.
        store.db.prepare("UPDATE outbox SET status='superseded',error='已由连续视觉重分析替代，原草稿保留' WHERE status='pending' AND kind='text' AND json_extract(payload,'$.videoId')=?").run(String(body.id));
        engine.reanalyze(String(body.id),{refreshAuth:true}).catch(e=>log(e.message,'error'));return json(res,{ok:true});
      }
      return json(res,{error:'未找到接口'},404);
    }
    if(req.method!=='GET')return json(res,{error:'不支持的方法'},405);
    const assets={'/':'index.html','/classic.html':'classic.html','/app.js':'app.js','/style.css':'style.css','/classic.css':'classic.css','/dom.js':'dom.js','/views.js':'views.js','/ui-layout.js':'ui-layout.js','/group-settings.js':'group-settings.js'};if(!assets[path])return json(res,{error:'页面不存在'},404);
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    res.writeHead(200,{'Content-Type':types[extname(assets[path])]+'; charset=utf-8','Set-Cookie':`bridge_session=${token}; HttpOnly; SameSite=Strict; Path=/`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});
    res.end(await readFile(join(project,'public',assets[path])));
  }catch(e){json(res,{error:e.message,...(e.code?{code:e.code}:{})},400);}
});
server.listen(port,'127.0.0.1',()=>{console.log('抖音 Agent Bridge 控制台：'+origin);log('控制台已启动，正在恢复本机连接');store.backup().catch(()=>log('状态快照暂未完成，请检查磁盘空间','attention'));});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'控制台端口已被占用，请打开 '+origin:e.message);process.exitCode=1;clearInterval(statusTimer);engine.stop();codex.close();});
engine.start();codex.startAuthWatcher();
let retentionWork=Promise.resolve();const retentionTimer=setInterval(()=>{retentionWork=Promise.allSettled([retention.run().catch(()=>log('归档保留策略检查失败，记录已保留','attention')),chatSessions.reconcileUncertain()]);},60000);
const codexReady=codex.connect().then(async()=>{await conversations.ensureLegacy();log('本机 '+(active==='dsh'?'DeepSeek Harness':'Codex')+' 已连接');}).catch(e=>log('助手连接失败：'+e.message,'error'));
if((store.config.owner||chats.bots().length)&&existsSync(join(store.root,'browser-profile')))adapter.open(store.config.owner).then(async()=>{
  await codexReady;if(closing||!store.config.resumeOnStartup)return;
  try{await engine.arm(true,{resumeSince:startupSince});log('已恢复保存的会话与监听，补收本次启动期间的消息；已有记录不会重复执行');}catch(e){log('绑定和资料已保留，等待恢复抖音会话：'+e.message,'attention');}
}).catch(()=>log('抖音登录态和资料已保留，请打开抖音窗口检查平台登录状态','attention'));
const statusTimer=setInterval(()=>{if(adapter.page&&!adapter.sending)adapter.scan().catch(()=>{});},5000);
const backupTimer=setInterval(()=>store.backup().catch(()=>log('自动状态快照暂未完成','attention')),30*60000);backupTimer.unref();
async function shutdown(){if(closing)return;closing=true;clearInterval(statusTimer);clearInterval(backupTimer);clearInterval(retentionTimer);retention.closing=true;deliveryReview.closing=true;chatSessions.closing=true;await Promise.allSettled([retentionWork,deliveryReview.batchWork]);engine.stop();chats.stop();await Promise.allSettled([codex.close(),taskCodex.close(),chatSandbox.close()]);await codeSandbox.close();await Promise.allSettled([...engine.interrupts.requests.values(),...chats.running.values(),...engine.memoryUpdates]);await adapter.close();if(store.backingUp)await store.backingUp.catch(()=>{});await store.backup().catch(()=>{});server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
