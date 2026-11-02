import { createInterface } from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
let threadSeq=0;const archived=new Map();
createInterface({input:process.stdin}).on('line',raw=>{const m=JSON.parse(raw);if(!m.id)return;
  if(m.method==='initialize')return send({id:m.id,result:{}});
  if(m.method==='model/list')return send({id:m.id,result:{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',isDefault:true,defaultReasoningEffort:'low',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'max'}],serviceTiers:[{id:'priority',name:'Fast'}]}],nextCursor:null}});
  if(m.method==='config/read')return send({id:m.id,result:{config:{model:'fixture-model',model_reasoning_effort:'low'}}});
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'fixture-thread-'+(++threadSeq)}}});
  if(m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId}}});
  if(m.method==='thread/read')return send({id:m.id,result:{thread:{id:m.params.threadId,archived:!!archived.get(m.params.threadId),status:{type:'idle'},turns:[]}}});
  if(m.method==='thread/archive'||m.method==='thread/unarchive'){archived.set(m.params.threadId,m.method==='thread/archive');return send({id:m.id,result:{}});}
  if(m.method==='turn/start'){
    const turn={id:'turn-test',status:'completed',items:[{type:'agentMessage',text:'模拟正常回复'}]};
    send({method:'turn/completed',params:{threadId:m.params.threadId,turn}});
    return send({id:m.id,result:{turn}});
  }
  send({id:m.id,result:{}});
});
