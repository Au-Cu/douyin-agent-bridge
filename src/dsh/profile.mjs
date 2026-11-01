import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveDshCommand} from './command.mjs';

export const auditedDshVersion='0.2.1-rc.5';
const core=new Set(['timer','llm','deepseek-llm-api-extensions','session','session-log-deepseek','session-title','agent','agent-loop','config-editor','settings','agent-default-model','llm-retry','authorization','deepseek-account','credentials','session-persistence-jsonl','attachment-local','working-directory','session-projection','storage','storage-json','storage-domain','session-projection-cache','subprocess','sandbox','sandbox-policy','approval','permission','fs-sandbox','tools','system-prompt','acp-app-startup','acp','token-meter','compaction-basic','timeout-policy','session-checkpoint-policy','tool-result-pruner','image-offload','llm-deepseek','llm-deepseek-account']);
const web=new Set(['web','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']);
const exec=promisify(execFile);

export function dshProfilePatch(ids,{mode='chat',home,credentialsPath,webSearch=false,instructions='',defaultSelection}={}){
  if(!['chat','agent'].includes(mode)||!['acp','agent','llm','tools'].every(id=>ids.includes(id)))throw new Error('DSH 默认配置无法通过隔离校验');
  const allow=new Set([...core,...(webSearch?web:[])]);
  const patch=ids.map(id=>({id,disabled:!allow.has(id)})),set=(id,config)=>{const row=patch.find(p=>p.id===id);if(!row)throw new Error('DSH 缺少已验证配置：'+id);row.config=config;};
  set('credentials',{path:credentialsPath,watch:false});
  set('session-persistence-jsonl',{root:join(home,'sessions')});
  set('sandbox-policy',{mode:'read-only',workspaceRoot:join(home,'empty-workspace')});
  set('approval',{policy:'never'});
  set('permission',{presets:{'read-only':{sandbox:'read-only',approval:'never'}},defaultPreset:'read-only'});
  set('system-prompt',{personaPrefix:instructions});
  set('agent-loop',{agents:[]});
  if(defaultSelection){const [provider,model]=defaultSelection;if(typeof provider!=='string'||typeof model!=='string')throw new Error('DSH 默认模型配置无效');set('agent-default-model',{provider,model});set('acp',{provider,model});}
  if(webSearch)set('tool-web',{search:true,fetch:true,searchTimeoutMs:60000});
  return patch;
}

// A fresh home excludes user plugins, skills, hooks and instruction discovery.
// Only the trusted credential service references the existing login file; no
// credentials are copied or put into model context or a new auth document.
export async function prepareDshProfile({root,mode='chat',executable='dsh',authHome=process.env.DSH_HOME||join(homedir(),'.dsh'),webSearch=false,instructions='',defaultSelection}={}){
  const folder=resolve(root,'dsh-profiles',mode),home=join(folder,'home');await mkdir(join(home,'empty-workspace'),{recursive:true});
  const command=resolveDshCommand(executable),env={...process.env,...command.env,DSH_HOME:home,DSH_PERMISSION_MODE:'read-only'};
  const run=args=>exec(command.executable,[...command.prefix,...args],{env,cwd:join(home,'empty-workspace'),windowsHide:true,timeout:30000,maxBuffer:2000000});
  const version=(await run(['--version'])).stdout.trim();if(!(version.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g)||[]).includes(auditedDshVersion))throw new Error('DSH 隔离运行仅支持已验证版本 '+auditedDshVersion+'；当前版本未启用普通聊天或视频读取');
  const dump=(await run(['--profile','acp','--dump-default-config'])).stdout,ids=[...dump.matchAll(/^- id:\s*([a-z0-9-]+)\s*$/gm)].map(m=>m[1]);if(new Set(ids).size!==ids.length)throw new Error('DSH 配置标识重复，未启动受限连接');
  const file=join(folder,'policy.json'),patch=dshProfilePatch(ids,{mode,home,credentialsPath:join(authHome,'.credentials.yaml'),webSearch,instructions,defaultSelection});await writeFile(file,JSON.stringify(patch),{mode:0o600});
  const composed=(await run(['--profile','acp','--patch',file,'--dump-config'])).stdout;
  const finalIds=[...composed.matchAll(/^- id:\s*([a-z0-9-]+)\s*$/gm)].map(m=>m[1]);if(finalIds.length!==ids.length||finalIds.some(id=>!ids.includes(id)))throw new Error('DSH 最终配置出现未知插件，未启动受限连接');
  // Only our fresh generated profile and final patch are allowed to compose.
  for(const row of patch.filter(p=>p.disabled)){const entry=composed.split(new RegExp('^- id: '+row.id+'\\r?\\n','m'))[1]?.split(/^-(?: id:| name:)/m)[0];if(!entry||!/^\s+disabled: true\s*$/m.test(entry))throw new Error('DSH 工具隔离配置未生效：'+row.id);}
  return {home,authHome,spawnArgs:['--profile','acp','--patch',file],cwd:join(home,'empty-workspace'),version:auditedDshVersion};
}
