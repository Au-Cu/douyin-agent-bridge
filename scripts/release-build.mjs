import {mkdir,readFile,copyFile,writeFile} from 'node:fs/promises';import {createReadStream} from 'node:fs';
import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {auditRelease,projectRoot} from './release-files.mjs';
const files=await auditRelease(),pkg=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8'));
const folder=`${pkg.name}-${pkg.version}`,dist=join(projectRoot,'dist'),stage=join(dist,'.stage',randomUUID()),root=join(stage,folder);
await mkdir(root,{recursive:true});for(const file of files){const dest=join(root,file);await mkdir(dirname(dest),{recursive:true});await copyFile(join(projectRoot,file),dest);}
const archive=join(dist,`${pkg.name}-v${pkg.version}-windows-source.zip`);
await new Promise((resolve,reject)=>{const p=spawn('tar',['-a','-cf',archive,'-C',stage,folder],{windowsHide:true,stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('ZIP creation failed')));});
const hash=createHash('sha256');for await(const b of createReadStream(archive))hash.update(b);const digest=hash.digest('hex');
await writeFile(join(dist,'SHA256SUMS.txt'),`${digest}  ${pkg.name}-v${pkg.version}-windows-source.zip\n`);
await writeFile(join(dist,'source-manifest.json'),JSON.stringify({version:pkg.version,files,sha256:digest},null,2)+'\n');
console.log(`Built ${archive} (${files.length} clean source files)`);
