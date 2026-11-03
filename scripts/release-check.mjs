import {spawnSync} from 'node:child_process';import {existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {auditRelease,projectRoot} from './release-files.mjs';
const readPackage=name=>JSON.parse(readFileSync(join(projectRoot,name),'utf8'));
const version=readPackage('package.json').version,lock=readPackage('package-lock.json');
if(lock.version!==version||lock.packages?.['']?.version!==version)throw new Error('Package and lockfile versions differ');
const tag=process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:process.argv[2];
if(tag&&tag!=='v'+version)throw new Error('Release tag must match v'+version);
const files=await auditRelease();
if(existsSync(join(projectRoot,'.git'))){
  const result=spawnSync('git',['ls-files','-z'],{cwd:projectRoot,windowsHide:true,encoding:'utf8'});if(result.status!==0)throw new Error('Unable to check Git index');
  const unexpected=result.stdout.split('\0').filter(Boolean).filter(p=>!files.includes(p));if(unexpected.length)throw new Error('Tracked files outside release allowlist: '+unexpected.join(', '));
}
console.log(`Release audit passed: ${files.length} allowlisted text/source files; no runtime state, model weights, browser profile or credentials.`);
