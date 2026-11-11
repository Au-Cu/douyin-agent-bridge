import test from 'node:test';import assert from 'node:assert/strict';import {runtimeClients} from '../src/runtime-clients.mjs';
test('personal persistent work uses the desktop writer; temporary analysis and ordinary-chat auth remain independent',async()=>{
  const r=runtimeClients({store:{root:'fixture',config:{harness:'codex'}},cwd:process.cwd()}),calls=[];
  r.desktopCodex.createCoordinator=async(...args)=>{calls.push(['create',...args]);return 'personal-need';};
  r.desktopCodex.run=async(...args)=>{calls.push(['run',...args]);return {text:'done'};};
  r.localCodex.runReadOnly=async()=>({text:'visual'});r.localCodex.runEphemeral=async()=>({text:'routing'});
  r.localCodex.createCoordinator=()=>{throw Error('persistent writer must not be local');};
  r.localCodex.connect=async()=>{};r.localCodex.models=async()=>({models:['initial-setup']});r.desktopCodex.connect=async()=>{throw Error('desktop unavailable');};
  await r.codex.connect();assert.deepEqual((await r.codex.models()).models,['initial-setup']);
  assert.equal(await r.codex.createCoordinator([],false),'personal-need');assert.equal((await r.codex.run('personal-need',[])).text,'done');
  assert.equal((await r.codex.runReadOnly([])).text,'visual');assert.equal((await r.codex.runEphemeral([])).text,'routing');
  r.localCodex.ephemeral.set('temporary',0);r.localCodex.interrupt=async()=>({confirmed:true});r.desktopCodex.interrupt=()=>{throw Error('temporary turn must not reach desktop');};assert.equal((await r.codex.interrupt('temporary')).confirmed,true);
  assert.equal(r.codex.forHarness('codex').desktop,r.taskCodex.forHarness('codex'));assert.notEqual(r.localCodex,r.desktopCodex);
  let count=0;r.codex.on('approval',()=>count++);r.taskCodex.on('approval',()=>count++);r.desktopCodex.emit('approval',{id:'1'});assert.equal(count,1);
});
