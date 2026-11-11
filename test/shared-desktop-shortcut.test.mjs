import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,copyFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));
async function run(cmd,root){
  const child=spawn('cmd.exe',['/d','/c',cmd],{windowsHide:true,env:{...process.env,BRIDGE_DATA_DIR:root},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.stdin.end();
  const timer=setTimeout(()=>child.kill(),12000);
  try{return {code:await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);}),out,err};}finally{clearTimeout(timer);}
}

test('a copied desktop entry finds the configured project, rejects stale paths, and returns a failure code',{skip:process.platform!=='win32'},async()=>{
  await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'快捷方式 空格-')),desktop=join(root,'Desktop'),project=join(root,'项目 空格'),data=join(root,'data'),config=join(data,'desktop-shared','connection.json');
  await mkdir(desktop);await mkdir(join(project,'scripts'),{recursive:true});await mkdir(join(data,'desktop-shared'),{recursive:true});
  const copied=join(desktop,'启动共享Codex.cmd'),marker=join(root,'ran.txt');await copyFile(fileURLToPath(new URL('../启动共享Codex.cmd',import.meta.url)),copied);
  await writeFile(join(project,'scripts','StartSharedCodex.ps1'),"[IO.File]::WriteAllText($env:BRIDGE_DATA_DIR + '/marker','started')\n");
  await writeFile(config,JSON.stringify({project}));const ok=await run(copied,data);assert.equal(ok.code,0,ok.err);assert.equal(await readFile(join(data,'marker'),'utf8'),'started');
  await writeFile(config,JSON.stringify({project:join(root,'project disappeared')}));const failed=await run(copied,data);assert.notEqual(failed.code,0);assert.match(failed.err,/项目位置不可用/);assert.equal(await readFile(join(data,'marker'),'utf8'),'started');
});
