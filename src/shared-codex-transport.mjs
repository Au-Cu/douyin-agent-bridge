import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile,lstat,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';

export const sharedConfigFile=root=>join(root,'desktop-shared','connection.json');
export const desktopUnavailable=()=>Object.assign(new Error('桌面共享连接尚未就绪，请从“启动共享 Codex”入口启动桌面应用；任务尚未提交'),{code:'DESKTOP_NOT_CONNECTED',notSubmitted:true});

// Call only while holding the private broker startup lock. A forced shutdown
// can leave a Unix socket inode behind; never remove a live or foreign socket.
export async function clearStaleSharedSocket(endpoint){
  if(process.platform==='win32')return false;
  let before;try{before=await lstat(endpoint);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  const folder=await lstat(dirname(endpoint));if(!before.isSocket()||before.uid!==process.getuid()||!folder.isDirectory()||folder.uid!==process.getuid()||(folder.mode&0o077))throw new Error('共享通信路径无法安全恢复，已保留原文件');
  const refused=await new Promise(resolve=>{const socket=net.createConnection(endpoint),timer=setTimeout(()=>finish(false),500);const finish=value=>{clearTimeout(timer);socket.destroy();resolve(value);};socket.once('connect',()=>finish(false));socket.once('error',e=>finish(e.code==='ECONNREFUSED'));});
  if(!refused)return false;const after=await lstat(endpoint);if(after.ino!==before.ino||after.dev!==before.dev||!after.isSocket())throw new Error('共享通信路径已变化，未清理');await unlink(endpoint);return true;
}

// A client owns only this pipe connection. Closing it must never kill the
// desktop's Codex process or another chat's work.
export class SharedCodexTransport extends EventEmitter {
  constructor(socket){super();this.socket=socket;this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();this.stdin.pipe(socket);socket.pipe(this.stdout);socket.on('error',e=>this.emit('error',e));socket.once('close',()=>this.emit('exit',0));}
  kill(){this.socket.destroy();}
}
export async function connectSharedCodex(root,{role='bridge',timeoutMs=4000}={}){
  let config;try{config=JSON.parse(await readFile(sharedConfigFile(root),'utf8'));}catch{throw desktopUnavailable();}
  if(config.version!==1||typeof config.endpoint!=='string'||!/^[a-f0-9]{64}$/.test(config.token||''))throw desktopUnavailable();
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(config.endpoint);let buffer='',settled=false;
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();reject(desktopUnavailable());};
    const timer=setTimeout(fail,timeoutMs);socket.once('error',fail);socket.once('connect',()=>socket.write(JSON.stringify({sharedCodex:1,token:config.token,role})+'\n'));
    const data=chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>4096)return fail();const end=buffer.indexOf('\n');if(end<0)return;let response;try{response=JSON.parse(buffer.slice(0,end));}catch{return fail();}if(!response.ready)return fail();settled=true;clearTimeout(timer);socket.off('error',fail);socket.off('data',data);const transport=new SharedCodexTransport(socket);const rest=buffer.slice(end+1);if(rest)transport.stdout.write(rest);resolve(transport);};socket.on('data',data);
  });
}
