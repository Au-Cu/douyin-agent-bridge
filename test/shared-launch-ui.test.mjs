import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {startSharedCodexMac} from '../scripts/start-shared-codex-mac.mjs';

const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));
async function fixture(){
  await mkdir(base,{recursive:true});const project=await mkdtemp(join(base,'共享窗口 空格-')),root=join(project,'saved data');
  await mkdir(join(root,'desktop-shared'),{recursive:true});await mkdir(join(project,'scripts'));
  const app=join(project,'助手.app','Contents','MacOS','ChatGPT').replaceAll('\\','/'),wrapper=join(root,'desktop-shared','wrapper'),original=join(project,'core');
  await mkdir(join(project,'助手.app','Contents','MacOS'),{recursive:true});for(const p of [app,wrapper,original])await writeFile(p,'fixture');
  const config={app,wrapper,original};await writeFile(join(root,'desktop-shared','connection.json'),JSON.stringify(config));
  return {project,root,config};
}

async function windowsLaunch({running=false,fail='',noOpen=false,initial='original-cli'}={}){
  const f=await fixture();await copyFile(fileURLToPath(new URL('../scripts/StartSharedCodex.ps1',import.meta.url)),join(f.project,'scripts','StartSharedCodex.ps1'));
  await writeFile(join(f.project,'scripts','Launcher.ps1'),'function Get-BridgeDataRoot { param($ProjectRoot, [switch]$Prepare) return $env:BRIDGE_DATA_DIR }');
  await writeFile(join(f.project,'Start.ps1'),`$global:events += @{event='console';cli=$env:CODEX_CLI_PATH}
if ($env:BRIDGE_TEST_FAIL -eq 'console') { throw 'fixture-console-failure' }
`);
  const driver=join(f.project,'driver.ps1');await writeFile(driver,`\uFEFF$global:events=@()
function Get-Process { param($Name,$ErrorAction) if($env:BRIDGE_TEST_RUNNING -eq '1'){[pscustomobject]@{Path=$env:BRIDGE_TEST_APP}} }
function Start-Process { param($FilePath,$WindowStyle) $global:events+=@{event='desktop';path=$FilePath;style=[string]$WindowStyle;cli=$env:CODEX_CLI_PATH}; if($env:BRIDGE_TEST_FAIL -eq 'desktop'){throw 'fixture-launch-failure'} }
function Stop-Process { throw 'must-not-stop-an-existing-chat' }
try { & (Join-Path $PSScriptRoot 'scripts\\StartSharedCodex.ps1') -NoOpen:($env:BRIDGE_TEST_NO_OPEN -eq '1') } catch { $global:events+=@{event='error';message=$_.Exception.Message} }
$global:events+=@{event='final';cli=$env:CODEX_CLI_PATH}
Write-Output ('EVENTS '+(ConvertTo-Json -InputObject $global:events -Compress -Depth 4))
`,'utf8');
  const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver],{windowsHide:true,env:{...process.env,BRIDGE_DATA_DIR:f.root,BRIDGE_TEST_APP:f.config.app,BRIDGE_TEST_RUNNING:running?'1':'0',BRIDGE_TEST_FAIL:fail,BRIDGE_TEST_NO_OPEN:noOpen?'1':'0',CODEX_CLI_PATH:initial},stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const code=await new Promise((yes,no)=>{p.once('error',no);p.once('close',yes);});assert.equal(code,0,err);const line=out.split(/\r?\n/).find(v=>v.startsWith('EVENTS '));assert.ok(line,out+err);
  return {...f,events:JSON.parse(line.slice(7)),out};
}

