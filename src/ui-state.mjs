const panels=new Set(['setup','model','targets','storage','chats']);
export function configurePanel(store,key){
  if(!panels.has(key))throw new Error('未知配置卡片');
  if(!store.config.uiConfigured?.[key])store.saveConfig({uiConfigured:{...store.config.uiConfigured,[key]:true},uiPanels:{...store.config.uiPanels,[key]:true}});
}
export function updatePanels(store,patch){
  if(!patch||Array.isArray(patch)||typeof patch!=='object'||!Object.keys(patch).length||Object.entries(patch).some(([key,value])=>!panels.has(key)||typeof value!=='boolean'))throw new Error('折叠配置无效');
  store.saveConfig({uiPanels:{...store.config.uiPanels,...patch}});return store.config.uiPanels;
}
