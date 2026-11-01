#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const version = (() => {
  try { return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// Minimal MCP stdio server. The DeepSeek Harness ACP server starts one of
// these per session and calls it for the bridge's dynamic tools. Every call is
// forwarded to the bridge process over a loopback callback; this child never
// touches bridge state itself and keeps stdout free of anything but protocol
// frames.
const url = process.env.BRIDGE_MCP_URL || '';
const token = process.env.BRIDGE_MCP_TOKEN || '';
let tools = [];
try { tools = JSON.parse(process.env.BRIDGE_MCP_TOOLS || '[]'); } catch { tools = []; }

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

// A start marker makes an unexplained spawn failure visible without changing
// the protocol stream.
if (process.env.BRIDGE_MCP_MARKER) {
  try { appendFileSync(process.env.BRIDGE_MCP_MARKER, `start ${process.pid}\n`); } catch { /* diagnostics only */ }
}

const send = message => { process.stdout.write(JSON.stringify(message) + '\n'); };
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callBridge(name, args) {
  if (!url || !token) throw new Error('工具回调地址缺失');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify({ tool: name, arguments: args || {} }),
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = { error: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(value?.error || `工具回调失败 HTTP ${response.status}`);
  if (value?.success === false) throw new Error(value.error || '工具执行失败');
  return value;
}

// Preserve image blocks from verified visual tools, in their original order.
function toContent(value) {
  if (value == null) return [{ type: 'text', text: '' }];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (Array.isArray(value.contentItems)) {
    const content = value.contentItems
      .filter(item => item && (typeof item.text === 'string'||item.type==='image'&&typeof item.data==='string'&&/^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType)))
      .map(item => item.type==='image'?{type:'image',data:item.data,mimeType:item.mimeType}:{type:'text',text:item.text});
    return content.length ? content : [{ type: 'text', text: JSON.stringify(value) }];
  }
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  const { id, method, params } = message;
  if (id === undefined || method === undefined) return;
  if (process.env.BRIDGE_MCP_DEBUG) process.stderr.write('[mcp] ' + method + '\n');
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'douyin-codex-bridge', version }
      });
      return;
    }
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') { reply(id, { tools }); return; }
    if (method === 'tools/call') {
      const name = params?.name;
      const known = tools.some(tool => tool.name === name);
      if (!known) { fail(id, -32602, '未知工具：' + name); return; }
      try {
        const value = await callBridge(name, params?.arguments);
        reply(id, { content: toContent(value) });
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
      return;
    }
    fail(id, -32601, 'Unsupported method: ' + method);
  } catch (e) {
    if (id !== undefined) fail(id, -32603, String(e.message || e));
  }
});
lines.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
