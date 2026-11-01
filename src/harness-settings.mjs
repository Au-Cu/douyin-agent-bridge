import {harnessValue} from './harness.mjs';
const blank=()=>({model:'',reasoningEffort:'',fastMode:false});
export function modelSettings(config,harness='codex',{chat=false}={}){
  harnessValue(harness);
  if(harness==='codex')return chat?{model:config.chatModel||'',reasoningEffort:config.chatReasoningEffort||'',fastMode:config.chatFastMode===true}:{model:config.model||'',reasoningEffort:config.reasoningEffort||'',fastMode:config.fastMode===true};
  return {...blank(),...config.harnessSettings?.[harness]?.[chat?'chat':'agent']};
}
export function saveModelSettings(store,harness,patch,{chat=false}={}){
  harnessValue(harness);
  if(harness==='codex')return store.saveConfig(chat?Object.fromEntries(Object.entries(patch).map(([key,value])=>[{model:'chatModel',reasoningEffort:'chatReasoningEffort',fastMode:'chatFastMode'}[key],value])):patch);
  const all=store.config.harnessSettings||{},old=all[harness]||{};return store.saveConfig({harnessSettings:{...all,[harness]:{...old,[chat?'chat':'agent']:{...modelSettings(store.config,harness,{chat}),...patch}}}});
}
export function visibleSettings(config,harness,chatHarness=config.chatHarness||'codex'){
  const chat=modelSettings(config,chatHarness,{chat:true});return {...config,...modelSettings(config,harness),chatModel:chat.model,chatReasoningEffort:chat.reasoningEffort,chatFastMode:chat.fastMode};
}
