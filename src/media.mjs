import { fileURLToPath } from 'node:url';
import { spawn,fork } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {existsSync} from 'node:fs';
import {resolveDataRoot} from './data-root.mjs';
import {durableJson,durableWrite} from './durable.mjs';
import { modelName } from '../scripts/setup-asr.mjs';
import {operationContext,checkWork,workSignal,trackStop,interruptedError} from './execution.mjs';
const legacyFfmpeg=fileURLToPath(new URL('../data/runtime/ffmpeg.exe',import.meta.url));

export function runFfmpeg(args,timeout=180000) {
  checkWork();const signal=workSignal(),scope=operationContext.getStore();
  return new Promise((resolve,reject)=>{
    const stable=join(resolveDataRoot(),'runtime','ffmpeg.exe'),ffmpeg=existsSync(stable)?stable:legacyFfmpeg;
    const child=spawn(ffmpeg,args,{windowsHide:true});let stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('音视频处理超时'));},timeout);
    if(scope){scope.processes||=new Set();scope.processes.add(child);}
    const abort=()=>{trackStop(new Promise(done=>child.once('exit',()=>done({confirmed:true}))),scope);child.kill();reject(signal.reason||interruptedError());};signal?.addEventListener('abort',abort,{once:true});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-24000);});child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('exit',code=>{clearTimeout(timer);scope?.processes?.delete(child);signal?.removeEventListener('abort',abort);code===0?resolve(stderr):reject(new Error('音视频处理失败：'+stderr.slice(-900)));});
  });
}
export async function transcribe(wav,model,progress=()=>{}) {
  checkWork();const signal=workSignal();
  try{await stat(join(model,'model.int8.onnx'));}catch{throw new Error('本地口播转写模型尚未安装，请在控制台点击“安装转写模型”');}
  return new Promise((resolve,reject)=>{
    checkWork();
    const worker=fork(new URL('./asr-worker.mjs',import.meta.url),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    const scope=operationContext.getStore();if(scope){scope.processes||=new Set();scope.processes.add(worker);}
    const abort=()=>{trackStop(new Promise(done=>worker.once('exit',()=>done({confirmed:true}))),scope);worker.kill();reject(signal.reason||interruptedError());};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{worker.kill();reject(new Error('本地口播转写超时'));},12*60*1000);
    worker.on('message',msg=>{if(msg.type==='progress')progress(msg.progress);if(msg.type==='result'){clearTimeout(timer);worker.kill();resolve(msg.segments);}if(msg.type==='error'){clearTimeout(timer);worker.kill();reject(new Error(msg.error));}});
    worker.on('error',e=>{clearTimeout(timer);reject(e);});
    worker.on('exit',code=>{clearTimeout(timer);scope?.processes?.delete(worker);signal?.removeEventListener('abort',abort);if(code!==0)reject(new Error('本地转写工作进程已退出'));});
    worker.send({wav,model});
  });
}
export class MediaProcessor {
  constructor({root,adapter,modelsRoot=join(root,'models'),log=()=>{}}){Object.assign(this,{root,adapter,modelsRoot,log});}
  async process(message,maxSeconds=1800) {
    checkWork();
    const id=message.awemeId;if(!/^\d{12,24}$/.test(id))throw new Error('未提取到有效视频 ID');
    const folder=join(this.root,'knowledge',id);await mkdir(folder,{recursive:true});
    const metadata=await this.adapter.resolveVideo(message);
    if(metadata.seconds>maxSeconds)throw new Error(`视频长于 ${maxSeconds/60} 分钟，请在控制台调整上限后重试`);
    const video=join(folder,'video.mp4');await this.adapter.download(metadata.url,video);
    // Inspect duration even when the platform metadata omits it.
    let info='';try{info=await runFfmpeg(['-hide_banner','-i',video,'-f','null','-t','0','-']);}catch(e){checkWork();info=e.message;}
    const wav=join(folder,'audio.wav');let audioInfo='';let noAudio=false;
    try{audioInfo=await runFfmpeg(['-hide_banner','-y','-i',video,'-t',String(maxSeconds+1),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],300000);}
    catch(e){if(/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(e.message))noAudio=true;else throw e;}
    const match=(audioInfo||info).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const seconds=metadata.seconds||(match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0);
    if(!seconds)throw new Error('未能确认视频时长，停止处理');
    if(seconds>maxSeconds)throw new Error(`实际视频长于 ${maxSeconds/60} 分钟，停止处理`);
    this.log('正在本地转写口播：'+metadata.title.slice(0,50));
    const segments=noAudio?[]:await transcribe(wav,join(this.modelsRoot,modelName));
    const transcript=segments.map(s=>`[${Math.floor(s.seconds/60)}:${String(s.seconds%60).padStart(2,'0')}] ${s.text}`).join('\n');
    const frames=[];const count=Math.min(10,Math.max(2,Math.ceil(seconds/20)));
    for(let i=0;i<count;i++){
      checkWork();
      const second=Math.min(Math.max(0,seconds-0.3),(i+0.4)*seconds/count);const path=join(folder,'frame-'+String(i+1).padStart(2,'0')+'.jpg');
      await runFfmpeg(['-hide_banner','-loglevel','error','-y','-ss',String(second),'-i',video,'-frames:v','1','-vf','scale=960:-2','-q:v','4',path]);frames.push({path,seconds:Math.round(second)});
    }
    // Do not persist expiring CDN URLs, cookies or request headers.
    checkWork();
    const saved={id,title:metadata.title,author:metadata.author,source:metadata.source,seconds,transcript,noAudio,frames,created:new Date().toISOString()};
    durableJson(join(folder,'metadata.json'),saved);
    const path=join(folder,'note.md');durableWrite(path,`# ${saved.title}\n\n来源：${saved.source}\n作者：${saved.author}\n时长：${seconds.toFixed(1)} 秒\n\n## 口播文字稿\n\n${transcript||(noAudio?'此视频没有音轨，后续依据连续视觉记录学习。':'未识别到有效口播，后续依据连续视觉记录学习。')}\n`);
    return {...saved,path};
  }
}
