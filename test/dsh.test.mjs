import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshClient, extractJson } from '../src/dsh/client.mjs';
import { resolveDshCommand } from '../src/dsh/command.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = fileURLToPath(new URL('../data/test-runs/', import.meta.url));
mkdirSync(base, { recursive: true });
const fixture = fileURLToPath(new URL('./fixture-acp.mjs', import.meta.url));
const client = () => new DshClient({ cwd: base, executable: fixture, spawnArgs: [] });

test('DeepSeek Harness 适配层连接后拿到模型名单、推理强度和默认模型', async () => {
  const c = client();
  try {
    await c.connect();
    assert.equal(c.ready, true);
    assert.equal(c.authState.status, 'ready');
    const catalog = await c.models();
    assert.deepEqual(catalog.models.map(m => m.model), ['fixture-model', 'fixture-model-fast']);
    assert.equal(catalog.defaults.model, 'fixture-model');
    // DeepSeek 的推理强度比 Codex 少，适配层保留 Codex 名称供既有设置使用。
    assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ['none', 'low', 'medium', 'high']);
    assert.equal(catalog.models[0].defaultReasoningEffort, 'medium');
    assert.match(c.threadUrl('579205ba-850a-40b7-a327-603251776955'), /^dsh:\/\/session\//);
    assert.equal(c.threadUrl('not-a-session'), null);
  } finally { await c.close(); }
});

test('会话的桥接工具经 MCP 真正被调用，工具结果回到本轮答复', async () => {
  const c = client();
  try {
    await c.connect();
    const tools = [{ name: 'need_context', description: '取得当前需求记录。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
    const thread = await c.createCoordinator(tools, false, { name: '抖音 · 测试' });
    const calls = [];
    const result = await c.run(thread, [{ type: 'text', text: '请调用 need_context' }], {
      toolHandler: async call => { calls.push(call); return { needId: 'need-1', title: '测试需求' }; }
    });
    assert.deepEqual(calls, [{ tool: 'need_context', arguments: {} }]);
    assert.match(result.text, /工具 need_context 返回/);
    assert.match(result.text, /need-1/);
    assert.equal(result.tokenUsage.totalTokens, 4242);
    assert.equal(c.runs.size, 0);
  } finally { await c.close(); }
});

test('临时会话按结构化要求返回 JSON，并可解析出结果', async () => {
  const c = client();
  try {
    await c.connect();
    const result = await c.runEphemeral([{ type: 'text', text: '只输出 JSON' }], {
      role: 'router',
      outputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }
    });
    assert.equal(extractJson(result.text), '{"action":"continue"}');
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJson('前缀 {"action":"continue"} 后缀'), '{"action":"continue"}');
    assert.throws(() => extractJson('没有 JSON'), /JSON/);
  } finally { await c.close(); }
});

test('待确认操作由宿主决定，允许与拒绝都只授予本轮范围', async () => {
  const c = client();
  try {
    await c.connect();
    const thread = await c.createCoordinator([], false, {});
    const pending = [];
    c.on('approval', request => pending.push(request));
    const run = c.run(thread, [{ type: 'text', text: '这一步需要确认' }]);
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].params.threadId, thread);
    c.approve(pending[0].id, true);
    const result = await run;
    assert.match(result.text, /确认结果：allow-once/);
  } finally { await c.close(); }
});

test('图片以本机路径交给助手打开，不依赖模型直接接收图片', async () => {
  const c = client();
  try {
    await c.connect();
    const thread = await c.createCoordinator([], false, {});
    const result = await c.run(thread, [{ type: 'text', text: '看图' }, { type: 'localImage', path: '/tmp/frame-01.jpg' }], {});
    assert.equal(result.text, '模拟正常回复');
  } finally { await c.close(); }
});

test('启动器解析不到可执行文件时给出明确提示，不静默换用别的程序', () => {
  assert.throws(() => resolveDshCommand('/definitely/missing/dsh'), /不存在/);
  const resolved = resolveDshCommand(fileURLToPath(new URL('./fixture-acp.mjs', import.meta.url)));
  assert.equal(resolved.executable, process.execPath);
  assert.equal(resolved.prefix.length, 1);
});
