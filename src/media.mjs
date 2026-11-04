import { fileURLToPath } from 'node:url';
import { spawn,fork } from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {existsSync} from 'node:fs';
import {resolveDataRoot} from './data-root.mjs';
import {durableJson,durableWrite} from './durable.mjs';
import { modelName } from '../scripts/setup-asr.mjs';
import {operationContext,checkWork,workSignal,trackStop,interruptedError} from './execution.mjs';
export function ffmpegPath(){const name=process.platform==='win32'?'ffmpeg.exe':'ffmpeg',stable=join(resolveDataRoot(),'runtime',name),legacy=fileURLToPath(new URL('../data/runtime/'+name,import.meta.url));return existsSync(stable)?stable:legacy;}
export function localAsrEnv(env=process.env){if(process.platform!=='darwin')return {...env};const native=fileURLToPath(new URL('../node_modules/sherpa-onnx-darwin-arm64',import.meta.url));return {...env,DYLD_LIBRARY_PATH:[native,env.DYLD_LIBRARY_PATH].filter(Boolean).join(':')};}

export function runFfmpeg(args,timeout=180000) {
  checkWork();const signal=workSignal(),scope=operationContext.getStore();
  return new Promise((resolve,reject)=>{
    const ffmpeg=ffmpegPath();
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
    const worker=fork(new URL('./asr-worker.mjs',import.meta.url),[],{env:localAsrEnv(),windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
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
  async downloadCandidates(urls,destination,options) {
    let failure;
    for(const url of urls.slice(0,3)){
      checkWork();
      try{await this.adapter.download(url,destination,options);return;}
      catch(e){checkWork();if(['ENOSPC','EACCES','EPERM'].includes(e.code))throw e;failure=e;}
    }
    throw failure||new Error('作品未提供可用的原始媒体地址');
  }
  async prepareAlbum(message,metadata,folder,maxSeconds) {
    const slides=[];
    for(const [index,slide] of metadata.slides.entries()){
      const label=String(index+1).padStart(3,'0'),original=join(folder,'slide-'+label+(slide.motionUrls.length?'.mp4':'.image'));
      await this.downloadCandidates(slide.motionUrls.length?slide.motionUrls:slide.urls,original,{image:!slide.motionUrls.length});
      const file=await open(original,'r');let signature;
      try{const head=Buffer.alloc(21);await file.read(head,0,head.length,0);signature=head;}finally{await file.close();}
      const probe=await runFfmpeg(['-hide_banner','-i',original,'-f','null','-t','0','-']);
      const match=probe.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const seconds=match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0;
      const gif=signature.toString('ascii',0,4)==='GIF8';
      const animatedWebp=signature.toString('ascii',8,16)==='WEBPVP8X'&&(signature[20]&2)!==0;
      if(animatedWebp)throw new Error('原图是动态 WebP，本机暂不能可靠解码全部帧。');
      const animated=slide.motionUrls.length>0||gif&&seconds>0.12;
      if(animated&&(!seconds||seconds>maxSeconds))throw new Error('图文中的动态画面时长无法核实或超过本次时长上限。');
      const count=animated?Math.min(8,Math.max(3,Math.ceil(seconds*2))):1,frames=[];
      for(let i=0;i<count;i++){
        const at=animated?Math.min(seconds*i/count,Math.max(0,seconds-.05)):0,name='overview-slide-'+label+'-'+String(i+1).padStart(2,'0')+'.jpg';
        await runFfmpeg(['-hide_banner','-loglevel','error','-y','-ss',String(at),'-i',original,'-frames:v','1','-vf',"scale='min(1200,iw)':-2",'-q:v','4',join(folder,name)]);
        await stat(join(folder,name));
        frames.push({name,seconds:at});
      }
      slides.push({index:index+1,animated,duration:seconds||0,frames});
    }
    const images=slides.flatMap(slide=>slide.frames.map(frame=>frame.name));
    const path=join(folder,'note.md'),observation=slides.map(s=>'第 '+s.index+' 张'+(s.animated?' · 动态，按顺序提供 '+s.frames.length+' 个时间点':'')+'：'+s.frames.map(f=>f.name+(s.animated?'（'+f.seconds.toFixed(2)+' 秒）':'')).join('、')).join('\n');
    durableWrite(path,'# '+metadata.title+'\n\n来源：'+metadata.source+'\n\n'+observation+'\n');
    durableWrite(join(folder,'visual-analysis.md'),observation+'\n');
    const saved={id:message.awemeId,kind:'album',title:metadata.title,author:metadata.author,source:metadata.source,seconds:0,transcript:'',noAudio:true,frames:[],images,slides,created:new Date().toISOString()};
    durableJson(join(folder,'metadata.json'),saved);
    return {...saved,path};
  }
  async process(message,maxSeconds=1800,{folder:outputFolder,previews=true,requireDurationProbe=false}={}) {
    checkWork();
    const id=message.awemeId;if(!/^\d{12,24}$/.test(id))throw new Error('未提取到有效视频 ID');
    const folder=outputFolder||join(this.root,'knowledge',id);await mkdir(folder,{recursive:true});
    if(message.nativeLive)throw new Error('抖音网页版没有提供这条私信实况照片的可读动态轨。可以转发对应的图文作品，或把动图作为普通视频发送。');
    const metadata=Array.isArray(message.nativeImageUrls)&&message.nativeImageUrls.length
      ?{kind:'album',slides:[{urls:message.nativeImageUrls,motionUrls:[]}],title:message.title||'抖音私信图片',author:'',source:'https://www.douyin.com/chat'}
      :await this.adapter.resolveVideo(message);
    if(metadata.kind==='album')return this.prepareAlbum(message,metadata,folder,maxSeconds);
    if(metadata.seconds>maxSeconds)throw new Error(`视频长于 ${maxSeconds/60} 分钟，请在控制台调整上限后重试`);
    const video=join(folder,'video.mp4');await this.downloadCandidates(metadata.urls||[metadata.url],video);
    // Inspect duration even when the platform metadata omits it.
    let info='';try{info=await runFfmpeg(['-hide_banner','-i',video,'-f','null','-t','0','-']);}catch(e){checkWork();info=e.message;}
    const probe=info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/),probedSeconds=probe?Number(probe[1])*3600+Number(probe[2])*60+Number(probe[3]):0;
    if(requireDurationProbe&&!probedSeconds)throw new Error('无法核实实际视频时长，群聊未继续分析');
    if(probedSeconds>maxSeconds)throw new Error(`实际视频长于 ${maxSeconds/60} 分钟，停止处理`);
    const wav=join(folder,'audio.wav');let audioInfo='';let noAudio=false;
    try{audioInfo=await runFfmpeg(['-hide_banner','-y','-i',video,'-t',String(maxSeconds+1),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],300000);}
    catch(e){if(/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(e.message))noAudio=true;else throw e;}
    const match=(audioInfo||info).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const seconds=probedSeconds||(match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):metadata.seconds||0);
    if(!seconds)throw new Error('未能确认视频时长，停止处理');
    if(seconds>maxSeconds)throw new Error(`实际视频长于 ${maxSeconds/60} 分钟，停止处理`);
    this.log('正在本地转写口播：'+metadata.title.slice(0,50));
    const segments=noAudio?[]:await transcribe(wav,join(this.modelsRoot,modelName));
    const transcript=segments.map(s=>`[${Math.floor(s.seconds/60)}:${String(s.seconds%60).padStart(2,'0')}] ${s.text}`).join('\n');
    const frames=[];const count=previews?Math.min(10,Math.max(2,Math.ceil(seconds/20))):0;
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
