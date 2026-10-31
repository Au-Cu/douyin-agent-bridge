import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const defaultCodexHome=()=>process.env.CODEX_HOME||join(homedir(),'.codex');
// Only a one-way digest stays in memory. Never log, copy or persist credentials.
export async function credentialRevision(home=defaultCodexHome()){
  try{return createHash('sha256').update(await readFile(join(home,'auth.json'))).digest('hex');}
  catch(e){if(e.code==='ENOENT')return 'missing';throw new Error('无法检查本机 Codex 登录状态，请检查登录目录的访问权限');}
}
export function authFailure(error){
  if(error?.authKind)return error.authKind;
  if(error?.code==='CODEX_AUTH_PENDING')return 'pending';
  if(error?.cause&&error.cause!==error){const kind=authFailure(error.cause);if(kind)return kind;}
  const text=String(error?.message||error||'');
  if(/access token.*refresh|refresh token|token.*(?:expired|revoked)|logged out|signed in to another account|authentication|unauthori[sz]ed|not (?:logged|signed) in|sign in again|401\b/i.test(text))return 'login';
  if(/usage limit|insufficient_quota|quota|usage_limit_reached/i.test(text))return 'quota';
  return null;
}
export function authError(kind='login'){
  const message=kind==='pending'?'登录状态已变更，等待当前任务结束后重新连接':kind==='quota'?'Codex 当前可用额度不足，请在本机切换可用账号或等待额度恢复':'Codex 登录已失效，请在本机 Codex 重新登录，再重新连接';
  return Object.assign(new Error(message),{authKind:kind,code:kind==='pending'?'CODEX_AUTH_PENDING':'CODEX_AUTH_REQUIRED'});
}
