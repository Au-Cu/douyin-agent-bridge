import {modelSettings,saveModelSettings} from './harness-settings.mjs';
import {effectiveConversation,overrideKey} from './conversation-config.mjs';
import {threadHarness} from './harness.mjs';
export const effortNames={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const clean=s=>String(s||'').toLowerCase().replace(/[\s_.-]/g,'');
export function chooseModel(value,catalog){
  if(!value||['默认','default'].includes(value))return '';
  const exact=catalog.models.filter(m=>[m.id,m.model,m.displayName,m.rawModel].some(x=>x&&clean(x)===clean(value)));
  const matches=exact.length?exact:catalog.models.filter(m=>[m.id,m.model,m.displayName].some(x=>clean(x).includes(clean(value))));
  if(matches.length!==1)throw new Error(matches.length?'模型名称不唯一，请填写完整模型 ID。':'当前助手未提供这个模型；发送 /模型 查看可用名单。');
  return matches[0].model;
}
export function effortValue(value){
  if(!value||['默认','default'].includes(value))return '';
  return Object.entries(effortNames).find(([k,v])=>clean(k)===clean(value)||clean(v)===clean(value))?.[0]||String(value).toLowerCase();
}
export class Preferences{
  constructor({store,codex}){Object.assign(this,{store,codex});}
  async catalog(harness=this.codex.harnessName||'codex'){return this.codex.models(harness);}
  chatCatalog(harness=this.store.config.chatHarness||'codex'){return this.chatCatalogProvider?this.chatCatalogProvider(harness):this.catalog(harness);}
  async resolve(config=this.store.config,{light=false,preferWork=false,textOnly=false,chat=false,harness=this.codex.harnessName||'codex'}={}){
    const catalog=await (chat?this.chatCatalog(harness):this.catalog(harness));
    const id=config.model||catalog.defaults.model;
    const matches=catalog.models.filter(m=>m.model===id||m.id===id||m.rawModel===id);let model=matches.length===1?matches[0]:null;
    if(light&&!preferWork)model=catalog.models.find(m=>/luna/i.test(m.model))||model;
    if(!model)throw new Error('当前登录不可用所配置的模型，请发送 /模型 重新选择。');
    if(!light&&!textOnly&&model.inputModalities&&!model.inputModalities.includes('image'))throw new Error('视频理解需要支持图片输入的模型。');
    if(textOnly&&model.inputModalities&&!model.inputModalities.includes('text'))throw new Error('普通聊天需要支持文字输入的模型。');
    const supported=model.supportedReasoningEfforts.map(e=>e.reasoningEffort);
    const effort=light?(supported.includes('low')?'low':supported[0]):config.reasoningEffort||(config.model?model.defaultReasoningEffort:catalog.defaults.effort||model.defaultReasoningEffort);
    if(supported.length&&!supported.includes(effort)||!supported.length&&config.reasoningEffort&&!['none','off'].includes(config.reasoningEffort))throw new Error('此模型不支持该推理强度，可用：'+supported.map(e=>effortNames[e]||e).join('、'));
    const fastTier=model.serviceTiers?.find(t=>/fast/i.test(t.name)||['fast','priority'].includes(t.id));
    if(!light&&config.fastMode&&!fastTier)throw new Error('当前模型未提供快速模式。');
    return {model:model.model,effort,serviceTier:!light&&config.fastMode?fastTier.id:'default'};
  }
  work(){return this.resolve(modelSettings(this.store.config,this.codex.harnessName||'codex'));}
  agentConfig(harness=this.codex.harnessName||'codex'){return effectiveConversation(this.store.config,this.store.config.owner,harness);}
  agentWork(){const harness=this.codex.harnessName||'codex';return this.resolve(this.agentConfig(harness),{harness});}
  workFor(thread){const harness=threadHarness(thread);return this.resolve(this.agentConfig(harness),{harness});}
  chatWork(harness=this.store.config.chatHarness||'codex',peer){return this.resolve(effectiveConversation(this.store.config,peer,harness,{chat:true}),{textOnly:true,chat:true,harness});}
  async updateConversation({peer,chat,harness,patch,current}){
    const key=overrideKey(peer,chat),previous=this.store.config.conversationOverrides?.[key];
    const model={};
    if(patch.model!==undefined&&patch.model!==null)model.model=chooseModel(patch.model,await (chat?this.chatCatalog(harness):this.catalog(harness)));
    if(patch.reasoningEffort!==undefined&&patch.reasoningEffort!==null)model.reasoningEffort=effortValue(patch.reasoningEffort);
    if(patch.fastMode!==undefined&&patch.fastMode!==null){if(typeof patch.fastMode!=='boolean')throw new Error('快速模式必须选择继承、开启或关闭');model.fastMode=patch.fastMode;}
    const next={...previous,models:{...previous?.models,[harness]:model}};
    for(const [field,min,max] of [['contextBudget',4000,chat?96000:200000],...(!chat?[['maxVideoSeconds',30,7200],['visualFps',2,8]]:[])]){
      const value=patch[field];
      if(value==null){delete next[field];continue;}
      if(!Number.isInteger(value)||value<min||value>max||field==='visualFps'&&![2,4,8].includes(value))throw new Error('会话覆盖值超出可用范围');
      next[field]=value;
    }
    if(!chat){
      if(patch.autoRoute==null)delete next.autoRoute;
      else{if(typeof patch.autoRoute!=='boolean')throw new Error('需求路由必须选择继承、开启或关闭');next.autoRoute=patch.autoRoute;}
    }
    const defaults=modelSettings(this.store.config,harness,{chat});
    if(Object.keys(model).length)await this.resolve({...defaults,...model},{textOnly:chat,chat,harness});
    if(!current()||this.store.config.conversationOverrides?.[key]!==previous||JSON.stringify(modelSettings(this.store.config,harness,{chat}))!==JSON.stringify(defaults))throw new Error('会话或设置已变化，请刷新后重新保存');
    this.store.saveConfig({conversationOverrides:{...this.store.config.conversationOverrides,[key]:next}});
    return next;
  }
  light(preferWork=false){return this.resolve(modelSettings(this.store.config,this.codex.harnessName||'codex'),{light:true,preferWork});}
  update(patch){const task=(this.updating||Promise.resolve()).catch(()=>{}).then(()=>this.applyUpdate(patch));this.updating=task;return task;}
  updateChat(patch){const task=(this.updating||Promise.resolve()).catch(()=>{}).then(()=>this.applyChatUpdate(patch));this.updating=task;return task;}
  async applyChatUpdate(patch){
    const harness=this.store.config.chatHarness||'codex',next=modelSettings(this.store.config,harness,{chat:true});
    if('model'in patch)next.model=chooseModel(String(patch.model),await this.chatCatalog(harness));
    if('reasoningEffort'in patch)next.reasoningEffort=effortValue(patch.reasoningEffort);
    if('fastMode'in patch){if(typeof patch.fastMode!=='boolean')throw new Error('开关必须为开或关');next.fastMode=patch.fastMode;}
    await this.resolve(next,{textOnly:true,chat:true,harness});
    if(harness!==(this.store.config.chatHarness||'codex'))throw new Error('普通聊天后端已切换，请刷新后保存对应配置');
    const extra={};for(const [key,target]of [['webSearch','chatWebSearch'],['codeSandbox','chatCodeSandbox']])if(key in patch){if(typeof patch[key]!=='boolean')throw new Error('聊天能力开关无效');extra[target]=patch[key];}
    if('contextBudget'in patch){const n=Number(patch.contextBudget);if(!Number.isInteger(n)||n<4000||n>96000)throw new Error('群聊上下文预算需为 4000–96000 tokens');extra.chatContextBudget=n;}
    saveModelSettings(this.store,harness,next,{chat:true});if(Object.keys(extra).length)this.store.saveConfig(extra);configurePanel(this.store,'chats');return this.store.config;
  }
  async applyUpdate(patch){
    const harness=this.codex.harnessName||'codex',next={...this.store.config,...modelSettings(this.store.config,harness)};
    if('model'in patch)next.model=chooseModel(String(patch.model),await this.catalog());
    if('reasoningEffort'in patch)next.reasoningEffort=effortValue(patch.reasoningEffort);
    for(const key of ['fastMode','autoRoute'])if(key in patch){if(typeof patch[key]!=='boolean')throw new Error('开关必须为开或关');next[key]=patch[key];}
    if('contextBudget'in patch){const n=Number(patch.contextBudget);if(!Number.isInteger(n)||n<4000||n>200000)throw new Error('上下文预算需为 4000–200000 tokens');next.contextBudget=n;}
    if('visualFps'in patch){if(![2,4,8].includes(Number(patch.visualFps)))throw new Error('密度仅支持 2、4、8 帧/秒');next.visualFps=Number(patch.visualFps);}
    if(['model','reasoningEffort','fastMode'].some(k=>k in patch))await this.resolve(next);
    const keys=['model','reasoningEffort','fastMode','autoRoute','contextBudget','visualFps'],modelKeys=['model','reasoningEffort','fastMode'];if(modelKeys.some(k=>k in patch))saveModelSettings(this.store,harness,Object.fromEntries(modelKeys.map(k=>[k,next[k]])));this.store.saveConfig(Object.fromEntries(keys.filter(k=>!modelKeys.includes(k)&&k in patch).map(k=>[k,next[k]])));
    if(keys.some(k=>k!=='visualFps'&&k in patch))configurePanel(this.store,'model');return this.store.config;
  }
  describe(){const c={...this.store.config,...this.agentConfig()};const name=this.codex.harnessName==='dsh'?'DeepSeek Harness':'Codex';return `助手：${name}\n模型：${c.model||name+' 默认'}\n强度：${effortNames[c.reasoningEffort]||c.reasoningEffort||name+' 默认'}\n快速：${c.fastMode?'开':'关'}；密度：${c.visualFps} 帧/秒\n自动分聊：${c.autoRoute?'开':'关'}；上下文预算：${c.contextBudget} tokens`;}
}
import {configurePanel} from './ui-state.mjs';
