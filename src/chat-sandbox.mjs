import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CodexClient} from './codex.mjs';
import {credentialRevision,defaultCodexHome} from './codex-auth.mjs';
import {publicChatTools,publicChatTool} from './chat-tools.mjs';
import {sandboxTool} from './code-sandbox.mjs';
const instructions=await readFile(new URL('../prompts/chat.md',import.meta.url),'utf8');

// Audited against @openai/codex 0.166.0 (core/tools/spec_plan.rs). The catalog
// override is essential: shell_tool=false alone does NOT remove apply_patch.
// Upgrade the pinned CLI only after the actual wire-tools test passes on both OSes.
export const disabledChatFeatures=['shell_tool','view_image','apps','connectors','plugins','remote_plugin','plugin_hooks','hooks','codex_hooks','multi_agent','multi_agent_v2','multi_agent_mode','collab','collaboration_modes','browser_use','browser_use_external','computer_use','in_app_browser','in_app_chat','in_app_local_automation','image_generation','js_repl','code_mode','code_mode_host','code_mode_only','code_mode_tool_search','tool_search','search_tool','skill_search','skill_mcp_dependency_install','memories','memory_tool','goals','request_permissions_tool','request_permissions','request_rule','tool_suggest','sleep_tool','token_budget','deferred_executor','standalone_web_search','send_message_to_user_async','send_async_message','unavailable_dummy_tools','shell_snapshot','responses_websockets','responses_websockets_v2'];
export function chatCatalog(models){
  if(!Array.isArray(models)||!models.length)throw new Error('尚未取得本机 Codex 模型目录，普通聊天保持关闭；请先刷新模型名单');
  return {models:models.map(m=>({...m,shell_type:'disabled',apply_patch_tool_type:null,experimental_supported_tools:[],supports_search_tool:false,tool_mode:'direct',use_responses_lite:false,node_repl_disabled:true,include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,model_messages:null,base_instructions:instructions}))};
}
export function chatConfig(config,catalogPath,{webSearch=false}={}){
  const overrides={model_catalog_json:catalogPath,model_provider:'openai',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',project_doc_max_bytes:0,project_doc_fallback_filenames:[],notify:[],instructions:'',developer_instructions:instructions,include_apps_instructions:false,include_collaboration_mode_instructions:false,include_environment_context:false,include_environment_context_time:false,'skills.include_instructions':false,'skills.bundled.enabled':false,'features.skip_host_skill_discovery':true,'features.omit_skill_descriptions':true,'tools.update_plan.enabled':false,'tools.experimental_request_user_input.enabled':false};
  for(const f of disabledChatFeatures)overrides['features.'+f]=false;
  overrides.web_search=webSearch?'live':'disabled';overrides['features.standalone_web_search']=webSearch;
  overrides.mcp_servers=Object.fromEntries(Object.keys(config?.mcp_servers||{}).map(name=>[name,{enabled:false,command:process.execPath,args:[]}]));
  overrides.apps={_default:{enabled:false}};
  // A managed/user hook must not see group content, even when no tool is called.
  for(const name of ['SessionStart','SessionEnd','UserPromptSubmit','PreModelRequest','PostModelRequest','PreToolUse','PostToolUse','Stop','PreCompact','PostCompact','SubagentStart','SubagentStop','PermissionRequest','Interrupt'])overrides['hooks.'+name]=[];
  return overrides;
}
const toml=value=>Array.isArray(value)?'['+value.map(toml).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}':JSON.stringify(value);
export const chatArgs=config=>['app-server',...Object.entries(config).flatMap(([key,value])=>{if(!/^[\w.-]+$/.test(key))throw new Error('本机配置含无法安全覆盖的名称，普通聊天保持关闭');return ['-c',key+'='+toml(value)];})];

