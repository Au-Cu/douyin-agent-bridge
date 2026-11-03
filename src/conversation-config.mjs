import {modelSettings} from './harness-settings.mjs';

export function verifiedAgentBinding(scan) {
  const peer=scan?.peer;
  if(!peer||scan.loginRequired||peer.type!=='single'||!/^\d{5,32}$/.test(peer.peerUid)||peer.chatKey.startsWith('peer:'))throw new Error('请打开主号的私信，并确认网页版已识别当前登录账号。');
  if(!/^\d{5,32}$/.test(peer.selfUid))throw new Error('无法核实当前登录账号。请用当前登录账号在这条私信手动发一条消息，再核验。');
  const same=peer.peerUid===peer.selfUid;
  if(same!==!!peer.selfChat)throw new Error('无法核实主号与当前登录账号的对应关系。');
  const ownerMessage=scan.messages.some(m=>m.conversation===peer.chatKey&&m.sender===peer.peerUid&&m.created>0&&(same||m.direction==='in'));
  if(!ownerMessage)throw new Error('请保留一条主号发出的消息，再读取会话。');
  return {peer,mode:same?'self':'assistant'};
}

export function agentBindings(config){
  const owner=config.owner;
  return {...config.agentBindings,...(owner?{[owner.selfChat?'self':'assistant']:owner}:{})};
}

export function overrideKey(peer,chat){
  return 'conversation:'+JSON.stringify([chat?'chat':'agent',peer.chatKey,peer.selfUid||'']);
}

export function effectiveConversation(config,peer,harness,{chat=false}={}){
  const saved=peer&&config.conversationOverrides?.[overrideKey(peer,chat)]||{};
  return {...modelSettings(config,harness,{chat}),...(saved.models?.[harness]||{}),
    autoRoute:saved.autoRoute??config.autoRoute,
    visualFps:saved.visualFps??config.visualFps??4,maxVideoSeconds:saved.maxVideoSeconds??config.maxVideoSeconds??1800,
    contextBudget:saved.contextBudget??(chat?config.chatContextBudget??16000:config.contextBudget??48000)};
}
