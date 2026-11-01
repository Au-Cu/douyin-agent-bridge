import {mkdir,readFile,copyFile,writeFile,rename,chmod} from 'node:fs/promises';import {createReadStream} from 'node:fs';
import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {auditRelease,projectRoot} from './release-files.mjs';
const files=await auditRelease(),pkg=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8'));
const folder=`${pkg.name}-${pkg.version}`,dist=join(projectRoot,'dist'),stage=join(dist,'.stage',randomUUID()),root=join(stage,folder);
await mkdir(root,{recursive:true});for(const file of files){const dest=join(root,file);await mkdir(dirname(dest),{recursive:true});await copyFile(join(projectRoot,file),dest);}
const platform=process.platform==='win32'?'windows':process.platform==='darwin'&&process.arch==='arm64'?'macos-arm64':null;
if(!platform)throw new Error('Release builds require Windows or Apple Silicon macOS.');
const archiveName=`${pkg.name}-v${pkg.version}-${platform}-source.zip`,archive=join(dist,archiveName);
// Use the Windows compression library: PATH may select a tar build that cannot
// create ZIP files. Environment arguments preserve Unicode and spaces safely.
const temporary=join(dist,randomUUID()+'.zip');
const command=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($env:BRIDGE_BUILD_OUTPUT,[IO.Compression.ZipArchiveMode]::Create,[Text.Encoding]::UTF8)
try {
  Get-ChildItem -LiteralPath $env:BRIDGE_BUILD_SOURCE -Recurse -File -Force | ForEach-Object {
    $name=$_.FullName.Substring($env:BRIDGE_BUILD_SOURCE.Length+1).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$_.FullName,$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
`;
const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
if(platform==='macos-arm64')for(const name of ['install-mac.command','start-mac.command','stop-mac.command'])await chmod(join(root,name),0o755);
await new Promise((resolve,reject)=>{const p=platform==='windows'?spawn(powershell,['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,BRIDGE_BUILD_SOURCE:stage,BRIDGE_BUILD_OUTPUT:temporary},windowsHide:true,stdio:'inherit'}):spawn('/usr/bin/ditto',['-c','-k','--keepParent',root,temporary],{stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('ZIP creation failed, exit code '+c)));});
await rename(temporary,archive);
const hash=createHash('sha256');for await(const b of createReadStream(archive))hash.update(b);const digest=hash.digest('hex');
await writeFile(join(dist,`SHA256SUMS-${platform}.txt`),`${digest}  ${archiveName}\n`);
await writeFile(join(dist,`source-manifest-${platform}.json`),JSON.stringify({version:pkg.version,platform,files,sha256:digest},null,2)+'\n');
if(platform==='windows'){await writeFile(join(dist,'SHA256SUMS.txt'),`${digest}  ${archiveName}\n`);await writeFile(join(dist,'source-manifest.json'),JSON.stringify({version:pkg.version,platform,files,sha256:digest},null,2)+'\n');}
console.log(`Built ${archive} (${files.length} clean source files)`);