export class ChatSandbox {
  constructor({root,codex,log=()=>{},Client=CodexClient,codexHome=defaultCodexHome(),capabilities=()=>({}),codeSandbox}){Object.assign(this,{root,codex,log,Client,codexHome,capabilities,codeSandbox});this.active=0;this.idle=[];}
  async prepare(){
    if(this.closed)throw new Error('普通聊天连接已关闭');
    if(this.preparing)return this.preparing;
    this.preparing=this._prepare().finally(()=>{this.preparing=null;});return this.preparing;
  }
  async _prepare(){
    const installed=JSON.parse(await readFile(new URL('../node_modules/@openai/codex/package.json',import.meta.url),'utf8'));if(installed.version!=='0.166.0')throw new Error('普通聊天仅支持已验证的 Codex CLI 0.166.0，请运行 npm ci 恢复固定版本');
    await this.codex.ensureAuthenticated();
    let models;try{models=JSON.parse(await readFile(join(this.codexHome,'models_cache.json'),'utf8')).models;}catch{throw new Error('本机 Codex 模型目录不可读取，普通聊天保持关闭；请刷新模型名单后重试');}
    const caps=this.capabilities(),permissions={webSearch:caps.webSearch===true,publicTools:caps.publicTools===true,codeSandbox:caps.codeSandbox===true};if(permissions.codeSandbox&&!(await this.codeSandbox?.check())?.ready)throw new Error('代码沙箱尚未就绪，未向模型开放代码执行');
    const tools=[...(permissions.publicTools?publicChatTools:[]),...(permissions.codeSandbox?[sandboxTool]:[])],catalog=chatCatalog(models),folder=join(this.root,'chat-only'),cwd=join(folder,'empty-workspace'),path=join(folder,'models.json'),config=chatConfig({},path,permissions),fingerprint=createHash('sha256').update(JSON.stringify({catalog,config,permissions,revision:await credentialRevision(this.codexHome)})).digest('hex');
    if(this.client&&!this.client.closed&&this.fingerprint===fingerprint)return this.client;
    if(this.active){await new Promise(resolve=>this.idle.push(resolve));if(this.closed)throw new Error('普通聊天连接已关闭');return this._prepare();}
    this.client?.close();await mkdir(cwd,{recursive:true});await writeFile(path,JSON.stringify(catalog),{mode:0o600});
    if(this.closed)throw new Error('普通聊天连接已关闭');
    // Separate CODEX_HOME prevents global AGENTS.md, skills, hooks, plugins,
    // project sessions and personal memory from reaching ordinary chats.
    // Only the current access token travels over local stdio, in memory. No
    // refresh token or auth file is copied, linked, logged or persisted here.
    const isolatedHome=join(folder,'codex-home');await mkdir(isolatedHome,{recursive:true});
    const access=async()=>{let a;try{a=JSON.parse(await readFile(join(this.codexHome,'auth.json'),'utf8'));}catch{throw new Error('无法读取本机 Codex 登录，请重新登录后重试');}const t=a.tokens;if(!t?.access_token||!t.account_id)throw new Error('此登录暂不支持隔离聊天，请使用本机 ChatGPT 登录；无需 API key');return {accessToken:t.access_token,chatgptAccountId:t.account_id};};
    if(this.closed)throw new Error('普通聊天连接已关闭');const client=this.starting=new this.Client({executable:'codex',cwd,codexHome:isolatedHome,spawnArgs:chatArgs(config),restricted:true,log:this.log,authTokensProvider:access,allowedChatTools:tools.map(t=>t.name),allowPublicWeb:permissions.webSearch});
    try{
      await client.connect();await client.request('account/login/start',{type:'chatgptAuthTokens',...await access()});const account=await client.request('account/read',{refreshToken:false});if(account.account?.type!=='chatgpt')throw new Error('隔离聊天未能核验本机 ChatGPT 登录');client.auth={status:'ready',message:'共享本机 Codex 登录，权限已隔离'};
      const effective=(await client.request('config/read',{includeLayers:false})).config||{};
      if(effective.features?.shell_tool!==false||effective.web_search!==config.web_search||Object.values(effective.mcp_servers||{}).some(s=>s.enabled!==false)||effective.features?.hooks!==false||effective.features?.plugins!==false||effective.model_catalog_json!==path)throw new Error('普通聊天权限配置未通过核验，已停止启用');
    }catch(e){client.close();throw e;}
    this.client=client;this.permissions=permissions;this.tools=tools;this.fingerprint=fingerprint;this.allowedModels=new Set(catalog.models.map(m=>m.slug));return client;
  }
  async reply(input,{model,effort,serviceTier,onSubmitted,onStarted,signal}={}){
    const client=await this.prepare();if(!model||!this.allowedModels.has(model))throw new Error('此模型不在已隔离的本机目录中，请刷新模型名单');
    this.active++;let thread,turnId,aborted=false;
    const abort=()=>{aborted=true;if(thread)client.interrupt(thread,{turnId}).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)throw new Error('聊天已停用，未提交');
      const out=await client.request('thread/start',{cwd:client.cwd,ephemeral:true,sandbox:'read-only',approvalPolicy:'never',dynamicTools:this.tools,baseInstructions:instructions,developerInstructions:instructions,model,...(serviceTier?{serviceTier:serviceTier==='default'?null:serviceTier}:{})});thread=out.thread.id;
      if(aborted||signal?.aborted)throw new Error('聊天已停用，未提交');
      const result=await client.run(thread,[{type:'text',text:JSON.stringify(input)}],{resume:false,model,effort,serviceTier,toolHandler:call=>{if(aborted||signal?.aborted)throw new Error('聊天已停用');if(call.tool==='sandbox_python'&&this.permissions.codeSandbox){const a=call.arguments;if(!a||Object.keys(a).some(k=>k!=='code'))throw new Error('代码沙箱参数无效');return this.codeSandbox.run(a.code,{signal});}return publicChatTool(call);},timeoutMs:120000,interruptOnTimeout:true,onSubmitted:()=>{if(aborted||signal?.aborted)throw Object.assign(new Error('聊天已停用，未提交'),{notSubmitted:true});onSubmitted?.({thread});},onStarted:id=>{turnId=id;if(aborted)abort();onStarted?.({thread,turn:id});}});
      if(aborted)throw new Error('聊天已停用，结果未发送');return result;
    }catch(e){if(/超时/.test(e.message))e.uncertain=true;throw e;
    }finally{signal?.removeEventListener('abort',abort);this.active--;if(!this.active)for(const resolve of this.idle.splice(0))resolve();if(thread&&client.ready)await client.request('thread/unsubscribe',{threadId:thread},5000).catch(()=>{});}
  }
  close(){this.closed=true;for(const resolve of this.idle.splice(0))resolve();this.starting?.close();this.client?.close();}
}
