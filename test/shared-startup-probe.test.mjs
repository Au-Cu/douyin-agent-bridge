import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {prepareDesktopShared} from '../src/desktop-shared-setup.mjs';
import {isSharedDesktopServer} from '../src/shared-codex-command.mjs';

const desktop=['app-server','--analytics-default-enabled'];
test('only a persistent desktop stdio host enters the broker; one-shot startup, sign-out and CLI tooling bypass it',()=>{
  for(const args of [desktop,[...desktop,'--stdio'],[...desktop,'--listen=stdio://'],['-c','model="fixture"',...desktop,'--strict-config','--startup-client-info','{"name":"desktop"}']])assert.equal(isSharedDesktopServer(args),true,JSON.stringify(args));
  for(const args of [[],['--version'],['app-server'],[...desktop,'--print-startup-config'],[...desktop,'--startup-sign-out'],[...desktop,'--print-startup-config','--startup-sign-out'],[...desktop,'--help'],[...desktop,'-h'],[...desktop,'generate-ts'],[...desktop,'generate-json-schema'],[...desktop,'proxy'],[...desktop,'daemon','status'],[...desktop,'--listen','ws://127.0.0.1:4000'],[...desktop,'--listen=off'],[...desktop,'--unknown-new-mode'],['exec','app-server','--analytics-default-enabled'],['-e','app-server','--analytics-default-enabled'],['--config','app-server','--analytics-default-enabled'],['app-server','--config','--analytics-default-enabled']])assert.equal(isSharedDesktopServer(args),false,JSON.stringify(args));
  assert.equal(isSharedDesktopServer([...desktop,'-c','--print-startup-config']),true,'a value is not a bootstrap option');
});

const base=fileURLToPath(new URL('../data/test-runs/',import.meta.url));
const output='{"appServerVersion":"fixture-core","configRequirements":null}\n',stderr='fixture-probe-stderr\n';
async function coreFixture(){
  await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'启动预检 核心-'));
  if(process.platform==='win32'){
    const file=join(root,'FixtureCore.cs'),original=join(root,'fixture-core.exe');
    await writeFile(file,`using System;using System.Text;using System.Threading;
public static class FixtureCore {public static int Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);Thread.Sleep(120);Console.Out.Write("{\\"appServerVersion\\":\\"fixture-core\\",\\"configRequirements\\":null}\\n");Console.Error.Write("fixture-probe-stderr\\n");return Array.IndexOf(args,"--startup-sign-out")>=0?17:0;}}`);
    await promisify(execFile)(join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/platform:anycpu','/out:'+original,file],{windowsHide:true,timeout:20000});
    return original;
  }
  const original=join(root,'fixture-core');await writeFile(original,'#!/usr/bin/env node\nsetTimeout(()=>{process.stdout.write('+JSON.stringify(output)+');process.stderr.write('+JSON.stringify(stderr)+');process.exitCode=process.argv.includes("--startup-sign-out")?17:0;},120);\n',{mode:0o700});await chmod(original,0o700);return original;
}
async function run(file,args){
  const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill(),10000);
  try{const code=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});return {code,stdout,stderr};}finally{clearTimeout(timer);}
}
test('native wrapper preserves closed-stdin startup probes and exit codes without touching an already live broker',{skip:!['win32','darwin'].includes(process.platform)},async t=>{
  const original=await coreFixture();
  for(const [name,args,expected] of [
    ['normal organization policy check',[...desktop,'--print-startup-config','--startup-client-info','{"name":"desktop"}'],0],
    ['failed one-shot sign-out in a fake core only',[...desktop,'--print-startup-config','--startup-sign-out'],17],
    ['help is a one-shot command',[...desktop,'--help'],0],
    ['schema generation is tooling',[...desktop,'generate-json-schema'],0],
  ])await t.test(name,async()=>{
    const root=await mkdtemp(join(base,'预检 输出-')),prepared=await prepareDesktopShared(root,{original}),file=join(root,'desktop-shared','desktop-launch.json'),sentinel='existing-desktop-launch-must-stay';await writeFile(file,sentinel);
    const config=JSON.parse(await readFile(join(root,'desktop-shared','connection.json'),'utf8'));let connections=0;const sockets=new Set(),trap=net.createServer(socket=>{connections++;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.destroy();});
    await new Promise((yes,no)=>{trap.once('error',no);trap.listen(config.endpoint,yes);});
    try{
      const result=await run(prepared.wrapper,args);assert.equal(result.code,expected);assert.equal(result.stdout,output);assert.equal(result.stderr,stderr);assert.equal(connections,0,'startup checks must not attach to or start a broker');assert.equal(await readFile(file,'utf8'),sentinel);assert.equal(existsSync(join(root,'desktop-shared','broker.lock')),false);
    }finally{for(const socket of sockets)socket.destroy();await new Promise(yes=>trap.close(yes));}
  });
});
