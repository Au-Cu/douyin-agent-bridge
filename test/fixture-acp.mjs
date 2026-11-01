import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

// A local stand-in for the DeepSeek Harness ACP server. It speaks the same
// newline-delimited JSON-RPC, really starts the session's MCP servers and
// really calls their tools, so the adapter can be tested without a model or a
// network account.
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const sessions = new Map();
let sessionSeq = 0;
let requestSeq = 0;

const CONFIG_OPTIONS = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: '["fixture-provider","fixture-model"]',
    options: [{
      group: 'fixture-provider', name: 'Fixture', options: [
        { value: '["fixture-provider","fixture-model"]', name: 'fixture-model' },
        { value: '["fixture-provider","fixture-model-fast"]', name: 'fixture-model-fast' }
      ]
    }]
  },
  {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: 'high',
    options: [{ value: 'off', name: 'Off' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }]
  }
];

// One MCP server started the way the harness starts it.
class McpPeer {
  constructor(server) {
    this.seq = 0;
    this.pending = new Map();
    const env = {};
    for (const entry of server.env || []) env[entry.name] = entry.value;
    this.child = spawn(server.command, server.args || [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', raw => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'MCP 调用失败'));
      else pending.resolve(message.result);
    });
  }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async open() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-acp', version: '1' } });
    this.notify('notifications/initialized', {});
    this.tools = (await this.request('tools/list', {})).tools || [];
  }
  call(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.child.kill(); }
}

const toolResultText = result => (result?.content || []).map(item => item.text || '').join('\n');

async function handlePrompt(session, params) {
  const text = (params.prompt || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'agent_thought_chunk', messageId: 'fixture-message', content: { type: 'text', text: '准备处理本轮输入' } } } });
  let answer = '模拟正常回复';
  if (text.includes('JSON')) answer = '{"action":"continue"}';
  else if (text.includes('需要确认')) {
    const id = ++requestSeq;
    const outcome = await new Promise(resolve => {
      session.pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: session.sessionId, toolCall: { toolCallId: 'fixture-call' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });
    });
    answer = '确认结果：' + outcome;
  } else {
    const tool = session.tools.find(item => text.includes(item.name));
    if (tool) {
      const result = await session.peer.call(tool.name, {});
      answer = '工具 ' + tool.name + ' 返回：' + toolResultText(result);
    }
  }
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'fixture-message', content: { type: 'text', text: answer } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'usage_update', used: 4242, size: 1000000 } } });
  return { stopReason: 'end_turn' };
}

createInterface({ input: process.stdin }).on('line', raw => {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  const { id, method, params } = message;
  if (id !== undefined && method === undefined) {
    const pending = [...sessions.values()].find(session => session.pending.has(id));
    const resolve = pending?.pending.get(id);
    if (resolve) { pending.pending.delete(id); resolve(message.result?.outcome?.optionId || 'unknown'); }
    return;
  }
  if (id === undefined || method === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } });
  (async () => {
    try {
      if (method === 'initialize') return reply({ protocolVersion: 1, agentInfo: { name: 'fixture-acp', version: '1' }, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] });
      if (method === 'authenticate') return reply({});
      if (method === 'session/new') {
        const sessionId = 'fixture-session-' + (++sessionSeq);
        let peer = null;
        let tools = [];
        const servers = params?.mcpServers || [];
        for (const server of servers) {
          if (server.type) continue;
          peer = new McpPeer(server);
          await peer.open();
          tools = peer.tools;
        }
        const session = { sessionId, peer, tools, pending: new Map() };
        sessions.set(sessionId, session);
        return reply({ sessionId, configOptions: CONFIG_OPTIONS });
      }
      if (method === 'session/resume') {
        const sessionId = params?.sessionId;
        if (!sessions.has(sessionId)) return fail(-32602, 'unknown session: ' + sessionId);
        return reply({ sessionId, configOptions: CONFIG_OPTIONS });
      }
      if (method === 'session/list') return reply({ sessions: [...sessions.values()].map(session => ({ sessionId: session.sessionId, cwd: params?.cwd || '' })) });
      if (method === 'session/set_config_option') return reply({ configOptions: CONFIG_OPTIONS });
      if (method === 'session/cancel') return reply({});
      if (method === 'session/close') {
        const session = sessions.get(params?.sessionId);
        if (session) { session.peer?.close(); sessions.delete(params.sessionId); }
        return reply({});
      }
      if (method === 'session/prompt') {
        const session = sessions.get(params?.sessionId);
        if (!session) return fail(-32602, 'unknown session');
        return reply(await handlePrompt(session, params));
      }
      return fail(-32601, 'Unsupported method: ' + method);
    } catch (e) {
      return fail(-32603, String(e?.message || e));
    }
  })();
});
