export function inspectQuoteDraft(){
  const scope=this?.document?this:globalThis,document=scope.document,ids=new Set(),shapes=[];
  const safeId=x=>x!=null&&(typeof x!=='number'||Number.isSafeInteger(x))&&/^\d{5,32}$/.test(String(x))?String(x):'';
  const fields=['referenceInfo','reference_info','replyInfo','replyMessage','replyingMessage','referenceMessage','refMessage','quotedMessage','replyTo','refMsg','reference'];
  const previews=[...document.querySelectorAll('[class*="reply" i],[class*="reference" i],[class*="refMsg" i],[data-e2e*="reply"]')].filter(e=>e.getClientRects().length&&!e.closest('[data-bridge-message-id],[role="menu"],[class*="MessageOperatePopBody"]')&&((e.innerText||'').trim()&&/refmsg|reference|replypreview|replymessage/i.test(String(e.className))||/^回复[：:\s]|^引用[：:\s]/.test((e.innerText||'').trim())));
  const inputs=[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(e=>e.getClientRects().length),roots=[...inputs,...previews];
  const inspect=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>2)return;for(const k of ['referenced_message_id','referencedMessageId','refMessageId','ref_message_id']){const id=safeId(v[k]);if(id)ids.add(id);}for(const key of fields){const ref=v[key];if(!ref||typeof ref!=='object')continue;shapes.push({key,fields:Object.keys(ref).slice(0,16)});for(const k of ['serverId','serverMessageId','messageId','msgId','id']){const id=safeId(ref[k]);if(id)ids.add(id);}inspect(ref,depth+1);}};
  const checked=new WeakSet();for(const root of roots.slice(0,20)){let e=root;for(let p=0;p<7&&e;p++,e=e.parentElement)for(const key of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[key];for(let j=0;j<12&&f;j++,f=f.return){if(checked.has(f))break;checked.add(f);inspect(f.memoizedProps||f);let state=f.memoizedState;for(let h=0;h<8&&state&&typeof state==='object';h++,state=state.next)inspect(state.memoizedState);}}}
  for(const e of previews)for(const k of ['data-message-id','data-reference-id','data-reply-id']){const id=safeId(e.getAttribute(k));if(id)ids.add(id);}
  return {ids:[...ids],visible:previews.length>0,previewClasses:previews.slice(0,8).map(e=>String(e.className).slice(0,160)),shapes:shapes.slice(0,12)};
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
  for(const root of roots)for(const e of root.querySelectorAll('button,[role="button"],span,div'))if(visible(e)&&(e.innerText||'').trim()==='回复'&&![...e.children].some(c=>(c.innerText||'').trim()==='回复')){const target=e.closest('button,[role="button"]')||e;if(!matches.includes(target))matches.push(target);}
  if(matches.length===1)matches[0].setAttribute('data-bridge-quote-action',token);return matches.length;
}
export async function prepareQuote(io,messageId){
  if(!/^\d{5,32}$/.test(messageId||''))throw new Error('没有有效的群聊原消息编号，未发送回复');
  const existing=await io.evaluate(inspectQuoteDraft);if(existing.visible||existing.ids.length)throw new Error('输入框已有引用草稿，请先处理后再发送');
  let found=false;for(let i=0;i<12;i++){await io.verify();const located=await io.evaluate(locateQuoteSource,{messageId,scroll:i>0});if(located.found){found=true;break;}if(i>0&&!located.moved)break;await io.wait(250);}
  if(!found)throw new Error('原消息暂不在可读取的历史中，未发送无引用回复');
  await io.openMenu();const token=String(Date.now());await io.wait(150);const n=await io.evaluate(markQuoteAction,token);io.diagnostic({stage:'menu',matches:n});if(n!==1)throw new Error('未找到唯一的原生“回复”入口，未发送无引用回复');await io.choose(token);
  for(let i=0;i<8;i++){await io.wait(150);const draft=await io.evaluate(inspectQuoteDraft);io.diagnostic(draft);if(draft.ids.length===1&&draft.ids[0]===messageId)return;}
  throw new Error('未能核验输入框引用的原消息编号，未发送回复');
}
