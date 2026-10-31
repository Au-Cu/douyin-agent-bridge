import { createInterface } from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
createInterface({input:process.stdin}).on('line',raw=>{const m=JSON.parse(raw);if(!m.id)return;
  if(m.method==='initialize')return send({id:m.id,result:{}});
  if(m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId}}});
  if(m.method==='turn/start'){
    const turn={id:'turn-test',status:'completed',items:[{type:'agentMessage',text:'模拟正常回复'}]};
    send({method:'turn/completed',params:{threadId:m.params.threadId,turn}});
    return send({id:m.id,result:{turn}});
  }
  send({id:m.id,result:{}});
});
