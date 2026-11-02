import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';import {Chats} from '../src/chats.mjs';import {ChatSessions} from '../src/chat-sessions.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
const settings={model:'test',effort:'low',serviceTier:'default'},group=key=>({chatKey:key,peerUid:'group:'+key,selfUid:'999999',type:'group',mode:'chat',enabled:true,displayName:key,revision:'r-'+key});
function setup(root){
  const store=new Store(root||mkdtempSync(join(base,'chat-sessions-')));if(!store.config.aiChats?.length)store.saveConfig({aiChats:[group('one'),group('two')]});
  const chats=new Chats({store,adapter:{},sandbox:{},preferences:{}}),native=new Map(),calls=[];
  const runtime={async createSession(h,p){calls.push(['create',h,p]);const id='session-'+calls.length;native.set(id,{archived:false,turns:[]});return id;},async readSession(_h,id){calls.push(['read',id]);return native.get(id);},async archiveSession(h,id,value){calls.push(['archive',h,id,value]);if(h==='dsh')return {supported:false,reason:'DSH ACP 不支持原生归档，仅控制台归档'};native.get(id).archived=value;return {supported:true};}};
  const sessions=new ChatSessions({store,chats,runtime});chats.sessions=sessions;
  const bot=(id,status='done',peer='one',text='用户消息',result='已送达的回答')=>{store.db.prepare('INSERT INTO bot_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,peer,'r-'+peer,JSON.stringify({id,text,kind:'text'}),status,result,'','',Date.now(),Date.now());return {id,peer,revision:'r-'+peer};};
  return {store,chats,sessions,runtime,native,calls,bot};
}
test('each group reuses exactly its own persistent chat and budget handoff contains only its delivered exchanges',async()=>{
  const h=setup();try{
    const first=await h.sessions.prepare(h.bot('a'),h.chats.get('one'),'codex',settings,300);h.sessions.complete(first,{text:'ok',tokenUsage:{last:{totalTokens:500},modelContextWindow:10000}},300);
    const next=await h.sessions.prepare(h.bot('b'),h.chats.get('one'),'codex',settings,300);assert.equal(next.id,first.id);
    const other=await h.sessions.prepare(h.bot('other','done','two','OTHER_PRIVATE'),h.chats.get('two'),'codex',settings,300);assert.notEqual(other.id,first.id);
    const unsent=h.bot('unsent','replying','one','NOT_DELIVERED');await h.sessions.prepare(unsent,h.chats.get('one'),'codex',settings,300);
    h.store.db.prepare('UPDATE chat_sessions SET tokens=7900 WHERE id=?').run(first.id);
    const rotated=await h.sessions.prepare(h.bot('c'),h.chats.get('one'),'codex',settings,300);assert.notEqual(rotated.id,first.id);assert.equal(rotated.seq,2);assert.match(rotated.handoff,/用户消息/);assert.doesNotMatch(rotated.handoff,/OTHER_PRIVATE|NOT_DELIVERED/);
    assert.equal(h.store.isArchived('chat_session',first.id),true);assert.equal(h.native.get(first.thread).archived,true);assert.equal(h.sessions.get(first.id).archive_state,'done');
    await h.sessions.archive(first.id,false);assert.equal(h.store.isArchived('chat_session',first.id),false);assert.equal(h.native.get(first.thread).archived,false);assert.equal(h.sessions.current('one').id,rotated.id);assert.equal(h.sessions.current('two').id,other.id);
    await assert.rejects(h.sessions.archive(rotated.id,true),/当前群聊/);await assert.rejects(h.sessions.transcript('foreign'),/登记/);
  }finally{h.store.close();}
});
test('clearing starts blank, archives old at both levels and fences queued context and stale submissions',async()=>{
  const h=setup();try{
    const first=await h.sessions.prepare(h.bot('old','done','one','OLD_CONTEXT'),h.chats.get('one'),'codex',settings,100);h.sessions.complete(first,{text:'old'},100);
    h.bot('queued','new');const blank=await h.sessions.reset('one',settings,'codex');assert.equal(blank.handoff,'');assert.equal(blank.tokens,0);assert.equal(blank.seq,2);assert.equal(h.sessions.current('one').id,blank.id);assert.equal(h.sessions.get(first.id).state,'archived');assert.equal(h.store.db.prepare("SELECT status FROM bot_messages WHERE id='queued'").get().status,'cancelled');assert.throws(()=>h.sessions.guard(first,h.chats.get('one')),e=>e.notSubmitted);
    const b=h.bot('unknown','uncertain');await assert.rejects(h.sessions.reset('one',settings,'codex'),/结果尚未核实/);h.store.db.prepare('DELETE FROM bot_messages WHERE id=?').run(b.id);
    h.chats.running.set('one',Promise.resolve());await assert.rejects(h.sessions.reset('one',settings,'codex'),/仍在回复/);h.chats.running.clear();
    h.sessions.uncertain(blank,'native turn unknown');await assert.rejects(h.sessions.prepare(h.bot('new'),h.chats.get('one'),'codex',settings,100),/不重复执行/);
    assert.equal(h.calls.filter(c=>c[0]==='create').length,2);
  }finally{h.store.close();}
});
test('DSH rollover is reversible in console and explicitly records unsupported native archive',async()=>{
  const h=setup();try{const old=await h.sessions.prepare(h.bot('a'),h.chats.get('one'),'dsh',settings,100),blank=await h.sessions.reset('one',settings,'dsh');assert.notEqual(old.id,blank.id);assert.equal(h.sessions.get(old.id).archive_state,'unsupported');assert.match(h.sessions.get(old.id).error,/不支持原生/);assert.equal(h.store.isArchived('chat_session',old.id),true);await h.sessions.archive(old.id,false);assert.equal(h.store.isArchived('chat_session',old.id),false);const transcript=await h.sessions.transcript(old.id);assert.equal(transcript.source,'native'); // This mock exposes history; the real DSH adapter returns null.
    h.runtime.readSession=async()=>null;const fallback=await h.sessions.transcript(old.id);assert.equal(fallback.source,'bridge_records');assert.match(fallback.notice,/DSH ACP/);assert.equal(fallback.exchanges.length,1);
  }finally{h.store.close();}
});
test('an uncertain archive is reconciled read-only after restart, never silently repeated or reversed',async()=>{
  const h=setup();const root=h.store.root;let old;
  try{old=await h.sessions.prepare(h.bot('a'),h.chats.get('one'),'codex',settings,100);h.runtime.archiveSession=async()=>{throw Object.assign(new Error('connection lost'),{uncertain:true});};await h.sessions.reset('one',settings,'codex');assert.equal(h.sessions.get(old.id).archive_state,'uncertain');await assert.rejects(h.sessions.archive(old.id,false),/上一次/);h.store.close();
    const restored=setup(root);try{restored.runtime.readSession=async()=>({archived:false});const before=restored.calls.length;await assert.rejects(restored.sessions.archive(old.id,true),/未重复提交/);assert.equal(restored.calls.length,before);restored.runtime.readSession=async()=>({archived:true});await restored.sessions.archive(old.id,true);assert.equal(restored.sessions.get(old.id).archive_state,'done');assert.equal(restored.calls.length,before);assert.equal(restored.store.isArchived('chat_session',old.id),true);}finally{restored.store.close();}
  }finally{try{h.store.close();}catch{}}
});
test('chat runtime appends to persistent groups without replaying bounded history or mixing groups',async()=>{
  const h=setup();try{h.store.saveConfig({enabled:true});const inputs=[],options=[];h.chats.preferences={chatWork:async()=>settings};h.chats.sandbox={reply:async(input,o)=>{inputs.push(input);options.push(o);o.onSubmitted({thread:o.session.thread});o.onStarted({turn:'turn-'+options.length});return {text:'回答',tokenUsage:{last:{totalTokens:1000}}};}};
    const a=h.bot('a','new','one','CURRENT');await h.chats.run(h.store.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(a.id),h.chats.get('one'));
    assert.equal('recent'in inputs[0],false);assert.equal(inputs[0].message.text,'CURRENT');assert.ok(options[0].session.thread);assert.equal(h.sessions.forMessage('a').peer,'one');
    h.store.db.prepare("UPDATE bot_messages SET status='done' WHERE id='a'").run();const b=h.bot('b','new','one','FOLLOWUP');await h.chats.run(h.store.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(b.id),h.chats.get('one'));assert.equal(options[1].session.thread,options[0].session.thread);assert.equal('recent'in inputs[1],false);assert.doesNotMatch(JSON.stringify(inputs[1]),/CURRENT/);
    const other=h.bot('other','new','two','OTHER');await h.chats.run(h.store.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(other.id),h.chats.get('two'));assert.notEqual(options[2].session.thread,options[0].session.thread);
  }finally{h.store.close();}
});

test('unknown group turns are reconciled by exact native turn only, recovering one reply group without model replay',async()=>{
  const h=setup();try{const row=h.bot('source','uncertain'),s=await h.sessions.prepare(row,h.chats.get('one'),'codex',settings,100);h.store.db.prepare("UPDATE bot_messages SET thread=?,turn='exact-turn' WHERE id='source'").run(s.thread);h.sessions.uncertain(s,'connection lost');h.native.get(s.thread).turns=[{id:'other-turn',status:'completed',items:[{type:'agentMessage',text:'WRONG_RESULT'}]}];assert.equal((await h.sessions.reconcile(s.id)).verified,0);assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='text'").get().n,0);
    h.native.get(s.thread).turns=[{id:'exact-turn',status:'completed',items:[{type:'agentMessage',text:'真实完整回复'}]}];const result=await h.sessions.reconcile(s.id);assert.equal(result.verified,1);assert.equal(result.remaining,0);assert.equal(h.sessions.get(s.id).state,'current');const out=h.store.db.prepare("SELECT * FROM outbox WHERE kind='text'").all();assert.equal(out.length,1);assert.match(out[0].body,/真实完整回复/);assert.equal(JSON.parse(out[0].payload).replyToMessageId,'source');assert.equal((await h.sessions.reconcile(s.id)).verified,0);assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='text'").get().n,1);assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
  }finally{h.store.close();}
});
test('restart fences a submitted unknown native group turn before accepting another model request',async()=>{
  const h=setup(),root=h.store.root;try{const r=h.bot('pending','submitted'),s=await h.sessions.prepare(r,h.chats.get('one'),'codex',settings,100);h.store.db.prepare('UPDATE bot_messages SET thread=?,turn=? WHERE id=?').run(s.thread,'unknown-turn',r.id);h.store.close();const restored=setup(root);try{assert.equal(restored.sessions.current('one').state,'uncertain');await assert.rejects(restored.sessions.prepare(restored.bot('next'),restored.chats.get('one'),'codex',settings,100),/不重复执行/);assert.equal(restored.calls.length,0);}finally{restored.store.close();}}finally{try{h.store.close();}catch{}}
});
test('first persistent group chat preserves bounded delivered legacy context while clear never reimports it',async()=>{
  const h=setup();try{h.bot('legacy','done','one','KEEP_OWN_HISTORY');h.bot('other','done','two','OTHER_GROUP');h.bot('not-delivered','failed','one','FAILED_HISTORY');const first=await h.sessions.prepare(h.bot('new','new'),h.chats.get('one'),'codex',settings,100);assert.match(first.handoff,/KEEP_OWN_HISTORY/);assert.doesNotMatch(first.handoff,/OTHER_GROUP|FAILED_HISTORY/);h.store.db.prepare("UPDATE bot_messages SET status='done' WHERE id='new'").run();const blank=await h.sessions.reset('one',settings,'codex');assert.equal(blank.handoff,'');const later=await h.sessions.prepare(h.bot('after-clear','new'),h.chats.get('one'),'codex',settings,100);assert.equal(later.handoff,'');}finally{h.store.close();}
});
