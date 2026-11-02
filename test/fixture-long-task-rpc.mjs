import {createInterface} from 'node:readline';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const tasks=new Map();let seq=0,starts=0,reads=0,interrupts=0,readMode='normal';
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)return;
  const reply=result=>send({id:m.id,result});
  if(m.method==='initialize')return reply({});
  if(m.method==='account/read')return reply({requiresOpenaiAuth:false,account:{type:'chatgpt'}});
  if(m.method==='thread/resume')return reply({thread:{id:p.threadId}});
  if(m.method==='turn/start'){
    starts++;const turn={id:'owned-'+(++seq),status:'inProgress',items:[]};tasks.set(p.threadId,turn);
    send({method:'turn/started',params:{threadId:p.threadId,turn}});reply({turn});return;
  }
  if(m.method==='thread/read'){
    reads++;
    if(readMode==='offline')return send({id:m.id,error:{code:-32000,message:'temporary read failure'}});
    const turn=tasks.get(p.threadId),turns=readMode==='missing'?[{id:'other-turn',status:'completed',items:[{type:'agentMessage',text:'WRONG_RESULT'}]}]:turn?[turn]:[];
    return reply({thread:{id:p.threadId,status:{type:'active'},turns}});
  }
  if(m.method==='test/readMode'){readMode=p.mode;return reply({});}
  if(m.method==='test/stats')return reply({starts,reads,interrupts});
  if(m.method==='test/finish'||m.method==='turn/interrupt'){
    if(m.method==='turn/interrupt')interrupts++;
    const turn=tasks.get(p.threadId);if(turn){turn.status=m.method==='turn/interrupt'?'interrupted':'completed';turn.items=[{type:'agentMessage',text:'OWN_RESULT'}];if(p.emit!==false)send({method:'turn/completed',params:{threadId:p.threadId,turn}});}
    return reply({});
  }
  if(m.method==='test/newer'){
    const turn={id:'newer-'+(++seq),status:'inProgress',items:[]};
    send({method:'turn/started',params:{threadId:p.threadId,turn}});
    send({method:'item/completed',params:{threadId:p.threadId,turnId:turn.id,item:{type:'agentMessage',text:'WRONG_NEWER_RESULT'}}});return reply({turn});
  }
  reply({});
});
