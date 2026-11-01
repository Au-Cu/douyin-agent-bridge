import {DshClient} from './client.mjs';
import {prepareDshProfile} from './profile.mjs';

export class ProfiledDshClient extends DshClient{
  constructor({mode='chat',instructions='',webSearch=false,selectionProvider,...options}){super({...options,restricted:mode==='chat',instructionsByRole:{chat:instructions}});Object.assign(this,{profileMode:mode,profileRoot:options.root,profileInstructions:instructions,profileWeb:webSearch,authHome:options.home,selectionProvider});}
  async connect(){
    if(!this.profile){if(!this.preparing)this.preparing=(async()=>prepareDshProfile({root:this.profileRoot,mode:this.profileMode,executable:this.executable,authHome:this.authHome,webSearch:this.profileWeb,instructions:this.profileInstructions,defaultSelection:await this.selectionProvider?.()}))().then(p=>{this.profile=p;this.home=p.home;this.authHome=p.authHome;this.cwd=p.cwd;this.spawnArgs=p.spawnArgs;this.spawnEnv={...this.spawnEnv,DSH_PERMISSION_MODE:'read-only'};}).finally(()=>{this.preparing=null;});await this.preparing;}
    return super.connect();
  }
}
