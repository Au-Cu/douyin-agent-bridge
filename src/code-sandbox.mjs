import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {readFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {durableJson} from './durable.mjs';
const exec=promisify(execFile),imageTag='python:3.13-slim';
export const sandboxTool={name:'sandbox_python',description:'在无网络、无宿主机挂载的临时 Linux 容器中运行 Python 代码，用于计算、推导和验证。只能访问容器自己的临时工作目录；没有用户文件、账户、电脑或 Docker 接口。每次运行后临时文件消失。',inputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}};
export function sandboxArgs(image,name){
  if(!/^sha256:[a-f0-9]{64}$/.test(image)||!/^bridge-sandbox-[a-f0-9-]{36}$/.test(name))throw new Error('沙箱运行标识无效');
  return ['run','--rm','--pull','never','--name',name,'--label','douyin-codex-bridge.sandbox='+name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--pids-limit','32','--memory','256m','--memory-swap','256m','--cpus','1','--ulimit','nofile=128:128','--tmpfs','/work:rw,noexec,nosuid,nodev,size=32m,uid=65534,gid=65534','--workdir','/work','--env','HOME=/work','--interactive',image,'python3','-I','-'];
}
export class CodeSandbox {
  constructor({root,executable='docker',backend='docker'}={}){Object.assign(this,{root,executable,backend});this.active=new Set();this.stops=new Map();this.finishing=new Map();this.status={ready:false,message:'尚未检查本机容器环境'};}
  invocation(args){return this.backend==='wsl'?{executable:'wsl.exe',args:['--distribution','codex-chat-sandbox','--user','root','--cd','/','--exec','docker',...args]}:{executable:this.executable,args};}
  command(args,options={}){const call=this.invocation(args);return exec(call.executable,call.args,{windowsHide:true,timeout:15000,maxBuffer:64000,...options});}
  async check(){
    try{let saved;try{saved=JSON.parse(await readFile(join(this.root,'code-sandbox.json'),'utf8'));if(saved.backend==='wsl'){if(process.platform!=='win32')throw new Error('此沙箱后端需要 Windows WSL');this.backend='wsl';}}catch(e){if(e.code!=='ENOENT')throw e;}const type=(await this.command(['info','--format','{{.OSType}}'])).stdout.trim();if(type!=='linux')throw new Error('需要 Linux 容器引擎');if(!/^sha256:[a-f0-9]{64}$/.test(saved?.image||''))throw new Error('尚未准备固定的 Python 镜像');const id=(await this.command(['image','inspect',saved.image,'--format','{{.Id}}'])).stdout.trim();if(id!==saved.image)throw new Error('Python 镜像未通过核验');this.image=id;this.status={ready:true,message:'Linux 容器已就绪：无宿主挂载、无网络、256MB、30秒'};}catch(e){this.image='';this.status={ready:false,message:e.code==='ENOENT'?'未安装 Docker；代码沙箱保持关闭':e.message.startsWith('需要')||e.message.startsWith('尚未')||e.message.startsWith('Python')?e.message:'容器引擎或固定镜像未就绪，请启动 Docker 并运行 npm run setup:sandbox'};}return this.status;
  }
  async setup({useCached=false}={}){
    const type=(await this.command(['info','--format','{{.OSType}}'])).stdout.trim();if(type!=='linux')throw new Error('请先启动 Linux 容器引擎');
    if(!useCached)await this.command(['pull',imageTag],{timeout:5*60*1000});const image=(await this.command(['image','inspect',imageTag,'--format','{{.Id}}'])).stdout.trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Python 镜像标识未通过核验');await mkdir(this.root,{recursive:true});durableJson(join(this.root,'code-sandbox.json'),{image,source:imageTag,backend:this.backend,prepared:Date.now()});return this.check();
  }
  async removeOwned(name){
    try{const label=(await this.command(['inspect',name,'--format','{{index .Config.Labels "douyin-codex-bridge.sandbox"}}'])).stdout.trim();if(label!==name)return false;await this.command(['rm','--force',name]);return true;}catch{return false;}
  }
  async run(code,{signal}={}){
    if(this.closed)throw new Error('代码沙箱已关闭');if(typeof code!=='string'||code.length>20000)throw new Error('Python 代码长度需在 20000 字符以内');if(this.active.size>=2)throw new Error('代码沙箱正在使用中，请稍后再试');
    if(!(await this.check()).ready)throw new Error(this.status.message);if(signal?.aborted||this.closed)throw new Error('聊天已停用，未启动代码沙箱');
    const name='bridge-sandbox-'+randomUUID(),folder=join(this.root,'sandbox-runs');await mkdir(folder,{recursive:true});const record={name,status:'starting',submitted:Date.now(),codeHash:createHash('sha256').update(code).digest('hex')},path=join(folder,name+'.json');durableJson(path,record);this.active.add(name);
    const finished=Promise.withResolvers();this.finishing.set(name,finished.promise);let stopped=false,child,stopReason='',timer,output='',errors='';const stop=reason=>{if(stopped)return;stopped=true;stopReason=reason;child?.kill();};this.stops.set(name,stop);const abort=()=>stop('用户已停用聊天');signal?.addEventListener('abort',abort,{once:true});
    try{const exit=await new Promise((resolve,reject)=>{const call=this.invocation(sandboxArgs(this.image,name));child=spawn(call.executable,call.args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let total=0;const take=(b,err)=>{total+=b.length;if(total>1024*1024)stop('输出超过限制');if(err)errors=(errors+b).slice(0,12000);else output=(output+b).slice(0,12000);};child.stdout.on('data',b=>take(b,false));child.stderr.on('data',b=>take(b,true));child.on('error',reject);child.on('exit',resolve);child.stdin.on('error',()=>{});child.stdin.end(code);timer=setTimeout(()=>stop('运行超过 30 秒'),30000);if(signal?.aborted)abort();});
      record.status=stopped?'stopped':'finished';record.exitCode=exit;return {exitCode:exit,stdout:output,stderr:errors,...(stopReason?{stopped:stopReason}:{})};
    }catch{record.status='uncertain';throw new Error('沙箱启动或结果未能核实，不会改在宿主机运行代码');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(stopped||record.status==='uncertain'){for(let i=0;i<4&&!record.cleaned;i++){if(i)await new Promise(r=>setTimeout(r,200*i));record.cleaned=await this.removeOwned(name);}}record.finished=Date.now();try{durableJson(path,record);}finally{this.active.delete(name);this.stops.delete(name);this.finishing.delete(name);finished.resolve();}}
  }
  async close(){this.closed=true;for(const stop of this.stops.values())stop('助手正在退出');await Promise.allSettled([...this.finishing.values()]);}
}
