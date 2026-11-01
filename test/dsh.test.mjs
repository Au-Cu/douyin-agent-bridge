import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshClient, extractJson } from '../src/dsh/client.mjs';
import { resolveDshCommand } from '../src/dsh/command.mjs';
import { mkdtempSync, mkdirSync,writeFileSync,readFileSync } from 'node:fs';
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
    assert.deepEqual(catalog.models.map(m => m.model), ['fixture-provider/fixture-model', 'fixture-provider/fixture-model-fast']);
    assert.equal(catalog.defaults.model, 'fixture-provider/fixture-model');
    assert.deepEqual(catalog.models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ['none', 'low', 'high', 'max']);
    assert.equal(catalog.models[0].defaultReasoningEffort, 'high');
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

test('不具备视觉能力时在提交前拒绝，不把文件名当作看过图片', async () => {
  const c = client();
  try {
    await c.connect();
    const thread = await c.createCoordinator([], false, {});
    let submitted=false;await assert.rejects(c.run(thread, [{ type: 'text', text: '看图' }, { type: 'localImage', path: '/tmp/frame-01.jpg' }], {onSubmitted:()=>submitted=true}),e=>e.code==='DSH_VISUAL_UNAVAILABLE'&&e.notSubmitted);
    assert.equal(submitted,false);assert.equal(c.runs.size,0);
  } finally { await c.close(); }
});

test('启动器解析不到可执行文件时给出明确提示，不静默换用别的程序', () => {
  assert.throws(() => resolveDshCommand('/definitely/missing/dsh'), /不存在/);
  const resolved = resolveDshCommand(fileURLToPath(new URL('./fixture-acp.mjs', import.meta.url)));
  assert.equal(resolved.executable, process.execPath);
  assert.equal(resolved.prefix.length, 1);
});

test('图片实际按顺序进入 ACP 输入，强度不支持时拒绝而不静默降级',async()=>{
  const root=mkdtempSync(join(base,'dsh-images-')),path=join(root,'frame.png'),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWOQmxYlNy2KAUIBABymBDlSzqTIAAAAAElFTkSuQmCC','base64');writeFileSync(path,bytes);
  const c=new DshClient({cwd:root,executable:fixture,spawnArgs:[],spawnEnv:{FIXTURE_ACP_IMAGES:'1'}});
  try{const thread=await c.createCoordinator([],false,{});let submitted=false;await assert.rejects(c.run(thread,[{type:'text',text:'test'}],{effort:'medium',onSubmitted:()=>submitted=true}),e=>e.notSubmitted&&/未提供/.test(e.message));assert.equal(submitted,false);
    const result=await c.run(thread,[{type:'text',text:'FIXTURE_INPUT'},{type:'localImage',path},{type:'text',text:'最后一帧'},{type:'localImage',path}],{effort:'max'}),input=JSON.parse(result.text);assert.equal(input.filter(b=>b.type==='image').length,2);assert.equal(input.find(b=>b.type==='image').data,bytes.toString('base64'));assert.equal(input.at(-2).text,'最后一帧');
  }finally{await c.close();}
});

test('取消必须走通知并等待原提示结束；不同会话并行，同一会话互斥',async()=>{
  const c=client();try{const first=await c.createCoordinator([],false,{}),second=await c.createCoordinator([],false,{}),started=Promise.withResolvers();const running=c.run(first,[{type:'text',text:'FIXTURE_WAIT'}],{onStarted:started.resolve});const turnId=await started.promise;
    await assert.rejects(c.run(first,[{type:'text',text:'重复'}]),e=>e.code==='THREAD_BUSY'&&e.notSubmitted);assert.equal((await c.run(second,[{type:'text',text:'独立要求'}])).text,'模拟正常回复');assert.equal((await c.interrupt(first,{turnId:'different-turn'})).confirmed,false);
    const stopped=assert.rejects(running,e=>e.code==='TASK_INTERRUPTED');assert.equal((await c.interrupt(first,{turnId})).confirmed,true);await stopped;assert.equal(c.interrupting.size,0);assert.equal(c.runs.size,0);assert.equal((await c.interrupt(second,{turnId:'unknown'})).confirmed,false);
  }finally{await c.close();}
});

test('重启后恢复桥接工具；外部项目会话不注入个人助手规则；未核实回合不重跑',async()=>{
  const root=mkdtempSync(join(base,'dsh-resume-')),spawnEnv={FIXTURE_ACP_RECORDS:join(root,'sessions.json')},make=()=>new DshClient({root,cwd:root,executable:fixture,spawnArgs:[],spawnEnv});let c=make();let thread,target;
  const tools=[{name:'need_context',description:'test',inputSchema:{type:'object',properties:{}}}];
  try{thread=await c.createCoordinator(tools,false,{});await c.close();const external=new DshClient({cwd:root,executable:fixture,spawnArgs:[],spawnEnv});try{target=await external.createCoordinator([],false,{});}finally{await external.close();}c=make();let calls=0;const result=await c.run(thread,[{type:'text',text:'need_context'}],{toolHandler:()=>{calls++;return 'RESTORED_TOOL';}});assert.match(result.text,/RESTORED_TOOL/);assert.equal(calls,1);
    const externalReply=await c.run(target,[{type:'text',text:'FIXTURE_INPUT'}]);assert.deepEqual(JSON.parse(externalReply.text),[{type:'text',text:'FIXTURE_INPUT'}]);
    const pending=await c.createCoordinator([],false,{});await assert.rejects(c.run(pending,[{type:'text',text:'FIXTURE_UNKNOWN'}],{timeoutMs:100}),e=>e.uncertain);const saved=c.state.turns(pending)[0];await c.close();c=make();assert.equal(c.state.turn(saved.id).status,'inProgress');await assert.rejects(c.run(pending,[{type:'text',text:'不能重跑'}]),e=>e.code==='DSH_RESULT_UNKNOWN');assert.equal(c.state.turns(pending).length,1);
  }finally{await c.close();}
});

test('Windows npm .cmd 启动器解析到官方 JS 入口，不调用 shell',()=>{
  const root=mkdtempSync(join(base,'dsh-shim-')),entry=join(root,'node_modules','@deepseek-ai','dsh','lib','bin.js');mkdirSync(join(root,'node_modules','@deepseek-ai','dsh','lib'),{recursive:true});writeFileSync(entry,'// fixture');const shim=join(root,'dsh.cmd');writeFileSync(shim,'@echo SHOULD_NOT_RUN');const command=resolveDshCommand(shim,{platform:'win32'});assert.equal(command.executable,process.execPath);assert.deepEqual(command.prefix,[entry]);
});
