import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {CodexClient} from '../src/codex.mjs';
import {once} from 'node:events';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const errorText='Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
function setup(scenario={}){
  const home=mkdtempSync(join(base,'auth-'));
  const write=(file,value)=>writeFileSync(join(home,file),JSON.stringify(value));write('auth.json',{account:'first'});write('scenario.json',scenario);
  const client=new CodexClient({codexHome:home,executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-auth-rpc.mjs',import.meta.url))]});
  return {client,write,logs:()=>readFileSync(join(home,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}
const input=text=>[{type:'text',text}];

test('本机换号后新请求使用新登录，迟到的旧进程退出事件不能断开新连接',async()=>{
  const h=setup();try{
    assert.equal((await h.client.run('existing-chat',input('first'))).text,'ACCOUNT_first');
    h.client.startAuthWatcher(20);const changed=once(h.client,'auth-reconnected',{signal:AbortSignal.timeout(3000)});h.write('auth.json',{account:'second'});await changed;
    assert.equal((await h.client.run('existing-chat',input('second'))).text,'ACCOUNT_second');
    await new Promise(r=>setTimeout(r,30));assert.equal(h.client.ready,true);assert.equal(h.client.generation,2);
    assert.equal((await h.client.run('existing-chat',input('third'))).text,'ACCOUNT_second');
  }finally{h.client.close();}
});

test('换号发生在任务执行中时延后重连，原任务不被中断或重放，后续任务使用新账号',async()=>{
  const h=setup();try{
    let started;const ready=new Promise(r=>started=r),running=h.client.run('target-chat',input('hold'),{onStarted:started});await ready;
    h.write('auth.json',{account:'second'});assert.equal((await h.client.reconnect()).deferred,true);
    let submitted=0;await assert.rejects(h.client.run('other-chat',input('new'),{onSubmitted:()=>submitted++}),e=>e.code==='CODEX_AUTH_PENDING');assert.equal(submitted,0);
    await h.client.request('test/release');assert.equal((await running).text,'ACCOUNT_first');
    assert.equal((await h.client.run('other-chat',input('new'))).text,'ACCOUNT_second');
    assert.equal(h.logs().filter(e=>e.method==='turn/start'&&e.params.threadId==='target-chat').length,1);
  }finally{h.client.close();}
});

test('旧令牌报错只对只读分析重建会话并重试一次；持续无效登录不无限重试',async()=>{
  const h=setup({failLaunch:1});try{
    assert.equal((await h.client.runReadOnly(input('observe'))).text,'ACCOUNT_first');
    const starts=h.logs().filter(e=>e.method==='thread/start');assert.equal(starts.length,2);
    assert.equal(starts[0].params.sandbox,'read-only');assert.equal(starts[0].params.approvalPolicy,'never');
  }finally{h.client.close();}
  const bad=setup({failAll:true});try{
    await assert.rejects(bad.client.runReadOnly(input('observe')),e=>e.authKind==='login'&&e.message===errorText);
    await bad.client.connect();assert.equal(bad.client.generation,2);
    assert.equal(bad.logs().filter(e=>e.method==='turn/start').length,2);
  }finally{bad.client.close();}
});

test('执行类请求遇到认证失败不自动重发，重新连接也不会重放已经提交的任务',async()=>{
  const h=setup({failLaunch:1});try{
    let submitted=0;await assert.rejects(h.client.run('real-target',input('execute'),{onSubmitted:()=>submitted++}),e=>e.authKind==='login');
    await h.client.reconnect();assert.equal(submitted,1);assert.equal(h.logs().filter(e=>e.method==='turn/start').length,1);
  }finally{h.client.close();}
});

test('固定规则在恢复助手聊天时仅加载一次，目标聊天已有的规则不被覆盖',async()=>{
  const h=setup();try{
    await h.client.run('assistant-chat',input('新的指示'),{assistant:true});await h.client.run('assistant-chat',input('另一条指示'),{assistant:true});
    await h.client.run('project-chat',input('执行任务'));
    const resumes=h.logs().filter(e=>e.method==='thread/resume');
    assert.match(resumes[0].params.developerInstructions,/抖音助手固定规则/);
    assert.equal(resumes.length,2);assert.equal(resumes[1].params.developerInstructions,undefined);
    assert.deepEqual(h.logs().filter(e=>e.method==='turn/start').map(e=>e.params.input[0].text),['新的指示','另一条指示','执行任务']);
  }finally{h.client.close();}
});

test('关闭时正在检查登录文件也不能在关闭后启动新的子进程',async()=>{
  const h=setup(),connecting=h.client.connect();h.client.close();
  await assert.rejects(connecting,e=>e.code==='CODEX_CLIENT_CLOSED');
  await assert.rejects(h.client.connect(),e=>e.code==='CODEX_CLIENT_CLOSED');assert.equal(h.client.generation,0);
});

test('隔离聊天每次重连先重新导入内存登录，绝不依赖或写入 auth 文件',async()=>{
  const h=setup(),c=new CodexClient({codexHome:h.client.codexHome,executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-auth-rpc.mjs',import.meta.url))],restricted:true,authTokensProvider:async()=>({accessToken:'FAKE_ACCESS',chatgptAccountId:'fake-account'})});
  try{await c.connect();await c.reconnect();assert.equal(c.authState.status,'ready');const log=h.logs();for(const launch of [1,2]){const rows=log.filter(r=>r.launch===launch);assert.ok(rows.findIndex(r=>r.method==='account/login/start')<rows.findIndex(r=>r.method==='account/read'));}assert.deepEqual(JSON.parse(readFileSync(join(c.codexHome,'auth.json'),'utf8')),{account:'first'});}finally{h.client.close();c.close();}
});

test('写入锁按聊天隔离：A 运行时 B 可完成，同一 A 不能重入，也不重复恢复本机已加载聊天',async()=>{
  const h=setup();try{let started;const ready=new Promise(r=>started=r),a=h.client.run('chat-A',input('hold'),{onStarted:started});await ready;
    await assert.rejects(h.client.run('chat-A',input('duplicate')),e=>e.code==='THREAD_BUSY'&&e.notSubmitted===true);
    assert.equal((await h.client.run('chat-B',input('independent'))).text,'ACCOUNT_first');assert.equal(h.client.runs.size,1);
    await h.client.request('test/release');await a;await h.client.run('chat-A',input('next'));
    assert.equal(h.logs().filter(e=>e.method==='thread/resume'&&e.params.threadId==='chat-A').length,1);
    assert.equal(h.logs().filter(e=>e.method==='turn/start').length,3);
  }finally{h.client.close();}
});

test('模型、推理强度、快速档位透传到每轮；临时路由会话使用独立角色且结束后卸载',async()=>{
  const h=setup();try{
    await h.client.run('work-chat',input('工作'),{model:'test-sol',effort:'max',serviceTier:'priority'});
    await h.client.run('work-chat',input('关闭快速'),{model:'test-sol',effort:'high',serviceTier:'default'});
    await h.client.runEphemeral(input('只做分类'),{role:'router',model:'test-luna',effort:'low',serviceTier:'default',outputSchema:{type:'object'}});
    const logs=h.logs(),turns=logs.filter(e=>e.method==='turn/start');assert.equal(turns[0].params.model,'test-sol');assert.equal(turns[0].params.effort,'max');assert.equal(turns[0].params.serviceTierForTurn,'priority');assert.equal(turns[1].params.serviceTierForTurn,'default');
    const start=logs.find(e=>e.method==='thread/start');assert.equal(start.params.ephemeral,true);assert.equal(start.params.sandbox,'read-only');assert.match(start.params.developerInstructions,/只做轻量分类/);assert.doesNotMatch(start.params.developerInstructions,/逐段视觉观察规则/);
    assert.equal(logs.filter(e=>e.method==='thread/unsubscribe').length,1);assert.equal(h.client.ephemeral.size,0);
  }finally{h.client.close();}
});
