import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
const home=process.env.CODEX_HOME,read=name=>{try{return JSON.parse(readFileSync(join(home,name),'utf8'));}catch{return {};}};
const cached=read('auth.json'),launch=(read('launches.json').count||0)+1;writeFileSync(join(home,'launches.json'),JSON.stringify({count:launch}));
const log=entry=>appendFileSync(join(home,'requests.jsonl'),JSON.stringify({launch,...entry})+'\n');
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');let held,seq=0,external;
const finish=(id,threadId,fail=false)=>{
  const turn={id,status:fail?'failed':'completed',items:fail?[]:[{type:'agentMessage',text:'ACCOUNT_'+cached.account}],...(fail?{error:{message:'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.'}}:{})};
  send({method:'turn/completed',params:{threadId,turn}});return turn;
};
createInterface({input:process.stdin}).on('line',raw=>{
  const m=JSON.parse(raw);if(m.id===undefined)return;log({method:m.method,params:m.params});
  if(m.method==='account/login/start'){external=m.params.accessToken;return send({id:m.id,result:{type:m.params.type}});}
  if(m.method==='account/read')return send({id:m.id,result:{account:cached.account||external?{type:'chatgpt',planType:'plus'}:null,requiresOpenaiAuth:true}});
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'fixture-thread-'+launch+'-'+(++seq)}}});
  if(m.method==='thread/read')return send({id:m.id,result:{thread:{status:{type:'idle'}}}});
  if(m.method==='turn/start'){
    const id='fixture-turn-'+launch+'-'+(++seq),threadId=m.params.threadId;
    if(m.params.input.some(i=>i.text==='hold')){held={id,threadId};return send({id:m.id,result:{turn:{id,status:'inProgress',items:[]}}});}
    const scenario=read('scenario.json'),fail=read('auth.json').account!==cached.account||scenario.failAll||scenario.failLaunch===launch;
    return send({id:m.id,result:{turn:finish(id,threadId,fail)}});
  }
  if(m.method==='test/release'&&held){finish(held.id,held.threadId);held=null;}
  send({id:m.id,result:{}});
});
