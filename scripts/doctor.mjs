import { stat } from 'node:fs/promises';
import { spawn,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CodexClient } from '../src/codex.mjs';
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
process.exitCode=missing?1:0;
