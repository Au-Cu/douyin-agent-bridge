import {spawn} from 'node:child_process';
import {closeSync,existsSync,openSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareDataRoot,resolveDataRoot,inspectData} from '../src/data-root.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const [action,...args]=process.argv.slice(2);
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('此入口仅适用于 Apple 芯片的 macOS，请使用原生 ARM64 Node.js。');
const [major,minor]=process.versions.node.split('.').map(Number);if(major<24||major===24&&minor<5)throw new Error('请先安装 Node.js 24.5.0 或更高版本。');
const run=(command,argv,options={})=>new Promise((resolveRun,reject)=>{const child=spawn(command,argv,{cwd:project,stdio:'inherit',...options});child.on('error',reject);child.on('exit',code=>code===0?resolveRun():reject(new Error(command+' 退出，状态 '+code)));});
const argument=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const selectedPort=root=>{const value=Number(argument('--port')||process.env.BRIDGE_PORT||inspectData(root).config.port||39361);if(!Number.isInteger(value)||value<1024||value>65535)throw new Error('端口必须为 1024–65535 的整数');return value;};
async function connection(root,port){
  const base='http://127.0.0.1:'+port;let page;
  try{page=await fetch(base,{signal:AbortSignal.timeout(2500)});}catch(e){if(e.cause?.code==='ECONNREFUSED')return null;throw new Error('无法核验该端口，请检查占用或使用其他端口。');}
  if(!page.ok||!(await page.text()).includes('douyin-bridge-console'))throw new Error('该端口已被其他程序占用。');
  const cookie=page.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('无法核验已有助手实例。');
  const headers={cookie,origin:base,'content-type':'application/json'},request=async(path,body)=>{const r=await fetch(base+'/api/'+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const value=await r.json();if(!r.ok)throw new Error(value.error||'助手请求失败');return value;};
  const identity=await request('instance');if(identity.app!=='douyin-codex-bridge'||resolve(identity.dataRoot)!==resolve(root))throw new Error('该端口属于另一套数据，请使用不同端口。');
  return {base,request};
}
async function start(){
  const root=await prepareDataRoot(project),port=selectedPort(root);let existing=await connection(root,port);
  if(!existing){
    if(!existsSync(join(project,'node_modules','@openai','codex','bin','codex.js')))await run('npm',['ci','--no-audit','--no-fund']);
    await run(process.execPath,['--use-env-proxy',join(project,'scripts','setup-runtime.mjs')]);
    const out=openSync(join(root,'server.stdout.log'),'a',0o600),err=openSync(join(root,'server.stderr.log'),'a',0o600);
    let child;try{child=spawn(process.execPath,['--use-env-proxy',join(project,'src','server.mjs'),'--port',String(port),'--data-dir',root],{cwd:project,env:process.env,detached:true,stdio:['ignore',out,err]});child.unref();}finally{closeSync(out);closeSync(err);}
    await writeFile(join(root,'server.pid'),String(child.pid)+'\n',{mode:0o600});
    for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,250));try{existing=await connection(root,port);if(existing)break;}catch(e){if(i===99)throw e;}}
    if(!existing)throw new Error('助手未启动，请检查固定数据目录中的 server.stderr.log。');
  }
  console.log('助手控制台：'+existing.base);
  if(!args.includes('--no-open'))await run('/usr/bin/open',['-a','Safari',existing.base]);
}
async function install(){
  await prepareDataRoot(project);console.log('安装项目依赖和官方 Codex CLI…');await run('npm',['ci','--no-audit','--no-fund']);
  await run(process.execPath,['--use-env-proxy',join(project,'scripts','setup-runtime.mjs')]);
  if(!args.includes('--skip-model'))await run(process.execPath,['--use-env-proxy',join(project,'scripts','setup-asr.mjs')]);
  if(!args.includes('--skip-doctor'))try{await run(process.execPath,[join(project,'scripts','doctor.mjs')]);}catch{console.log('部分检查仍需完成；新用户请先运行 npm run codex:login。');}
  console.log('安装结束。请用自己的 Codex 和抖音助手账号登录。');
}
async function stop(){const root=resolveDataRoot(),port=selectedPort(root),existing=await connection(root,port);if(!existing){console.log('助手未运行。');return;}await existing.request('shutdown',{force:args.includes('--force')});console.log('助手已停止，登录和资料已保留。');}
if(action==='start')await start();else if(action==='install')await install();else if(action==='stop')await stop();else throw new Error('用法：node scripts/mac-launcher.mjs install|start|stop');
