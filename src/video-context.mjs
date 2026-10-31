import { readFileSync,existsSync } from 'node:fs';
import { dirname,join } from 'node:path';

const readJson=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};

// Initial image attachments are navigation aids. The complete visual evidence,
// original MP4 and local inspection command remain available to the task.
export function buildVideoContext(items,{project,node=process.execPath,maxImages=16}={}){
  const videos=items.map(item=>{
    const folder=dirname(item.path),reportPath=join(folder,'visual-report.json');const report=readJson(reportPath);
    const key=report?.cacheKey;const manifestPath=/^visual-continuous-v\d+-(2|4|8)fps-[a-f\d]{12}$/.test(key||'')?join(folder,key,'manifest.json'):null;
    const manifest=manifestPath?readJson(manifestPath):null;
    const sheets=(manifest?.sheets||[]).filter(n=>/^sheet-\d+\.jpg$/.test(n)).map(n=>join(folder,key,n)).filter(existsSync);
    return {id:item.id,title:item.title,source:/^\d{12,24}$/.test(item.id)?'https://www.douyin.com/video/'+item.id:undefined,
      videoPath:join(folder,'video.mp4'),notePath:item.path,visualPath:join(folder,'visual-analysis.md'),reportPath,manifestPath,
      duration:report?.duration,fps:report?.fps,visualStatus:report?.status||'not_analyzed',coveredUntil:report?.coveredUntil||0,sheetCount:sheets.length,sheets};
  });
  const images=[];const perVideo=Math.max(1,Math.floor(maxImages/Math.max(1,videos.length)));
  for(const video of videos){
    const count=Math.min(perVideo,video.sheets.length);
    for(let i=0;i<count;i++){
      const index=count===1?0:Math.round(i*(video.sheets.length-1)/(count-1));
      images.push({path:video.sheets[index],videoId:video.id,seconds:index*4/(video.fps||4)});
    }
  }
  return {videos,images:images.slice(0,maxImages),inspector:join(project,'scripts','video-inspect.mjs'),node};
}

export function videoContextInstructions(context){
  const rules=join(dirname(context.inspector),'..','prompts','task-reference.md');
  return `执行前先阅读视频参考说明：${rules}\n素材与工具索引：${JSON.stringify({node:context.node,inspector:context.inspector,need:context.need,videos:context.videos.map(({sheets,...v})=>v)})}`;
}
