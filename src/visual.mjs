import { mkdir,readdir,readFile,stat } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { runFfmpeg } from './media.mjs';
import {durableJson,durableWrite} from './durable.mjs';

const VERSION='continuous-v2';
export function planVisualSegments(sheets,duration,fps,maxSheets=8) {
  if(!Number.isFinite(duration)||duration<=0||![2,4,8].includes(fps))throw new Error('视觉分析时长或帧率无效');
  if(!sheets.length)throw new Error('没有连续画面可供分析');
  return Array.from({length:Math.ceil(sheets.length/maxSheets)},(_,i)=>({
    index:i,start:i*maxSheets*4/fps,end:i===Math.ceil(sheets.length/maxSheets)-1?duration:Math.min(duration,(i+1)*maxSheets*4/fps),
    sheets:sheets.slice(i*maxSheets,(i+1)*maxSheets)
  }));
}
export function validateVisualWindow(start,end,duration,maxLength=3) {
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.001||end-start>maxLength)throw new Error('仅能细看原视频内最多 3 秒的片段');
}
export function validateVisualCrop(seconds,box,duration){
  if(!Number.isFinite(seconds)||seconds<0||seconds>duration||!Array.isArray(box)||box.length!==4||box.some(n=>!Number.isFinite(n)||n<0||n>1000)||box[2]-box[0]<10||box[3]-box[1]<10)throw new Error('裁剪须指定原视频时间和 0–1000 坐标的有效矩形，最小宽高为 10');
}
export const visualTools=[
  {name:'video_frame',description:'查看当前原视频指定时间的原始清晰画面，用于识别界面文字、细小控件和图像细节。',inputSchema:{type:'object',properties:{seconds:{type:'number'}},required:['seconds'],additionalProperties:false}},
  {name:'video_crop',description:'放大指定时间的一处画面细节。box 为显示画面上 0–1000 坐标的 [左,上,右,下]，无需其他模型或 API。',inputSchema:{type:'object',properties:{seconds:{type:'number'},box:{type:'array',items:{type:'number',minimum:0,maximum:1000},minItems:4,maxItems:4}},required:['seconds','box'],additionalProperties:false}},
  {name:'video_interval',description:'以 8、12 或 16 fps 连续细看当前视频内最多 3 秒的片段，用于分辨快速过渡、手势、动画前后状态。',inputSchema:{type:'object',properties:{start:{type:'number'},end:{type:'number'},fps:{type:'integer',enum:[8,12,16]}},required:['start','end'],additionalProperties:false}}
];
function timelineFilter(fps,width){return `fps=${fps}:round=up,scale=${width}:-2,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.75,tile=2x2:padding=4:margin=4`;}
// Current ChatGPT-authenticated app-server does not reliably expose images embedded
// in a dynamic tool result. Native view_image can read these same local files.
const imageOutput=async(paths,text)=>({success:true,contentItems:[{type:'inputText',text:text+'\n图片已保存到本机。请调用原生 view_image 工具查看下面的图片路径后再判断，不能只根据文件名推断：\n'+paths.join('\n')}]});

