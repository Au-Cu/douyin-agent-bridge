import { stat,readFile,mkdir,mkdtemp } from 'node:fs/promises';
import { spawn,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CodexClient } from '../src/codex.mjs';
import { DshClient } from '../src/dsh/client.mjs';
import {ProfiledDshClient} from '../src/dsh/profile-client.mjs';
import { runFfmpeg,transcribe,localAsrEnv } from '../src/media.mjs';
import { modelName } from './setup-asr.mjs';
import {resolveDataRoot} from '../src/data-root.mjs';
import {existsSync} from 'node:fs';
const project=fileURLToPath(new URL('../',import.meta.url));const stable=resolveDataRoot(),data=existsSync(stable)?stable:join(project,'data');let missing=false;
function check(label,ok,detail=''){console.log(`[${ok?'OK':'待完成'}] ${label}${detail?'：'+detail:''}`);if(!ok)missing=true;}
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
check('Node.js',nodeMajor>24||nodeMajor===24&&nodeMinor>=5,process.version+' / '+process.arch);
try{if(process.platform==='darwin'){const result=spawnSync(process.execPath,['-e',"const s=require('sherpa-onnx-node');process.exit(typeof s.OfflineRecognizer==='function'?0:1)"],{cwd:project,env:localAsrEnv(),encoding:'utf8',timeout:30000});check('本地转写引擎',result.status===0,result.status===0?'':'请检查本地原生语音库');}else{const s=createRequire(import.meta.url)('sherpa-onnx-node');check('本地转写引擎',typeof s.OfflineRecognizer==='function');}}catch(e){check('本地转写引擎',false,e.message);}
try{await runFfmpeg(['-version']);check('视频解码工具',true);}catch(e){check('视频解码工具',false,e.message);}
const model=join(data,'models',modelName);
try{check('本地口播模型',(await stat(join(model,'model.int8.onnx'))).size>200000000);}catch{check('本地口播模型',false,'运行 npm run setup:asr');}
let configured='codex';try{configured=JSON.parse(await readFile(join(data,'config.json'),'utf8')).harness||'codex';}catch{}
const harness=(process.env.BRIDGE_HARNESS||configured).toLowerCase();if(!['codex','dsh'].includes(harness))throw new Error('助手只能是 codex 或 dsh');
if(harness==='dsh'){
  const client=new DshClient({cwd:project});
  try{
    await client.connect();
    const sessions=await client.threads();check('DeepSeek Harness 已连接',true,`可读取 ${sessions.length} 个本机会话`);
    const catalog=await client.models();check('DeepSeek Harness 模型可用',catalog.models.length>0,catalog.models.map(m=>m.model).join('、'));
    if(process.argv.includes('--live-dsh')){
      const folder=join(data,'diagnostics');await mkdir(folder,{recursive:true});const root=await mkdtemp(join(folder,'dsh-')),probe=new ProfiledDshClient({root,home:client.home,executable:client.executable,mode:'chat',instructions:'This is a disposable connectivity check. Reply with exactly BRIDGE_OK. No tools.',selectionProvider:()=>JSON.parse(catalog.models.find(m=>m.isDefault).id)});
      try{const id=await probe.createCoordinator([],true,{role:'chat'}),result=await probe.run(id,[{type:'text',text:'Reply with exactly BRIDGE_OK.'}],{timeoutMs:90000,interruptOnTimeout:true});check('DeepSeek Harness 实际回复',result.text.includes('BRIDGE_OK'),result.text.slice(0,120));}finally{await probe.close();}
    }
    if(process.argv.includes('--live-asr')){
      const segments=await transcribe(join(model,'test_wavs','zh.wav'),model);check('中文口播实际转写',segments.some(s=>s.text.length>5),segments.map(s=>s.text).join('').slice(0,120));
    }
  }catch(e){check('DeepSeek Harness / 转写验证',false,e.message);}finally{await client.close();}
}else{
  const codex=new CodexClient({cwd:project});
  try{
    const threads=await codex.threads();check('Codex 已连接',true,`可读取 ${threads.length} 个本机聊天`);
    const account=await codex.request('account/read',{refreshToken:false});
    check('Codex 已登录',!!account.account,account.account?'使用本机 Codex 登录状态':'请执行 npm run codex:login');
    if(process.argv.includes('--live-codex')){
      const id=await codex.createCoordinator([],true);
      const result=await codex.run(id,[{type:'text',text:'This is a connectivity check. Reply with exactly BRIDGE_OK. Do not call tools or modify files.'}],{resume:false,timeoutMs:90000});
      check('Codex 实际回复',result.text.includes('BRIDGE_OK'),result.text.slice(0,120));
    }
    if(process.argv.includes('--live-asr')){
      const segments=await transcribe(join(model,'test_wavs','zh.wav'),model);check('中文口播实际转写',segments.some(s=>s.text.length>5),segments.map(s=>s.text).join('').slice(0,120));
    }
  }catch(e){check('Codex / 转写验证',false,e.message);}finally{codex.close();}
}
process.exitCode=missing?1:0;
