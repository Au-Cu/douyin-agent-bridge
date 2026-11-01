import {fileURLToPath} from 'node:url';import {resolveDataRoot} from '../src/data-root.mjs';import {CodeSandbox} from '../src/code-sandbox.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),sandbox=new CodeSandbox({root:resolveDataRoot(project),backend:process.argv.includes('--wsl')?'wsl':'docker'});
try{const status=await sandbox.setup();if(!status.ready)throw new Error(status.message);console.log(status.message);}catch(e){console.error(e.code==='ENOENT'?'请先安装并启动 Docker 的 Linux 容器引擎，再重新运行 npm run setup:sandbox。':e.message);process.exitCode=1;}
