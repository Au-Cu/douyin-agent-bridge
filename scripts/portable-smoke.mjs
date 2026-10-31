import {mkdir,copyFile,readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import assert from 'node:assert/strict';import {once} from 'node:events';
import {collectReleaseFiles,projectRoot} from './release-files.mjs';

const root=join(projectRoot,'data','test-runs','portable-'+Date.now(),'fresh clone 空格');await mkdir(root,{recursive:true});
for(const file of await collectReleaseFiles()){await mkdir(dirname(join(root,file)),{recursive:true});await copyFile(join(projectRoot,file),join(root,file));}
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const url='http://127.0.0.1:'+port;
const proc=spawn(process.execPath,['--use-env-proxy','src/server.mjs','--port',String(port)],{cwd:root,env:{...process.env,CODEX_BIN:join(root,'test','fixture-rpc.mjs')},windowsHide:true,stdio:['ignore','ignore','pipe']});
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
  if(process.platform==='win32'){
    const wrong=await new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(projectRoot,'Stop.ps1'),'-Port',String(port)],{cwd:projectRoot,windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',resolve);});
    assert.notEqual(wrong,0,'another copy must not stop this instance');assert.equal((await request('state')).status,200);
    const right=await new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'Stop.ps1')],{cwd:root,env:{...process.env,BRIDGE_PORT:''},windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',resolve);});
    assert.equal(right,0,'this copy must stop its saved-port instance');
  }else await request('shutdown',{method:'POST',body:{}});
  if(proc.exitCode===null){let timer;try{await Promise.race([once(proc,'exit'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Shutdown timed out')),10000);})]);}finally{clearTimeout(timer);}}
  console.log(JSON.stringify({ok:true,cleanOwnerAndHistory:true,unicodeAndSpaces:true,otherCopyStopBlocked:process.platform==='win32',modelCalls:0,sourceFiles:(await collectReleaseFiles()).length},null,2));
}finally{if(proc.exitCode===null){try{await request('shutdown',{method:'POST',body:{force:true}});}catch{}if(proc.exitCode===null)proc.kill();}}
