import assert from 'node:assert/strict';
import { mkdir,copyFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient,coordinatorTools } from '../src/codex.mjs';
import { MediaProcessor,runFfmpeg } from '../src/media.mjs';
import { modelName } from './setup-asr.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sampleRoot=join(root,'data','acceptance',String(Date.now()));await mkdir(sampleRoot,{recursive:true});
const audio=join(root,'data','models',modelName,'test_wavs','zh.wav');const video=join(sampleRoot,'fixture.mp4');
const report={started:new Date().toISOString(),syntheticFixture:true,realDouyinVerified:false,realBusinessChatsMessaged:false};
const codex=new CodexClient({cwd:root});
try {
  await runFfmpeg(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=0x184f3c:s=640x360:r=10','-i',audio,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart',video]);
  const adapter={
    resolveVideo:async()=>({url:'local-fixture',title:'本机合成验收样本（不是抖音视频）',source:'local fixture / public SenseVoice sample',author:'local test',seconds:0}),
    download:async(_url,destination)=>copyFile(video,destination)
  };
  const media=new MediaProcessor({root:sampleRoot,modelsRoot:join(root,'data','models'),adapter,log:console.log});
  const learned=await media.process({awemeId:'9000000000000000001'},60);
  assert.ok(learned.transcript.length>5);assert.ok(learned.frames.length>=2);report.transcript=learned.transcript;report.frames=learned.frames.length;console.log('[OK] 真正的视频解码、口播转写和关键帧提取');
  const videoThread=await codex.createCoordinator([],true);
  const videoResult=await codex.run(videoThread,[{type:'text',text:`这是本机合成视频验收，只依据引用材料，回复 BRIDGE_VIDEO_OK 并原样引用口播。不要调用任何工具。\n引用口播：${learned.transcript}`},...learned.frames.map(f=>({type:'localImage',path:f.path}))],{resume:false,timeoutMs:90000});
  assert.match(videoResult.text,/BRIDGE_VIDEO_OK/);report.videoModelReply=videoResult.text;console.log('[OK] Codex 接收口播与真实关键帧');

  const target=await codex.createCoordinator([],true);const coordinator=await codex.createCoordinator(coordinatorTools,true);let targetResult=null,dispatchCount=0;
  const result=await codex.run(coordinator,[{type:'text',text:'这是用户授权的本机协议验收。本轮允许派发：是。唯一已授权目标别名：联调目标。请调用 dispatch_task，把指令“只回复 BRIDGE_TASK_OK，不调用工具、不修改文件”派给联调目标。收到工具结果后回复 BRIDGE_DISPATCH_OK。请勿调用其他工具。'}],{
    resume:false,timeoutMs:120000,
    toolHandler:async call=>{
      assert.equal(call.tool,'dispatch_task');assert.equal(call.arguments.alias,'联调目标');dispatchCount++;
      targetResult=await codex.run(target,[{type:'text',text:'This is an isolated protocol test. Reply with exactly BRIDGE_TASK_OK. Do not call tools, write files, or contact any other chat.'}],{resume:false,timeoutMs:90000});
      assert.match(targetResult.text,/BRIDGE_TASK_OK/);return {status:'completed',result:targetResult.text};
    }
  });
  assert.equal(dispatchCount,1);assert.match(result.text,/BRIDGE_DISPATCH_OK/);report.dispatchCount=dispatchCount;report.targetReply=targetResult.text;report.coordinatorReply=result.text;report.passed=true;console.log('[OK] 调度会话调用工具 → 指定测试会话执行 → 返回结果');
}catch(e){report.passed=false;report.error=e.message;process.exitCode=1;console.error('[FAILED]',e.message);}
finally{codex.close();report.finished=new Date().toISOString();await writeFile(join(sampleRoot,'report.json'),JSON.stringify(report,null,2));console.log('验收报告：'+join(sampleRoot,'report.json'));}
