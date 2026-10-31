import {homedir} from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,cp,rename,readdir,readFile,writeFile,stat} from 'node:fs/promises';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {durableJson,lockStorage,processAlive} from './durable.mjs';

export function resolveDataRoot({env=process.env,platform=process.platform,home=homedir()}={}){
  if(env.BRIDGE_DATA_DIR)return resolve(env.BRIDGE_DATA_DIR);
  return resolve(platform==='win32'?join(env.LOCALAPPDATA||join(home,'AppData','Local'),'DouyinCodexBridge','data'):join(env.XDG_DATA_HOME||join(home,'.local','share'),'douyin-codex-bridge','data'));
}
export function inspectData(root){
  let config={},counts={},db;const file=join(root,'bridge.sqlite');
  if(existsSync(join(root,'config.json')))try{config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));}catch{}
  if(existsSync(file))try{db=new DatabaseSync(file,{readOnly:true});for(const table of ['messages','knowledge','tasks','needs'])try{counts[table]=db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;}catch{};try{const r=db.prepare("SELECT value FROM app_settings WHERE key='config'").get();if(r)config=JSON.parse(r.value);}catch{}}finally{db?.close();}
  return {meaningful:!!(config.owner||config.targets?.length||config.model||Object.values(counts).some(Boolean)),config,counts};
}
export function rebaseText(text,source,target){
  const from=resolve(source),to=resolve(target),pairs=[[JSON.stringify(from).slice(1,-1),JSON.stringify(to).slice(1,-1)],[from,to],[from.replaceAll('\\','/'),to.replaceAll('\\','/')]];
  for(const [a,b]of pairs)if(a!==b)text=text.replaceAll(a,b);return text;
}
const identifier=s=>'"'+s.replaceAll('"','""')+'"';
export async function rebaseData(root,source,target){
  const db=new DatabaseSync(join(root,'bridge.sqlite'));
  try{
    db.exec('PRAGMA synchronous=FULL;BEGIN IMMEDIATE');
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
      const table=identifier(name),columns=db.prepare('PRAGMA table_info('+table+')').all().filter(c=>/TEXT/i.test(c.type)).map(c=>c.name);
      for(const row of db.prepare('SELECT rowid AS __storage_rowid,* FROM '+table).all()){
        const changed=columns.filter(c=>typeof row[c]==='string'&&rebaseText(row[c],source,target)!==row[c]);
        if(changed.length)db.prepare('UPDATE '+table+' SET '+changed.map(c=>identifier(c)+'=?').join(',')+' WHERE rowid=?').run(...changed.map(c=>rebaseText(row[c],source,target)),row.__storage_rowid);
      }
    }
    db.exec('COMMIT;PRAGMA wal_checkpoint(TRUNCATE)');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
  async function walk(folder){if(!existsSync(folder))return;for(const entry of await readdir(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isSymbolicLink())throw new Error('迁移中发现符号链接，原数据保持不变。');if(entry.isDirectory())await walk(file);else if(/\.(?:json|md|txt)$/i.test(entry.name)){const text=await readFile(file,'utf8'),next=rebaseText(text,source,target);if(next!==text)await writeFile(file,next);}}}
  for(const part of ['knowledge','needs'])await walk(join(root,part));
  for(const name of ['config.json','config.json.bak'])if(existsSync(join(root,name))){const text=await readFile(join(root,name),'utf8');await writeFile(join(root,name),rebaseText(text,source,target));}
}
export async function migrateData(source,target){
  source=resolve(source);target=resolve(target);if(source===target)return target;
  const nested=relative(source,target);if(!nested.startsWith('..')&&!isAbsolute(nested))throw new Error('新数据目录不能放在旧数据目录内部。');
  if(inspectData(target).meaningful)throw new Error('目标目录已经有账号或记忆，不能覆盖；请先选择要恢复的数据。');
  const pidFile=join(source,'server.pid');if(existsSync(pidFile)){const pid=Number(readFileSync(pidFile,'utf8').trim());if(Number.isInteger(pid)&&pid>0&&processAlive(pid))throw new Error('请先正常停止旧项目，再迁移数据和浏览器登录态。');}
  const unlockSource=lockStorage(source),parent=dirname(target),staging=join(parent,'.data-migrating-'+randomUUID());await mkdir(parent,{recursive:true});let unlock;
  try{
    unlock=lockStorage(parent,'migration.lock');await mkdir(staging);
    if(existsSync(target))await cp(target,staging,{recursive:true,force:false,errorOnExist:false,filter:p=>!['bridge.lock','server.pid'].includes(p.split(/[\\/]/).at(-1))&&!/^bridge\.sqlite(?:-|$)/.test(p.split(/[\\/]/).at(-1))});
    for(const name of ['config.json','config.json.bak','knowledge','needs','models','browser-profile','runtime'])if(existsSync(join(source,name)))await cp(join(source,name),join(staging,name),{recursive:true,force:true,preserveTimestamps:true,filter:p=>!['SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort'].includes(p.split(/[\\/]/).at(-1))});
    // Windows copy timestamps can round sub-millisecond precision. Preserve the
    // original revision so completed visual segments remain reusable after a move.
    if(existsSync(join(source,'knowledge')))for(const entry of await readdir(join(source,'knowledge'),{withFileTypes:true}))if(entry.isDirectory()){
      const oldVideo=join(source,'knowledge',entry.name,'video.mp4'),newVideo=join(staging,'knowledge',entry.name,'video.mp4');if(!existsSync(oldVideo))continue;
      const before=await stat(oldVideo),after=await stat(newVideo);let originalMtimeMs=before.mtimeMs;
      try{const prior=JSON.parse(await readFile(join(source,'knowledge',entry.name,'video-storage.json'),'utf8'));if(prior.bytes===before.size&&prior.storedMtimeMs===before.mtimeMs)originalMtimeMs=prior.originalMtimeMs;}catch{}
      durableJson(join(staging,'knowledge',entry.name,'video-storage.json'),{bytes:after.size,originalMtimeMs,storedMtimeMs:after.mtimeMs});
    }
    const db=new DatabaseSync(join(source,'bridge.sqlite'),{readOnly:true});try{await backup(db,join(staging,'bridge.sqlite'));}finally{db.close();}
    await rebaseData(staging,source,target);durableJson(join(staging,'storage.json'),{version:1,migratedFrom:source,created:Date.now()});
    // Both moves stay in the explicitly resolved storage parent. Keep any
    // previous empty installation as a recovery copy rather than deleting it.
    if(existsSync(target))await rename(target,join(parent,'data-before-migration-'+Date.now()));
    await rename(staging,target);return target;
  }finally{unlock?.();unlockSource();}
}
export async function prepareDataRoot(project,{env=process.env,root=resolveDataRoot({env})}={}){
  root=resolve(root);const legacy=join(project,'data');
  if(!env.BRIDGE_DATA_DIR&&root!==resolve(legacy)&&!inspectData(root).meaningful&&inspectData(legacy).meaningful)await migrateData(legacy,root);
  await mkdir(root,{recursive:true});if(!existsSync(join(root,'storage.json')))durableJson(join(root,'storage.json'),{version:1,created:Date.now()});return root;
}
