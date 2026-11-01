import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolveDshCommand } from './command.mjs';
import { AcpConnection } from './acp.mjs';
import { assistantInstructions, roleInstructions } from '../prompts.mjs';
import { operationContext, checkWork, workSignal, raceWork, trackStop, interruptedError } from '../execution.mjs';

const mcpServerPath = fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url));
const bridgeVersion = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// Codex reasoning efforts are the bridge's own vocabulary. DeepSeek Harness
// exposes a smaller set, so both directions are mapped here and the model
// catalogue keeps the Codex names so the shared preferences layer is
// unchanged.
const effortToDsh = { none: 'off', minimal: 'off', off: 'off', low: 'low', medium: 'high', high: 'max', xhigh: 'max', max: 'max', ultra: 'max' };
const effortToBridge = { off: 'none', low: 'low', medium: 'medium', high: 'medium', max: 'high' };

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

// DeepSeek routes reject inline images, so reference frames travel as local
// file paths and the agent opens them with its own image tool.
function convertInput(input) {
  const blocks = [];
  const images = [];
  for (const item of input || []) {
    if (!item) continue;
    if (item.type === 'text') blocks.push({ type: 'text', text: String(item.text || '') });
    else if (item.type === 'localImage' || item.type === 'image') {
      const path = item.path || item.filePath || item.file_path;
      if (path) images.push(path);
    } else if (item.type === 'resource_link') {
      blocks.push({ type: 'text', text: `[resource_link name=${JSON.stringify(item.name || '')} uri=${JSON.stringify(item.uri || '')}]` });
    } else blocks.push({ type: 'text', text: JSON.stringify(item) });
  }
  if (images.length) {
    blocks.push({
      type: 'text',
      text: '本轮参考画面已保存在本机。请用本机的图片查看工具逐张打开下列文件后再判断，不能只根据文件名推断，也不能要求用户截图或重述：\n' + images.join('\n')
    });
  }
  return blocks;
}

export class DshClient extends EventEmitter {
  constructor({ cwd, executable = process.env.DSH_BIN || 'dsh', spawnArgs = ['--profile', 'acp'], log = () => {}, catalogSessionId = '', onCatalogSession = null } = {}) {
    super();
    Object.assign(this, { cwd, executable, spawnArgs, log, catalogSessionId, onCatalogSession });
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
  threadUrl(id) { return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(id || '')) ? 'dsh://session/' + encodeURIComponent(id) : null; }

  async connect() {
    if (this.closed) throw Object.assign(new Error('DeepSeek Harness 客户端已关闭'), { code: 'DSH_CLIENT_CLOSED' });
    if (this.connecting) return this.connecting;
    this.connecting = this.#ensureConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #ensureConnection() {
    if (this.ready && !this.needsReconnect) return;
    if (this.runs.size) throw Object.assign(new Error('登录状态已变更，等待当前任务结束后重新连接'), { code: 'CODEX_AUTH_PENDING' });
    const old = this.acp;
    this.acp = null;
    this.needsReconnect = false;
    old?.close();
    await this.#startToolServer();
    const acp = this.acp = new AcpConnection({
      command: resolveDshCommand(this.executable),
      args: this.spawnArgs,
      cwd: this.cwd,
      log: this.log,
      clientInfo: { name: 'douyin_codex_bridge', version: bridgeVersion }
    });
    acp.on('notification', message => this.#notification(message));
    acp.on('request', message => this.#serverRequest(message));
    acp.on('disconnected', error => {
      if (this.acp !== acp) return;
      this.acp = null;
      this.auth = { status: 'login', message: 'DeepSeek Harness 连接已断开' };
      this.emit('disconnected', error);
    });
    try {
      await acp.start();
      this.auth = { status: 'ready', message: '已连接本机 DeepSeek Harness' };
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
      const handler = record.handler;
      if (!handler) return json(200, { success: false, error: '当前会话没有可用的工具处理器' });
      const scope = record.scope;
      const call = () => handler({ tool: body.tool, arguments: body.arguments || {} });
      const result = scope ? await operationContext.run(scope, call) : await call();
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
      const record = { token, handler: null, scope: null, sessionId: null };
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
        record.configOptions = created.configOptions || [];
        this.#captureCatalog(record.configOptions);
        record.instructions = roleInstructions[role] || assistantInstructions;
        record.instructions = this.#withToolNames(record.instructions, tools);
        return record;
      } catch (e) {
        this.toolOwners.delete(token);
        throw e;
      }
    }
    const created = await this.acp.request('session/new', { cwd: this.cwd, mcpServers: [] }, 60000);
    const record = { token: null, handler: null, scope: null, sessionId: created.sessionId, configOptions: created.configOptions || [] };
    this.#captureCatalog(record.configOptions);
    record.instructions = roleInstructions[role] || assistantInstructions;
    return record;
  }

  // The harness publishes MCP tools under a server-qualified public name. The
  // shared prompts name the plain tool, so the mapping is stated explicitly.
  #withToolNames(instructions, tools) {
    if (!tools?.length) return instructions;
    const names = tools.map(tool => `mcp__bridge__${tool.name}`);
    return `${instructions}\n\n本轮可用的桥接工具必须用完整名称调用：${names.join('、')}。规则正文里的简称指的就是这些工具。`;
  }

