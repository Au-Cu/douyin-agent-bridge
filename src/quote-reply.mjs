// Diagnostic schemas contain property names and editor structure only. Never
// return draft text, message content, account state or arbitrary React values.
export function inspectQuoteSchema(){
  const scope=this?.document?this:globalThis,document=scope.document,items=[],seen=new WeakSet();
  const keys=v=>v&&typeof v==='object'?Object.keys(v).filter(k=>/^[a-zA-Z_]/.test(k)).slice(0,24):[];
  const shape=v=>({keys:keys(v),objects:Object.fromEntries(keys(v).filter(k=>v[k]&&typeof v[k]==='object'&&k!=='children').map(k=>[k,keys(v[k])]))});
  const roots=[...document.querySelectorAll('[class*="MsgInputReference"],[contenteditable="true"],textarea')].filter(e=>e.getClientRects().length);
  for(const root of roots.slice(0,12)){let e=root;for(let p=0;p<5&&e;p++,e=e.parentElement)for(const key of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[key];for(let j=0;j<12&&f;j++,f=f.return){if(seen.has(f))break;seen.add(f);const states=[];let s=f.memoizedState;for(let h=0;h<16&&s&&typeof s==='object';h++,s=s.next){if(s.memoizedState&&typeof s.memoizedState==='object')states.push(shape(s.memoizedState));}items.push({component:typeof f.type==='string'?f.type:f.type?.displayName||f.type?.name||'',props:shape(f.memoizedProps||f),states});}}}
  const mentions=[];for(const e of document.querySelectorAll('[data-bridge-message-id]'))for(const k of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[k];for(let n=0;n<8&&f;n++,f=f.return){const m=(f.memoizedProps||f).message;if(!m?.parsedContent)continue;const p=m.parsedContent;mentions.push({contentKeys:keys(p),richText:Array.isArray(p.richTextInfos)?p.richTextInfos.slice(0,3).map(shape):shape(p.richTextInfos),mentions:Array.isArray(p.mention_users)?p.mention_users.slice(0,3).map(shape):shape(p.mention_users)});break;}if(mentions.length>=4)break;}
  return {items:items.slice(0,60),mentions:mentions.slice(-6),editors:[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,children:[...e.querySelectorAll('*')].slice(0,32).map(c=>({tag:c.tagName,className:String(c.className).slice(0,100),attributes:[...c.attributes].map(a=>a.name),textLength:(c.textContent||'').length,props:Object.keys(c).filter(k=>/^__reactProps\$/.test(k)).map(k=>shape(c[k]))}))}))};
}

export function inspectNativeMentionDraft(){
  const scope=this?.document?this:globalThis,document=scope.document,editors=[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(e=>e.getClientRects().length),uids=new Set(),shapes=[];
  const id=v=>v!=null&&(typeof v!=='number'||Number.isSafeInteger(v))&&/^\d{5,32}$/.test(String(v))?String(v):'';
  const seen=new WeakSet(),inspect=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>4||seen.has(v)||v.props?.modules||v.modules?.ContentState)return;seen.add(v);if(depth===0&&shapes.length<12)shapes.push({propsKeys:Object.keys(v).slice(0,20),objects:Object.fromEntries(Object.keys(v).filter(k=>k!=='children'&&v[k]&&typeof v[k]==='object').slice(0,8).map(k=>[k,Object.keys(v[k]).slice(0,16)]))});for(const k of ['uid','userId','user_id','mentionUid']){const uid=id(v[k]);if(uid)uids.add(uid);}for(const k of Object.keys(v).slice(0,24))if(!['editor','Context','contextValue','style','children','_owner','return','next','ref'].includes(k)&&v[k]&&typeof v[k]==='object')inspect(v[k],depth+1);};
  for(const editor of editors){const tokens=[...editor.querySelectorAll('[data-fake-text][contenteditable="false"]')];if(tokens.length!==1)continue;const clone=editor.cloneNode(true);clone.querySelectorAll('[data-fake-text],[data-slate-placeholder],[data-placeholder],[class*="placeholder" i]').forEach(e=>e.remove());const rest=(clone.textContent||'').replace(/[\s\u200B-\u200D\u2060\uFEFF]/g,'');if(rest||!tokens[0].textContent.trim().startsWith('@'))continue;
    for(const e of [...tokens[0].querySelectorAll('[data-uuid]'),tokens[0],...tokens[0].querySelectorAll('*')]){for(const attr of ['data-uid','data-user-id','data-uuid']){const raw=e.getAttribute(attr),uid=id(raw);if(uid)uids.add(uid);else if(raw&&raw.length<2000)try{inspect(JSON.parse(raw));}catch{}}for(const k of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[k];for(let j=0;j<18&&f;j++,f=f.return)inspect(f.memoizedProps||f);}}
    return {onlyMention:true,uids:[...uids],shapes:shapes.slice(0,12)};
  }return {onlyMention:false,uids:[]};
}

