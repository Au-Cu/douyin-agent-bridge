import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {VisualAnalyzer,planVisualSegments,validateVisualWindow,validateVisualCrop} from '../src/visual.mjs';
const root=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(root,{recursive:true});
test('连续画面分段覆盖开始到结尾，片段之间没有遗漏',()=>{
  const sheets=Array.from({length:73},(_,i)=>'sheet-'+i);const segments=planVisualSegments(sheets,72.2,4);
  assert.equal(segments[0].start,0);assert.equal(segments.at(-1).end,72.2);assert.equal(segments.flatMap(s=>s.sheets).length,73);
  for(let i=1;i<segments.length;i++)assert.equal(segments[i].start,segments[i-1].end);
  assert.throws(()=>planVisualSegments([],10,4),/没有连续画面/);
});
test('局部细看只能在原视频范围内，拒绝负数、越界和超长片段',()=>{
  assert.doesNotThrow(()=>validateVisualWindow(1,3,10));
  for(const [a,b] of [[-1,1],[5,4],[9,11],[0,4],[NaN,1]])assert.throws(()=>validateVisualWindow(a,b,10));
});
test('局部放大拒绝倒置、超界、过小矩形和原片之外的时间',()=>{
  assert.doesNotThrow(()=>validateVisualCrop(2,[0,500,1000,1000],10));
  for(const [t,b] of [[11,[0,0,1000,1000]],[0,[500,0,100,500]],[0,[-1,0,100,500]],[0,[0,0,1001,500]],[0,[0,0,1,1]],[NaN,[0,0,1000,1000]]])assert.throws(()=>validateVisualCrop(t,b,10));
});
test('部分视觉分析失败不报告完成；重新运行复用已完成片段并覆盖剩余时间',async()=>{
  const folder=mkdtempSync(join(root,'visual-'));const learned={path:join(folder,'note.md'),seconds:11.3,transcript:'引用口播'};
  const prepared={folder,video:join(folder,'video.mp4'),manifest:{cacheKey:'fixture',sheets:['a','b'],finalFrame:join(folder,'end.jpg')},segments:[{index:0,start:0,end:8,sheets:['a']},{index:1,start:8,end:11.3,sheets:['b']}]};
  let calls=0;const codex={createCoordinator:async()=>String(calls),run:async()=>{if(++calls===2)throw new Error('测试连接中断');return{text:'第一段真实视觉观察'};}};
  const first=new VisualAnalyzer({codex});first.prepare=async()=>prepared;
  await assert.rejects(first.analyze(learned),/1\/2 段已保存/);
  const partial=JSON.parse(readFileSync(join(folder,'visual-report.json'),'utf8'));assert.equal(partial.status,'partial');assert.equal(partial.coveredUntil,8);assert.equal(existsSync(join(folder,'visual-analysis.md')),false);
  let resumed=0;const second=new VisualAnalyzer({codex:{createCoordinator:async()=>'',run:async()=>{resumed++;return{text:'第二段真实视觉观察'};}}});second.prepare=async()=>prepared;
  const complete=await second.analyze(learned);assert.equal(resumed,1);assert.equal(complete.status,'complete');assert.equal(complete.coveredUntil,11.3);assert.match(complete.notes,/第一段真实视觉观察/);assert.match(complete.notes,/第二段真实视觉观察/);
});
