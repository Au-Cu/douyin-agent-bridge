import {createInterface} from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n'),active=new Map(),history=new Map(),callbacks=[];let seq=0,initializations=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};
  if(m.id!==undefined&&!m.method){callbacks.push(m);send({method:'serverRequest/resolved',params:{requestId:m.id}});return;}
  if(m.method==='initialize'){initializations++;return send({id:m.id,result:{serverVersion:'fixture',initializations}});}
  if(m.method==='account/read')return send({id:m.id,result:{account:{type:'chatgpt'}}});
  if(m.method==='thread/resume'||m.method==='thread/read')return send({id:m.id,result:{thread:{id:p.threadId,status:{type:active.has(p.threadId)?'active':'idle'},turns:[...(history.get(p.threadId)||[]),...(active.has(p.threadId)?[active.get(p.threadId)]:[])]}}});
  if(m.method==='test/callback'){send({id:'core-callback-'+(++seq),method:p.method,params:p.params});return send({id:m.id,result:{}});}
  if(m.method==='test/results')return send({id:m.id,result:{callbacks}});
  if(m.method==='turn/start'){const turn={id:'turn-'+(++seq),status:'inProgress',items:[]};active.set(p.threadId,turn);send({method:'turn/started',params:{threadId:p.threadId,turn}});send({id:m.id,result:{turn}});if(!p.input?.[0]?.text?.includes('wait'))setTimeout(()=>finish(p.threadId,'completed'),40);return;}
  if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return finish(p.threadId,'interrupted');}
  if(m.method==='thread/loaded/list')return send({id:m.id,result:{data:[...active.keys()]}});
  if(m.id!==undefined)send({id:m.id,result:{}});
});
function finish(threadId,status){const turn=active.get(threadId);if(!turn)return;active.delete(threadId);turn.status=status;turn.items=[{type:'agentMessage',text:status==='completed'?'SHARED_OK':'INTERRUPTED'}];send({method:'turn/completed',params:{threadId,turn}});}
