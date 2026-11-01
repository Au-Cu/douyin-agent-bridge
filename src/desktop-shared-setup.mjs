import {readFile,writeFile,mkdir,chmod,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {durableJson} from './durable.mjs';
import {sharedConfigFile} from './shared-codex-transport.mjs';

const exec=promisify(execFile),project=fileURLToPath(new URL('../',import.meta.url)),sh=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function installedDesktop(){
  if(process.platform==='win32'){
    const script="$all=Get-CimInstance Win32_Process; $app=$all | Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') -and $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.' } | Select-Object -First 1; if($app){$core=$all | Where-Object { $_.ParentProcessId -eq $app.ProcessId -and $_.Name -eq 'codex.exe' -and $_.CommandLine -match '\\bapp-server\\b' } | Select-Object -First 1; if($core){@{original=$core.ExecutablePath;app=$app.ExecutablePath}|ConvertTo-Json -Compress}}";
    try{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:8000});return JSON.parse(r.stdout);}catch{return {};}
  }
  for(const [original,app]of [['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'],['/Applications/Codex.app/Contents/Resources/codex','/Applications/Codex.app/Contents/MacOS/Codex']])if(existsSync(original))return {original,app};return {};
}
export async function prepareDesktopShared(root,{original=process.env.CODEX_APP_RUNTIME_CLI_PATH,app}={}){
  const installed=await installedDesktop();original||=installed.original;app||=installed.app;
  root=resolve(root);const folder=dirname(sharedConfigFile(root));await mkdir(folder,{recursive:true,mode:0o700});
  let config;try{config=JSON.parse(await readFile(sharedConfigFile(root),'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('已有桌面连接配置损坏，已保留原文件');}
  if(!original||config?.wrapper&&resolve(original)===resolve(config.wrapper))original=config?.original;
  if(!original||!existsSync(original))throw new Error('请在 Codex 中运行一次 npm run setup:desktop，或通过 --codex 指定桌面自带 Codex 可执行文件。');original=resolve(original);
  const key=createHash('sha256').update(resolve(root)).digest('hex').slice(0,18),socketFolder=process.platform==='win32'?null:join('/tmp','douyin-codex-'+(process.getuid?.()??0)+'-'+key);
  if(socketFolder){await mkdir(socketFolder,{recursive:true,mode:0o700});const s=await lstat(socketFolder);if(s.uid!==process.getuid()||!s.isDirectory()||s.isSymbolicLink())throw new Error('本机共享通信目录不属于当前用户');await chmod(socketFolder,0o700);}
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\douyin-codex-'+key:join(socketFolder,'rpc.sock');
  config={version:1,endpoint,token:config?.token||randomBytes(32).toString('hex'),original,node:process.execPath,project,app:app||config?.app||''};durableJson(sharedConfigFile(root),config);
  const proxy=join(project,'scripts','shared-codex-proxy.mjs');let wrapper;
  if(process.platform==='win32'){
    const source=join(project,'scripts','SharedCodexLauncher.cs'),hash=createHash('sha256').update(await readFile(source)).digest('hex').slice(0,12);wrapper=join(folder,'codex-shared-'+hash+'.exe');await writeFile(join(folder,'launcher-paths.txt'),[process.execPath,proxy,sharedConfigFile(root)].join('\r\n')+'\r\n',{mode:0o600});
    const compiler=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    if(!existsSync(wrapper))try{await exec(compiler,['/nologo','/codepage:65001','/target:exe','/platform:anycpu','/out:'+wrapper,source],{windowsHide:true,timeout:20000});}catch{throw new Error('无法生成本机 Codex 连接入口，请检查 Windows .NET Framework。');}
  }else{
    wrapper=join(folder,'codex-shared');await writeFile(wrapper,'#!/bin/sh\nexec '+sh(process.execPath)+' '+sh(proxy)+' '+sh(sharedConfigFile(root))+' "$@"\n',{mode:0o700});await chmod(wrapper,0o700);
  }
  config.wrapper=wrapper;durableJson(sharedConfigFile(root),config);
  return {prepared:true,wrapper,launcher:join(project,process.platform==='win32'?'启动共享Codex.cmd':'start-shared-codex-mac.command')};
}
