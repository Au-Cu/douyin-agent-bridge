import {openSync,closeSync,writeFileSync,fsyncSync,renameSync,mkdirSync,existsSync,readFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export function durableWrite(file,text){
  mkdirSync(dirname(file),{recursive:true});const temporary=file+'.tmp',fd=openSync(temporary,'w',0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,file);
  // Windows does not expose directory fsync through Node on every filesystem.
  let directory;try{directory=openSync(dirname(file),'r');fsyncSync(directory);}catch{}finally{if(directory!==undefined)closeSync(directory);}
}
export const durableJson=(file,value)=>durableWrite(file,JSON.stringify(value,null,2)+'\n');
export function processAlive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
export function lockStorage(root,name='bridge.lock'){
  mkdirSync(root,{recursive:true});const file=join(resolve(root),name),value=JSON.stringify({pid:process.pid,nonce:randomUUID(),created:Date.now()});
  for(let attempt=0;attempt<2;attempt++){
    let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,value);fsyncSync(fd);closeSync(fd);return ()=>{if(existsSync(file)&&readFileSync(file,'utf8')===value)unlinkSync(file);};}
    catch(e){if(fd!==undefined)try{closeSync(fd);}catch{}if(e.code!=='EEXIST')throw e;
      let old;try{old=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('数据目录的锁文件不完整，已停止启动以保护原数据。');}
      if(!Number.isInteger(old.pid)||old.pid<=0||processAlive(old.pid))throw new Error('这套数据已被另一个助手进程使用，请打开已有面板或先停止旧程序。');
      try{if(readFileSync(file,'utf8')===JSON.stringify(old))unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }
  throw new Error('数据目录正在启动，请稍后重试。');
}
