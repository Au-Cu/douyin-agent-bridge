import test from 'node:test';import assert from 'node:assert/strict';
import {PeerBrowser} from '../src/peer-browser.mjs';import {operationContext,checkWork} from '../src/execution.mjs';
const A={chatKey:'chat-a',peerUid:'user-a'},B={chatKey:'chat-b',peerUid:'user-b'},C={chatKey:'chat-c',peerUid:'user-c'};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){let current=A,now=0,release;const order=[],native={scan:async()=>({peer:current,messages:[]}),restoreOwner:async peer=>{current=peer;order.push('select:'+peer.chatKey);},send:async peer=>{assert.equal(current.chatKey,peer.chatKey);order.push('send:'+peer.chatKey);await new Promise(r=>release=r);assert.equal(current.chatKey,peer.chatKey);order.push('confirmed:'+peer.chatKey);return {messageId:'90000000000001'};},react:async peer=>{assert.equal(current.chatKey,peer.chatKey);order.push('react:'+peer.chatKey);return {verified:true};}},browser=new PeerBrowser(native,{now:()=>now,wait:async ms=>{now+=ms;await tick();}});browser.multiple=true;return {native,browser,order,get current(){return current;},get now(){return now;},release:()=>release?.()};}

test('switching chat holds the read lock until delayed messages arrive and returns a stable snapshot',async()=>{const h=fixture();h.native.scan=async()=>({peer:h.current,messages:h.current.chatKey===B.chatKey?[{id:'old',conversation:B.chatKey},...(h.now>=600?[{id:'fresh',conversation:B.chatKey}]:[])]:[]});const reading=h.browser.scanPeer(B),next=h.browser.scanPeer(C);const snapshot=await reading;assert.ok(snapshot.messages.some(m=>m.id==='fresh'));await next;assert.deepEqual(h.order,['select:chat-b','select:chat-c']);assert.equal(snapshot.peer.chatKey,B.chatKey);});

test('send and reaction verification cannot be interrupted by polls, diagnostics or another reply',async()=>{const h=fixture(),sending=h.browser.send(A,'fixture');await tick();const b=h.browser.scanPeer(B),c=h.browser.scanPeer(C),reaction=h.browser.react(A,'90000000000001'),inspect=h.browser.scan();await tick();assert.deepEqual(h.order,['send:chat-a']);h.release();await Promise.all([sending,b,c,reaction,inspect]);assert.ok(h.order.indexOf('confirmed:chat-a')<h.order.indexOf('select:chat-b'));});

test('pending writes outrank routine polling without accumulating repeated polls',async()=>{const h=fixture(),sending=h.browser.send(A,'fixture');await tick();const polls=Array.from({length:15},()=>h.browser.scanPeer(B)),reaction=h.browser.react(A,'90000000000001');h.release();await Promise.all([sending,...polls,reaction]);assert.ok(h.order.indexOf('react:chat-a')<h.order.indexOf('select:chat-b'));assert.equal(h.order.filter(x=>x==='select:chat-b').length,1);});

test('a video in its own tab does not block collecting another chat; close still waits for the video tab cleanup',async()=>{const h=fixture();let finishVideo,closed=false,videoClosed=false;h.native.resolveVideo=async()=>{await new Promise(r=>finishVideo=r);videoClosed=true;return {source:'fixture'};};h.native.close=async()=>{assert.equal(videoClosed,true);closed=true;};const video=h.browser.resolveVideo({awemeId:'90000000000001'});await tick();let read=false;const scan=h.browser.scanPeer(B).then(()=>read=true);await tick();await tick();for(let i=0;i<20&&!read;i++)await tick();const readBeforeVideoFinished=read,closedTask=h.browser.close();await tick();assert.equal(closed,false);finishVideo();await Promise.all([scan,video,closedTask]);assert.equal(readBeforeVideoFinished,true);assert.equal(closed,true);assert.ok(h.order.indexOf('select:chat-b')>=0);});

test('repeated polling of the chat currently settling shares its complete snapshot; reads cannot starve behind a reply burst',async()=>{const h=fixture(),read=h.browser.scanPeer(B),same=h.browser.scanPeer(B);assert.equal(read,same);await Promise.all([read,same]);const hold=h.browser.send(B,'fixture');await tick();const other=h.browser.scanPeer(C),reactions=Array.from({length:7},()=>h.browser.react(B,'90000000000001'));h.release();await Promise.all([hold,other,...reactions]);const beforeOther=h.order.slice(0,h.order.indexOf('select:chat-c')).filter(x=>x==='react:chat-b');assert.ok(beforeOther.length<=2);assert.equal(h.browser.diagnostics.coalesced,1);});

test('identity changes during stable collection abort the read and never return mixed conversations',async()=>{const h=fixture();h.native.scan=async()=>({peer:h.current.chatKey===B.chatKey&&h.now>=300?C:h.current,messages:[]});await assert.rejects(h.browser.scanPeer(B),e=>e.code==='CHAT_CHANGED'&&e.notSubmitted);assert.deepEqual(h.order,['select:chat-b']);});

test('a zero unread badge cannot hide a personal Agent message for the full group reconciliation interval',async()=>{
  const h=fixture();
  h.native.inbox=async()=>({entries:[{ids:[B.chatKey],unread:0}]});
  h.browser.visited.set(B.chatKey,0);
  h.browser.now=()=>4999;
  assert.equal(await h.browser.scanPeer(B,{background:true,agent:true}),null);
  h.browser.now=()=>5000;
  assert.equal(await h.browser.scanPeer(B,{background:true}),null);
  assert.equal(await h.browser.wantsRead(B,{agent:true}),true);
});

test('queued browser work retains the originating cancellation guard after prioritization',async()=>{const h=fixture(),sending=h.browser.send(A,'fixture');await tick();const c=new AbortController();const job=operationContext.run({signal:c.signal,guard:()=>{if(c.signal.aborted)throw new Error('origin-cancelled');}},()=>h.browser.react(B,'90000000000001'));const failure=assert.rejects(job,/origin-cancelled|用户已强制中断/);c.abort();h.release();await Promise.all([sending,failure]);assert.deepEqual(h.order,['send:chat-a','confirmed:chat-a']);checkWork();});
