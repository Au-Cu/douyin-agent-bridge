import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {Preferences,chooseModel} from '../src/preferences.mjs';import {parseCommand,onOff} from '../src/commands.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
export const catalog={defaults:{model:'test-sol',effort:'max'},models:[{id:'test-sol',model:'test-sol',displayName:'Test Sol',inputModalities:['text','image'],defaultReasoningEffort:'low',supportedReasoningEfforts:['low','medium','max','ultra'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]},{id:'test-luna',model:'test-luna',displayName:'Test Luna',inputModalities:['text','image'],defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[]}]};
test('组合按本机模型能力验证；默认继承 Max，轻量路由独立使用低强度且关闭快速',async()=>{
  const store=new Store(mkdtempSync(join(base,'preferences-'))),prefs=new Preferences({store,codex:{models:async()=>catalog}});
  assert.deepEqual(await prefs.work(),{model:'test-sol',effort:'max',serviceTier:'default'});
  await prefs.update({reasoningEffort:'Max',fastMode:true});assert.deepEqual(await prefs.work(),{model:'test-sol',effort:'max',serviceTier:'priority'});
  assert.deepEqual(await prefs.light(),{model:'test-luna',effort:'low',serviceTier:'default'});
  const saved={...store.config};await assert.rejects(prefs.update({model:'test-luna',reasoningEffort:'ultra'}),/不支持/);assert.deepEqual(store.config,saved);
  await assert.rejects(prefs.update({fastMode:'开'}),/开关/);await assert.rejects(prefs.update({contextBudget:3000}),/4000/);
  await prefs.update({fastMode:false,model:'Test Luna',reasoningEffort:'高',autoRoute:false,visualFps:8});assert.equal(store.config.model,'test-luna');assert.equal(store.config.reasoningEffort,'high');
  await assert.rejects(prefs.update({fastMode:true}),/未提供快速/);store.close();
});
test('所有已用旧命令与新简写精确归一，不通过含糊的模型名或省略的开关猜测',()=>{
  for(const [old,short] of [['/派给 网站 做事','/派 网站 做事'],['/继续视频 9000000000000000001','/续看 9000000000000000001'],['/重新连接','/重连'],['/status','/状态'],['/快速 开','/快 开']])assert.equal(parseCommand(old).name,parseCommand(short).name);
  assert.equal(parseCommand('/模型 test-sol').arg,'test-sol');assert.equal(parseCommand('/密度 8').name,'density');assert.equal(parseCommand('/新建 网站').name,'new');assert.equal(parseCommand('/切换 abcd1234').name,'switch');
  assert.equal(parseCommand('/同意 42').name,'approve');assert.equal(parseCommand('/拒绝 42').name,'decline');assert.equal(parseCommand('/随便命令').name,'unknown');assert.equal(parseCommand('视频里说 /派 网站 做事'),null);
  assert.equal(onOff('开'),true);assert.equal(onOff('off'),false);assert.throws(()=>onOff(''),/明确/);
  assert.equal(chooseModel('Test Sol',catalog),'test-sol');assert.throws(()=>chooseModel('test',catalog),/不唯一/);
});

test('personal Agent and ordinary chat keep independent model, effort and fast defaults across restart',async()=>{
  const folder=mkdtempSync(join(base,'mode-preferences-')),store=new Store(folder),prefs=new Preferences({store,codex:{models:async()=>catalog}});
  try{await prefs.update({model:'test-luna',reasoningEffort:'low'});assert.deepEqual(await prefs.chatWork(),{model:'test-sol',effort:'max',serviceTier:'default'});
    await prefs.updateChat({model:'test-luna',reasoningEffort:'high',fastMode:false});assert.deepEqual(await prefs.work(),{model:'test-luna',effort:'low',serviceTier:'default'});
    const saved={...store.config};await assert.rejects(prefs.updateChat({fastMode:true}),/未提供快速/);assert.deepEqual(store.config,saved);
    await prefs.update({model:'test-sol',reasoningEffort:'ultra',fastMode:true});assert.deepEqual(await prefs.chatWork(),{model:'test-luna',effort:'high',serviceTier:'default'});assert.deepEqual(await prefs.work(),{model:'test-sol',effort:'ultra',serviceTier:'priority'});
  }finally{store.close();}
  const restored=new Store(folder);try{const p=new Preferences({store:restored,codex:{models:async()=>catalog}});assert.equal((await p.chatWork()).model,'test-luna');assert.equal((await p.work()).model,'test-sol');assert.equal(restored.config.chatReasoningEffort,'high');assert.equal(restored.config.reasoningEffort,'ultra');}finally{restored.close();}
});

test('reply-only defaults allow text-only models while Agent visual validation still applies',async()=>{const store=new Store(mkdtempSync(join(base,'text-chat-'))),textCatalog={...catalog,models:catalog.models.map(m=>m.model==='test-luna'?{...m,inputModalities:['text']}:m)},p=new Preferences({store,codex:{models:async()=>textCatalog}});try{await p.updateChat({model:'test-luna',reasoningEffort:'high'});assert.equal((await p.chatWork()).model,'test-luna');await assert.rejects(p.update({model:'test-luna',reasoningEffort:'low'}),/支持图片/);}finally{store.close();}});

test('upgrade copies the previously shared combination once, then further Agent changes do not change chat defaults',()=>{const root=mkdtempSync(join(base,'model-migrate-'));writeFileSync(join(root,'config.json'),JSON.stringify({model:'test-sol',reasoningEffort:'max',fastMode:true,owner:{chatKey:'owner',peerUid:'user'}}));const s=new Store(root);assert.equal(s.config.chatModel,'test-sol');assert.equal(s.config.chatReasoningEffort,'max');assert.equal(s.config.chatFastMode,true);s.saveConfig({model:'test-luna',reasoningEffort:'low',fastMode:false});s.close();const next=new Store(root);try{assert.equal(next.config.model,'test-luna');assert.equal(next.config.chatModel,'test-sol');assert.equal(next.config.chatReasoningEffort,'max');assert.equal(next.config.chatFastMode,true);assert.equal(next.config.owner.chatKey,'owner');}finally{next.close();}});