export async function allowComposerDraft(evaluate,text,messageId,sender){
  if(!text)return true;if(!messageId||!sender)return false;
  const quote=await evaluate(inspectQuoteDraft),draft=await evaluate(inspectNativeMentionDraft);
  // Some native editor versions use opaque UUIDs for an @ token. In that
  // case its existing native quote must identify BOTH the source message and
  // its SDK sender. Preserve the token; never infer identity from its label.
  return quote.ids.length===1&&quote.ids[0]===messageId&&draft.onlyMention&&(draft.uids.length===1?draft.uids[0]===sender:draft.uids.length===0&&quote.senders?.length===1&&quote.senders[0]===sender);
}

export function focusComposerEnd({index,expected}){
  const scope=this?.document?this:globalThis,document=scope.document,e=document.querySelectorAll('[contenteditable="true"],textarea')[index];if(!e)throw new Error('输入框已变化');
  const clone=e.cloneNode(true);clone.querySelectorAll('[data-slate-placeholder],[data-placeholder],[class*="placeholder" i]').forEach(n=>n.remove());clone.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));clone.querySelectorAll('div,p').forEach(n=>{n.prepend('\n');n.append('\n');});const text=String(e.tagName==='TEXTAREA'?e.value:clone.textContent||'').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').trim();if(text!==expected)throw new Error('草稿已变化，未填写回复');
  e.focus();if(e.tagName==='TEXTAREA')e.setSelectionRange(e.value.length,e.value.length);else{const range=document.createRange();range.selectNodeContents(e);range.collapse(false);const selection=scope.getSelection();selection.removeAllRanges();selection.addRange(range);}return true;
}

