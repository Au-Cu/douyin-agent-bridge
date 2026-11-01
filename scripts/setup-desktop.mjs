import {prepareDesktopShared} from '../src/desktop-shared-setup.mjs';
import {resolveDataRoot} from '../src/data-root.mjs';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),value=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
try{const r=await prepareDesktopShared(resolveDataRoot(fileURLToPath(new URL('../',import.meta.url))),{original:value('--codex')||process.env.CODEX_APP_RUNTIME_CLI_PATH,app:value('--app')});console.log('共享连接入口已准备，当前桌面和任务未被中断。');console.log('完全退出桌面 Codex 后，使用：'+r.launcher);}
catch(e){console.error(e.message);process.exitCode=1;}
