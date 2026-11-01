export class ChatRuntime{
  constructor({store,sandboxes}){Object.assign(this,{store,sandboxes});}
  current(){const name=this.store.config.chatHarness||'codex',sandbox=this.sandboxes[name];if(!sandbox)throw new Error('未配置这个普通聊天后端');return sandbox;}
  prepare(){return this.current().prepare();}
  catalog(harness){return this.sandboxes[harness]?.catalog?.();}
  reply(input,options){const selected=options?.harness?this.sandboxes[options.harness]:this.current();if(!selected)throw new Error('普通聊天后端尚未配置');return selected.reply(input,options);}
  invalidate(){for(const sandbox of Object.values(this.sandboxes))sandbox.invalidate();}
  async close(){await Promise.allSettled(Object.values(this.sandboxes).map(s=>s.close()));}
}
