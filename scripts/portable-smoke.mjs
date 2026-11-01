import {mkdir,copyFile,readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import assert from 'node:assert/strict';import {once} from 'node:events';
import {collectReleaseFiles,projectRoot} from './release-files.mjs';

const root=join(projectRoot,'data','test-runs','portable-'+Date.now(),'fresh clone 空格');await mkdir(root,{recursive:true});
for(const file of await collectReleaseFiles()){await mkdir(dirname(join(root,file)),{recursive:true});await copyFile(join(projectRoot,file),join(root,file));}
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const url='http://127.0.0.1:'+port;
const profile=join(root,'data');
const proc=spawn(process.execPath,['--use-env-proxy','src/server.mjs','--port',String(port)],{cwd:root,env:{...process.env,BRIDGE_DATA_DIR:profile,CODEX_HOME:join(root,'data','fixture-codex-home'),CODEX_BIN:join(root,'test','fixture-rpc.mjs')},windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';proc.stderr.on('data',b=>{stderr=(stderr+b).slice(-3000);});let cookie;
const request=async(path,{method='GET',body,auth=true}={})=>fetch(url+'/api/'+path,{method,headers:{...(auth?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
try{
  let ready=false;for(let i=0;i<60;i++){
    if(proc.exitCode!==null)throw new Error('Portable server exited: '+stderr);
    try{const home=await fetch(url,{signal:AbortSignal.timeout(600)});cookie=home.headers.get('set-cookie')?.split(';')[0];if(cookie){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,150));
  }
  assert.ok(ready,'clean server must start');
  const identity=await (await request('instance')).json();assert.equal(resolve(identity.projectRoot),resolve(root));
  const state=await (await request('state')).json();assert.equal(state.config.owner,null);assert.equal(state.config.coordinator,'');assert.deepEqual(state.config.targets,[]);assert.equal(state.config.enabled,false);
  for(const key of ['knowledge','messages','outbox','tasks'])assert.equal(state[key].length,0);
  assert.equal(existsSync(join(root,'data','browser-profile')),false);
  assert.equal((await request('state',{auth:false})).status,401);
  const reconnected=await (await request('codex/reconnect',{method:'POST',body:{}})).json();assert.equal(typeof reconnected.deferred,'boolean');
  let recovered;for(let i=0;i<40;i++){recovered=await (await request('state')).json();if(recovered.runtime.auth.status==='ready'&&!recovered.runtime.auth.reconnectPending)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(recovered.runtime.auth.status,'ready');assert.equal(recovered.runtime.auth.reconnectPending,false);assert.equal(recovered.config.owner,null);
  const catalog=await (await request('models')).json();assert.equal(catalog.models[0].model,'fixture-model');
  const settings=await request('preferences',{method:'POST',body:{model:'fixture-model',reasoningEffort:'max',fastMode:true,autoRoute:true,contextBudget:16000}});assert.equal(settings.status,200);
  const current=(await (await request('state')).json()).config;assert.equal(current.reasoningEffort,'max');assert.equal(current.fastMode,true);assert.equal(current.contextBudget,16000);
  const invalid=await request('preferences',{method:'POST',body:{reasoningEffort:'unavailable-level'}});assert.equal(invalid.status,400);assert.equal((await (await request('state')).json()).config.reasoningEffort,'max');
  const need=await (await request('needs/new',{method:'POST',body:{title:'合成需求'}})).json();assert.ok(need.thread.startsWith('fixture-thread-'));
  const needs=await (await request('needs')).json();assert.equal(needs.activeNeed,need.id);assert.equal(needs.needs.length,1);
  assert.ok((await (await request('commands')).json()).text.includes('/密度 2|4|8'));
  if(process.platform==='win32'){
    const wrong=await new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(projectRoot,'Stop.ps1'),'-Port',String(port)],{cwd:projectRoot,env:{...process.env,BRIDGE_DATA_DIR:join(root,'other-data')},windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',resolve);});
    assert.notEqual(wrong,0,'another copy must not stop this instance');assert.equal((await request('state')).status,200);
    const right=await new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'Stop.ps1')],{cwd:root,env:{...process.env,BRIDGE_DATA_DIR:profile,BRIDGE_PORT:''},windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';for(const stream of[p.stdout,p.stderr])stream.on('data',b=>diagnostic=(diagnostic+b).slice(-2500));p.on('error',reject);p.on('exit',code=>code===0?resolve(code):reject(new Error('Isolated stop script failed: '+diagnostic)));});
    assert.equal(right,0,'this copy must stop its saved-port instance');
  }else if(process.platform==='darwin'){
    const launch=async(file,extra,env)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[file,'stop',...extra],{cwd:root,env,stdio:['ignore','pipe','pipe']});let diagnostic='';for(const stream of[p.stdout,p.stderr])stream.on('data',b=>diagnostic=(diagnostic+b).slice(-2500));p.on('error',reject);p.on('exit',code=>resolve({code,diagnostic}));});
    const wrong=await launch(join(projectRoot,'scripts','mac-launcher.mjs'),['--port',String(port)],{...process.env,BRIDGE_DATA_DIR:join(root,'other-data')});assert.notEqual(wrong.code,0,'another profile must not stop this instance');assert.equal((await request('state')).status,200);
    const right=await launch(join(root,'scripts','mac-launcher.mjs'),[],{...process.env,BRIDGE_DATA_DIR:profile,BRIDGE_PORT:''});assert.equal(right.code,0,'this profile must stop its saved-port instance: '+right.diagnostic);
  }else await request('shutdown',{method:'POST',body:{}});
  if(proc.exitCode===null){let timer;try{await Promise.race([once(proc,'exit'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Shutdown timed out')),10000);})]);}finally{clearTimeout(timer);}}
  console.log(JSON.stringify({ok:true,cleanOwnerAndHistory:true,unicodeAndSpaces:true,otherCopyStopBlocked:['win32','darwin'].includes(process.platform),modelCalls:0,sourceFiles:(await collectReleaseFiles()).length},null,2));
}finally{if(proc.exitCode===null){try{await request('shutdown',{method:'POST',body:{force:true}});}catch{}let timer;try{if(proc.exitCode===null)await Promise.race([once(proc,'exit'),new Promise(r=>{timer=setTimeout(r,1500);})]);}finally{clearTimeout(timer);}if(proc.exitCode===null)proc.kill();}}
