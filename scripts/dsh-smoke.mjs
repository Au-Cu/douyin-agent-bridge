import { DshClient, extractJson } from '../src/dsh/client.mjs';
import {ProfiledDshClient} from '../src/dsh/profile-client.mjs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveDataRoot} from '../src/data-root.mjs';

const log = message => console.log('·', message);
const catalogClient = new DshClient({ cwd: process.cwd() });let client;

try {
  const models = await catalogClient.models(),folder=join(resolveDataRoot(),'diagnostics');await mkdir(folder,{recursive:true});const root=await mkdtemp(join(folder,'dsh-smoke-'));client=new ProfiledDshClient({root,home:catalogClient.home,executable:catalogClient.executable,mode:'agent',instructions:'只处理本次连通性检查，不能执行项目任务。',selectionProvider:()=>JSON.parse(models.models.find(m=>m.isDefault).id)});await client.connect();
  log('connected restricted DSH, ready=' + client.ready);
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
  await client?.close();await catalogClient.close();
}