export function inspectQuoteDraft(){
  const scope=this?.document?this:globalThis,document=scope.document,ids=new Set(),nativeIds=new Set(),senders=new Set(),shapes=[];
  const safeId=x=>x!=null&&(typeof x!=='number'||Number.isSafeInteger(x))&&/^\d{5,32}$/.test(String(x))?String(x):'';
  const fields=['referenceInfo','reference_info','replyInfo','replyMessage','replyingMessage','referenceMessage','refMessage','quotedMessage','replyTo','refMsg','reference'];
  const previews=[...document.querySelectorAll('[class*="reply" i],[class*="reference" i],[class*="refMsg" i],[data-e2e*="reply"]')].filter(e=>e.getClientRects().length&&!e.closest('[data-bridge-message-id],[role="menu"],[class*="MessageOperatePopBody"]')&&((e.innerText||'').trim()&&/refmsg|reference|replypreview|replymessage/i.test(String(e.className))||/^回复[：:\s]|^引用[：:\s]/.test((e.innerText||'').trim())));
  const inputs=[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(e=>e.getClientRects().length),roots=[...inputs,...previews];
  const inspect=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>2||v.parsedContent&&(v.serverId||v.serverMessageId))return;for(const k of ['referenced_message_id','referencedMessageId','refMessageId','ref_message_id']){const id=safeId(v[k]);if(id)ids.add(id);}for(const key of fields){const ref=v[key];if(!ref||typeof ref!=='object')continue;shapes.push({key,fields:Object.keys(ref).slice(0,16)});for(const k of ['serverId','serverMessageId','messageId','msgId','id']){const id=safeId(ref[k]);if(id)ids.add(id);}inspect(ref,depth+1);}};
  const checked=new WeakSet();for(const root of roots.slice(0,20)){let e=root;for(let p=0;p<7&&e;p++,e=e.parentElement)for(const key of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[key];for(let j=0;j<12&&f;j++,f=f.return){if(checked.has(f))break;checked.add(f);const props=f.memoizedProps||f;inspect(props);
    // The native MsgInputReference component receives the original SDK Message
    // instance. Its serverId is a prototype getter, absent from Object.keys.
    if(typeof props.setReferencedMsg==='function'&&props.message){const m=props.message;for(const k of ['serverId','serverMessageId','messageId','msgId','id']){const id=safeId(m[k]);if(id){nativeIds.add(id);shapes.push({key:'nativeQuotedMessage',fields:[k]});break;}}const sender=safeId(m.sender?.uid||m.sender?.id||m.senderId||m.senderUserId||m.fromUserId||(typeof m.sender!=='object'?m.sender:''));if(sender)senders.add(sender);}
    let state=f.memoizedState;for(let h=0;h<8&&state&&typeof state==='object';h++,state=state.next)inspect(state.memoizedState);}}}
  for(const e of previews)for(const k of ['data-message-id','data-reference-id','data-reply-id']){const id=safeId(e.getAttribute(k));if(id)ids.add(id);}
  // A quoted message can itself quote an older message. The native preview's
  // own Message ID wins over references nested inside that message's state.
  return {ids:[...(nativeIds.size?nativeIds:ids)],senders:[...senders],visible:previews.length>0,previewClasses:previews.slice(0,8).map(e=>String(e.className).slice(0,160)),shapes:shapes.slice(0,12)};
}
export function locateQuoteSource({messageId,scroll=false}){
  const scope=this?.document?this:globalThis,document=scope.document,row=[...document.querySelectorAll('[data-bridge-message-id]')].find(e=>e.getAttribute('data-bridge-message-id')===messageId);
  if(row){const e=row.querySelector('[class*="MessageBoxContentactiveClickArea"]')||row;e.setAttribute('data-bridge-quote-source','true');return {found:true};}
  if(scroll){let e=document.querySelector('[data-bridge-message-id]');for(;e;e=e.parentElement)if(e.scrollHeight>e.clientHeight+40&&/auto|scroll/.test(scope.getComputedStyle(e).overflowY)){scope.__douyinBridgeQuoteScroller=e;const before=e.scrollTop;e.scrollTop-=Math.max(300,e.clientHeight*.85);return {found:false,moved:e.scrollTop!==before};}}
  return {found:false,moved:false};
}
export function markQuoteAction(token){
  const scope=this?.document?this:globalThis,document=scope.document,before=scope.__douyinBridgeVisibleBefore,visible=e=>e.getClientRects().length&&scope.getComputedStyle(e).visibility!=='hidden';
  const fresh=before?[...document.querySelectorAll('body *')].filter(e=>!before.has(e)&&visible(e)&&['回复','复制','分享','转发','多选','删除','撤回'].filter(k=>(e.innerText||'').includes(k)).length>=2):[];
  const roots=[...document.querySelectorAll('[role="menu"],[class*="MessageOperatePopBody"],[class*="contextmenu" i],[class*="popover" i]'),...fresh].filter(visible),matches=[];
  for(const root of roots)for(const e of [root,...root.querySelectorAll('button,[role="button"],span,div')])if(visible(e)&&(e.innerText||'').trim()==='回复'&&![...e.children].some(c=>(c.innerText||'').trim()==='回复')){const target=e.closest('button,[role="button"]')||e;if(!matches.includes(target))matches.push(target);}
  if(matches.length===1)matches[0].setAttribute('data-bridge-quote-action',token);return matches.length;
}
export function clickQuoteAction(token){
  const scope=this?.document?this:globalThis,document=scope.document,e=document.querySelector('[data-bridge-quote-action="'+token+'"]');
  if(!e||(e.innerText||'').trim()!=='回复')throw new Error('原生回复入口已变化');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);
  if(!r.width||!r.height||scope.getComputedStyle(e).visibility==='hidden'||!top||!(top===e||e.contains(top)))throw new Error('原生回复入口被遮挡，未点击');
  // Click the verified native action, independent of popup entrance animation.
  e.click();return true;
}
export async function prepareQuote(io,messageId){
  if(!/^\d{5,32}$/.test(messageId||''))throw new Error('没有有效的群聊原消息编号，未发送回复');
  const existing=await io.evaluate(inspectQuoteDraft);if(existing.ids.length===1&&existing.ids[0]===messageId)return;if(existing.visible||existing.ids.length)throw new Error('输入框已有引用草稿，请先处理后再发送');
  let found=false;for(let i=0;i<12;i++){await io.verify();const located=await io.evaluate(locateQuoteSource,{messageId,scroll:i>0});if(located.found){found=true;break;}if(i>0&&!located.moved)break;await io.wait(250);}
  if(!found)throw new Error('原消息暂不在可读取的历史中，未发送无引用回复');
  await io.openMenu();const token=String(Date.now());let n=0;for(let i=0;i<12;i++){await io.wait(150);n=await io.evaluate(markQuoteAction,token);io.diagnostic({stage:'menu',matches:n});if(n)break;}if(n!==1)throw new Error('未找到唯一的原生“回复”入口，未发送无引用回复');await io.choose(token);
  for(let i=0;i<8;i++){await io.wait(150);const draft=await io.evaluate(inspectQuoteDraft);io.diagnostic(draft);if(draft.ids.length===1&&draft.ids[0]===messageId)return;}
  throw new Error('未能核验输入框引用的原消息编号，未发送回复');
}
