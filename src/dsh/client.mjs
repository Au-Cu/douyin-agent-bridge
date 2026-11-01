import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,extname} from 'node:path';
import {homedir} from 'node:os';
import { EventEmitter } from 'node:events';
import { resolveDshCommand } from './command.mjs';
import { AcpConnection } from './acp.mjs';
import { assistantInstructions, roleInstructions,instructionRevision } from '../prompts.mjs';
import { operationContext, checkWork, workSignal, raceWork, trackStop, interruptedError } from '../execution.mjs';
import {authFailure,authError} from '../codex-auth.mjs';
import {dshThread,nativeDshThread} from '../harness.mjs';
import {DshState} from './state.mjs';

const mcpServerPath = fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url));
const bridgeVersion = (() => {
  try { return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// Preserve the exact published effort levels. Only ACP's off is named none
// in the shared settings vocabulary; high must never silently become medium.
const effortToDsh = {none:'off',off:'off',low:'low',medium:'medium',high:'high',max:'max'};
const effortToBridge = {off:'none',low:'low',medium:'medium',high:'high',max:'max'};

const jsonInstruction = schema => `只输出一个 JSON 对象，不要包含解释、Markdown 或代码块。必须符合以下 JSON Schema：\n${JSON.stringify(schema)}`;
const stripFence = text => String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

// Codex returns structured output directly. ACP has no structured-output
// surface, so the schema travels with the prompt and the reply is parsed back.
export function extractJson(text) {
  const raw = stripFence(text).trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('未返回可解析的 JSON 结果');
  let depth = 0, end = -1, inString = false, escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('未返回完整可解析的 JSON 结果');
  return raw.slice(start, end);
}

// Capability admission is checked on the connection booted with the selected
// visual route. A filename alone is never evidence that the model saw an image.
async function convertInput(input,{inlineImages=false}={}) {
  const blocks = [];
  for (const item of input || []) {
    if (!item) continue;
    if (item.type === 'text') blocks.push({ type: 'text', text: String(item.text || '') });
    else if (item.type === 'localImage' || item.type === 'image') {
      const path = item.path || item.filePath || item.file_path;
      if(path){if(!inlineImages)throw Object.assign(new Error('当前 DSH 模型未确认支持图片输入，原片与连续画面已保留；请选择支持视觉的模型后续看'),{code:'DSH_VISUAL_UNAVAILABLE',notSubmitted:true});const bytes=await readFile(path),mimeType={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[extname(path).toLowerCase()];if(!mimeType||bytes.length>20*1024*1024)throw Object.assign(new Error('视觉图片格式或大小超出 DSH 支持范围'),{notSubmitted:true});blocks.push({type:'image',mimeType,data:bytes.toString('base64')});}
    } else if (item.type === 'resource_link') {
      blocks.push({ type: 'text', text: `[resource_link name=${JSON.stringify(item.name || '')} uri=${JSON.stringify(item.uri || '')}]` });
    } else blocks.push({ type: 'text', text: JSON.stringify(item) });
  }
  return blocks;
}

export class DshClient extends EventEmitter {
  constructor({ cwd, executable = process.env.DSH_BIN || 'dsh', spawnArgs = ['--profile', 'acp'], log = () => {}, catalogSessionId = '', onCatalogSession = null,root,home=process.env.DSH_HOME||join(homedir(),'.dsh'),spawnEnv={},restricted=false,instructionsByRole={},allowedChatTools=[] } = {}) {
    super();
    Object.assign(this, { cwd, executable, spawnArgs, log, catalogSessionId, onCatalogSession,home,spawnEnv,restricted,instructionsByRole });this.allowedChatTools=new Set(allowedChatTools);
    this.state=new DshState(root);this.catalogSessionId||=this.state.value.catalogSessionId||'';this.generation=0;this.capabilities={nativeArchive:false};
    this.acp = null;
    this.connecting = null;
    this.sessions = new Map();
    this.runs = new Map();
    this.approvals = new Map();
    this.threadLocks = new Map();
    this.interrupting = new Map();
    this.usage = new Map();
    this.auth = { status: 'unknown', message: '' };
    this.needsReconnect = false;
    this.toolServer = null;
    this.toolUrl = '';
    this.toolOwners = new Map();
    this.modelCatalog = null;
    this.catalogSession = null;
    this.turnSeq = 0;
    this.harnessName = 'dsh';
  }

  get ready() { return !!this.acp?.ready; }
  get authState() { return { ...this.auth, reconnectPending: !!this.needsReconnect }; }
  threadUrl(id) {const value=nativeDshThread(id);return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)?'dsh://session/'+encodeURIComponent(value):null;}

  async connect() {
    if (this.closed) throw Object.assign(new Error('DeepSeek Harness 客户端已关闭'), { code: 'DSH_CLIENT_CLOSED' });
    if (this.connecting) return this.connecting;
    this.connecting = this.#ensureConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #ensureConnection() {
    let revision;try{revision=createHash('sha256').update(await readFile(join(this.authHome||this.home,'.credentials.yaml'))).digest('hex');}catch(e){if(e.code!=='ENOENT')throw new Error('无法检查 DSH 登录目录');revision='missing';}
    const changed=this.loadedRevision!==undefined&&revision!==this.loadedRevision;
    if (this.ready && !this.needsReconnect&&!changed) return;
    if ([...this.runs.values()].some(r=>!r.disconnected)||this.acp?.pending.size) throw authError('pending');
    const old = this.acp;
    this.acp = null;
    this.needsReconnect = false;
    old?.close();
    this.loadedRevision=revision;this.toolOwners.clear();this.modelCatalog=null;this.catalogDefaults=null;
    await this.#startToolServer();
    const acp = this.acp = new AcpConnection({
      command: resolveDshCommand(this.executable),
      args: this.spawnArgs,
      cwd: this.cwd,
      env:{...this.spawnEnv,DSH_HOME:this.home},
      log: this.log,
      clientInfo: { name: 'douyin_codex_bridge', version: bridgeVersion }
    });
    acp.on('notification', message => this.#notification(message));
    acp.on('request', message => this.#serverRequest(message));
    acp.on('disconnected', error => {
      if (this.acp !== acp) return;
      for(const run of this.runs.values())if(run.record.generation===this.generation)run.disconnected=true;
      this.acp = null;
      this.auth = { status: 'login', message: 'DeepSeek Harness 连接已断开' };
      this.emit('disconnected', error);
    });
    try {
      await acp.start();
      this.generation++;
      this.auth = { status: 'ready', message: '已连接本机 DeepSeek Harness' };
      if(this.generation>1)this.emit('auth-reconnected');
    } catch (e) {
      acp.close();
      if (this.acp === acp) this.acp = null;
      throw e;
    }
  }

  async ensureAuthenticated() {
    await this.connect();
    if (this.auth.status !== 'ready') throw Object.assign(new Error('DeepSeek Harness 尚未就绪'), { code: 'CODEX_AUTH_REQUIRED' });
  }

  async reconnect() {
    this.needsReconnect = true;
    if (this.runs.size) return { deferred: true, auth: this.authState };
    await this.connect();
    return { deferred: false, auth: this.authState };
  }

  startAuthWatcher(intervalMs = 3000) {
    clearInterval(this.authTimer);
    this.authTimer = setInterval(() => this.connect().catch(e => {
      if (!['CODEX_AUTH_PENDING', 'DSH_CLIENT_CLOSED'].includes(e.code) && Date.now() - (this.lastAuthWarning || 0) > 60000) {
        this.lastAuthWarning = Date.now();
        this.log('本机 DeepSeek Harness 暂未连接，请在恢复后点“重新连接”', 'attention');
      }
    }), intervalMs);
    this.authTimer.unref();
  }

  // ── tool bridge ────────────────────────────────────────────────────────────
  // DeepSeek Harness reaches the bridge's dynamic tools through an MCP server.
  // That server runs as a child of the harness and calls back here.
  async #startToolServer() {
    if (this.toolServer) return;
    const server = http.createServer((req, res) => this.#toolCall(req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.unref();
    this.toolServer = server;
    this.toolUrl = `http://127.0.0.1:${server.address().port}/tool`;
  }

  async #toolCall(req, res) {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || req.url !== '/tool') return json(404, { success: false, error: '未知接口' });
    const record = this.toolOwners.get(String(req.headers['x-bridge-token'] || ''));
    if (!record) return json(404, { success: false, error: '未知工具会话' });
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4 * 1024 * 1024) throw new Error('工具参数过大');
      }
      const body = JSON.parse(raw || '{}');
      const active=record.threadId&&this.runs.get(record.threadId);
      if(!record.tools?.some(t=>t.name===body.tool)||!active||active.cancelled)throw new Error('工具不在当前运行会话的授权名单中');
      const handler = record.handler;
      if (!handler) return json(200, { success: false, error: '当前会话没有可用的工具处理器' });
      const scope = record.scope;
      const call = () => {checkWork();if(active.cancelled)throw interruptedError();return handler({ tool: body.tool, arguments: body.arguments || {} });};
      const result = scope ? await operationContext.run(scope, call) : await call();
      if(record.role==='visual'&&Array.isArray(result?.imagePaths)){
        checkWork();if(active.cancelled)throw interruptedError();
        const images=await convertInput(result.imagePaths.map(path=>({type:'localImage',path})),{inlineImages:this.acp.capabilities.promptCapabilities?.image===true});
        return json(200,{success:true,contentItems:[{type:'inputText',text:result.contentItems?.map(i=>String(i.text||'').split('\n图片已保存到本机。')[0]).join('\n')+'\n本工具附带实际画面，按顺序查看。'},...images]});
      }
      const value = result && typeof result === 'object' && Array.isArray(result.contentItems)
        ? result
        : { success: true, contentItems: [{ type: 'inputText', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      return json(200, value);
    } catch (e) {
      return json(200, { success: false, error: String(e.message || e) });
    }
  }

  // ── sessions ───────────────────────────────────────────────────────────────
  async #createSession(tools = [], { role, model, serviceTier } = {}) {
    await this.ensureAuthenticated();
    let mcpServers = [];
    if (tools.length) {
      const token = randomUUID();
      const record = { token, handler: null, scope: null, sessionId: null,tools,role:role||'assistant',generation:this.generation };
      this.toolOwners.set(token, record);
      mcpServers = [{
        name: 'bridge',
        command: process.execPath,
        args: [mcpServerPath],
        // ACP declares environment entries as an ordered name/value list. A
        // plain object is rejected and the whole server declaration is
        // dropped, which would silently leave the model without bridge tools.
        env: [
          { name: 'BRIDGE_MCP_URL', value: this.toolUrl },
          { name: 'BRIDGE_MCP_TOKEN', value: token },
          { name: 'BRIDGE_MCP_TOOLS', value: JSON.stringify(tools) }
        ]
      }];
      try {
        const created = await this.acp.request('session/new', { cwd: this.cwd, mcpServers }, 60000);
        record.sessionId = created.sessionId;
        record.threadId=dshThread(record.sessionId);
        record.configOptions = created.configOptions || [];
        this.#captureCatalog(record.configOptions);
        record.instructions = this.instructionsByRole[role]||roleInstructions[role] || assistantInstructions;
        record.instructions = this.#withToolNames(record.instructions, tools);
        return record;
      } catch (e) {
        this.toolOwners.delete(token);
        throw e;
      }
    }
    const created = await this.acp.request('session/new', { cwd: this.cwd, mcpServers: [] }, 60000);
    const record = { token: null, handler: null, scope: null, sessionId: created.sessionId,threadId:dshThread(created.sessionId), configOptions: created.configOptions || [],tools:[],role:role||'assistant',generation:this.generation };
    this.#captureCatalog(record.configOptions);
    record.instructions = this.instructionsByRole[role]||roleInstructions[role] || assistantInstructions;
    return record;
  }

  // The harness publishes MCP tools under a server-qualified public name. The
  // shared prompts name the plain tool, so the mapping is stated explicitly.
  #withToolNames(instructions, tools) {
    instructions=instructions.replace('工具返回的是图片路径，必须再用原生 view_image 查看，不能把拿到路径当作已看见图片。','工具结果附带实际图片内容，按顺序查看；不能把路径当作已经看过的图片。');
    if (!tools?.length) return instructions;
    const names = tools.map(tool => `mcp__bridge__${tool.name}`);
    return `${instructions}\n\n本轮可用的桥接工具必须用完整名称调用：${names.join('、')}。规则正文里的简称指的就是这些工具。`;
  }

  async #closeSession(record) {
    if (!record?.sessionId) return;
    this.toolOwners.delete(record.token);
    try { await this.acp?.request('session/close', { sessionId: record.sessionId }, 15000); } catch { /* the harness already dropped it */ }
  }
  async release(threadId){if(this.interrupting.has(threadId))return false;const record=this.sessions.get(threadId);if(record){await this.#closeSession(record);this.sessions.delete(threadId);}return true;}

  async createCoordinator(tools, ephemeral = false, { visual = false, role = visual ? 'visual' : 'assistant', name = '抖音视频助手', model, serviceTier } = {}) {
    checkWork();
    await this.ensureAuthenticated();
    const record = await this.#createSession(tools, { role, model, serviceTier });
    record.threadId = dshThread(record.sessionId);
    record.ephemeral = !!ephemeral;
    record.name = name;
    this.sessions.set(record.threadId, record);
    if(!ephemeral){this.state.profile(record.threadId,{tools:record.tools,role:record.role,name,instructionRevision,cwd:this.cwd});this.state.directory(record.threadId,{cwd:this.cwd,title:name});}
    if (model) await this.#applyModel(record, model);
    return record.threadId;
  }

  async #applyModel(record, model) {
    const matches=(this.modelCatalog?.models||[]).filter(m=>m.model===model||m.id===model||m.displayName===model);if(matches.length!==1)throw Object.assign(new Error('DSH 模型不存在或名称不唯一，请重新选择完整模型'),{notSubmitted:true});const entry=matches[0];
    const value = entry?.id;
    if (!value) throw Object.assign(new Error('DSH 没有提供该模型'),{notSubmitted:true});
    try {
      const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId: 'model', value }, 20000);
      record.configOptions = result?.configOptions || record.configOptions;
      this.#captureCatalog(record.configOptions);
    } catch (e) {
      throw Object.assign(new Error('DSH 模型切换未生效：'+e.message),{notSubmitted:true});
    }
  }

  async #applyEffort(record, effort) {
    const target = effortToDsh[String(effort || '').toLowerCase()];
    if (!target||!record.configOptions.find(o=>o.id==='reasoning_effort')?.options?.some(o=>o.value===target))throw Object.assign(new Error('DSH 未提供该推理强度，请使用模型公布的档位'),{notSubmitted:true});
    try {
      const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId: 'reasoning_effort', value: target }, 20000);
      record.configOptions = result?.configOptions || record.configOptions;
      this.#captureCatalog(record.configOptions);
    } catch (e) {
      throw Object.assign(new Error('DSH 推理强度切换未生效：'+e.message),{notSubmitted:true});
    }
  }

  #captureCatalog(configOptions) {
    const model = (configOptions || []).find(option => option.id === 'model');
    const reasoning = (configOptions || []).find(option => option.id === 'reasoning_effort');
    if (!model) return;
    const efforts = (reasoning?.options || []).map(option => ({
      reasoningEffort: effortToBridge[option.value] || option.value,
      name: option.name
    }));
    const models = [];
    for (const group of model.options || []) {
      for (const option of group.options || []) {
        let provider = '', id = option.value,rawModel=option.name;
        try { const parsed = JSON.parse(option.value); provider = parsed[0] || '';rawModel=parsed[1]||rawModel; } catch { /* keep the raw value */ }
        models.push({
          id,
          model: provider?provider+'/'+rawModel:rawModel,rawModel,
          displayName: `${provider}/${option.name}`,
          provider,
          // ACP does not publish per-model image modalities in its catalog.
          // The read-only worker checks native capability for the exact route.
          visualAdmission: 'checkedAtSubmission',
          supportedReasoningEfforts: efforts,
          defaultReasoningEffort: effortToBridge[reasoning?.currentValue] || efforts[0]?.reasoningEffort,
          serviceTiers: [{ id: 'default', name: '默认' }],
          isDefault: option.value === model.currentValue
        });
      }
    }
    const preferred = models.find(m => m.isDefault) || models[0];
    this.modelCatalog = {
      models,
      defaults: this.catalogDefaults||{ model: preferred?.model, effort: preferred?.defaultReasoningEffort },
      loaded: Date.now()
    };
  }

  async models() {
    await this.connect();
    if (this.modelCatalog && Date.now() - this.modelCatalog.loaded < 60000) return this.modelCatalog;
    if(this.loadingModels)return this.loadingModels;
    this.loadingModels=this.loadModels().finally(()=>{this.loadingModels=null;});return this.loadingModels;
  }
  async loadModels(){
    if(this.catalogSession){await this.#closeSession(this.catalogSession);this.catalogSession=null;}
    // The catalogue is read from a real session because the protocol only
    // publishes the model list there. The same session is reused on later
    // starts so the harness history does not fill with empty sessions.
    if (this.catalogSessionId) {
      try {
        const resumed = await this.acp.request('session/resume', { sessionId: this.catalogSessionId, cwd: this.cwd, mcpServers: [] }, 30000);
        this.#captureCatalog(resumed?.configOptions || []);
        this.catalogDefaults={...this.modelCatalog?.defaults};
        this.catalogSession={sessionId:this.catalogSessionId,configOptions:resumed?.configOptions||[]};
        if (this.modelCatalog) return this.modelCatalog;
      } catch {
        this.catalogSessionId = '';
      }
    }
    const record = await this.#createSession([], {});
    this.catalogSession = record;
    this.catalogDefaults={...this.modelCatalog?.defaults};
    this.catalogSessionId = record.sessionId;
    this.state.value.catalogSessionId=record.sessionId;this.state.save();
    this.onCatalogSession?.(record.sessionId);
    if (!this.modelCatalog) throw new Error('本机 DeepSeek Harness 尚未提供可用模型名单');
    return this.modelCatalog;
  }

  async threads(searchTerm = '') {
    await this.connect();
    const sessions = await this.listSessions();
    const term = String(searchTerm || '').toLowerCase();
    return sessions
      .filter(session => !term || String(session.title || session.sessionId).toLowerCase().includes(term))
      .filter(session => session.sessionId !== this.catalogSessionId && session.sessionId !== this.catalogSession?.sessionId)
      .map(session => ({ id: dshThread(session.sessionId), name: session.title || (session.cwd+' · '+session.sessionId.slice(0,8)), cwd: session.cwd, status: undefined }));
  }
  async listSessions(){
    const all=[],seen=new Set();let cursor;
    for(let page=0;page<100;page++){const result=await this.acp.request('session/list',cursor?{cursor}:{},20000);for(const session of result.sessions||[]){const id=dshThread(session.sessionId);this.state.directory(id,{cwd:session.cwd,title:session.title||''});all.push(session);}if(!result.nextCursor)return all;if(seen.has(result.nextCursor))throw new Error('DSH 会话目录游标重复，未把不完整目录当作全部记录');seen.add(result.nextCursor);cursor=result.nextCursor;}
    throw new Error('DSH 会话目录尚未读取完整，请缩小原生会话目录后再试');
  }

  // ── runs ───────────────────────────────────────────────────────────────────
  async runEphemeral(input, { tools = [], role = 'router', ...options } = {}) {
    if(this.ephemeralClientForModel)return this.ephemeralClientForModel(options.model).runEphemeral(input,{tools,role,...options});
    if(this.ephemeralClient)return this.ephemeralClient.runEphemeral(input,{tools,role,...options});
    for (let attempt = 0; attempt < 2; attempt++) {
      let record = null;
      try {
        record = await this.#createSession(tools, { role, model: options.model, serviceTier: options.serviceTier });
        record.threadId = dshThread(record.sessionId);
        record.ephemeral = true;
        return await this.#runTurn(record, input, { ...options, resume: false });
      } catch (e) {
        if (attempt||record?.submitted||e.uncertain||!authFailure(e)) throw e;
        const result = await this.reconnect();
        if (result.deferred) throw e;
      }finally{if(record)await this.#closeSession(record);}
    }
    throw new Error('临时会话未能建立');
  }

  async runReadOnly(input, { tools = [], ...options } = {}) {
    return this.runEphemeral(input, { ...options, tools, role: 'visual' });
  }

  async run(threadId, input, options = {}) {
    checkWork();
    if(this.state.turns(threadId).some(t=>t.status==='inProgress')&&!this.runs.has(threadId))throw Object.assign(new Error('该 DSH 聊天上次提交结果尚未核实，不会启动另一轮或自动重跑'),{code:'DSH_RESULT_UNKNOWN',uncertain:true,notSubmitted:true,threadId});
    if (this.threadLocks.has(threadId) || this.interrupting.has(threadId)) {
      throw Object.assign(new Error('目标聊天已有任务运行或中断结果仍需核实，正在等待同一聊天的写入权'), { code: 'THREAD_BUSY', notSubmitted: true, threadId });
    }
    const token = Symbol(threadId);
    this.threadLocks.set(threadId, token);
    try {
      return await raceWork(this.#runTurnById(threadId, input, options));
    } catch (e) {
      e.threadId ||= threadId;
      throw e;
    } finally {
      if (this.threadLocks.get(threadId) === token) this.threadLocks.delete(threadId);
    }
  }

  async #runTurnById(threadId, input, options) {
    await this.ensureAuthenticated();
    checkWork();
    let record = this.sessions.get(threadId);
    if (!record||record.generation!==this.generation) {
      const resumed = await this.#resumeSession(threadId, options);
      if (!resumed) throw Object.assign(new Error('该 DeepSeek Harness 会话已不存在，请重新建立需求会话'), { code: 'DSH_SESSION_MISSING', notSubmitted: true });
      record = resumed;
      this.sessions.set(threadId, record);
    }
    return this.#runTurn(record, input, options);
  }

  async #resumeSession(threadId, options) {
      const profile=this.state.profile(threadId)||{},tools=profile.tools||[];
      let cwd=profile.cwd||this.state.directory(threadId)?.cwd;if(!cwd){await this.listSessions();cwd=this.state.directory(threadId)?.cwd;}if(!cwd)throw Object.assign(new Error('DSH 未提供该会话的工作目录，可能仍被桌面占用；请先在 DSH 中结束该聊天的运行，不会另建副本或清理写入锁'),{code:'THREAD_BUSY',notSubmitted:true});
      const token=tools.length?randomUUID():null,record={threadId,sessionId:nativeDshThread(threadId),token,tools,role:profile.role||(options?.assistant?'assistant':'target'),handler:null,scope:null,ephemeral:false,generation:this.generation};
      const mcpServers=token?[{name:'bridge',command:process.execPath,args:[mcpServerPath],env:[{name:'BRIDGE_MCP_URL',value:this.toolUrl},{name:'BRIDGE_MCP_TOKEN',value:token},{name:'BRIDGE_MCP_TOOLS',value:JSON.stringify(tools)}]}]:[];if(token)this.toolOwners.set(token,record);
    try {
      const resumed = await this.acp.request('session/resume', { sessionId: record.sessionId, cwd, mcpServers }, 30000);
      record.configOptions=resumed?.configOptions||[];record.instructions=record.role==='target'?'':this.#withToolNames(this.instructionsByRole[record.role]||roleInstructions[record.role]||assistantInstructions,tools);
      this.#captureCatalog(record.configOptions);
      return record;
    } catch (e) {
      if(token)this.toolOwners.delete(token);if(e.remote&&/unknown session|not found|does not exist|already.*(?:active|loaded)|already has an active writer|busy/i.test(e.message))e.notSubmitted=true;throw e;
    }
  }

  async #runTurn(record, input, { toolHandler, onStarted, onSubmitted, timeoutMs = 15 * 60 * 1000, effort, model, outputSchema, interruptOnTimeout = false,serviceTier } = {}) {
    checkWork();
    if (this.runs.has(record.threadId)||this.interrupting.has(record.threadId)) throw Object.assign(new Error('该 DeepSeek Harness 会话仍在工作，请稍后再试'),{code:'THREAD_BUSY',notSubmitted:true});
    if(serviceTier&&serviceTier!=='default')throw Object.assign(new Error('DSH 未提供快速模式'),{notSubmitted:true});
    if (model) await this.#applyModel(record, model);
    if (effort) await this.#applyEffort(record, effort);
    const scope = operationContext.getStore();
    const completion = Promise.withResolvers();
    completion.promise.catch(() => {});
    const run = {
      threadId: record.threadId,
      record,
      handler: toolHandler || null,
      scope,
      text: '',
      messageId: null,
      turnId: 'dsh-turn-' + randomUUID(),
      submitted: false,
      cancelled: false,
      terminal: null,
      resolve: completion.resolve,
      reject: completion.reject,
      completion,terminalReady:Promise.withResolvers(),onStarted
    };
    this.runs.set(record.threadId, run);
    record.handler = toolHandler || null;
    record.scope = scope;
    if(scope){scope.nativeRuns||=new Set();scope.nativeRuns.add(run);}
    const signal = workSignal();
    const abort = () => {
      if (run.cancelled) return;
      trackStop(this.interrupt(record.threadId, { run,turnId:run.turnId }).then(result => ({ ...result, kind: 'codex' })), scope);
    };
    run.cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    let blocks;try{blocks=await convertInput(input,{inlineImages:this.acp.capabilities.promptCapabilities?.image===true});}catch(e){this.runs.delete(record.threadId);record.handler=null;run.cleanup();e.notSubmitted=true;throw e;}
    if (record.instructions && !record.instructionsSent) {
      blocks.unshift({ type: 'text', text: record.instructions });
    }
    if (outputSchema) blocks.push({ type: 'text', text: jsonInstruction(outputSchema) });
    let timer;
    try {
      checkWork();
      this.state.turn(run.turnId,{threadId:record.threadId,status:'inProgress',at:Date.now()});
      onSubmitted?.();
      checkWork();
      run.submitted = true;record.submitted=true;
      // Keep the original prompt pending after a local deadline, so a late
      // quiescent result can still prove stopping. session/cancel has no reply.
      const prompt = this.acp.request('session/prompt', { sessionId: record.sessionId, prompt: blocks },0).then(stop=>{
        const status=stop?.stopReason==='cancelled'?'interrupted':stop?.stopReason==='end_turn'?'completed':'failed';run.terminal={id:run.turnId,status};this.state.turn(run.turnId,{status,text:run.text,stopReason:stop?.stopReason,at:Date.now()});run.terminalReady.resolve(run.terminal);if(this.interrupting.get(record.threadId)===run)this.interrupting.delete(record.threadId);if(run.cancelled||run.localEnded)this.runs.delete(record.threadId);return stop;
      },error=>{if(error.remote){run.terminal={id:run.turnId,status:'failed'};this.state.turn(run.turnId,{status:'failed',notSubmitted:!!error.notSubmitted,text:run.text,at:Date.now()});run.terminalReady.resolve(run.terminal);if(this.interrupting.get(record.threadId)===run)this.interrupting.delete(record.threadId);if(run.localEnded)this.runs.delete(record.threadId);}else run.terminalReady.resolve(null);throw error;});prompt.catch(()=>{});record.instructionsSent=true;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('DSH 本轮等待超时'),{code:'DSH_PROMPT_TIMEOUT',uncertain:true})),timeoutMs);});
      const stop=await Promise.race([prompt,completion.promise,deadline]);
      if (run.cancelled) throw interruptedError();
      if (stop?.stopReason !== 'end_turn') {
        throw new Error(`DeepSeek Harness 执行状态：${stop.stopReason}`);
      }
      const text = run.text;
      const result = { text: outputSchema ? extractJson(text) : text, turnId: run.turnId, tokenUsage: this.usage.get(record.threadId) };
      run.resolve(result);
      return result;
    } catch (e) {
      const kind=authFailure(e);if(kind){e.authKind=kind;this.auth={status:kind,message:'DSH 登录或额度需要核验'};this.needsReconnect=true;}
      if(!run.submitted||e.notSubmitted){e.notSubmitted=true;run.terminal={id:run.turnId,status:'failed'};this.state.turn(run.turnId,{status:'failed',notSubmitted:true,at:Date.now()});run.terminalReady.resolve(run.terminal);}
      if(e.code==='DSH_PROMPT_TIMEOUT'&&interruptOnTimeout){const result=await this.interrupt(record.threadId,{run,turnId:run.turnId});e.uncertain=!result.confirmed;}
      if(run.submitted&&!run.terminal&&!e.notSubmitted)e.uncertain=true;
      run.reject(e);
      throw e;
    } finally {
      clearTimeout(timer);
      run.cleanup();
      run.localEnded=true;
      for(const [id,approval]of this.approvals)if(approval.params?.sessionId===record.sessionId)this.approvals.delete(id);
      if(run.terminal||!run.submitted)this.runs.delete(record.threadId);else this.interrupting.set(record.threadId,run);
      record.handler = null;
    }
  }

  async interrupt(threadId, { turnId, run, verifyOwnership = false } = {}) {
    const r = run || this.runs.get(threadId);
    if (!r){const saved=turnId&&this.state.turn(turnId);return saved?.threadId===threadId&&['completed','failed','interrupted'].includes(saved.status)?{confirmed:true}:{confirmed:false,error:'没有可核验的本连接回合，不会取消未知任务'};}
    if(r.threadId!==threadId||turnId&&r.turnId!==turnId)return {confirmed:false,error:'回合不属于该任务，未发送中断'};
    if (r.terminal) return { confirmed: true };
    if(!r.submitted){r.cancelled=true;r.reject(interruptedError());return {confirmed:true};}
    try {
      if(!r.cancelled){r.cancelled=true;for(const [id,approval]of this.approvals)if(approval.params?.sessionId===r.record.sessionId)this.approvals.delete(id);r.reject(interruptedError());this.interrupting.set(threadId,r);this.acp.notify('session/cancel',{sessionId:r.record.sessionId});}
      let timer;const end=await Promise.race([r.terminalReady.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]).finally(()=>clearTimeout(timer));
      if (end) return { confirmed: true };
      return { confirmed: false, error: '中断请求已发出，尚未核验到回合结束' };
    } catch (e) {
      return { confirmed: false, error: e.message };
    }
  }

  approve(id, allow) {
    const pending = this.approvals.get(String(id));
    if (!pending) throw new Error('确认请求已过期');
    const option=pending.params?.options?.find(o=>o.kind===(allow?'allow_once':'reject_once'));if(!option)throw new Error('DSH 未提供本轮范围的确认选项');const optionId=option.optionId;
    this.acp.respond(pending.id, { outcome: { outcome: 'selected', optionId } });
    this.approvals.delete(String(id));
  }

  // ── protocol events ────────────────────────────────────────────────────────
  #notification(message) {
    if (message.method === 'session/update') {
      const { sessionId, update } = message.params || {};
      const run = [...this.runs.values()].find(r => r.record.sessionId === sessionId);
      if (run) {
        if(this.restricted&&update?.sessionUpdate==='tool_call'&&!this.allowedChatTools.has(update.title)){run.cancelled=true;run.reject(Object.assign(new Error('普通聊天出现未获授权的 DSH 工具，连接已停止'),{code:'DSH_TOOL_ISOLATION'}));this.acp.close();return;}
        if(!run.started&&['agent_message_chunk','agent_thought_chunk','tool_call','usage_update'].includes(update?.sessionUpdate)){run.started=true;run.onStarted?.(run.turnId);}
        if (update?.sessionUpdate === 'agent_message_chunk') {
          if (update.messageId && run.messageId && update.messageId !== run.messageId) run.text = '';
          run.messageId = update.messageId || run.messageId;
          run.text += update.content?.text || '';
        }
        if (update?.sessionUpdate === 'usage_update') {
          this.usage.set(run.threadId, { totalTokens: update.used, modelContextWindow: update.size });
          // The shared bridge code reads Codex's token-usage notification shape.
          this.emit('notification', {
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: run.threadId,
              tokenUsage: { last: { totalTokens: update.used }, modelContextWindow: update.size }
            }
          });
        }
      }
    }
    this.emit('notification', message);
  }

  #serverRequest(message) {
    if (message.method === 'session/request_permission') {
      const owning=[...this.runs.values()].find(r=>r.record.sessionId===message.params?.sessionId);if(this.restricted||!owning||owning.cancelled){const choice=message.params?.options?.find(o=>o.kind==='reject_once');this.acp.respond(message.id,choice?{outcome:{outcome:'selected',optionId:choice.optionId}}:{outcome:{outcome:'cancelled'}});return;}
      const id = String(message.id);
      this.approvals.set(id, message);
      const run = [...this.runs.values()].find(r => r.record.sessionId === message.params?.sessionId);
      this.emit('approval', {
        id,
        method: message.method,
        params: { ...(message.params || {}), threadId: run?.threadId }
      });
      return;
    }
    this.acp.respondError(message.id, -32601, 'Unsupported client request');
  }

  // Codex-specific calls that the shared bridge code still issues. They keep
  // the same shape so the rest of the project does not branch per harness.
  async request(method, params = {}) {
    await this.connect();
    if (method === 'thread/list') {
      // DeepSeek Harness keeps every session active, so an archived-only query
      // never reports a native archived session.
      if (params.archived === true) return { data: [] };
      const listed = await this.listSessions();
      return { data: listed.map(session => ({ id: dshThread(session.sessionId), name: session.title || session.sessionId, cwd: session.cwd })) };
    }
    if (method === 'thread/read') {
      if(!this.sessions.has(params.threadId)&&!this.state.profile(params.threadId)&&!this.state.directory(params.threadId)){await this.listSessions();if(!this.state.directory(params.threadId))throw new Error('DSH 未提供该聊天的可核验记录，可能仍被桌面占用');}
      const turns=this.state.turns(params.threadId);return { thread: { id: params.threadId, status: { type: this.runs.has(params.threadId)?'active':turns.some(t=>t.status==='inProgress')?'unknown':'notLoaded' }, turns } };
    }
    if (method === 'thread/unsubscribe') return {};
    if (method === 'thread/name/set') return {};
    if (method === 'thread/archive' || method === 'thread/unarchive') throw Object.assign(new Error('DSH ACP 没有原生归档接口，请使用面板的可恢复本地归档'),{notSubmitted:true});
    if (method === 'account/read') return { requiresOpenaiAuth: false, account: { authMethod: 'dsh' } };
    throw new Error('DeepSeek Harness 不支持该调用：' + method);
  }

  async close() {
    if(this.closed)return;
    this.closed = true;
    clearInterval(this.authTimer);
    if(this.catalogSession)await this.#closeSession(this.catalogSession);
    for (const record of this.sessions.values()) await this.#closeSession(record);
    this.sessions.clear();
    this.toolOwners.clear();
    this.acp?.close();
    this.acp = null;
    await this.ephemeralClient?.close();
    await Promise.allSettled([...(this.ephemeralClients?.values()||[])].map(c=>c.close()));
    if (this.toolServer) { this.toolServer.close(); this.toolServer = null; }
  }
}
