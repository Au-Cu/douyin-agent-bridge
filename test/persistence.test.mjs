import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,statSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {fork} from 'node:child_process';import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';import {Needs} from '../src/needs.mjs';import {BridgeEngine} from '../src/engine.mjs';
import {resolveDataRoot,migrateData,prepareDataRoot} from '../src/data-root.mjs';
import {createHash} from 'node:crypto';import {VisualAnalyzer} from '../src/visual.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});const temp=()=>mkdtempSync(join(base,'persistence-'));

test('强杀进程后恢复配置、授权名单、需求与资料；正在执行或送达的操作不自动重跑',async()=>{
  const root=temp(),child=fork(fileURLToPath(new URL('./fixture-crash-store.mjs',import.meta.url)),[root],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  try{const [m]=await once(child,'message',{signal:AbortSignal.timeout(10000)});assert.equal(m.ready,true);const exit=once(child,'exit');child.kill('SIGKILL');await exit;
    // Simulate an interrupted/deleted JSON mirror as well: committed DB settings win.
    writeFileSync(join(root,'config.json'),'{"broken":');const s=new Store(root);
    try{assert.equal(s.config.model,'fixture-model');assert.equal(s.config.reasoningEffort,'max');assert.equal(s.config.fastMode,true);assert.equal(s.config.targets.length,1);assert.equal(s.config.owner.peerUid,'fixture-uid');assert.equal(s.config.resumeOnStartup,true);assert.equal(s.config.enabled,false);assert.ok(s.recovery);
      assert.equal(s.db.prepare('PRAGMA synchronous').get().synchronous,2);assert.equal(s.db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(new Needs(s).list().length,1);assert.equal(s.search('',10).length,1);assert.equal(readFileSync(s.search('',1)[0].path,'utf8'),'原视频视觉记录');
      assert.equal(s.snapshot().tasks.find(t=>t.turn==='accepted-turn').status,'uncertain');assert.equal(s.queuedTasks().length,1);assert.equal(s.snapshot().outbox[0].status,'uncertain');assert.equal(s.pendingMessages().length,0);
    }finally{s.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

test('重复启动同一数据目录先拒绝，不能把第一个进程正在执行的任务改成不明',()=>{
  const root=temp(),s=new Store(root);try{const id=s.createTask('网站','thread','执行');s.taskStatus(id,'running','','turn');assert.throws(()=>new Store(root),/另一个助手进程/);assert.equal(s.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'running');}finally{s.close();}
});

test('固定目录与代码文件夹无关；显式配置仍可隔离多套账号及测试数据',async()=>{
  const parent=temp(),env={LOCALAPPDATA:parent},a=resolveDataRoot({env,platform:'win32'}),b=resolveDataRoot({env,platform:'win32'});assert.equal(a,b);assert.equal(a,resolve(parent,'DouyinCodexBridge','data'));
  const isolated=join(parent,'独立资料 空格');assert.equal(resolveDataRoot({env:{...env,BRIDGE_DATA_DIR:isolated}}),resolve(isolated));
  const old=join(parent,'code','data'),legacy=new Store(old);legacy.saveConfig({model:'legacy-model'});legacy.close();
  const selected=await prepareDataRoot(join(parent,'code'),{root:isolated,env:{BRIDGE_DATA_DIR:isolated}});assert.equal(selected,resolve(isolated));assert.equal(existsSync(join(isolated,'bridge.sqlite')),false,'explicit clean profiles do not import another account');
});

test('迁移保留旧数据并重定位原视频、时间戳视觉记录、需求文件和排队任务中的路径',async()=>{
  const parent=temp(),source=join(parent,'旧副本','data'),target=join(parent,'固定资料'),s=new Store(source),folder=join(source,'knowledge','video');mkdirSync(folder,{recursive:true});
  const path=join(folder,'note.md'),video=join(folder,'video.mp4');writeFileSync(path,'证据：'+video);writeFileSync(video,'fixture-video');writeFileSync(join(folder,'metadata.json'),JSON.stringify({source:video,path}));s.addKnowledge({id:'video',title:'视觉资料',path});s.saveConfig({owner:{chatKey:'c',peerUid:'u'},targets:[{id:'t',alias:'网站'}],model:'fixture-model'});
  const info=statSync(video),revision=createHash('sha256').update(`${info.size}:${info.mtimeMs}:2`).digest('hex').slice(0,12),cacheKey='visual-continuous-v2-4fps-'+revision,cache=join(folder,cacheKey);mkdirSync(cache);writeFileSync(join(cache,'sheet-00001.jpg'),'fixture');writeFileSync(join(cache,'manifest.json'),JSON.stringify({cacheKey,videoBytes:info.size,fps:4,duration:2,sheets:['sheet-00001.jpg']}));
  const needs=new Needs(s),need=needs.create('旧需求','old-thread');needs.activate(need.id);needs.json(need.id,'history.json',{reference:path});const task=s.createTask('网站','t','检查 '+path,{path});s.close();
  await migrateData(source,target);assert.ok(existsSync(join(source,'bridge.sqlite')));assert.equal(readFileSync(path,'utf8'),'证据：'+video);const restored=new Store(target);
  try{const expected=join(target,'knowledge','video','note.md');assert.equal(restored.knowledge('video').path,expected);assert.ok(readFileSync(expected,'utf8').includes(join(target,'knowledge','video','video.mp4')));assert.equal(JSON.parse(readFileSync(join(target,'knowledge','video','metadata.json'),'utf8')).path,expected);assert.equal(new Needs(restored).list().length,1);assert.ok(restored.queuedTasks().find(t=>t.id===task).prompt.includes(expected));assert.equal(restored.config.model,'fixture-model');const prepared=await new VisualAnalyzer({}).prepare({path:expected,seconds:2},4);assert.ok(prepared.folder.endsWith(cacheKey),'moving data must not invalidate completed visual work');}finally{restored.close();}
  await assert.rejects(migrateData(source,target),/已经有账号或记忆/);assert.ok(existsSync(join(target,'knowledge','video','video.mp4')));
});

test('配置镜像不完整时用上次有效副本恢复；所有副本无效时停止而不写入空设置',()=>{
  const root=temp();writeFileSync(join(root,'config.json'),'{');writeFileSync(join(root,'config.json.bak'),JSON.stringify({model:'backup-model',targets:[{id:'saved'}]}));const s=new Store(root);assert.equal(s.config.model,'backup-model');assert.equal(s.config.targets.length,1);s.close();
  const bad=temp();writeFileSync(join(bad,'config.json'),'{');assert.throws(()=>new Store(bad),/不能用空配置覆盖/);assert.equal(readFileSync(join(bad,'config.json'),'utf8'),'{');
});

test('备份使用一致性数据库快照并保留最新设置；正常关闭只暂停运行，不清除下次恢复意图',async()=>{
  const root=temp(),s=new Store(root);try{s.saveConfig({model:'saved-model',resumeOnStartup:true,enabled:true});const n=new Needs(s).create('快照中的需求','thread');const result=await s.backup(),file=join(root,'backups',result.folder,'bridge.sqlite'),db=new DatabaseSync(file,{readOnly:true});
    try{assert.equal(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='config'").get().value).model,'saved-model');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM needs').get().n,1);assert.equal(db.prepare('SELECT id FROM needs').get().id,n.id);}finally{db.close();}
    BridgeEngine.prototype.stop.call({store:s});assert.equal(s.config.enabled,false);assert.equal(s.config.resumeOnStartup,true);assert.ok(s.storageState().backup.created);
  }finally{s.close();}
});

test('数据库缺失但备份仍在时停止启动，不能用一套空记忆覆盖恢复线索',async()=>{
  const root=temp(),s=new Store(root);s.saveConfig({model:'retained-model'});await s.backup();s.close();renameSync(join(root,'bridge.sqlite'),join(root,'retained.sqlite'));
  assert.throws(()=>new Store(root),/不能创建空库替代/);assert.equal(existsSync(join(root,'bridge.sqlite')),false);assert.ok(existsSync(join(root,'backups','latest.json')));
});
