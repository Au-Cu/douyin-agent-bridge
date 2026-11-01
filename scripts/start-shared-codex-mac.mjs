import {readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {resolveDataRoot} from '../src/data-root.mjs';import {sharedConfigFile} from '../src/shared-codex-transport.mjs';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('此入口用于 Apple 芯片 macOS');
const config=JSON.parse(await readFile(sharedConfigFile(resolveDataRoot()),'utf8')),exec=promisify(execFile);
let running=false;try{const r=await exec('/usr/bin/pgrep',['-x','ChatGPT']);running=!!r.stdout.trim();}catch{}
try{const r=await exec('/usr/bin/pgrep',['-x','Codex']);running||=!!r.stdout.trim();}catch{}
if(running)throw new Error('请先完全退出桌面 Codex，再运行共享入口；不会自动中断现有聊天');
const app=config.app||['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT','/Applications/Codex.app/Contents/MacOS/Codex'].find(existsSync);if(!app||!existsSync(config.wrapper))throw new Error('桌面应用或共享连接入口缺失，请重新准备');
const child=spawn(app,[],{env:{...process.env,CODEX_CLI_PATH:config.wrapper},detached:true,stdio:'ignore'});child.unref();console.log('已启动共享 Codex，请在助手面板检查共享连接。');
