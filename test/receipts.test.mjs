import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { BridgeEngine } from '../src/engine.mjs';
import { DouyinAdapter } from '../src/douyin.mjs';
const root=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(root,{recursive:true});
const owner={chatKey:'owner-chat',peerUid:'owner',displayName:'用户'};
const video={id:'123456789012345',conversation:owner.chatKey,sender:owner.peerUid,direction:'in',created:Date.now(),kind:'video',awemeId:'9000000000000000002',title:'界面演示'};
const stored={...video,platformId:video.id,id:owner.chatKey+':'+video.id,peer:owner.chatKey};
const settle=()=>new Promise(r=>setImmediate(r));
function harness(){
  const s=new Store(mkdtempSync(join(root,'receipt-')));s.saveConfig({owner,coordinator:'coordinator',enabled:true});
  const codex=new EventEmitter();let receipts=[];
  const adapter={scan:async()=>({peer:owner,messages:[{...video,created:Date.now()}]}),send:async()=>{},acknowledge:async(o,p,t)=>{receipts.push({owner:o,payload:p,text:t});return {method:'text'};}};
  adapter.react=async(o,id,options)=>{receipts.push({owner:o,messageId:id,payload:options});return {verified:true,emoji:options.emojis[0]};};
  const media={process:async()=>{throw new Error('停止测试');}};
  const engine=new BridgeEngine({store:s,adapter,codex,media});engine.armedAt=Date.now();
  return {s,engine,adapter,media,receipts};
}

test('正在分析别的视频时，新视频也立即贴收到表情；排队时不贴 active，重复扫描不重复回应',async()=>{
  const h=harness();h.engine.busy=true;
  await h.engine.scan();await settle();
  assert.equal(h.receipts.length,1);assert.deepEqual(h.receipts[0].payload.emojis,['👌']);assert.equal(h.s.snapshot().outbox.filter(o=>o.kind==='text').length,1);assert.match(h.s.snapshot().outbox.find(o=>o.kind==='text').body,/^已登记任务 1：/);assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).stage==='active'),false);
  h.engine.seen.clear();await h.engine.scan();await settle();assert.equal(h.receipts.length,1);h.s.close();
});

test('收到表情先于下载；真正开始后才排入 active，失败不贴 done',async()=>{
  const h=harness();h.s.incoming(stored);
  let mediaCalled=false;h.media.process=async()=>{mediaCalled=true;assert.equal(h.receipts.length,1);assert.deepEqual(h.receipts[0].payload.emojis,['👌']);throw new Error('下载测试终止');};
  await h.engine.processNext();assert.equal(mediaCalled,true);await h.engine.deliver();assert.equal(h.receipts.length,2);assert.deepEqual(h.receipts[1].payload.emojis,['[奋斗]']);assert.equal(h.s.snapshot().outbox.some(o=>JSON.parse(o.payload).stage==='done'),false);h.s.close();
});

test('已经收到排队确认的视频，真正开始分析时再确认一次，重复调用不刷屏',async()=>{
  const h=harness();h.engine.notifyVideo(stored,'queued');await h.engine.deliver();h.engine.notifyVideo(stored,'started');h.engine.notifyVideo(stored,'started');await h.engine.deliver();
  assert.equal(h.receipts.length,2);assert.equal(h.receipts[1].payload.mode,'text');assert.match(h.receipts[1].text,/已开始分析/);h.s.close();
});

test('视频接收确认优先于旧总结；发送失败会退避，不能每次轮询都重复操作页面',async()=>{
  const h=harness();h.engine.reply('旧总结');h.engine.notifyVideo(stored,'started');await h.engine.deliver();assert.equal(h.receipts.length,1);
  let sends=0;h.adapter.send=async()=>{sends++;throw new Error('尚未选中会话');};await h.engine.deliver();await h.engine.deliver();assert.equal(sends,1);h.s.close();
});

test('表情点击结果不明时不重复点击；独立的一条文字确认仍能送达',async()=>{
  const adapter=new DouyinAdapter({root:'unused'});let reactions=0,texts=0;
  adapter.react=async()=>{reactions++;throw Object.assign(new Error('表情回执不明'),{uncertain:true});};adapter.send=async()=>texts++;
  const result=await adapter.acknowledge(owner,{mode:'auto',messageId:video.id},'开始分析');
  assert.equal(reactions,1);assert.equal(texts,1);assert.equal(result.method,'text');
});

test('旧数据库升级保留原回复；通知键跨重启去重，发送中通知不自动重做',()=>{
  const folder=mkdtempSync(join(root,'migration-'));const db=new DatabaseSync(join(folder,'bridge.sqlite'));
  db.exec("CREATE TABLE outbox(id TEXT PRIMARY KEY,peer TEXT,body TEXT,status TEXT,error TEXT,created INTEGER);INSERT INTO outbox VALUES('old','owner-chat','原回复','pending','',1)");db.close();
  let s=new Store(folder);assert.equal(s.snapshot().outbox.find(o=>o.id==='old').body,'原回复');
  const id=s.enqueueReply(owner.chatKey,'通知',{kind:'video_ack',dedupe:'receipt-key',priority:100});s.delivery(id,'sending');s.close();
  s=new Store(folder);assert.equal(s.enqueueReply(owner.chatKey,'重复通知',{kind:'video_ack',dedupe:'receipt-key'}),id);assert.equal(s.snapshot().outbox.find(o=>o.id===id).status,'uncertain');s.close();
});

test('额度不足时原聊天获得中文续做提示，/继续视频 复用进度且不会重放派任务',async()=>{
  const h=harness(),folder=join(h.s.root,'knowledge','9000000000000000002');mkdirSync(folder,{recursive:true});
  h.s.addKnowledge({id:'9000000000000000002',title:'界面演示',path:join(folder,'note.md')});
  writeFileSync(join(folder,'visual-report.json'),JSON.stringify({status:'partial',completedSegments:3,totalSegments:20,coveredUntil:24,duration:155,error:'usage limit',updated:'fixture'}));
  h.engine.visualProgress={id:'9000000000000000002',completed:3,total:20};
  const notice=h.engine.failureNotice(new Error('You have hit your usage limit'));assert.match(notice,/3\/20/);assert.match(notice,/继续视频/);assert.doesNotMatch(notice,/Upgrade|Pro|https/);
  let resumes=0;h.engine.reanalyze=async(id,options)=>{resumes++;h.engine.busy=true;assert.equal(id,'9000000000000000002');assert.equal(options.notify,false);};
  const command={id:'resume-command',kind:'text',peer:owner.chatKey,text:'/继续视频'};
  h.s.incoming(command);assert.equal(h.engine.handleControl(command),true);assert.equal(resumes,1);
  h.engine.handleControl({...command,id:'again'});assert.equal(resumes,1);assert.equal(h.s.queuedTasks().length,0);h.s.close();
});

test('更新后只补收交接时间之后的新消息，旧历史与已处理消息不重复执行',async()=>{
  const h=harness(),cutover=Date.now()-4000;
  const old={...video,id:'old-history',created:cutover-60000,kind:'text',text:'/状态'};
  const gap={...video,id:'during-upgrade',created:cutover+1000,kind:'text',text:'/状态'};
  h.adapter.scan=async()=>({peer:owner,messages:[old,gap]});
  await h.engine.arm(true,{resumeSince:cutover});await h.engine.scan();await settle();
  assert.equal(h.s.snapshot().messages.length,1);assert.match(h.s.snapshot().messages[0].id,/during-upgrade/);
  h.engine.seen.clear();await h.engine.scan();await settle();assert.equal(h.s.snapshot().messages.length,1);h.s.close();
});
