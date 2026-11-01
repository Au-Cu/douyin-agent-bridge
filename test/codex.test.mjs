import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {CodexClient,approvalResponse} from '../src/codex.mjs';
import {mkdirSync,mkdtempSync} from 'node:fs';import {join} from 'node:path';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
test('Codex 完成事件早于 turn/start 响应时仍只返回一次正确结果',async()=>{
  const c=new CodexClient({codexHome:mkdtempSync(join(base,'rpc-home-')),executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-rpc.mjs',import.meta.url))]});
  try{const r=await c.run('thread-test',[{type:'text',text:'你好'}]);assert.equal(r.text,'模拟正常回复');assert.equal(r.turnId,'turn-test');assert.equal(c.runs.size,0);}finally{c.close();}
});
test('权限确认按实际协议仅授予本轮所请求的范围，拒绝时不授予权限',()=>{
  const permissions={network:{enabled:true},fileSystem:{read:['D:\\Files\\example']}};
  const request={method:'item/permissions/requestApproval',params:{permissions}};
  assert.deepEqual(approvalResponse(request,true),{permissions,scope:'turn'});
  assert.deepEqual(approvalResponse(request,false),{permissions:{},scope:'turn'});
  assert.deepEqual(approvalResponse({method:'item/commandExecution/requestApproval'},false),{decision:'decline'});
});

test('提交边界因归档取消时不会发 turn/start，也不误标成未知执行',async()=>{
  const c=new CodexClient({codexHome:mkdtempSync(join(base,'archive-boundary-')),executable:process.execPath,spawnArgs:[fileURLToPath(new URL('./fixture-rpc.mjs',import.meta.url))]});
  try{let submitted=false;await assert.rejects(c.run('thread-test',[{type:'text',text:'不应提交'}],{onSubmitted:()=>{submitted=true;throw Object.assign(new Error('已归档'),{code:'ARCHIVED_TASK',notSubmitted:true});}}),e=>e.code==='ARCHIVED_TASK'&&e.notSubmitted&&!e.uncertain);assert.equal(submitted,true);assert.equal(c.runs.size,0);assert.equal(c.threadLocks.size,0);}finally{c.close();}
});
