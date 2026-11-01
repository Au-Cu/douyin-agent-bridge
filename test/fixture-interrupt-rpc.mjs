import {createInterface} from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),threads=new Map();let seq=0;
createInterface({input:process.stdin}).on('line',raw=>{
  const m=JSON.parse(raw);if(!m.id)return;const p=m.params||{},reply=result=>send({id:m.id,result});
  if(m.method==='account/read')return reply({account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}});
  if(m.method==='thread/start')return reply({thread:{id:'new-'+(++seq)}});
  if(m.method==='thread/resume')return reply({thread:{id:p.threadId}});
  if(m.method==='thread/read'){const t=threads.get(p.threadId);return reply({thread:{id:p.threadId,status:{type:t?.status==='inProgress'?'active':'idle'},turns:t?[t]:[]}});}
  if(m.method==='turn/start'){
    const text=p.input[0].text,turn={id:'turn-'+p.threadId,status:'inProgress',items:[]};threads.set(p.threadId,turn);turn.mode=text.includes('no-confirm')?'no-confirm':text.includes('late-confirm')?'late-confirm':text.includes('gap')?'gap':text;turn.readyAt=Date.now()+(turn.mode==='gap'?80:0);
    send({method:'turn/started',params:{threadId:p.threadId,turn}});
    const respond=()=>reply({turn:{...turn}});if(turn.mode==='gap')setTimeout(respond,160);else respond();
    if(text==='tool')setTimeout(()=>send({id:'dynamic-tool',method:'item/tool/call',params:{threadId:p.threadId,turnId:turn.id,tool:'pause_local',arguments:{}}}),20);
    if(text==='finish')setTimeout(()=>{turn.status='completed';turn.items=[{type:'agentMessage',text:'OTHER_CHAT_OK'}];send({method:'turn/completed',params:{threadId:p.threadId,turn}});},160);
    return;
  }
  if(m.method==='turn/interrupt'){
    const turn=threads.get(p.threadId);if(turn?.id!==p.turnId)return send({id:m.id,error:{code:-1,message:'wrong turn'}});
    if(Date.now()<turn.readyAt)return send({id:m.id,error:{code:-1,message:'no active turn to interrupt'}});
    reply({});if(turn.mode==='no-confirm')return;
    const finish=()=>{turn.status='interrupted';send({method:'turn/completed',params:{threadId:p.threadId,turn}});};if(turn.mode==='late-confirm')setTimeout(finish,3200);else finish();return;
  }
  reply({});
});
