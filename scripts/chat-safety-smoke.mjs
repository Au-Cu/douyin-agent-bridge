import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {CodexClient} from '../src/codex.mjs';import {ChatSandbox} from '../src/chat-sandbox.mjs';import {Preferences} from '../src/preferences.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),base=join(project,'data','acceptance');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'chat-safety-'));
const codex=new CodexClient({cwd:project}),sandbox=new ChatSandbox({root,codex,capabilities:()=>({publicTools:true,webSearch:true})});
const report={realDouyinVerified:false,realContactsMessaged:false,source:'local ChatGPT-authenticated Codex',started:new Date().toISOString()};
try{
  const model=await new Preferences({store:{config:{model:'',reasoningEffort:'',fastMode:false}},codex}).work();
  const sentinel=join(root,'private-sentinel.txt');await writeFile(sentinel,'UNCHANGED');
  const r=await sandbox.reply({message:{text:'这是隔离聊天验收，只回复 CHAT_ONLY_LIVE_OK。你没有任何工具。不要读取文件、调用工具或联系任何聊天。'}},model);
  assert.match(r.text,/CHAT_ONLY_LIVE_OK/);assert.equal(await readFile(sentinel,'utf8'),'UNCHANGED');
  const calc=await sandbox.reply({message:{text:'这是独立验收。请调用 public_calculate 计算 17*23，并调用 current_time 查询 UTC 当前时间。不要读取文件，不要使用网页或其他工具。回复中写明计算结果与 UTC 时间。'}},model);assert.match(calc.text,/391/);report.publicToolRoundTrip=true;
  let authSaved=false;try{await access(join(root,'chat-only','codex-home','auth.json'));authSaved=true;}catch{}assert.equal(authSaved,false,'external access token must not be persisted');
  report.passed=true;report.externalAuthNotPersisted=true;console.log('[OK] 独立聊天使用本机 Codex 登录，临时回合已回复；未写入 auth.json，未联系真实抖音聊天');
}catch(e){report.passed=false;report.error=e.authKind?'本机 Codex 登录或额度暂不可用':e.message;process.exitCode=1;console.error('[FAILED]',report.error);}
finally{sandbox.close();codex.close();await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('验收报告：'+join(root,'report.json'));}
