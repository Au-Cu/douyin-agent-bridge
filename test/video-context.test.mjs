import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';import { fileURLToPath } from 'node:url';import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';import { BridgeEngine } from '../src/engine.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});

test('派发保留原视频、完整视觉索引，并给目标聊天附上真实图片输入类型',async()=>{
  const root=mkdtempSync(join(base,'handoff-')),folder=join(root,'knowledge','1234567890123456'),key='visual-continuous-v2-4fps-123456abcdef';mkdirSync(join(folder,key),{recursive:true});
  const path=join(folder,'note.md');writeFileSync(path,'视频学习笔记');
  writeFileSync(join(folder,'video.mp4'),'fixture file, model is mocked');
  writeFileSync(join(folder,'visual-analysis.md'),'0–2 秒：抽屉跟随触点下移，底栏胶囊拉伸后收拢。');
  writeFileSync(join(folder,'visual-report.json'),JSON.stringify({cacheKey:key,status:'complete',fps:4,duration:2,coveredUntil:2}));
  const sheets=['sheet-00001.jpg','sheet-00002.jpg'];for(const name of sheets)writeFileSync(join(folder,key,name),'fixture image, model is mocked');
  writeFileSync(join(folder,key,'manifest.json'),JSON.stringify({sheets}));
  const store=new Store(root);store.saveConfig({owner:{chatKey:'owner'},coordinator:'main',enabled:true,targets:[{id:'target',alias:'项目'}]});
  store.addKnowledge({id:'1234567890123456',title:'界面参考',path,transcript:'口播',summary:'总结'});
  const codex=new EventEmitter();codex.connect=async()=>{};codex.request=async()=>({thread:{status:{type:'idle'}}});let input;
  codex.run=async(t,i,o)=>{input=i;o.onSubmitted();o.onStarted('turn');return {text:'执行完成',turnId:'turn'};};
  const engine=new BridgeEngine({store,codex,adapter:{},media:{}});engine.dispatch('项目','按视频实现','把这个交给项目实现');
  const task=store.queuedTasks()[0];assert.match(task.prompt,/video\.mp4/);assert.match(task.prompt,/manifest\.json/);assert.match(task.prompt,/先阅读.*task-reference\.md/);assert.match(task.prompt,/video-inspect\.mjs/);
  assert.doesNotMatch(task.prompt,/不要让用户重新截图|0–2 秒：抽屉/);assert.match(readFileSync(new URL('../prompts/task-reference.md',import.meta.url),'utf8'),/先读索引中的 notePath.*visualPath/);
  await engine.runTask();assert.equal(input.filter(i=>i.type==='localImage').length,2);assert.equal(input.filter(i=>i.type==='localImage')[0].path,join(folder,key,sheets[0]));assert.equal(store.snapshot().tasks[0].status,'done');store.close();
});
