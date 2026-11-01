import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ProfiledDshClient} from './profile-client.mjs';
import {publicChatTools,publicChatTool} from '../chat-tools.mjs';
import {sandboxTool} from '../code-sandbox.mjs';

const instructions=await readFile(new URL('../../prompts/chat.md',import.meta.url),'utf8');
export class DshChatSandbox{
  constructor({root,dsh,log=()=>{},capabilities=()=>({}),codeSandbox,Client=ProfiledDshClient}){Object.assign(this,{root,dsh,log,capabilities,codeSandbox,Client});this.active=0;this.idle=[];}
  invalidate(){this.fingerprint='';}
  async catalog(){const client=await this.prepare();return client.models();}
  async prepare(){if(this.closed)throw new Error('普通聊天连接已关闭');if(this.preparing){await this.preparing;return this.prepare();}this.preparing=this._prepare().finally(()=>{this.preparing=null;});return this.preparing;}
  async _prepare(){
    const permissions=this.capabilities();if(permissions.codeSandbox&&!(await this.codeSandbox?.check())?.ready)throw new Error('代码沙箱尚未就绪');
    let revision;try{revision=createHash('sha256').update(await readFile(join(this.dsh.home,'.credentials.yaml'))).digest('hex');}catch(e){if(e.code!=='ENOENT')throw new Error('DSH 登录目录无法读取');revision='missing';}
    const fingerprint=JSON.stringify({permissions,revision});if(this.client?.ready&&this.client.authState.status==='ready'&&!this.client.authState.reconnectPending&&this.fingerprint===fingerprint)return this.client;
    if(this.active){await new Promise(resolve=>this.idle.push(resolve));return this._prepare();}
    await this.client?.close();if(this.closed)throw new Error('普通聊天连接已关闭');
    this.tools=[...(permissions.publicTools?publicChatTools:[]),...(permissions.codeSandbox?[sandboxTool]:[])];this.permissions=permissions;
    const allowed=this.tools.map(t=>'mcp__bridge__'+t.name).concat(permissions.webSearch?['web_search','web_fetch']:[]);
    const client=this.client=new this.Client({root:join(this.root,'chat-dsh'),home:this.dsh.home,executable:this.dsh.executable,mode:'chat',instructions,webSearch:permissions.webSearch===true,selectionProvider:()=>this.dsh.defaultSelection(),allowedChatTools:allowed,log:this.log});
    try{await client.connect();const catalog=await client.models();this.allowedModels=new Set(catalog.models.map(m=>m.model));this.fingerprint=fingerprint;return client;}catch(e){await client.close();throw e;}
  }
  async reply(input,{model,effort,serviceTier,onSubmitted,onStarted,signal}={}){
    const client=await this.prepare();if(!this.allowedModels.has(model))throw new Error('普通聊天模型不在受限 DSH 目录中');this.active++;let thread,turn;
    const abort=()=>{if(thread)client.interrupt(thread,{turnId:turn}).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{if(signal?.aborted)throw new Error('聊天已停用，未提交');thread=await client.createCoordinator(this.tools,true,{role:'chat',model});return await client.run(thread,[{type:'text',text:JSON.stringify(input)}],{model,effort,serviceTier,onSubmitted:()=>{if(signal?.aborted)throw Object.assign(new Error('聊天已停用'),{notSubmitted:true});onSubmitted?.({thread});},onStarted:id=>{turn=id;if(signal?.aborted)abort();onStarted?.({thread,turn:id});},toolHandler:call=>{if(signal?.aborted)throw new Error('聊天已停用');if(call.tool==='sandbox_python'&&this.permissions.codeSandbox){if(!call.arguments||Object.keys(call.arguments).some(k=>k!=='code'))throw new Error('代码沙箱参数无效');return this.codeSandbox.run(call.arguments.code,{signal});}return publicChatTool(call);},timeoutMs:120000,interruptOnTimeout:true});}
    finally{signal?.removeEventListener('abort',abort);this.active--;if(!this.active)for(const resolve of this.idle.splice(0))resolve();if(thread&&client.ready)await client.release(thread);}
  }
  async close(){this.closed=true;for(const resolve of this.idle.splice(0))resolve();await this.client?.close();}
}
