import {spawn} from 'node:child_process';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectSharedCodex} from '../src/shared-codex-transport.mjs';

const [file,...args]=process.argv.slice(2),config=JSON.parse(await readFile(file,'utf8'));
// Desktop's main host has this flag; helper/repl app-servers must retain their
// own config, profile and permission isolation. All other CLI commands pass on.
if(!args.includes('app-server')||!args.includes('--analytics-default-enabled')){
  const child=spawn(config.original,args,{env:process.env,stdio:'inherit',windowsHide:true});child.once('error',()=>process.exit(1));child.once('exit',code=>process.exit(code??1));
}else{
  const root=dirname(dirname(file)),launchFile=join(dirname(file),'desktop-launch.json');
  const env={...process.env};delete env.CODEX_CLI_PATH;
  let transport;
  for(let attempt=0;attempt<50;attempt++){
    try{transport=await connectSharedCodex(root,{role:'desktop',timeoutMs:500});break;}catch{}
    if(attempt===0){await writeFile(launchFile,JSON.stringify({args,cwd:process.cwd()}),{mode:0o600});const broker=spawn(process.execPath,[fileURLToPath(new URL('./shared-codex-broker.mjs',import.meta.url)),file,launchFile],{env,detached:true,windowsHide:true,stdio:'ignore'});broker.unref();}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!transport){process.stderr.write('桌面共享服务未启动，请检查连接助手配置。\n');process.exitCode=1;}else{
    process.stdin.pipe(transport.stdin);transport.stdout.pipe(process.stdout);transport.once('exit',()=>process.exit(0));transport.once('error',()=>process.exit(1));process.stdin.once('end',()=>transport.kill());
  }
}
