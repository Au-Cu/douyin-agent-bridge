import {readFile,writeFile,readdir,stat} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {CodexClient} from '../src/codex.mjs';import {VisualAnalyzer,visualTools} from '../src/visual.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));let folder;
for(const entry of (await readdir(join(root,'data','acceptance')).catch(()=>[])).filter(n=>/^\d+$/.test(n)).sort().reverse()){
  const candidate=join(root,'data','acceptance',entry,'knowledge','9000000000000000001');
  if(await stat(join(candidate,'metadata.json')).then(()=>true).catch(()=>false)){folder=candidate;break;}
}
if(!folder)throw new Error('请先运行 npm run test:live 生成本机合成验收样本');
const learned=JSON.parse(await readFile(join(folder,'metadata.json'),'utf8'));learned.path=join(folder,'note.md');
const codex=new CodexClient({cwd:root});const report={syntheticFixture:true,realDouyinVerified:false,started:new Date().toISOString()};
try{
  const analyzer=new VisualAnalyzer({codex,log:console.log});const visual=await analyzer.analyze(learned,{fps:4});
  assert.equal(visual.status,'complete');assert.equal(visual.completedSegments,visual.totalSegments);assert.equal(visual.coveredUntil,learned.seconds);report.continuousVisual={fps:visual.fps,sheets:visual.sheetCount,segments:visual.totalSegments};console.log('[OK] 全时间轴连续视觉分析');
  const thread=await codex.createCoordinator(visualTools,true);let calls=0;
  const response=await codex.run(thread,[{type:'text',text:'这是客户端图片工具协议测试。请仅调用一次 video_frame，seconds 设为 0。它会返回本机图片路径，再调用原生 view_image 查看这张图片。最后回复 BRIDGE_VISUAL_TOOL_OK 并说明实际看到的主要颜色。不要执行命令或修改文件。'}],{resume:false,timeoutMs:120000,toolHandler:async call=>{
    assert.equal(call.tool,'video_frame');calls++;return{success:true,contentItems:[{type:'inputText',text:'本机合成测试画面路径，请用原生 view_image 查看：'+join(folder,'frame-01.jpg')}]};
  }});
  report.imageToolCalls=calls;report.imageToolReply=response.text;assert.ok(calls>=1&&calls<=6);assert.match(response.text,/BRIDGE_VISUAL_TOOL_OK/);assert.match(response.text,/绿|green/i);report.passed=true;console.log('[OK] 视觉细看工具返回图片可被 Codex 读取');
}catch(e){report.passed=false;report.error=e.message;process.exitCode=1;console.error(e.message);}finally{codex.close();report.finished=new Date().toISOString();await writeFile(join(folder,'visual-smoke-report.json'),JSON.stringify(report,null,2));}
