import { mkdir, stat, rename, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const modelName='sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const archiveSha256='7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e';
export async function setupAsr(dataRoot,log=console.log) {
  const parent=join(dataRoot,'models');const folder=join(parent,modelName);
  try{if((await stat(join(folder,'model.int8.onnx'))).size>200000000){log('本地转写模型已就绪');return folder;}}catch{}
  await mkdir(parent,{recursive:true});
  const archive=join(parent,modelName+'.tar.bz2');
  try{await stat(archive);}catch{
    log('下载中文、粤语等本地转写模型（约 163 MB，解压后约 239 MB）…');
    const response=await fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'+modelName+'.tar.bz2',{signal:AbortSignal.timeout(15*60*1000)});
    if(!response.ok)throw new Error('转写模型下载失败 HTTP '+response.status);
    const file=await open(archive+'.part','w');let bytes=0,last=0;
    try{for await(const chunk of response.body){await file.write(chunk);bytes+=chunk.length;if(bytes-last>25000000){log('已下载 '+Math.round(bytes/1e6)+' MB');last=bytes;}}}finally{await file.close();}
    await rename(archive+'.part',archive);
  }
  const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
  if(hash.digest('hex')!==archiveSha256)throw new Error('转写模型压缩包校验失败，请移走该压缩包后重新安装');
  const run=args=>new Promise((resolve,reject)=>{const child=spawn('tar',args,{windowsHide:true});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',()=>{});child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error('转写模型解压失败，tar 退出码 '+code)));});
  const listing=await run(['-tjf',archive]);
  if(listing.split(/\r?\n/).filter(Boolean).some(p=>!p.startsWith(modelName+'/')||p.split(/[\\/]/).includes('..')))throw new Error('转写模型压缩包路径校验失败');
  await run(['-xjf',archive,'-C',parent]);
  if((await stat(join(folder,'model.int8.onnx'))).size<200000000)throw new Error('转写模型文件不完整');
  log('本地转写模型安装完成');return folder;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await setupAsr(fileURLToPath(new URL('../data/',import.meta.url)));
