export const effortNames={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const clean=s=>String(s||'').toLowerCase().replace(/[\s_.-]/g,'');
export function chooseModel(value,catalog){
  if(!value||['默认','default'].includes(value))return '';
  const exact=catalog.models.filter(m=>[m.id,m.model,m.displayName].some(x=>clean(x)===clean(value)));
  const matches=exact.length?exact:catalog.models.filter(m=>[m.id,m.model,m.displayName].some(x=>clean(x).includes(clean(value))));
  if(matches.length!==1)throw new Error(matches.length?'模型名称不唯一，请填写完整模型 ID。':'当前 Codex 未提供这个模型；发送 /模型 查看可用名单。');
  return matches[0].model;
}
export function effortValue(value){
  if(!value||['默认','default'].includes(value))return '';
  return Object.entries(effortNames).find(([k,v])=>clean(k)===clean(value)||clean(v)===clean(value))?.[0]||String(value).toLowerCase();
}
export class Preferences{
  constructor({store,codex}){Object.assign(this,{store,codex});}
  async catalog(){return this.codex.models();}
  async resolve(config=this.store.config,{light=false,preferWork=false}={}){
    const catalog=await this.catalog();
    const id=config.model||catalog.defaults.model;
    let model=catalog.models.find(m=>m.model===id||m.id===id);
    if(light&&!preferWork)model=catalog.models.find(m=>/luna/i.test(m.model))||model;
    if(!model)throw new Error('当前登录不可用所配置的模型，请发送 /模型 重新选择。');
    if(!light&&model.inputModalities&&!model.inputModalities.includes('image'))throw new Error('视频理解需要支持图片输入的模型。');
    const supported=model.supportedReasoningEfforts.map(e=>e.reasoningEffort);
    const effort=light?(supported.includes('low')?'low':supported[0]):config.reasoningEffort||(config.model?model.defaultReasoningEffort:catalog.defaults.effort||model.defaultReasoningEffort);
    if(!supported.includes(effort))throw new Error('此模型不支持该推理强度，可用：'+supported.map(e=>effortNames[e]||e).join('、'));
    const fastTier=model.serviceTiers?.find(t=>/fast/i.test(t.name)||['fast','priority'].includes(t.id));
    if(!light&&config.fastMode&&!fastTier)throw new Error('当前模型未提供快速模式。');
    return {model:model.model,effort,serviceTier:!light&&config.fastMode?fastTier.id:'default'};
  }
  work(){return this.resolve();}
  light(preferWork=false){return this.resolve(this.store.config,{light:true,preferWork});}
  update(patch){const task=(this.updating||Promise.resolve()).catch(()=>{}).then(()=>this.applyUpdate(patch));this.updating=task;return task;}
  async applyUpdate(patch){
    const next={...this.store.config};
    if('model'in patch)next.model=chooseModel(String(patch.model),await this.catalog());
    if('reasoningEffort'in patch)next.reasoningEffort=effortValue(patch.reasoningEffort);
    for(const key of ['fastMode','autoRoute'])if(key in patch){if(typeof patch[key]!=='boolean')throw new Error('开关必须为开或关');next[key]=patch[key];}
    if('contextBudget'in patch){const n=Number(patch.contextBudget);if(!Number.isInteger(n)||n<4000||n>200000)throw new Error('上下文预算需为 4000–200000 tokens');next.contextBudget=n;}
    if('visualFps'in patch){if(![2,4,8].includes(Number(patch.visualFps)))throw new Error('密度仅支持 2、4、8 帧/秒');next.visualFps=Number(patch.visualFps);}
    if(['model','reasoningEffort','fastMode'].some(k=>k in patch))await this.resolve(next);
    const keys=['model','reasoningEffort','fastMode','autoRoute','contextBudget','visualFps'];return this.store.saveConfig(Object.fromEntries(keys.filter(k=>k in patch).map(k=>[k,next[k]])));
  }
  describe(){const c=this.store.config;return `模型：${c.model||'Codex 默认'}\n强度：${effortNames[c.reasoningEffort]||c.reasoningEffort||'Codex 默认'}\n快速：${c.fastMode?'开':'关'}；密度：${c.visualFps} 帧/秒\n自动分聊：${c.autoRoute?'开':'关'}；上下文预算：${c.contextBudget} tokens`;}
}
