import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,dirname,join } from 'node:path';
import {createRequire} from 'node:module';

// Prefer the official installed native binary so Windows shutdown does not
// leave a Node wrapper's child holding RPC pipes open. Preserve its package
// resource root; fall back to the official npm entry point when needed.
export function resolveCodexCommand(requested='codex'){
  let command=requested;
  if(command==='codex'){
    const targets={win32:{arm64:'aarch64-pc-windows-msvc',x64:'x86_64-pc-windows-msvc'},darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},linux:{arm64:'aarch64-unknown-linux-musl',x64:'x86_64-unknown-linux-musl'}};
    try{const pkg=createRequire(import.meta.url).resolve('@openai/codex-'+process.platform+'-'+process.arch+'/package.json'),native=join(dirname(pkg),'vendor',targets[process.platform][process.arch],'bin',process.platform==='win32'?'codex.exe':'codex');if(existsSync(native))return {executable:native,prefix:[],env:{CODEX_MANAGED_PACKAGE_ROOT:fileURLToPath(new URL('../node_modules/@openai/codex',import.meta.url)),CODEX_MANAGED_BY_NPM:'1'}};}catch{}
    const local=fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js',import.meta.url));
    if(existsSync(local))command=local;
  }
  return /\.(?:mjs|cjs|js)$/i.test(command)?{executable:process.execPath,prefix:[resolve(command)]}:{executable:command,prefix:[]};
}
