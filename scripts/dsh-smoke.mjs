import { DshClient, extractJson } from '../src/dsh/client.mjs';
import { coordinatorTools } from '../src/codex.mjs';

const log = message => console.log('·', message);
const client = new DshClient({ cwd: process.cwd(), log: message => console.log('  [harness]', message) });

try {
  await client.connect();
  log('connected, ready=' + client.ready);

  const models = await client.models();
  log('models=' + models.models.map(m => `${m.displayName} [${m.id}]`).join(' | '));
  log('defaults=' + JSON.stringify(models.defaults));
  log('efforts=' + JSON.stringify(models.models[0]?.supportedReasoningEfforts));

  const tools = [
    {
      name: 'need_context',
      description: '取得当前需求的简短交接。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ];
  const thread = await client.createCoordinator(tools, false, { name: '抖音 · 测试', model: models.defaults.model });
  log('thread=' + thread);

  const calls = [];
  const result = await client.run(thread, [{ type: 'text', text: '请调用 need_context 工具取得当前需求，然后只用一句话回答。' }], {
    toolHandler: async call => {
      calls.push(call);
      return { needId: 'test-need', title: '测试需求' };
    }
  });
  log('tool calls=' + JSON.stringify(calls));
  log('answer=' + result.text);
  log('usage=' + JSON.stringify(result.tokenUsage));

  const ephemeral = await client.runEphemeral([{ type: 'text', text: '只输出 JSON：{"action":"continue"}' }], {
    role: 'router',
    outputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }
  });
  log('ephemeral=' + ephemeral.text);
  log('extracted=' + extractJson(ephemeral.text));
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await client.close();
}
