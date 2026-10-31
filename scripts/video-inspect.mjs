// A local, model-free counterpart to core media_info / save_view / crop / read_video.
import { parseArgs } from 'node:util';
import { readFile,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { extractVideoFrame,extractVideoInterval } from '../src/visual.mjs';

try{
  const {values:v}=parseArgs({options:{id:{type:'string'},at:{type:'string'},box:{type:'string'},start:{type:'string'},end:{type:'string'},fps:{type:'string'},info:{type:'boolean'}}});
  if(!/^\d{12,24}$/.test(v.id||''))throw new Error('请用 --id 指定已保存的原视频 ID');
  const root=fileURLToPath(new URL('../data/knowledge/',import.meta.url));const folder=join(root,v.id),video=join(folder,'video.mp4');
  const metadata=JSON.parse(await readFile(join(folder,'metadata.json'),'utf8'));await stat(video);
  const duration=Number(metadata.seconds);if(!Number.isFinite(duration)||duration<=0)throw new Error('视频时长无效');
  let images=[];const output=join(folder,'task-views'),prefix=Date.now()+'-'+randomUUID().slice(0,8);
  if(v.at!==undefined){
    if(v.start!==undefined||v.end!==undefined)throw new Error('--at 与区间选项不能同时使用');
    images=[await extractVideoFrame({video,folder:output,seconds:Number(v.at),duration,box:v.box?.split(',').map(Number),name:prefix+'.jpg'})];
  }else if(v.start!==undefined||v.end!==undefined){
    images=await extractVideoInterval({video,folder:output,start:Number(v.start),end:Number(v.end),duration,fps:Number(v.fps||8),prefix:prefix+'-'});
  }else if(v.box!==undefined)throw new Error('局部放大需要 --at 秒数');
  console.log(JSON.stringify({id:v.id,title:metadata.title,duration,videoPath:video,source:metadata.source,images,note:images.length?'请用原生 view_image 实际查看返回图片；本工具只处理本地文件，不调用模型。':'使用 --at 秒数 [--box 左,上,右,下]，或 --start 秒数 --end 秒数 [--fps 8|12|16] 提取画面。'},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
