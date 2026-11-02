import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDataRoot} from '../src/data-root.mjs';
import {sharedConfigFile} from '../src/shared-codex-transport.mjs';

export async function startSharedCodexMac({root=resolveDataRoot(),exec=promisify(execFile),spawnApp=spawn,log=console.log,noOpen=false}={}){
  const config=JSON.parse(await readFile(sharedConfigFile(root),'utf8'));
  const app=config.app||['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT','/Applications/Codex.app/Contents/MacOS/Codex'].find(existsSync);
  if(!app||!existsSync(app)||!config.wrapper||!existsSync(config.wrapper)||!config.original||!existsSync(config.original))throw new Error('桌面应用或共享连接入口缺失，请重新准备');
  let running=false;
  for(const name of ['ChatGPT','Codex'])try{const r=await exec('/usr/bin/pgrep',['-x',name]);running||=!!r.stdout.trim();}catch(e){if(e.code!==1)throw new Error('无法确认桌面 Codex 是否运行；已保留现有进程。');}
  if(running){
    const bundle=app.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
    if(!bundle)throw new Error('无法定位桌面应用包；已保留现有进程。');
    await exec('/usr/bin/open',['-a',bundle]);
    log('已请求显示现有桌面窗口，本次没有切换共享连接。若检查仍未就绪，请等工作结束后完全退出桌面 Codex，再运行共享入口。');
  }else{
    const child=spawnApp(app,[],{env:{...process.env,CODEX_CLI_PATH:config.wrapper},detached:true,stdio:'ignore'});
    await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});
    child.unref();
    log('已请求打开桌面 Codex 窗口；共享服务将在后台运行。');
  }
  if(!noOpen)try{
    // Reuse saved data, port, instance checks and the normal Safari launcher.
    await exec(process.execPath,[fileURLToPath(new URL('./mac-launcher.mjs',import.meta.url)),'start'],{env:{...process.env,BRIDGE_DATA_DIR:root},timeout:120000,maxBuffer:1024*1024});
  }catch{throw new Error('桌面窗口已请求打开，但助手控制台启动失败。请运行 start-mac.command 查看启动错误。');}
  log('请在助手控制台点击“检查共享连接”；通过检查后才表示共享连接就绪。');
  return {desktopRunning:running};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('此入口用于 Apple 芯片 macOS');
  try{await startSharedCodexMac({noOpen:process.argv.includes('--no-open')});}catch(e){console.error(e.message);process.exitCode=1;}
}
