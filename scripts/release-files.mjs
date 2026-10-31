import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export async function collectReleaseFiles(root=projectRoot){
  const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8')),files=[];
  const realRoot=await realpath(root);
  const add=async relative=>{
    if(relative.split('/').some(p=>!p||p==='..'||['data','node_modules','dist','.git'].includes(p)))throw new Error('Invalid release path: '+relative);
    const path=resolve(root,relative),info=await lstat(path);
    if(info.isSymbolicLink()||!(await realpath(path)).toLowerCase().startsWith((realRoot+sep).toLowerCase()))throw new Error('Release symlink/path rejected: '+relative);
    if(info.isDirectory()){for(const name of await readdir(path))await add(relative+'/'+name);}
    else if(info.isFile())files.push(relative);
  };
  for(const name of [...manifest.files,...manifest.directories])await add(name);
  return [...new Set(files)].sort();
}
export async function auditRelease(root=projectRoot){
  const files=await collectReleaseFiles(root),errors=[];
  const rules=[
    /(?:sk-proj-|sk-ant-|ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /"(?:access_token|refresh_token|session_token)"\s*:\s*"[A-Za-z0-9_.-]{20,}"/,
    /[A-Z]:[\\/]+Users[\\/]+[^<>\\/\s"']+[\\/]/i,
    /https?:\/\/[^\s/]+:[^\s/]+@/
  ];
  for(const file of files){
    if(/(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|auth\.json$|cookies[^/]*\.json$)|\.(?:sqlite|db|log|pem|key|onnx|mp4|wav|exe|dll)(?:$|-)/i.test(file)){errors.push(file+': private/runtime file');continue;}
    const bytes=await readFile(join(root,file));if(bytes.includes(0)){errors.push(file+': binary file');continue;}
    if(rules.some(rule=>rule.test(bytes.toString('utf8'))))errors.push(file+': possible credential or machine-specific private path');
  }
  if(errors.length)throw new Error('Release audit failed:\n'+errors.join('\n'));
  return files;
}
