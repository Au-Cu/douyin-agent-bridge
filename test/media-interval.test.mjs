import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {runFfmpeg} from '../src/media.mjs';import {extractVideoInterval} from '../src/visual.mjs';
import {resolveDataRoot} from '../src/data-root.mjs';
const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));mkdirSync(base,{recursive:true});
test('局部片段保留源时间戳但不填充开头的重复帧，旧缓存图片不能混入结果',{skip:!existsSync(join(resolveDataRoot(),'runtime','ffmpeg.exe'))&&!existsSync(fileURLToPath(new URL('../data/runtime/ffmpeg.exe',import.meta.url)))},async()=>{
  const folder=mkdtempSync(join(base,'interval-')),video=join(folder,'source.mp4');
  await runFfmpeg(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=green:s=320x240:r=16:d=4','-c:v','libx264','-pix_fmt','yuv420p',video]);
  writeFileSync(join(folder,'clip-999.jpg'),'old result');
  const frames=await extractVideoInterval({video,folder,start:2,end:3,duration:4,fps:16});assert.equal(frames.length,4);assert.ok(!frames.some(p=>p.endsWith('clip-999.jpg')));
});
