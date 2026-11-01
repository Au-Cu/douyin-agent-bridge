import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createServer as netServer} from 'node:net';import {createServer} from 'node:http';import {once} from 'node:events';
import {SafariDouyinAdapter} from '../src/safari.mjs';
assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
const reserve=async()=>{const s=netServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const pagePort=await reserve(),driverPort=await reserve();
const body=`<!doctype html><meta charset="utf-8"><div class="RightPanelHeadertitle">用户</div><div class="messageMessageBoxcontentBox" data-direction="in" style="height:60px"><div class="MessageBoxContentactiveClickArea">原消息</div></div><div contenteditable="true" style="position:absolute;left:350px;top:450px;width:400px;height:80px"></div><script>
const row=document.querySelector('.messageMessageBoxcontentBox');row.__reactProps$fixture={message:{serverId:'9000000000001',sender:'owner',conversationId:'bound-chat',createTime:Date.now(),content:JSON.stringify({text:'原消息'})}};
row.addEventListener('contextmenu',e=>{e.preventDefault();const menu=document.createElement('div');menu.setAttribute('role','menu');menu.style='position:absolute;left:20px;top:100px;width:200px;height:80px';menu.innerHTML='<button aria-label="[OK]">👌</button>';menu.firstChild.onclick=()=>{const p=document.createElement('span');p.className='message-reaction';p.textContent='👌';row.append(p);menu.remove();};document.body.append(menu);});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('[role=menu]').forEach(n=>n.remove());});
document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const ed=e.currentTarget,reply=document.createElement('div');reply.className='messageMessageBoxcontentBox';reply.dataset.direction='out';reply.style.height='60px';reply.__reactProps$fixture={message:{serverId:'9000000000002',sender:'assistant',conversationId:'bound-chat',createTime:Date.now(),content:JSON.stringify({text:ed.innerText})}};reply.textContent=ed.innerText;document.body.append(reply);ed.textContent='';});</script>`;
const site=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(body);});site.listen(pagePort,'127.0.0.1');await once(site,'listening');
const driver=spawn('/usr/bin/safaridriver',['-p',String(driverPort)],{stdio:['ignore','ignore','pipe']});let errors='';driver.stderr.on('data',b=>errors=(errors+b).slice(-1500));
const endpoint='http://127.0.0.1:'+driverPort,request=async(path,data,method='POST')=>{const r=await fetch(endpoint+path,{method,headers:{'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(45000)}),json=await r.json();if(!r.ok||json.value?.error)throw new Error('Safari WebDriver: '+(json.value?.message||r.status));return json.value;};let session;
try{
  let ready=false;for(let i=0;i<80;i++){if(driver.exitCode!==null)throw new Error('SafariDriver exited: '+errors);try{const r=await fetch(endpoint+'/status',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'SafariDriver not ready');
  const created=await request('/session',{capabilities:{alwaysMatch:{browserName:'safari'}}});session=created.sessionId;assert.ok(session);const base='/session/'+session;
  await request(base+'/url',{url:'http://127.0.0.1:'+pagePort+'/chat'});
  const adapter=new SafariDouyinAdapter({root:'fixture'});adapter.page={};adapter.windowId=1;
  adapter.inTab=async code=>request(base+'/execute/sync',{script:'return (()=>{'+code.replaceAll('/^https:\\/\\/(www\\.)?douyin\\.com\\//','/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//')+'})()',args:[]});
  const owner={chatKey:'bound-chat',peerUid:'owner'},scan=await adapter.scan();assert.equal(scan.peer?.chatKey,owner.chatKey);
  const reaction=await adapter.react(owner,'9000000000001',{emojis:['👌']});assert.equal(reaction.verified,true);
  const reply=await adapter.send(owner,'第一段\n第二段');assert.equal(reply.messageId,'9000000000002');
  console.log(JSON.stringify({platform:'darwin-arm64',browser:'Safari WebDriver synthetic fixture',receive:true,send:true,reaction:true,realDouyinAccount:false}));
}finally{if(session)await request('/session/'+session,null,'DELETE').catch(()=>{});driver.kill();await new Promise(r=>site.close(r));}
