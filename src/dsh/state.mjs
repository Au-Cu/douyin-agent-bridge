import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {durableJson} from '../durable.mjs';

export class DshState{
  constructor(root){this.file=root?join(root,'dsh','bridge-state.json'):null;this.value={version:1,profiles:{},turns:{}};if(this.file&&existsSync(this.file)){try{this.value=JSON.parse(readFileSync(this.file,'utf8'));if(this.value.version!==1||!this.value.profiles||!this.value.turns)throw new Error();}catch{throw new Error('DSH 会话状态无法读取，已保留原文件，不能用空状态覆盖');}}}
  save(){if(this.file)durableJson(this.file,this.value);}
  profile(id,value){if(value){this.value.profiles[id]=value;this.save();}return this.value.profiles[id];}
  directory(id,value){this.value.directory||={};if(value){this.value.directory[id]=value;this.save();}return this.value.directory[id];}
  turn(id,value){if(value){this.value.turns[id]={...this.value.turns[id],...value};const ended=Object.entries(this.value.turns).filter(([,r])=>r.status!=='inProgress').sort((a,b)=>a[1].at-b[1].at);for(const [key]of ended.slice(0,Math.max(0,ended.length-512)))delete this.value.turns[key];this.save();}return this.value.turns[id];}
  turns(threadId){return Object.entries(this.value.turns).filter(([,r])=>r.threadId===threadId).map(([id,r])=>({id,...r}));}
}
