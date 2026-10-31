import { mkdir,readFile,writeFile,stat,rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../data/runtime/',import.meta.url));
if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw new Error('此安装入口支持 Windows x64/ARM64');
await mkdir(root,{recursive:true});
try{if((await stat(join(root,'ffmpeg.exe'))).size>10000000){console.log('FFmpeg 已就绪');process.exit(0);}}catch{}
// Windows on ARM supports running this x64 executable. The Node native ASR addon
// remains ARM64; do not force npm's entire dependency tree to x64.
console.log('安装适用于 Windows 的视频处理工具…');
const response=await fetch('https://registry.npmjs.org/@ffmpeg-installer/win32-x64/4.1.0',{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('无法读取 FFmpeg 包信息');
const meta=await response.json();const archive=join(root,'ffmpeg.tgz');
const binary=await fetch(meta.dist.tarball,{signal:AbortSignal.timeout(180000)});if(!binary.ok)throw new Error('FFmpeg 下载失败');
const data=Buffer.from(await binary.arrayBuffer());
const [algorithm,digest]=meta.dist.integrity.split('-');
if(createHash(algorithm).update(data).digest('base64')!==digest)throw new Error('FFmpeg 下载校验失败');
await writeFile(archive,data);
const extract=await new Promise((resolve,reject)=>{const p=spawn('tar',['-xzf',archive,'-C',root,'package/ffmpeg.exe','package/package.json','package/README.md'],{windowsHide:true});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('FFmpeg 解压失败')));});
await rename(join(root,'package','ffmpeg.exe'),join(root,'ffmpeg.exe'));
console.log('FFmpeg 安装完成');