export async function extractVideoFrame({video,folder,seconds,duration,box,name='frame.jpg'}){
  if(box)validateVisualCrop(seconds,box,duration);
  else if(!Number.isFinite(seconds)||seconds<0||seconds>duration)throw new Error('时间必须在原视频范围内');
  await mkdir(folder,{recursive:true});const frame=join(folder,name);
  const filter=box?['-vf',`crop=iw*${box[2]-box[0]}/1000:ih*${box[3]-box[1]}/1000:iw*${box[0]}/1000:ih*${box[1]}/1000,scale='min(1600,iw*2)':-2`]:[];
  await runFfmpeg(['-hide_banner','-loglevel','error','-y','-ss',String(Math.min(seconds,Math.max(0,duration-.1))),'-i',video,'-frames:v','1',...filter,'-q:v','2',frame]);return frame;
}
export async function extractVideoInterval({video,folder,start,end,duration,fps=8,prefix='clip-'}){
  validateVisualWindow(start,end,duration);if(![8,12,16].includes(fps))throw new Error('局部帧率只能是 8、12 或 16');
  await mkdir(folder,{recursive:true});prefix+=randomUUID().slice(0,8)+'-';
  // Keep source timestamps on the pictures without image2 duplicating frames
  // to fill the leading gap between timestamp zero and this selected interval.
  await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',video,'-an','-vf',`trim=start=${start}:end=${end},${timelineFilter(fps,480)}`,'-vsync','0','-q:v','3',join(folder,prefix+'%03d.jpg')]);
  const frames=(await readdir(folder)).filter(n=>n.startsWith(prefix)&&n.endsWith('.jpg')).sort().map(n=>join(folder,n));
  if(!frames.length)throw new Error('该片段未提取到画面');return frames;
}

