import http from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join,extname,dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.mjs';
import { CodexClient } from './codex.mjs';
import { DouyinAdapter } from './douyin.mjs';
import { MediaProcessor } from './media.mjs';
import { BridgeEngine } from './engine.mjs';
import { VisualAnalyzer } from './visual.mjs';
import { setupAsr,modelName } from '../scripts/setup-asr.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const store=new Store(join(project,'data'));
const log=(message,level)=>store.event(message,level);
const adapter=new DouyinAdapter({root:store.root,log});
const codex=new CodexClient({cwd:project,log});
const media=new MediaProcessor({root:store.root,adapter,log});
const visual=new VisualAnalyzer({codex,log});
const engine=new BridgeEngine({store,adapter,media,codex,visual});
const token=randomBytes(32).toString('hex');let asrInstalling=false;let closing=false;
const {values:args}=parseArgs({options:{port:{type:'string'}}});
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
      if(req.method==='GET'&&path==='/api/instance')return json(res,{app:'douyin-codex-bridge',version:'0.2.1',projectRoot:project,port});
      if(req.method==='GET'&&path==='/api/state'){
        let asrReady=false;try{asrReady=(await stat(join(store.root,'models',modelName,'model.int8.onnx'))).size>200000000;}catch{}
        const snapshot=store.snapshot();snapshot.knowledge=await Promise.all(snapshot.knowledge.map(async k=>{
          try{const v=JSON.parse(await readFile(join(dirname(k.path),'visual-report.json'),'utf8'));return {...k,visualStatus:v.status,visualCompleted:v.completedSegments,visualTotal:v.totalSegments};}catch{return {...k,visualStatus:'legacy'};}
        }));
        return json(res,{...snapshot,runtime:{codex:codex.ready,auth:codex.authState,asrReady,asrInstalling,browser:adapter.status,visualProgress:engine.visualProgress,scan:adapter.lastScan?{title:adapter.lastScan.title,peer:adapter.lastScan.peer,diagnostics:adapter.lastScan.diagnostics,loginRequired:adapter.lastScan.loginRequired}:null,processing:engine.busy}});
      }
      if(req.method==='GET'&&path==='/api/threads')return json(res,await codex.threads(url.searchParams.get('q')||''));
      if(req.method==='GET'&&path==='/api/approvals')return json(res,[...codex.approvals.entries()].map(([id,r])=>({id,description:JSON.stringify(r.params,null,2)})));
      if(req.method==='GET'&&path==='/api/browser/reaction-diagnostics')return json(res,{lastReceipt:adapter.lastReceipt||null,menu:adapter.lastReactionDiagnostic||null});
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
      if(path==='/api/codex/reconnect')return json(res,await codex.reconnect());
      if(path==='/api/shutdown'){
        if((engine.busy||engine.taskBusy)&&body.force!==true)throw new Error('仍有任务执行中，请先等待任务结束；强制停止会把执行结果标为需要核实');
        json(res,{ok:true});setTimeout(shutdown,100);return;
      }
      if(path==='/api/browser/open'){await adapter.open(store.config.owner);return json(res,{ok:true});}
      if(path==='/api/browser/scan')return json(res,await adapter.scan());
      if(path==='/api/browser/editor-state')return json(res,(await adapter.composerState()).map(({text,...c})=>({...c,draftLength:text.length,preview:text.slice(0,60)})));
      if(path==='/api/browser/reaction-probe'){
        const scan=await adapter.scan(),owner=store.config.owner;
        if(!owner||scan.peer?.peerUid!==owner.peerUid||scan.peer?.chatKey!==owner.chatKey)throw new Error('请选中绑定主人会话');
        const candidates=scan.messages.filter(m=>m.direction==='in'&&m.sender===owner.peerUid);
        let message=body.messageId?candidates.find(m=>m.id===String(body.messageId)):candidates.filter(m=>m.kind==='text').at(-1);
        if(!message&&body.messageId){
          const saved=store.db.prepare('SELECT body FROM messages WHERE id=? AND peer=?').get(owner.chatKey+':'+String(body.messageId),owner.chatKey);
          const value=saved?JSON.parse(saved.body):null;if(value?.sender===owner.peerUid)message={...value,id:value.platformId||String(body.messageId)};
        }
        if(!message)throw new Error('未找到主人的原消息');
        return json(res,await adapter.react(owner,message.id,{probeOnly:true}));
      }
      if(path==='/api/receipts/reaction'){
        const item=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(body.id));
        if(!item||item.kind!=='video_ack'||item.status!=='sent'||item.peer!==store.config.owner?.chatKey)throw new Error('只能核验已给绑定主人的视频确认贴表情');
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
        const scan=await adapter.scan();if(!scan.peer)throw new Error('请先在助手账号中打开主人的私信会话，并由主人发一条消息');
        if(!scan.messages.some(m=>m.direction==='in'&&m.sender===scan.peer.peerUid&&m.created>0))throw new Error('无法核实发信账号或时间，请让主人再发一条新私信');
        if(store.config.enabled||engine.busy||engine.taskBusy)throw new Error('请先暂停监听并等待当前任务结束，再更换绑定');
        if(store.config.owner&&store.config.owner.peerUid!==scan.peer.peerUid&&store.pendingOutbox().length)throw new Error('旧账号仍有待发送消息，请先处理发件箱');
        store.saveConfig({owner:scan.peer});store.event('已绑定主人会话：'+scan.peer.displayName);return json(res,{owner:scan.peer});
      }
      if(path==='/api/coordinator'){const id=await engine.createCoordinator();return json(res,{id});}
      if(path==='/api/listen'){await engine.arm(body.enabled===true,{resumeSince:body.resumeSince});return json(res,{enabled:store.config.enabled});}
      if(path==='/api/config'){
        if(!Array.isArray(body.targets)||body.targets.length>20)throw new Error('目标聊天列表格式错误');
        const targets=body.targets.map(t=>({id:String(t.id||''),alias:String(t.alias||'').trim(),name:String(t.name||'').slice(0,150)}));
        if(targets.some(t=>!/^[\w-]{5,100}$/.test(t.id)||!t.alias||t.alias.length>60)||new Set(targets.map(t=>t.alias)).size!==targets.length)throw new Error('目标 ID 或别名无效，别名不能重复');
        if(targets.some(t=>t.id===store.config.coordinator))throw new Error('调度聊天不能作为派发目标');
        const seconds=Number(body.maxVideoSeconds||1800);if(!Number.isFinite(seconds)||seconds<30||seconds>7200)throw new Error('视频上限必须在 30–7200 秒之间');
        const visualFps=Number(body.visualFps||store.config.visualFps||4);if(![2,4,8].includes(visualFps))throw new Error('视觉读取密度只能是每秒 2、4 或 8 帧');
        const ackMode=body.ackMode||store.config.ackMode||'auto';if(!['auto','text'].includes(ackMode))throw new Error('收到视频的确认方式无效');
        store.saveConfig({targets,maxVideoSeconds:seconds,visualFps,ackMode});return json(res,{ok:true});
      }
      if(path==='/api/asr/setup'){
        if(!asrInstalling){asrInstalling=true;setupAsr(store.root,log).catch(e=>log(e.message,'error')).finally(()=>{asrInstalling=false;});}
        return json(res,{ok:true});
      }
      if(path==='/api/approval'){codex.approve(String(body.id),body.allow===true);return json(res,{ok:true});}
      if(path==='/api/outbox/resolve'){
        const item=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(body.id));if(!item||item.status!=='uncertain')throw new Error('此回执无需人工处理');
        if(!['sent','pending'].includes(body.status))throw new Error('无效处理方式');
        store.delivery(item.id,body.status,'主人在本机手动确认');return json(res,{ok:true});
      }
      if(path==='/api/retry/video'){
        const m=store.db.prepare('SELECT * FROM messages WHERE id=?').get(String(body.id));
        if(!m||m.kind!=='video'||m.status!=='failed')throw new Error('仅支持重试处理失败的视频，不自动重放任务指令');
        store.messageStatus(m.id,'new');return json(res,{ok:true});
      }
      if(path==='/api/knowledge/notify-status'){
        if(!store.config.owner)throw new Error('请先绑定主人');
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
    const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(!assets[path])return json(res,{error:'页面不存在'},404);
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    res.writeHead(200,{'Content-Type':types[extname(assets[path])]+'; charset=utf-8','Set-Cookie':`bridge_session=${token}; HttpOnly; SameSite=Strict; Path=/`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});
    res.end(await readFile(join(project,'public',assets[path])));
  }catch(e){json(res,{error:e.message},400);}
});
server.listen(port,'127.0.0.1',()=>{console.log('抖音 Codex 助手控制台：'+origin);log('控制台已启动，等待账号连接');});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'控制台端口已被占用，请打开 '+origin:e.message);process.exitCode=1;clearInterval(statusTimer);engine.stop();codex.close();});
engine.start();codex.startAuthWatcher();codex.connect().then(()=>log('本机 Codex 已连接')).catch(e=>log('Codex 连接失败：'+e.message,'error'));
const statusTimer=setInterval(()=>{if(adapter.page&&!adapter.sending)adapter.scan().catch(()=>{});},5000);
async function shutdown(){if(closing)return;closing=true;clearInterval(statusTimer);engine.stop();codex.close();await adapter.close();server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
