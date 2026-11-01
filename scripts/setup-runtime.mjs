import { mkdir,writeFile,stat,rename,chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {prepareDataRoot} from '../src/data-root.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
const root=join(await prepareDataRoot(project),'runtime');
const windows=process.platform==='win32'&&['x64','arm64'].includes(process.arch),mac=process.platform==='darwin'&&process.arch==='arm64';
if(!windows&&!mac)throw new Error('此安装入口支持 Windows x64/ARM64 和 macOS Apple 芯片');
await mkdir(root,{recursive:true});
const name=windows?'ffmpeg.exe':'ffmpeg',target=join(root,name);
try{if((await stat(target)).size>10000000){if(mac)await chmod(target,0o755);console.log('FFmpeg 已就绪');process.exit(0);}}catch{}
// Windows on ARM supports running this x64 executable. The Node native ASR addon
// remains ARM64; do not force npm's entire dependency tree to x64.
console.log('安装适用于 '+(windows?'Windows':'macOS Apple 芯片')+' 的视频处理工具…');
const packageVersion=windows?'@ffmpeg-installer/win32-x64/4.1.0':'@ffmpeg-installer/darwin-arm64/4.1.5';
const response=await fetch('https://registry.npmjs.org/'+packageVersion,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('无法读取 FFmpeg 包信息');
const meta=await response.json();const archive=join(root,'ffmpeg.tgz');
const binary=await fetch(meta.dist.tarball,{signal:AbortSignal.timeout(180000)});if(!binary.ok)throw new Error('FFmpeg 下载失败');
const data=Buffer.from(await binary.arrayBuffer());
const [algorithm,digest]=meta.dist.integrity.split('-');
if(mac&&meta.dist.integrity!=='sha512-hYqTiP63mXz7wSQfuqfFwfLOfwwFChUedeCVKkBtl/cliaTM7/ePI9bVzfZ2c+dWu3TqCwLDRWNSJ5pqZl8otA==')throw new Error('FFmpeg 包校验信息不符合固定版本');
if(createHash(algorithm).update(data).digest('base64')!==digest)throw new Error('FFmpeg 下载校验失败');
await writeFile(archive,data);
await new Promise((resolve,reject)=>{const p=spawn('tar',['-xzf',archive,'-C',root,'package/'+name,'package/package.json','package/README.md'],{windowsHide:true});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('FFmpeg 解压失败')));});
await rename(join(root,'package',name),target);if(mac)await chmod(target,0o755);
console.log('FFmpeg 安装完成');
