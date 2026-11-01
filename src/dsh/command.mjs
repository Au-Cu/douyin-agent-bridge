import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// The DeepSeek Harness launcher ships as a POSIX shell script on macOS and as a
// Windows shim. Spawn it directly: no shell and no user message ever enters
// this command. The installed desktop app carries the same CLI entry the
// launcher script uses, so it is the fallback when no launcher is on PATH.
const launcherNames = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh'] : ['dsh'];

function fromPath() {
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of launcherNames) {
      const candidate = join(dir, name);
      try { if (existsSync(candidate)) return candidate; } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

// Running the app through Electron as Node avoids the Windows .cmd shim and
// keeps stdout free of anything but protocol frames.
function fromDesktopApp() {
  const homes = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')]
    : ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications', 'DeepSeek Harness.app')];
  for (const app of homes) {
    const asar = join(app, 'Contents', 'Resources', 'app.asar');
    const entry = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    const executable = process.platform === 'win32'
      ? join(app, 'DeepSeek Harness.exe')
      : join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
    if (!existsSync(asar) || !existsSync(executable)) continue;
    return { executable, prefix: ['--expose-internals', entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return null;
}

export function resolveDshCommand(requested = process.env.DSH_BIN || 'dsh') {
  if (requested && /\.(?:mjs|cjs|js)$/i.test(requested)) {
    return { executable: process.execPath, prefix: [resolve(requested)], env: {} };
  }
  if (requested && requested !== 'dsh') {
    if (!existsSync(requested)) throw new Error('DSH_BIN 指向的文件不存在：' + requested);
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(requested)) {
      throw new Error('Windows 下不能直接启动 .cmd 启动器，请把 DSH_BIN 指向 DeepSeek Harness 的 CLI 入口文件。');
    }
    return { executable: resolve(requested), prefix: [], env: {} };
  }
  const onPath = fromPath();
  if (onPath && !(process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(onPath))) {
    return { executable: onPath, prefix: [], env: {} };
  }
  const app = fromDesktopApp();
  if (app) return app;
  throw new Error('未找到 DeepSeek Harness 启动器，请先安装本机客户端，或用 DSH_BIN 指定可执行文件。');
}