  async #closeSession(record) {
    if (!record?.sessionId) return;
    this.toolOwners.delete(record.token);
    try { await this.acp?.request('session/close', { sessionId: record.sessionId }, 15000); } catch { /* the harness already dropped it */ }
  }

  async createCoordinator(tools, ephemeral = false, { visual = false, role = visual ? 'visual' : 'assistant', name = '抖音视频助手', model, serviceTier } = {}) {
    checkWork();
    await this.ensureAuthenticated();
    const record = await this.#createSession(tools, { role, model, serviceTier });
    record.threadId = record.sessionId;
    record.ephemeral = !!ephemeral;
    record.name = name;
    this.sessions.set(record.threadId, record);
    if (model) await this.#applyModel(record, model);
    return record.threadId;
  }

  async #applyModel(record, model) {
    const entry = (this.modelCatalog?.models || []).find(m => m.model === model || m.id === model);
    const value = entry?.id;
    if (!value) return;
    try {
      const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId: 'model', value }, 20000);
      record.configOptions = result?.configOptions || record.configOptions;
      this.#captureCatalog(record.configOptions);
    } catch (e) {
      this.log('模型切换未生效：' + e.message, 'attention');
    }
  }

  async #applyEffort(record, effort) {
    const target = effortToDsh[String(effort || '').toLowerCase()];
    if (!target) return;
    try {
      const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId: 'reasoning_effort', value: target }, 20000);
      record.configOptions = result?.configOptions || record.configOptions;
      this.#captureCatalog(record.configOptions);
    } catch (e) {
      this.log('推理强度未生效：' + e.message, 'attention');
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
        let provider = '', id = option.value;
        try { const parsed = JSON.parse(option.value); provider = parsed[0] || ''; } catch { /* keep the raw value */ }
        models.push({
          id,
          model: option.name,
          displayName: `${provider}/${option.name}`,
          provider,
          inputModalities: ['text', 'image'],
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
      defaults: { model: preferred?.model, effort: preferred?.defaultReasoningEffort },
      loaded: Date.now()
    };
  }

  async models() {
    await this.connect();
    if (this.modelCatalog && Date.now() - this.modelCatalog.loaded < 60000) return this.modelCatalog;
    // The catalogue is read from a real session because the protocol only
    // publishes the model list there. The same session is reused on later
    // starts so the harness history does not fill with empty sessions.
    if (this.catalogSessionId) {
      try {
        const resumed = await this.acp.request('session/resume', { sessionId: this.catalogSessionId, cwd: this.cwd, mcpServers: [] }, 30000);
        this.#captureCatalog(resumed?.configOptions || []);
        if (this.modelCatalog) return this.modelCatalog;
      } catch {
        this.catalogSessionId = '';
      }
    }
    const record = await this.#createSession([], {});
    this.catalogSession = record;
    this.catalogSessionId = record.sessionId;
    this.onCatalogSession?.(record.sessionId);
    if (!this.modelCatalog) throw new Error('本机 DeepSeek Harness 尚未提供可用模型名单');
    return this.modelCatalog;
  }

  async threads(searchTerm = '') {
    await this.connect();
    const listed = await this.acp.request('session/list', { cwd: this.cwd }, 20000);
    const term = String(searchTerm || '').toLowerCase();
    return (listed.sessions || [])
      .filter(session => !term || String(session.title || session.sessionId).toLowerCase().includes(term))
      .filter(session => session.sessionId !== this.catalogSessionId && session.sessionId !== this.catalogSession?.sessionId)
      .map(session => ({ id: session.sessionId, name: session.title || session.sessionId, cwd: session.cwd, status: undefined }));
  }

  // ── runs ───────────────────────────────────────────────────────────────────
  async runEphemeral(input, { tools = [], role = 'router', ...options } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let record = null;
      try {
        record = await this.#createSession(tools, { role, model: options.model, serviceTier: options.serviceTier });
        record.threadId = record.sessionId;
        record.ephemeral = true;
        return await this.#runTurn(record, input, { ...options, resume: false });
      } catch (e) {
        if (attempt) throw e;
        await this.#closeSession(record);
        const result = await this.reconnect();
        if (result.deferred) throw e;
      }
    }
    throw new Error('临时会话未能建立');
  }

  async runReadOnly(input, { tools = [], ...options } = {}) {
    return this.runEphemeral(input, { ...options, tools, role: 'visual' });
  }

  async run(threadId, input, options = {}) {
    checkWork();
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
    if (!record) {
      const resumed = await this.#resumeSession(threadId, options);
      if (!resumed) throw Object.assign(new Error('该 DeepSeek Harness 会话已不存在，请重新建立需求会话'), { code: 'DSH_SESSION_MISSING', notSubmitted: true });
      record = resumed;
      this.sessions.set(threadId, record);
    }
    return this.#runTurn(record, input, options);
  }

  async #resumeSession(threadId, options) {
    try {
      const resumed = await this.acp.request('session/resume', { sessionId: threadId, cwd: this.cwd, mcpServers: [] }, 30000);
      const record = {
        threadId,
        sessionId: threadId,
        token: null,
        handler: null,
        scope: null,
        ephemeral: false,
        configOptions: resumed?.configOptions || [],
        instructions: options?.assistant ? assistantInstructions : assistantInstructions
      };
      this.#captureCatalog(record.configOptions);
      return record;
    } catch (e) {
      this.log('原会话恢复失败：' + e.message, 'attention');
      return null;
    }
  }

  async #runTurn(record, input, { toolHandler, onStarted, onSubmitted, timeoutMs = 15 * 60 * 1000, effort, model, outputSchema, interruptOnTimeout = false, assistant = false } = {}) {
    checkWork();
    if (this.runs.has(record.threadId)) throw new Error('该 DeepSeek Harness 会话仍在工作，请稍后再试');
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
      turnId: 'dsh-turn-' + (++this.turnSeq),
      submitted: false,
      cancelled: false,
      terminal: null,
      resolve: completion.resolve,
      reject: completion.reject,
      completion
    };
    this.runs.set(record.threadId, run);
    record.handler = toolHandler || null;
    record.scope = scope;
    const signal = workSignal();
    const abort = () => {
      if (run.cancelled) return;
      run.cancelled = true;
      run.reject(interruptedError());
      this.interrupting.set(record.threadId, run);
      trackStop(this.interrupt(record.threadId, { run }).then(result => ({ ...result, kind: 'dsh' })), scope);
    };
    run.cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    const blocks = convertInput(input);
    if (record.instructions && !record.instructionsSent) {
      blocks.unshift({ type: 'text', text: record.instructions });
      record.instructionsSent = true;
    }
    if (outputSchema) blocks.push({ type: 'text', text: jsonInstruction(outputSchema) });
    try {
      checkWork();
      onSubmitted?.();
      checkWork();
      run.submitted = true;
      const prompt = this.acp.request('session/prompt', { sessionId: record.sessionId, prompt: blocks }, timeoutMs + 30000);
      onStarted?.(run.turnId);
      const stop = await prompt;
      run.terminal = stop;
      if (run.cancelled) throw interruptedError();
      if (stop?.stopReason && stop.stopReason !== 'end_turn' && stop.stopReason !== 'max_tokens') {
        throw new Error(`DeepSeek Harness 执行状态：${stop.stopReason}`);
      }
      const text = run.text;
      const result = { text: outputSchema ? extractJson(text) : text, turnId: run.turnId, tokenUsage: this.usage.get(record.threadId) };
      run.resolve(result);
      return result;
    } catch (e) {
      if (!e.remote && !e.notSubmitted && !run.cancelled) e.uncertain = true;
      run.reject(e);
      throw e;
    } finally {
      run.cleanup();
      this.runs.delete(record.threadId);
      record.handler = null;
    }
  }

  async interrupt(threadId, { turnId, run, verifyOwnership = false } = {}) {
    const r = run || this.runs.get(threadId);
    if (!r) return { confirmed: true };
    if (r.terminal) return { confirmed: true };
    try {
      await this.acp.request('session/cancel', { sessionId: r.record.sessionId }, 10000);
      const end = await Promise.race([r.completion.promise, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
      if (end) return { confirmed: true };
      return { confirmed: false, error: '中断请求已发出，尚未核验到回合结束' };
    } catch (e) {
      return { confirmed: false, error: e.message };
    } finally {
      this.interrupting.delete(threadId);
      if (r) { r.cleanup?.(); this.runs.delete(threadId); }
    }
  }

  approve(id, allow) {
    const pending = this.approvals.get(String(id));
    if (!pending) throw new Error('确认请求已过期');
    const optionId = allow ? 'allow-once' : 'reject-once';
    this.acp.respond(pending.id, { outcome: { outcome: 'selected', optionId } });
    this.approvals.delete(String(id));
  }

  // ── protocol events ────────────────────────────────────────────────────────
  #notification(message) {
    if (message.method === 'session/update') {
      const { sessionId, update } = message.params || {};
      const run = [...this.runs.values()].find(r => r.record.sessionId === sessionId);
      if (run) {
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
    if (method === 'thread/list') {
      // DeepSeek Harness keeps every session active, so an archived-only query
      // never reports a native archived session.
      if (params.archived === true) return { data: [] };
      const listed = await this.acp.request('session/list', { cwd: params.cwd || this.cwd }, 20000);
      return { data: (listed.sessions || []).map(session => ({ id: session.sessionId, name: session.title || session.sessionId, cwd: session.cwd })) };
    }
    if (method === 'thread/read') {
      const listed = await this.acp.request('session/list', { cwd: this.cwd }, 20000);
      const session = (listed.sessions || []).find(s => s.sessionId === params.threadId);
      if (!session) throw new Error('该 DeepSeek Harness 会话已不存在');
      return { thread: { id: session.sessionId, status: { type: this.runs.has(params.threadId) ? 'active' : 'idle' }, turns: [] } };
    }
    if (method === 'thread/unsubscribe') return {};
    if (method === 'thread/name/set') return {};
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      // DeepSeek Harness has no native archive surface. The bridge keeps its
      // own recoverable record and the session stays available for resume.
      this.log('DeepSeek Harness 会话没有原生归档，归档状态只保存在本机记录中', 'attention');
      return {};
    }
    if (method === 'account/read') return { requiresOpenaiAuth: false, account: { authMethod: 'dsh' } };
    throw new Error('DeepSeek Harness 不支持该调用：' + method);
  }

  async close() {
    this.closed = true;
    clearInterval(this.authTimer);
    for (const record of this.sessions.values()) await this.#closeSession(record);
    this.sessions.clear();
    this.toolOwners.clear();
    this.acp?.close();
    this.acp = null;
    if (this.toolServer) { this.toolServer.close(); this.toolServer = null; }
  }
}
