import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Progress } from '../src/progress.mjs';
import { attachVisualProgress, visualProgressView } from '../src/visual-progress-view.mjs';

test('视觉进度仅归入明确绑定的操作，旧缓存不能冒充本次覆盖', async () => {
  const id='1000000000000000001',report={status:'complete',fps:4,completedSegments:17,totalSegments:17,duration:132.5,coveredUntil:132.5};
  const live={operationId:'running',id,fps:4,completed:4,total:17};
  const store={knowledge:()=>({id,path:'demo/note.md'})};let reads=0;
  const cards=await attachVisualProgress([{id:'running',videoIds:[id]},{id:'unrelated',videoIds:[]},{id:'old',videoIds:[id]}],{store,live,readReport:async()=>{reads++;return report;}});
  assert.equal(reads,1);assert.equal(cards[0].visuals[0].source,'running');assert.equal(cards[0].visuals[0].completed,4);
  assert.equal(cards[0].visuals[0].coveredUntil,null,'older complete cache is not current coverage');
  assert.deepEqual(cards[1].visuals,[]);assert.equal(cards[2].visuals[0].source,'saved');assert.equal(cards[2].visuals[0].coveredUntil,132.5);
  const matching=visualProgressView(id,{...report,status:'partial',completedSegments:4,coveredUntil:32},live,'running');assert.equal(matching.coveredUntil,32);
});
test('缺失或无效覆盖记录不猜测百分比、秒数，资料缺失也保留真实运行段数', async () => {
  const id='1000000000000000001';
  const [card]=await attachVisualProgress([{id:'run',videoIds:['../private']}],{store:{knowledge:()=>null},live:{operationId:'run',id,completed:0,total:0,fps:8}});
  assert.equal(card.visuals.length,1);assert.equal(card.visuals[0].coveredUntil,null);assert.equal(card.visuals[0].duration,null);assert.equal(card.visuals[0].fps,8);
  const bad=visualProgressView(id,{completedSegments:-1,totalSegments:'17',coveredUntil:NaN,duration:Infinity},null,'done');
  assert.equal(bad.completed,null);assert.equal(bad.total,null);assert.equal(bad.duration,null);assert.equal(bad.coveredUntil,null);
});
test('任务卡通过保存的消息关系取得视频 ID，普通文本和其他任务不串用', () => {
  const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
  const store=new Store(mkdtempSync(join(base,'visual-view-')));
  try {
    const progress=new Progress({store,codex:new EventEmitter(),notify:()=>{}});
    const video={id:'video-message',platformId:'video-platform',peer:'demo',kind:'video',text:'转发视频',awemeId:'1000000000000000001',created:Date.now()};
    const text={id:'text-message',platformId:'text-platform',peer:'demo',kind:'text',text:'另一项独立要求',created:Date.now()};
    store.incoming(video);store.incoming(text);progress.receive(video);progress.receive(text);
    const cards=progress.cards({scope:'all'});
    assert.deepEqual(cards.find(c=>c.id===video.id).videoIds,[video.awemeId]);assert.deepEqual(cards.find(c=>c.id===text.id).videoIds,[]);
  } finally { store.close(); }
});
