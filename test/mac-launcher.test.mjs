import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,chmodSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createServer} from 'node:net';import {once} from 'node:events';
import {ffmpegPath} from '../src/media.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));mkdirSync(join(project,'data'),{recursive:true});

test('Mac 启动器复用同一实例，拒绝其他资料停止，并正常恢复和关闭',{skip:process.platform!=='darwin'},async()=>{
  assert.equal(process.arch,'arm64');const root=mkdtempSync(join(project,'data','mac-launcher-'));mkdirSync(join(root,'runtime'),{recursive:true});copyFileSync(ffmpegPath(),join(root,'runtime','ffmpeg'));chmodSync(join(root,'runtime','ffmpeg'),0o755);
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
  const env={...process.env,BRIDGE_DATA_DIR:root,CODEX_HOME:join(root,'codex-fixture'),CODEX_BIN:join(project,'test','fixture-rpc.mjs'),BRIDGE_PORT:''},script=join(project,'scripts','mac-launcher.mjs');
  const run=(action,extra=[],more={})=>spawnSync(process.execPath,[script,action,...extra],{cwd:project,env:{...env,...more},encoding:'utf8',timeout:60000});
  try{let r=run('start',['--port',String(port),'--no-open']);assert.equal(r.status,0,r.stderr);const pid=readFileSync(join(root,'server.pid'),'utf8');r=run('start',['--port',String(port),'--no-open']);assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(root,'server.pid'),'utf8'),pid);
    const wrong=run('stop',['--port',String(port)],{BRIDGE_DATA_DIR:join(root,'other-profile')});assert.notEqual(wrong.status,0);assert.equal((await fetch('http://127.0.0.1:'+port)).status,200);
    r=run('stop',['--port',String(port)]);assert.equal(r.status,0,r.stderr);
  }finally{try{run('stop',['--port',String(port)]);}catch{}}
});

test('Mac 版 Safari AppleScript 可以由系统编译，不依赖读取其他窗口',{skip:process.platform!=='darwin'},async()=>{
  const {SafariDouyinAdapter}=await import('../src/safari.mjs'),{scanConversation}=await import('../src/douyin.mjs');const sources=[];const adapter=new SafariDouyinAdapter({root:'unused',executeAppleScript:async text=>{sources.push(text);return JSON.stringify({ok:true,value:text.includes('getItem')?'fixture':true});}});adapter.windowId=123;adapter.tabIndex=1;adapter.marker='fixture';await adapter.inTab('return true;');await adapter.inTab(`const f=(${scanConversation.toString()});return f.call(window);`);await adapter.inTab(`return ${JSON.stringify('第一段\n第二段 👌')};`);
  const folder=mkdtempSync(join(project,'data','mac-osa-'));for(let i=0;i<sources.length;i++){const file=join(folder,`test-${i}.scpt`),result=spawnSync('/usr/bin/osacompile',['-o',file,'-'],{input:sources[i],encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);}
});

test('Mac 版 Safari 的新建窗口、视频页和清理脚本可由系统编译',{skip:process.platform!=='darwin'},async()=>{
  const {SafariDouyinAdapter}=await import('../src/safari.mjs'),sources=[],root=mkdtempSync(join(project,'data','mac-safari-'));
  const tabs=[];
  const adapter=new SafariDouyinAdapter({root,executeAppleScript:async script=>{sources.push(script);if(script.includes('make new document')){tabs.push('https://www.douyin.com/chat?isPopup=1');return '246';}if(script.includes('URL of every tab of window id'))return tabs.map((url,i)=>(i+1)+'\t'+url).join('\n')+'\n';if(script.includes('make new tab with properties')){tabs.push('https://www.douyin.com/video/1234567890123');return '';}if(script.includes('then close t'))return '';if(script.includes('const id='))return JSON.stringify({ok:true,value:{url:'https://v.douyinvod.com/example.mp4',title:'样例',seconds:2}});return JSON.stringify({ok:true,value:true});}});
  await adapter.open();const video=await adapter.resolveVideo({awemeId:'1234567890123'});assert.equal(video.seconds,2);assert.ok(sources.length>=5,'新建窗口、视频页和清理脚本都要经过系统编译');
  const folder=mkdtempSync(join(project,'data','mac-osa-all-'));for(let i=0;i<sources.length;i++){const result=spawnSync('/usr/bin/osacompile',['-o',join(folder,`test-${i}.scpt`),'-'],{input:sources[i],encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);}
});