export class VisualAnalyzer {
  constructor({codex,log=()=>{},settings=async()=>({})}){Object.assign(this,{codex,log,settings});}
  async prepare(learned,fps=4) {
    const video=join(dirname(learned.path),'video.mp4');const info=await stat(video);const size=info.size;
    let mtime=info.mtimeMs;try{const origin=JSON.parse(await readFile(join(dirname(video),'video-storage.json'),'utf8'));if(origin.bytes===size&&origin.storedMtimeMs===mtime&&Number.isFinite(origin.originalMtimeMs))mtime=origin.originalMtimeMs;}catch{}
    const revision=createHash('sha256').update(`${size}:${mtime}:${learned.seconds}`).digest('hex').slice(0,12);
    const cacheKey=`visual-${VERSION}-${fps}fps-${revision}`;
    const folder=join(dirname(learned.path),cacheKey);await mkdir(folder,{recursive:true});
    const manifestPath=join(folder,'manifest.json');let manifest=null;
    try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{}
    if(!manifest||manifest.videoBytes!==size||manifest.fps!==fps||manifest.duration!==learned.seconds){
      this.log(`正在生成全时段连续画面：${fps} fps，${learned.seconds.toFixed(1)} 秒`);
      await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',video,'-an','-vf',timelineFilter(fps,384),'-q:v','3',join(folder,'sheet-%05d.jpg')],10*60*1000);
      const sheets=(await readdir(folder)).filter(n=>/^sheet-\d+\.jpg$/.test(n)).sort();
      if(!sheets.length)throw new Error('未生成连续画面，不能进行全片视觉分析');
      const finalFrame=join(folder,'final-frame.jpg');
      await runFfmpeg(['-hide_banner','-loglevel','error','-y','-ss',String(Math.max(0,learned.seconds-.15)),'-i',video,'-frames:v','1','-q:v','3',finalFrame]);
      manifest={version:VERSION,cacheKey,videoBytes:size,fps,duration:learned.seconds,sheets,finalFrame,created:new Date().toISOString()};
      durableJson(manifestPath,manifest);
    }
    const sheets=manifest.sheets.map(n=>join(folder,n));
    for(const p of sheets)await stat(p);
    return {folder,video,manifest,segments:planVisualSegments(sheets,learned.seconds,fps)};
  }
  async analyze(learned,{fps=4,onProgress=()=>{}}={}) {
    const {folder,video,manifest,segments}=await this.prepare(learned,fps);const results=[];
    onProgress(0,segments.length);
    const statePath=join(dirname(learned.path),'visual-report.json');
    const save=async(status,error='')=>{
      const report={version:VERSION,cacheKey:manifest.cacheKey,status,fps,duration:learned.seconds,sheetCount:manifest.sheets.length,totalSegments:segments.length,completedSegments:results.length,coveredUntil:results.length?results.at(-1).end:0,segments:results,error,updated:new Date().toISOString()};
      durableJson(statePath,report);return report;
    };
    try{
      for(const segment of segments){
        const resultPath=join(folder,`segment-${String(segment.index+1).padStart(3,'0')}.json`);let cached=null;
        try{cached=JSON.parse(await readFile(resultPath,'utf8'));}catch{}
        if(cached?.version===VERSION&&cached.start===segment.start&&cached.end===segment.end&&cached.text){results.push(cached);onProgress(results.length,segments.length);continue;}
        this.log(`视觉分析 ${segment.index+1}/${segments.length}：${segment.start.toFixed(1)}–${segment.end.toFixed(1)} 秒`);
        const prompt=`分析时段：${segment.start.toFixed(2)}–${segment.end.toFixed(2)} 秒；全片 ${learned.seconds.toFixed(2)} 秒；${fps} fps。\n口播参考：${learned.transcript.slice(0,22000)}`;
        const input=[{type:'text',text:prompt},...segment.sheets.map(path=>({type:'localImage',path}))];
        if(segment.index===segments.length-1)input.push({type:'text',text:'视频最后一帧：'},{type:'localImage',path:manifest.finalFrame});
        let detailedViews=0;
        const callSettings=await this.settings();
        const options={resume:false,effort:'medium',...callSettings,timeoutMs:10*60*1000,interruptOnTimeout:true,toolHandler:async call=>{
          if(++detailedViews>6)throw new Error('本段已完成 6 次细看，请依据已获得画面完成本段观察');
          const args=call.arguments;
          if(call.tool==='video_frame'){
            const seconds=Number(args.seconds);
            const frame=await extractVideoFrame({video,folder,seconds,duration:learned.seconds,name:`detail-${segment.index}-${detailedViews}.jpg`});
            return imageOutput([frame],`原视频约 ${seconds.toFixed(2)} 秒的清晰画面。`);
          }
          if(call.tool==='video_crop'){
            const seconds=Number(args.seconds),box=args.box;
            const frame=await extractVideoFrame({video,folder,seconds,box,duration:learned.seconds,name:`crop-${segment.index}-${detailedViews}.jpg`});
            return imageOutput([frame],`原视频约 ${seconds.toFixed(2)} 秒，矩形 ${box.join(',')} 的局部放大。`);
          }
          if(call.tool==='video_interval'){
            const start=Number(args.start),end=Number(args.end);const detailFps=Number(args.fps||8);
            const prefix=`detail-clip-${segment.index}-${detailedViews}-`;
            const frames=await extractVideoInterval({video,folder,start,end,duration:learned.seconds,fps:detailFps,prefix});
            return imageOutput(frames,`原视频 ${start}–${end} 秒，${detailFps} fps 连续细看，2×2 阅读顺序不变。`);
          }
          throw new Error('未授权的视觉分析工具');
        }};
        const result=this.codex.runReadOnly?await this.codex.runReadOnly(input,{...options,tools:visualTools}):await this.codex.run(await this.codex.createCoordinator(visualTools,true),input,options);
        const observation={version:VERSION,start:segment.start,end:segment.end,text:result.text,detailedViews,settings:callSettings};
        durableJson(resultPath,observation);results.push(observation);await save('partial');onProgress(results.length,segments.length);
      }
      const report=await save('complete');
      const notes=`# 全时段视觉观察\n\n采样：${fps} fps；覆盖 0–${learned.seconds.toFixed(2)} 秒；${manifest.sheets.length} 张连续画面组；${results.length} 段。每组 2×2 连续画面，保留时间顺序。\n\n${results.map(r=>`## ${r.start.toFixed(1)}–${r.end.toFixed(1)} 秒\n\n${r.text}`).join('\n\n')}`;
      durableWrite(join(dirname(learned.path),'visual-analysis.md'),notes);return {...report,notes};
    }catch(e){await save('partial',e.message);throw new Error(`全时段视觉分析尚未完成（${results.length}/${segments.length} 段已保存，可续做）：${e.message}`,{cause:e});}
  }
}
