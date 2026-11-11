import test from 'node:test';import assert from 'node:assert/strict';
import {recoverOwnedDraft} from '../src/owned-draft.mjs';
test('draft timeout only clears exact persisted pre-submit text and quote, with a two-recovery limit',async()=>{
  let clears=0;const saved={body:'回复',text:'回复',quoteId:'123456',state:'prepared',created:1000,recoveries:0};
  const options={body:'回复',draft:{text:' 回复 '},saved,quoteId:'123456',quote:async()=>({ids:['123456']}),clear:async()=>clears++,now:20000};
  for(const change of [{saved:undefined},{saved:{...saved,state:'planned'}},{saved:{...saved,state:'submitted'}},{saved:{...saved,body:'另一个结果'}},{draft:{text:'用户修改'}},{quote:async()=>({ids:['654321']})}])assert.equal(await recoverOwnedDraft({...options,...change}),false);
  assert.equal(clears,0);await assert.rejects(recoverOwnedDraft({...options,now:2000}),e=>e.code==='OWNED_DRAFT_WAIT');
  await assert.rejects(recoverOwnedDraft({...options,saved:{...saved,recoveries:2}}),e=>e.code==='OWNED_DRAFT_EXHAUSTED');
  assert.equal(await recoverOwnedDraft(options),true);assert.equal(clears,1);
});
