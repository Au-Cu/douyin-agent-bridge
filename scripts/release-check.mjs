import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {join} from 'node:path';
import {auditRelease,projectRoot} from './release-files.mjs';
const files=await auditRelease();
if(existsSync(join(projectRoot,'.git'))){
  const result=spawnSync('git',['ls-files','-z'],{cwd:projectRoot,windowsHide:true,encoding:'utf8'});if(result.status!==0)throw new Error('Unable to check Git index');
  const unexpected=result.stdout.split('\0').filter(Boolean).filter(p=>!files.includes(p));if(unexpected.length)throw new Error('Tracked files outside release allowlist: '+unexpected.join(', '));
}
console.log(`Release audit passed: ${files.length} allowlisted text/source files; no runtime state, model weights, browser profile or credentials.`);