test('Windows shared entry opens a visible desktop and console with separately scoped environments',{skip:process.platform!=='win32'},async()=>{
  const {events,config}=await windowsLaunch();assert.deepEqual(events.map(e=>e.event),['desktop','console','final']);
  assert.equal(events[0].style,'Normal');assert.equal(events[0].path,config.app);assert.equal(events[0].cli,config.wrapper);assert.equal(events[1].cli,'original-cli');assert.equal(events[2].cli,'original-cli');
  const empty=await windowsLaunch({initial:''});assert.equal(empty.events[0].cli,empty.config.wrapper);assert.equal(empty.events[1].cli,null);assert.equal(empty.events[2].cli,null);
});
test('Windows repeated launch shows an existing custom-path desktop without replacing its connection or stopping it',{skip:process.platform!=='win32'},async()=>{
  const {events,out}=await windowsLaunch({running:true});assert.deepEqual(events.map(e=>e.event),['desktop','console','final']);assert.equal(events[0].style,'Normal');assert.equal(events[0].cli,'original-cli');assert.match(out,/本次没有切换共享连接/);
});
test('Windows launch failure restores the environment and console failures remain visible',{skip:process.platform!=='win32'},async()=>{
  const failed=await windowsLaunch({fail:'desktop'});assert.deepEqual(failed.events.map(e=>e.event),['desktop','error','final']);assert.equal(failed.events.at(-1).cli,'original-cli');assert.match(failed.events[1].message,/fixture-launch-failure/);
  const consoleFailed=await windowsLaunch({fail:'console'});assert.deepEqual(consoleFailed.events.map(e=>e.event),['desktop','console','error','final']);assert.match(consoleFailed.events[2].message,/助手控制台启动失败/);
  const noOpen=await windowsLaunch({noOpen:true});assert.deepEqual(noOpen.events.map(e=>e.event),['desktop','final']);
});

async function macLaunch({running=false,fail='',noOpen=false}={}){
  const f=await fixture(),calls=[],logs=[],before=process.env.CODEX_CLI_PATH;
  const exec=async(command,args,options)=>{
    calls.push({command,args,options});
    if(command==='/usr/bin/pgrep'){
      if(fail==='probe')throw Object.assign(new Error('fixture-probe'),{code:'EACCES'});
      if(running&&args[1]==='ChatGPT')return {stdout:'123\n'};
      throw Object.assign(new Error('no-match'),{code:1});
    }
    if(fail==='console'&&command===process.execPath)throw new Error('fixture-console-failure');
    return {stdout:''};
  };
  const spawnApp=(command,args,options)=>{
    calls.push({command,args,options});const child=new EventEmitter();child.unref=()=>calls.push({event:'unref'});
    queueMicrotask(()=>child.emit(fail==='desktop'?'error':'spawn',new Error('fixture-launch-failure')));return child;
  };
  let result,error;try{result=await startSharedCodexMac({root:f.root,exec,spawnApp,log:t=>logs.push(t),noOpen});}catch(e){error=e;}
  assert.equal(process.env.CODEX_CLI_PATH,before);return {...f,calls,logs,result,error,before};
}
test('Mac shared entry passes the wrapper only to the new desktop and reuses the saved-profile console launcher',async()=>{
  const r=await macLaunch();assert.equal(r.error,undefined);assert.equal(r.result.desktopRunning,false);
  const desktop=r.calls.find(c=>c.command===r.config.app),consoleCall=r.calls.find(c=>c.command===process.execPath);
  assert.equal(desktop.options.env.CODEX_CLI_PATH,r.config.wrapper);assert.equal(desktop.options.detached,true);assert.equal(consoleCall.options.env.CODEX_CLI_PATH,r.before);assert.equal(consoleCall.options.env.BRIDGE_DATA_DIR,r.root);assert.equal(consoleCall.args[1],'start');assert.match(consoleCall.args[0],/mac-launcher\.mjs$/);
});
test('Mac repeated entry activates the configured bundle and opens the console without spawning another shared writer',async()=>{
  const r=await macLaunch({running:true});assert.equal(r.error,undefined);assert.equal(r.result.desktopRunning,true);assert.equal(r.calls.some(c=>c.command===r.config.app),false);assert.deepEqual(r.calls.find(c=>c.command==='/usr/bin/open').args,['-a',r.config.app.split('/Contents/')[0]]);assert.match(r.logs[0],/本次没有切换共享连接/);assert.ok(r.calls.some(c=>c.command===process.execPath));
});
test('Mac startup distinguishes absent process, failed probe, failed spawn and failed console without claiming readiness',async()=>{
  const probe=await macLaunch({fail:'probe'});assert.match(probe.error.message,/无法确认/);assert.equal(probe.calls.length,1);
  const desktop=await macLaunch({fail:'desktop'});assert.match(desktop.error.message,/fixture-launch-failure/);assert.equal(desktop.calls.some(c=>c.command===process.execPath),false);
  const consoleFailed=await macLaunch({fail:'console'});assert.match(consoleFailed.error.message,/助手控制台启动失败/);assert.equal(consoleFailed.logs.some(t=>t.includes('通过检查后')),false);
  const noOpen=await macLaunch({noOpen:true});assert.equal(noOpen.error,undefined);assert.equal(noOpen.calls.some(c=>c.command===process.execPath),false);
});
