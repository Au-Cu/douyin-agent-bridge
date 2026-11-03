import { chromium } from 'playwright-core';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { toPlainChatText,comparableChatText,matchesOutgoingText } from './chat-text.mjs';
import {createHash} from 'node:crypto';
import {bindScanIdentity} from './chat-identity.mjs';
import {inspectInbox} from './inbox.mjs';
import {prepareQuote,inspectQuoteDraft,inspectQuoteSchema,inspectNativeMentionDraft,clickQuoteAction,allowComposerDraft,focusComposerEnd} from './quote-reply.mjs';

// Executed inside the dedicated, locally logged-in browser. No cookies or tokens leave it.
// Share-card extraction follows the publicly documented React message shape used by
// Aaron-gx/douyin-fire-desktop; this module is an independent, receive-only-first adapter.
export function scanConversation() {
  const scope=this?.document?this:globalThis,document=scope.document,location=scope.location,innerWidth=scope.innerWidth,innerHeight=scope.innerHeight,getComputedStyle=scope.getComputedStyle.bind(scope);
  const visible=e=>!!(e&&e.getClientRects().length);
  const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
  scope.__douyinBridgeDocumentIdentity||=String(Date.now())+'-'+Math.random().toString(36).slice(2);
  // Safari cannot read HttpOnly cookies. A readable account-UID cookie is used
  // only as an in-browser change marker; no cookie value is returned or logged.
  let accountMarker='';try{const parts=document.cookie.split(';').map(s=>s.trim()).filter(s=>/^(?:uid_tt|uid_tt_ss)=/.test(s)).sort();if(parts.length){let a=2166136261,b=2246822519;for(const c of parts.join(';')){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b^c.charCodeAt(0),3266489917);}accountMarker=(a>>>0).toString(16)+(b>>>0).toString(16);}}catch{}
  const id=v=>v==null||typeof v==='number'&&!Number.isSafeInteger(v)?'':typeof v==='object'?(v.toString?.()!=='[object Object]'?String(v):''):String(v);
  function reactMessage(node) {
    let el=node;
    for(let n=0;n<8&&el;n++,el=el.parentElement) {
      for(const key of Object.keys(el).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))) {
        let fiber=el[key];
        for(let j=0;j<15&&fiber;j++,fiber=fiber.return) {
          const props=fiber.memoizedProps||fiber;
          for(const value of [props.message,props.msg,props.data?.message,props.item?.message]) {
            if(value&&typeof value==='object'&&(value.content||value.parsedContent||value.messageId||value.serverId))return value;
          }
        }
      }
    }
    return null;
  }
  function direction(node,m) {
    const row=node.closest('[class*="MessageBoxContentrowBox"], [class*="messageMessageBoxcontentBox"], [data-e2e*="message-item"]')||node;
    const side=row.getAttribute('data-direction')||row.getAttribute('data-side')||'';
    if(/out|right|self/.test(side))return 'out'; if(/in|left/.test(side))return 'in';
    const justify=getComputedStyle(row).justifyContent;
    if(justify==='flex-end'||justify==='end')return 'out';
    if(justify==='flex-start'||justify==='start')return 'in';
    for(const key of ['isSelf','isFromMe','isMyMessage','isFromSelf'])if(typeof m[key]==='boolean')return m[key]?'out':'in';
    return 'unknown';
  }
  const title=[...document.querySelectorAll('.RightPanelHeadertitle,[class*="box-header-name"],[class*="item-header-name-"],[class*="conversation-title"]')].find(visible);
  const rows=[...document.querySelectorAll('[class*="MessageBoxContentrowBox"], [class*="MessageBoxContentcolumnBox"], [class*="messageMessageBoxcontentBox"], [data-e2e*="message-item"]')].filter(visible);
  const messages=[];const seen=new Set();const conversationTypes=new Set();let unknownDirection=0,withoutIdentity=0;
  for(const row of rows) {
    const m=reactMessage(row);if(!m)continue;
    let p=m.parsedContent;
    if(!p){try{p=typeof m.content==='string'?JSON.parse(m.content):m.content;}catch{p={text:m.content};}}
    p=p||{};
    const messageId=id(m.serverId||m.serverMessageId||m.server_message_id||m.messageId||m.msgId||m.id);
    const conversation=id(m.conversationId||m.conversation_id||m.conversationShortId||m.conversation_short_id);
    const fullId=id(m.conversationId||m.conversation_id||m.conversation?.id);
    const selfPair=fullId.match(/^\d+:1:(\d{5,32}):\1$/)?.[1];
    const conversationType=Number(m.conversationType??m.conversation_type??m.conversation?.type);
    if([1,2].includes(conversationType))conversationTypes.add(conversationType);
    const sender=id(m.sender?.uid||m.sender?.id||m.senderId||m.senderUserId||m.fromUserId||(typeof m.sender!=='object'?m.sender:''));
    if(!messageId||!sender){withoutIdentity++;continue;}
    if(seen.has(messageId))continue;seen.add(messageId);
    row.setAttribute('data-bridge-message-id',messageId);
    const side=direction(row,m);if(side==='unknown')unknownDirection++;
    const rawTime=m.createTime??m.createdAt??m.create_time??m.timestamp??m.createdTime;
    let created=Number(rawTime);if(created>0&&created<1e12)created*=1000;if(!Number.isFinite(created))created=0;
    const awemeId=id(p.itemId||p.item_id||p.awemeId||p.aweme_id);
    const rawText=String(p.text||p.content||p.textContent||(typeof m.content==='string'&&!m.content.startsWith('{')?m.content:''));
    const text=clean(rawText),lineBreaks=(rawText.match(/\n/g)||[]).length;
    // Only structured mention identities count. A literal @name, a quoted
    // mention, an @all token or text containing a UID never enables the bot.
    let mentioned=m.mentionedUsers??m.mentioned_users??p.mentioned_users??p.mentionedUsers??m.ext?.['awe:mention_users'];
    if(typeof mentioned==='string')try{mentioned=JSON.parse(mentioned);}catch{mentioned=[];}
    const mentionedUids=Array.isArray(mentioned)?[...new Set(mentioned.map(v=>id(v&&typeof v==='object'?(v.uid??v.userId??v.user_id??v):v)).filter(v=>/^\d{5,32}$/.test(v)))]:[];
    const ref=m.referenceInfo||m.reference_info||m.refInfo||p.referenceInfo||p.reference_info;
    let replyTo;
    if(ref&&typeof ref==='object'){
      const rawId=ref.referenced_message_id??ref.referencedMessageId??ref.refMessageId??ref.ref_message_id;
      const messageId=typeof rawId==='number'&&!Number.isSafeInteger(rawId)?'':id(rawId);
      let hint=ref.hint||'';try{if(typeof hint==='string')hint=JSON.parse(hint);}catch{hint={};}
      let sourceText=typeof hint?.content==='string'?hint.content:'';
      if(!sourceText&&typeof hint?.refmsg_content==='string'){try{const saved=JSON.parse(hint.refmsg_content);sourceText=typeof saved.text==='string'?saved.text:'';}catch{}}
      const rawStatus=ref.referenced_message_status??ref.referencedMessageStatus??ref.refMessageStatus;
      const authorId=id(hint?.refmsg_uid||hint?.sender_uid||'');
      replyTo={messageId:/^\d{5,32}$/.test(messageId)?messageId:'',status:rawStatus==null?null:Number(rawStatus),hint:sourceText.slice(0,12000),authorId};
    }
    const videoEl=row.querySelector('video');
    const mediaUrl=p.video?.play_addr?.url_list?.[0]||p.video_url||videoEl?.currentSrc||'';
    const kind=awemeId||videoEl?'video':text?'text':'unsupported';
    // Native group replies may prepend an @ token. Only structured rich-text
    // ranges identify that prefix; never strip an arbitrary @name by regex.
    const mentionPrefix=replyTo?.messageId&&Array.isArray(p.richTextInfos)?p.richTextInfos.find(r=>Number(r.location)===0&&Number.isSafeInteger(Number(r.length))&&Number(r.length)>0&&Number(r.length)<rawText.length&&/^\d{5,32}$/.test(id(r.info?.uid))&&rawText.startsWith('@')):null;
    const nativeReplyBody=mentionPrefix?{uid:id(mentionPrefix.info.uid),text:clean(rawText.slice(Number(mentionPrefix.length)))}:null;
    messages.push({id:messageId,conversation,selfPair,sender,direction:side,created,kind,text,lineBreaks,awemeId,title:clean(p.content_title||p.title||p.desc),mediaUrl,mentionedUids,...(replyTo?{replyTo}:{}),...(nativeReplyBody?{nativeReplyBody}:{})});
  }
  messages.sort((a,b)=>a.created-b.created);
  const interactiveRows=rows.filter(row=>{const e=row.querySelector('[class*="MessageBoxContentactiveClickArea"]')||row,r=e.getBoundingClientRect(),x=r.x+Math.min(24,r.width/4),y=r.y+Math.min(24,r.height/4);if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;const hit=document.elementFromPoint(x,y);return !!hit&&(e===hit||e.contains(hit));}).length;
  const inbound=messages.filter(m=>m.direction==='in');
  const last=inbound.at(-1);
  const current=last||messages.at(-1),chatKey=current?.conversation||'',idType=chatKey.match(/^\d+:([12]):/);
  if(idType)conversationTypes.add(Number(idType[1]));
  const type=conversationTypes.size===1?([...conversationTypes][0]===2?'group':'single'):'unknown';
  const ownIds=[...new Set(messages.filter(m=>m.direction==='out').map(m=>m.sender))],selfUid=ownIds.length===1?ownIds[0]:'';
  // A single-chat participant pair verifies self-chat independently of its title.
  const selfChat=type==='single'&&!!selfUid&&messages.every(m=>m.conversation===chatKey&&m.sender===selfUid)&&messages.some(m=>m.selfPair===selfUid);
  const peer=current?{chatKey:chatKey||'peer:'+current.sender,peerUid:type==='group'?'group:'+chatKey:selfChat?selfUid:last?.sender||'',displayName:clean(title?.textContent)||last?.sender||chatKey,type,selfUid,...(selfChat?{selfChat:true}:{})}:null;
  return {url:location.href,title:clean(title?.textContent),peer,messages,accountMarker,documentInstance:scope.__douyinBridgeDocumentIdentity,diagnostics:{rows:rows.length,parsed:messages.length,interactiveRows,unknownDirection,withoutIdentity,conversationType:type,selfIdentified:!!selfUid,selfIdentityConflict:ownIds.length>1},loginRequired:!messages.length&&/扫码登录|登录后.*消息|验证码登录/.test(document.body.innerText)};
}

export async function foregroundFrame(frame){
  for(let f=frame;f.parentFrame();f=f.parentFrame()){
    const reachable=await(await f.frameElement()).evaluate(e=>{const r=e.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')return false;return [[.5,.5],[.15,.15],[.85,.85]].some(([dx,dy])=>{const x=r.x+r.width*dx,y=r.y+r.height*dy;if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;const top=document.elementFromPoint(x,y);return top===e||e.contains(top);});});
    if(!reachable)return false;
  }return true;
}

export function isOwnerMessage(message,owner,armedAt) {
  if(!owner||message.direction!=='in'||message.sender!==owner.peerUid)return false;
  if((message.conversation||'peer:'+message.sender)!==owner.chatKey)return false;
  // Do not interpret newly rendered old history as fresh user commands.
  return message.created>0&&message.created>=armedAt-1500&&['text','video'].includes(message.kind);
}
export function selfChatInput(message,owner,armedAt) {
  if(message.sender!==owner.selfUid||message.conversation!==owner.chatKey||
    !Number.isFinite(message.created)||message.created<armedAt||message.created<=0||
    !/^\d{5,32}$/.test(message.id))return null;
  // The bridge only sends text and reactions. A native video card can be
  // forwarded as-is. Text requires an explicit trigger on the first line.
  if(message.kind==='video'&&/^\d{5,32}$/.test(message.awemeId))return message;
  const command=message.kind==='text'&&message.text.match(/^\/助手\s+(\S[\s\S]*)$/);
  return command?{...message,text:command[1].trim()}:null;
}
export const selfReplyPrefix='AI 回复\n\n';
export function matchesPeer(observed,expected){return !!(observed&&expected&&observed.chatKey===expected.chatKey&&observed.peerUid===expected.peerUid&&(!expected.type||expected.type==='unknown'||observed.type===expected.type||expected.legacy&&observed.type==='unknown')&&(!expected.selfChat||observed.selfChat===true)&&(!expected.selfUid||observed.selfUid===expected.selfUid));}

export function safeMediaUrl(value) {
  try {
    const u=new URL(value);
    const allowed=['douyin.com','iesdouyin.com','amemv.com','douyinvod.com','douyincdn.com','bytecdn.cn','byteimg.com','ibytedtos.com','bytecdn.com','douyinpic.com'];
    return u.protocol==='https:'&&allowed.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  } catch{return false;}
}

export function inspectComposers() {
  const scope=this?.document?this:globalThis,document=scope.document,innerWidth=scope.innerWidth,getComputedStyle=scope.getComputedStyle.bind(scope);
  return [...document.querySelectorAll('[contenteditable="true"],textarea')].map((el,index)=>{
    const rect=el.getBoundingClientRect();const clone=el.cloneNode(true);
    // Slate / Draft editors render their prompt inside the editable surface.
    // Placeholder text and zero-width caret markers are not a user's draft.
    clone.querySelectorAll('[data-slate-placeholder],[data-placeholder],[class*="placeholder" i]').forEach(n=>n.remove());
    clone.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));clone.querySelectorAll('div,p').forEach(n=>{n.prepend('\n');n.append('\n');});
    let text=el.tagName==='TEXTAREA'?el.value:clone.textContent||'';
    if(clone.querySelector('img,[data-slate-void="true"]'))text+='[非文字内容]';
    text=text.replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').trim();
    const visible=rect.width>0&&rect.height>0&&getComputedStyle(el).visibility!=='hidden';
    return {index,visible,x:rect.x,y:rect.y,width:rect.width,height:rect.height,text,tag:el.tagName,role:el.getAttribute('role'),className:String(el.className).slice(0,180),score:(visible?10000:0)+(rect.x>innerWidth*.25?1000:0)+rect.y};
  }).filter(e=>e.visible).sort((a,b)=>b.score-a.score);
}

export function inspectChatSurface(){
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const geometry=e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};};
  const rows=[...document.querySelectorAll('[data-bridge-message-id]')].filter(visible);
  const hit=e=>{const r=e.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.x+Math.min(24,r.width/4))),y=Math.max(0,Math.min(innerHeight-1,r.y+Math.min(24,r.height/4))),top=document.elementFromPoint(x,y);return {clear:!!top&&(e===top||e.contains(top)),topClass:String(top?.className||'').slice(0,160),topTag:top?.tagName||'',modalId:top?.closest('[id]')?.id||''};};
  const editors=[...document.querySelectorAll('[contenteditable="true"],textarea')].map(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e),onScreen=visible(e)&&r.x<innerWidth&&r.y<innerHeight&&r.right>0&&r.bottom>0;return {tag:e.tagName,className:String(e.className).slice(0,160),...geometry(e),visible:visible(e),onScreen,display:style.display,visibility:style.visibility,hit:onScreen?hit(e):null,ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,className:String(p.className).slice(0,120),...geometry(p),scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,overflow:getComputedStyle(p).overflow}))};});
  return {viewport:{width:innerWidth,height:innerHeight,outerWidth:globalThis.outerWidth,outerHeight:globalThis.outerHeight,visualHeight:globalThis.visualViewport?.height,visualScale:globalThis.visualViewport?.scale},editors,messages:rows.length,rows:rows.slice(-6).map(row=>{const target=row.querySelector('[class*="MessageBoxContentactiveClickArea"]')||row;return {className:String(row.className),...geometry(target),hit:hit(target)};}),layers:[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],#pc-im-popup-container,[class*="semi-modal-wrap"]')].filter(visible).map(e=>({tag:e.tagName,id:e.id,className:String(e.className).slice(0,160),...geometry(e),messageRows:e.querySelectorAll('[data-bridge-message-id]').length,iframes:e.querySelectorAll('iframe').length})).slice(0,12)};
}

// Inspect only a visible message context menu. Emoji identity must come from
// observable labels or a Unicode code point in the actual image URL.
export function captureMessageMenu(){
  const scope=this?.document?this:globalThis,document=scope.document,getComputedStyle=scope.getComputedStyle.bind(scope);
  scope.__douyinBridgeVisibleBefore=new WeakSet([...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'));
  // Keep the browser's own context menu from covering Douyin's reaction menu.
  // Do not stop propagation: the platform still handles its native web menu.
  const listener=e=>{if(e.target?.closest('[data-bridge-message-id]'))e.preventDefault();queueMicrotask(()=>{scope.__douyinBridgeContextEvent={type:e.type,button:e.button,trusted:e.isTrusted,prevented:e.defaultPrevented,targetClass:String(e.target?.className).slice(0,120)};});};
  scope.__douyinBridgeContextListener=listener;scope.__douyinBridgeContextEvent=null;document.addEventListener('contextmenu',listener,{once:true,capture:true});
}
export function inspectReactionChoices(token) {
  const scope=this?.document?this:globalThis,document=scope.document,getComputedStyle=scope.getComputedStyle.bind(scope);
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const before=scope.__douyinBridgeVisibleBefore;
  const appeared=before?[...document.querySelectorAll('body *')].filter(e=>!before.has(e)&&visible(e)):[];
  const freshMenus=appeared.filter(e=>{if(e.closest('[class*="messageMessageBoxcontentBox"],[data-bridge-message-id]')&&!e.matches('[role="menu"]'))return false;const text=e.innerText||'';return ['回复','复制','分享','转发','多选','删除','撤回'].filter(word=>text.includes(word)).length>=2;});
  const roots=[...new Set([...document.querySelectorAll('[role="menu"],[role="dialog"],[class*="MessageOperatePopBody"],[class*="contextmenu" i],[class*="context-menu" i],[class*="messageOperation" i],[class*="messageMenu" i],[class*="messageAction" i],[class*="rightClick" i],[class*="floatingPanel" i],[class*="popover" i],[class*="popper" i]'),...freshMenus])]
    .filter(e=>{const r=e.getBoundingClientRect();return visible(e)&&r.width<750&&r.height<650;});
  const candidates=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('button,[role="button"],img,[class*="emoji" i],[class*="reaction" i]')]))].filter(visible);
  const choices=[];
  for(const e of candidates){
    const imgs=e.matches('img')?[e]:[...e.querySelectorAll('img')];
    if(imgs.length>1)continue; // A whole row/grid is never one emoji target.
    const img=imgs[0];
    const label=[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-title'),e.textContent?.length<30?e.textContent:'',img?.alt,img?.title].filter(Boolean).join(' ').trim();
    const src=img?.getAttribute('src')||'';
    const value=label+' '+src;
    const emoji=/(?:^|[\s\[【])奋斗(?:[\]】\s]|$)/.test(label)?'[奋斗]':/👌|\[OK\]|(?:^|[\s_/-])ok[_\s.-]?(?:hand)?(?:[\s_.?/-]|$)|(?:^|[^a-f\d])1f44c(?:[^a-f\d]|$)/i.test(value)?'👌':/👀|眼睛|围观|(?:^|[^a-f\d])1f440(?:[^a-f\d]|$)/i.test(value)?'👀':/🎉|庆祝|撒花|(?:^|[^a-f\d])1f389(?:[^a-f\d]|$)/i.test(value)?'🎉':/✅|完成|勾选|2705/i.test(value)?'✅':/💪|肌肉|1f4aa/i.test(value)?'💪':/🤠|牛仔|1f920/i.test(value)?'🤠':/👍|\[赞\]|\[强\]|点赞|(?:^|[^a-f\d])1f44d(?:[^a-f\d]|$)/i.test(value)?'👍':'';
    if(!emoji)continue;
    const target=img?(img.closest('button,[role="button"]')||img):(e.closest('button,[role="button"]')||e);
    if(choices.some(c=>c.element===target))continue;
    const index=choices.length;target.setAttribute('data-bridge-reaction-choice',token+'-'+index);
    choices.push({element:target,index,emoji,label:label.slice(0,80),fresh:!!before&&!before.has(target),selected:target.getAttribute('aria-pressed')==='true'||target.getAttribute('data-state')==='checked'});
  }
  return {choices:choices.map(({element,...c})=>c),contextEvent:scope.__douyinBridgeContextEvent||null,menus:roots.map(r=>(r.innerText||'').trim().slice(0,200)).filter(Boolean).slice(0,5),appeared:appeared.filter(e=>!e.closest('[class*="messageMessageBoxcontentBox"],[data-bridge-message-id]')&&(e.matches('img,button,[role="button"]')||e.children.length===0)).slice(0,35).map(e=>({tag:e.tagName,className:String(e.className).slice(0,120),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('alt')||e.getAttribute('title')||'').slice(0,60)}))};
}

export function markMoreReactions(){
  const scope=this?.document?this:globalThis,document=scope.document;
  const roots=[...document.querySelectorAll('[role="menu"],[class*="MessageOperatePopBody"],[class*="contextmenu" i],[class*="messageMenu" i]')].filter(e=>e.getClientRects().length);
  for(const root of roots){
    const options=[...root.querySelectorAll('button,[role="button"],[class*="expand" i],[class*="more" i]')].filter(e=>e.getClientRects().length);
    const more=options.find(e=>/展开|更多|expand|more/i.test([e.getAttribute('aria-label'),e.getAttribute('title'),e.textContent,String(e.className)].join(' ')));
    if(more){more.setAttribute('data-bridge-more-reactions','true');return true;}
    // Douyin's native quick-reaction row uses an unlabeled circular SVG caret.
    // Restrict structural detection to the row containing multiple emoji images,
    // never to message actions such as delete, share or reply.
    for(const img of root.querySelectorAll('img[class*="PopBodyEmojiQuickReply"]')){
      let row=img.parentElement;for(let depth=0;depth<4&&row&&root.contains(row);depth++,row=row.parentElement){
        if(row.querySelectorAll('img[class*="PopBodyEmojiQuickReply"]').length<2)continue;
        const carets=[...row.querySelectorAll('svg')].filter(svg=>{const r=svg.getBoundingClientRect();return svg.querySelector('circle')&&r.width>0&&r.width<=72&&r.height<=72&&svg.getClientRects().length;});
        if(carets.length===1){const target=carets[0].closest('button,[role="button"]')||carets[0].parentElement;if(!/回复|复制|分享|转发|多选|删除|撤回/.test(target.innerText||'')){target.setAttribute('data-bridge-more-reactions','true');return true;}}
        break;
      }
    }
  }
  return false;
}

export function inspectMessageReactions({messageId,emoji}) {
  const scope=this?.document?this:globalThis,document=scope.document;
  const row=[...document.querySelectorAll('[data-bridge-message-id]')].find(e=>e.getAttribute('data-bridge-message-id')===messageId);
  if(!row)return {found:false,count:0};
  const visible=e=>!!e.getClientRects().length;
  const containers=[...row.querySelectorAll('[class*="reaction" i],[class*="emojiReply" i],[class*="emojiResponse" i],[class*="MessageBoxContentBottomwrapper"],[data-e2e*="reaction"]')].filter(visible);
  const nodes=[...new Set(containers.flatMap(e=>[e,...e.querySelectorAll('img,[aria-label],[title]')]))];
  const pattern=emoji==='[奋斗]'?/(?:^|[\s\[【])奋斗(?:[\]】\s]|$)/:emoji==='👌'?/👌|\[OK\]|ok[_-]?hand|1f44c/i:emoji==='👀'?/👀|眼睛|围观|1f440/i:emoji==='🎉'?/🎉|庆祝|撒花|1f389/i:emoji==='✅'?/✅|完成|勾选|2705/i:emoji==='💪'?/💪|肌肉|1f4aa/i:emoji==='🤠'?/🤠|牛仔|1f920/i:/👍|\[赞\]|\[强\]|点赞|1f44d/i;
  return {found:true,count:nodes.filter(e=>pattern.test([e.textContent,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('alt'),e.getAttribute('src')].filter(Boolean).join(' '))).length};
}

export function markOwnerConversation(target){
  const scope=this?.document?this:globalThis,document=scope.document;
  const name=typeof target==='string'?target:target?.displayName||'',chatKey=typeof target==='object'?String(target.chatKey||''):'';
  document.querySelectorAll('[data-bridge-owner-choice]').forEach(e=>e.removeAttribute('data-bridge-owner-choice'));
  const rows=[...new Set(document.querySelectorAll('[class*="conversationConversationItemwrapper"],[data-e2e*="conversation-item"],[data-conversation-id]'))].filter(e=>e.getClientRects().length);
  const identity=row=>{const ids=new Set(),keys=new Set();for(const e of [row,...row.querySelectorAll('*')].slice(0,14))for(const key of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let fiber=e[key];for(let i=0;i<5&&fiber;i++,fiber=fiber.return){const p=fiber.memoizedProps||fiber;if(!p||typeof p!=='object')continue;Object.keys(p).forEach(k=>keys.add(k));for(const [v,explicit]of [[p,false],[p.conversation,true],[p.conv,true],[p.conversationInfo,true],[p.item,false],[p.data,false],[p.item?.conversation,true],[p.data?.conversation,true]]){if(!v||typeof v!=='object')continue;for(const k of ['conversationId','conversation_id','conversationShortId','conversation_short_id','shortId',...(explicit?['id']:[])]){const id=v[k];if(id!=null&&(typeof id!=='number'||Number.isSafeInteger(id))&&String(id)!=='[object Object]')ids.add(String(id));}}}}const attr=row.getAttribute('data-conversation-id');if(attr)ids.add(attr);return {matches:!!chatKey&&ids.has(chatKey),keys:[...keys].slice(0,24),identityFields:ids.size};};
  const inspected=rows.map(e=>({e,...identity(e)})),byId=inspected.filter(r=>r.matches),byName=rows.filter(e=>(e.innerText||'').split(/\n+/)[0].trim()===name);
  const matches=byId.length?byId.map(r=>r.e):byName;
  scope.__douyinBridgeChoiceDiagnostic={rows:rows.length,idMatches:byId.length,nameMatches:byName.length,shapes:inspected.slice(0,5).map(({e,keys,identityFields})=>({className:String(e.className).slice(0,180),keys,identityFields}))};
  if(matches.length===1)matches[0].setAttribute('data-bridge-owner-choice','true');
  return matches.length;
}

export class DouyinAdapter {
  constructor({root,log=()=>{}}){Object.assign(this,{root,log});this.status='closed';this.sending=false;}
  async open(owner) {
    if(this.context&&this.page&&!this.page.isClosed?.()){
      await this.page.bringToFront();
      if(!this.openFailed&&this.page.url().startsWith('https://www.douyin.com/chat'))return;
    }
    if(!this.context){
      await mkdir(join(this.root,'browser-profile'),{recursive:true});
      const context=this.context=await chromium.launchPersistentContext(join(this.root,'browser-profile'),{channel:'msedge',headless:false,viewport:null,args:['--disable-notifications']});
      context.on('close',()=>{if(this.context===context){this.context=null;this.page=null;this.status='closed';}});
    }
    this.page=this.context.pages().find(p=>p.url().startsWith('https://www.douyin.com/chat'))||this.context.pages()[0]||await this.context.newPage();
    await this.page.bringToFront();
    try{
      const target='https://www.douyin.com/chat?isPopup=1',navigate=()=>this.page.goto(target,{waitUntil:'domcontentloaded',timeout:60000});
      const internalError=e=>/interrupted by another navigation to ["']chrome-error:\/\/chromewebdata\//.test(e.message);
      for(let attempt=0;attempt<3;attempt++)try{await navigate();break;}catch(e){
        if(this.openFailed&&e.message.includes('interrupted by another navigation to "'+target+'"')){
          // A retry can already be committing the exact target. Accept it only
          // after inspecting the real document, not Chromium's fallback URL.
          await this.page.waitForFunction(url=>location.href===url&&document.readyState!=='loading',target,{timeout:15000});break;
        }
        // An old internal error-page commit can interrupt the next goto.
        // Retry only that exact race, at most twice. Other errors stay visible.
        if(attempt===2||!internalError(e))throw e;
      }
      this.openFailed=false;this.status='waiting_login';
    }
    catch(e){this.openFailed=true;this.status='open_error';throw e;}
    if(owner)await this.restoreOwner(owner).catch(e=>this.log('请在项目窗口选回用户会话：'+e.message));
  }
  async restoreOwner(owner){
    let clicked=false;
    for(let attempt=0;attempt<20;attempt++){
      const scan=await this.scan();
      if(matchesPeer(scan.peer,owner))return true;
      if(scan.loginRequired)return false;
      for(const frame of this.page.frames()){
        if(!/^https:\/\/(www\.)?douyin\.com\//.test(frame.url()))continue;
        if(!await foregroundFrame(frame))continue;
        const count=await frame.evaluate(markOwnerConversation,owner);this.lastSelectionDiagnostic=await frame.evaluate(()=>globalThis.__douyinBridgeChoiceDiagnostic||null);
        if(count>1)throw new Error('联系人重名，需手动选择后核验账号');
        if(count===1&&(!clicked||attempt===10)){await frame.locator('[data-bridge-owner-choice="true"]').click({timeout:3000});clicked=true;}
      }
      await new Promise(r=>setTimeout(r,500));
    }
    throw new Error('未恢复到绑定账号，发送保持暂停');
  }
  async scan({observeOnly=false}={}) {
    if(!this.context)return {peer:null,messages:[],diagnostics:{},loginRequired:true};
    const candidates=this.context.pages().filter(p=>!p.isClosed()&&p.url().startsWith('https://www.douyin.com/chat'));
    const scans=[];
    for(const page of candidates)for(const frame of page.frames()){
      if(!/^https:\/\/(www\.)?douyin\.com\//.test(frame.url()))continue;
      try{if(await foregroundFrame(frame))scans.push({page,frame,value:await frame.evaluate(scanConversation)});}catch{}
    }
    const best=scans.sort((a,b)=>Number(b.value.diagnostics.interactiveRows>0)-Number(a.value.diagnostics.interactiveRows>0)||b.value.messages.length-a.value.messages.length)[0];
    const raw=best?.value||{peer:null,messages:[],diagnostics:{pages:candidates.length},loginRequired:true};
    const cookies=await this.context.cookies('https://www.douyin.com/'),identityCookies=cookies.filter(c=>/^(?:uid_tt|uid_tt_ss|sessionid|sessionid_ss|sid_tt|sid_guard)$/.test(c.name)).map(c=>c.name+'='+c.value).sort();
    const marker=identityCookies.length?createHash('sha256').update(identityCookies.join(';')).digest('hex'):'';
    const value=bindScanIdentity(this,raw,marker);
    if(!observeOnly){if(best){this.page=best.page;this.chatFrame=best.frame;}this.lastScan=value;this.status=value.loginRequired?'waiting_login':value.peer?(value.diagnostics.interactiveRows===0?'blocked':'ready'):'select_chat';}return value;
  }
  async uiDiagnostics(){
    if(!this.page)return {opened:false};const frames=[];
    for(const f of this.page.frames())if(/^https:\/\/(?:[a-z\d-]+\.)?douyin\.com\//i.test(f.url())){
      let host=null;try{if(f!==this.page.mainFrame())host=await(await f.frameElement()).evaluate(e=>{const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {visible:!!e.getClientRects().length&&r.width>0&&r.height>0,hit:top===e||e.contains(top),className:String(e.className),parentClass:String(e.parentElement?.className||'').slice(0,100)};});frames.push({main:f===this.page.mainFrame(),host,...await f.evaluate(inspectChatSurface)});}catch{}
    }return {opened:true,frames};
  }
  async inbox(){if(!this.chatFrame)return {entries:[],rows:0};return this.chatFrame.evaluate(inspectInbox);}
  async quoteSchema(){return this.chatFrame?{...await this.chatFrame.evaluate(inspectQuoteSchema),nativeDraft:await this.chatFrame.evaluate(inspectNativeMentionDraft)}:null;}
  async send(owner,text,{plainText=false,replyToMessageId='',replyToSenderUid=''}={}) {
    checkWork();
    if(this.sending)throw new Error('正在发送上一条回复');
    this.sending=true;let submitted=false,editor,surface,body;
    try {
      let scan=await this.scan();
      if(!matchesPeer(scan.peer,owner))throw new Error('请先在浏览器选回绑定的用户会话');
      surface=this.chatFrame||this.page;
      const composer=(await surface.evaluate(inspectComposers))[0];
      if(!composer)throw new Error('未找到私信输入框，抖音页面可能已改版');
      editor=surface.locator('[contenteditable="true"],textarea').nth(composer.index);
      const replyToSender=replyToSenderUid||scan.messages.find(m=>m.id===replyToMessageId)?.sender||'';
      if(!await allowComposerDraft(fn=>surface.evaluate(fn),composer.text,replyToMessageId,replyToSender))throw new Error('私信输入框有未发送的草稿，请先处理草稿');
      if(replyToMessageId)await prepareQuote({evaluate:(fn,arg)=>surface.evaluate(fn,arg),wait:ms=>new Promise(r=>setTimeout(r,ms)),verify:async()=>{checkWork();if(!matchesPeer((await this.scan()).peer,owner))throw new Error('会话已切换，停止准备引用');},openMenu:async()=>{await surface.evaluate(captureMessageMenu);await surface.locator('[data-bridge-quote-source="true"]').last().click({button:'right',timeout:3000});},choose:async token=>{checkWork();await surface.evaluate(clickQuoteAction,token);},diagnostic:v=>{this.lastQuoteDiagnostic=v;}},replyToMessageId);
      body=plainText?String(text).trim():toPlainChatText(text);
      const prefix=(await surface.evaluate(inspectComposers))[0]?.text||'';
      if(!await allowComposerDraft(fn=>surface.evaluate(fn),prefix,replyToMessageId,replyToSender))throw new Error('引用后出现了其他草稿，未填写回复');
      const expectedBody=prefix?prefix+' '+body:body;
      checkWork();await surface.evaluate(focusComposerEnd,{index:composer.index,expected:prefix});checkWork();await this.page.keyboard.insertText(prefix?' '+body:body);
      scan=await this.scan();
      if(!matchesPeer(scan.peer,owner))throw new Error('会话已切换，已取消发送，请检查未发送的草稿');
      if(replyToMessageId){const quote=await surface.evaluate(inspectQuoteDraft);if(quote.ids.length!==1||quote.ids[0]!==replyToMessageId)throw new Error('引用草稿已变化，已取消发送');}
      if(comparableChatText((await surface.evaluate(inspectComposers))[0]?.text)!==comparableChatText(expectedBody))throw new Error('回复草稿发生变化，未发送');
      const before=new Set(scan.messages.map(m=>m.id));
      checkWork();if(operationContext.getStore()?.delivery)operationContext.getStore().delivery.submitted=true;
      submitted=true;
      await this.page.keyboard.press('Enter');
      for(let i=0;i<15;i++) {
        await new Promise(r=>setTimeout(r,400));const after=await this.scan();
        if(!matchesPeer(after.peer,owner))throw new UncertainDelivery('发送后会话发生变化，请在抖音确认是否已收到');
        const matches=after.messages.filter(m=>m.direction==='out'&&!before.has(m.id)&&matchesOutgoingText(m,body,{replyToMessageId,replyToSender}));
        if(matches.length===1){if(replyToMessageId&&matches[0].replyTo?.messageId!==replyToMessageId)throw new UncertainDelivery('消息已发出，但未能核验它引用了指定原消息；不会自动重发');return {messageId:matches[0].id};}
        if(matches.length>1)throw new UncertainDelivery('检测到多条相同回复，无法确认本次发送的消息；不会自动重发');
      }
      throw new UncertainDelivery('已按下发送，但未能确认回执；不会自动重复发送');
    } catch(e){if(submitted)e.uncertain=true;else if(workSignal()?.aborted&&editor&&surface&&body){try{const scan=await this.scan(),draft=(await surface.evaluate(inspectComposers))[0];if(scan.peer?.chatKey===owner.chatKey&&scan.peer?.peerUid===owner.peerUid&&draft?.text===body)await editor.fill('');}catch{}}throw e;} finally {if(replyToMessageId&&surface)await surface.evaluate(()=>{document.removeEventListener('contextmenu',globalThis.__douyinBridgeContextListener,true);delete globalThis.__douyinBridgeContextListener;document.querySelectorAll('[data-bridge-quote-source],[data-bridge-quote-action]').forEach(e=>{e.removeAttribute('data-bridge-quote-source');e.removeAttribute('data-bridge-quote-action');});}).catch(()=>{});this.sending=false;}
  }
  async react(owner,messageId,{probeOnly=false,verifyOnly=false,emojis=['👌','👀','👍']}={}) {
    checkWork();
    if(this.sending)throw new Error('正在发送上一条回复');
    if(!/^\d{5,32}$/.test(messageId||''))return {supported:false,reason:'无法定位原视频消息'};
    this.sending=true;let submitted=false;let surface;let menuSurfaces=[];
    try{
      const scan=await this.scan();
      if(!matchesPeer(scan.peer,owner))throw new Error('请选回绑定的用户会话');
      this.lastReactionDiagnostic={messageId,stage:'locating'};
      surface=this.chatFrame||this.page;
      if(surface.mainFrame)surface=surface.mainFrame();
      menuSurfaces=[surface];for(const frame of this.page.frames())if(!menuSurfaces.includes(frame)&&/^https:\/\/([a-z\d-]+\.)?douyin\.com\//i.test(frame.url())&&await foregroundFrame(frame))menuSurfaces.push(frame);
      const row=surface.locator('[data-bridge-message-id="'+messageId+'"]');
      // The message list virtualizes old cards. Scroll only this bound chat,
      // then restore its tail so incoming messages stay visible to the listener.
      for(let attempt=0;attempt<12&&await row.count()===0;attempt++){
        const step=await surface.evaluate(()=>{
          let e=[...document.querySelectorAll('[class*="messageMessageBoxcontentBox"],[data-bridge-message-id]')].find(n=>n.getClientRects().length);
          for(;e;e=e.parentElement)if(e.scrollHeight>e.clientHeight+40&&/auto|scroll/.test(getComputedStyle(e).overflowY)){
            globalThis.__douyinBridgeReactionScroller=e;const previous=e.scrollTop;
            // column-reverse chat lists use negative scrollTop for older items.
            e.scrollTop=previous-Math.max(300,e.clientHeight*.85);return {moved:previous!==e.scrollTop||previous===0,className:String(e.className),previous,position:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight,flex:getComputedStyle(e).flexDirection};
          }
          return false;
        });
        (this.lastReactionDiagnostic.scroll??=[]).push(step);if(!step?.moved)break;await new Promise(r=>setTimeout(r,400));const current=await this.scan();
        if(!matchesPeer(current.peer,owner))throw new Error('会话已切换，停止查找原消息');
      }
      if(await row.count()!==1)return {supported:false,reason:'原视频消息未显示在当前会话'};
      const cards=row.locator('[class*="ShareAweme"],[class*="shareAweme"],[class*="cardMsg"],[data-e2e*="share"],video');
      const areas=row.locator('[class*="MessageBoxContentactiveClickArea"]');
      const target=await areas.count()?areas.first():await cards.count()?cards.first():row;
      const structure=await row.evaluate(e=>{
        const nodes=[e,...e.querySelectorAll('*')].slice(0,30);let p=e.parentElement;for(let i=0;i<4&&p;i++,p=p.parentElement)nodes.push(p);
        return {rowClass:String(e.className),children:nodes.map(n=>{
          const key=Object.keys(n).find(k=>k.startsWith('__reactProps$'));const props=key?n[key]:{};
          return {tag:n.tagName,className:String(n.className).slice(0,120),handlers:Object.keys(props).filter(k=>/^on(?:ContextMenu|MouseDown|MouseUp|PointerDown|Click)$/.test(k)&&typeof props[k]==='function'),contextMenu:typeof props.onContextMenu==='function'?String(props.onContextMenu).slice(0,500):undefined};
        })};
      });
      await target.scrollIntoViewIfNeeded({timeout:2500});const hit=await target.evaluate(e=>{
        const r=e.getBoundingClientRect();for(const [x,y]of [[Math.min(24,r.width/4),Math.min(24,r.height/4)],[r.width/2,r.height/2],[Math.min(12,r.width/4),Math.max(1,r.height-12)]]){const top=document.elementFromPoint(r.x+x,r.y+y);if(top&&(top===e||e.contains(top)))return {clear:true,x,y};}return {clear:false};
      });
      this.lastReactionDiagnostic={messageId,structure,stage:'before_menu',hit};
      if(!hit.clear||!await foregroundFrame(surface))return {supported:false,notSubmitted:true,retryable:true,code:'OVERLAY_BLOCKED',reason:'抖音弹层遮挡原消息，尚未点击表情；弹层关闭后可恢复。'};
      await Promise.all(menuSurfaces.map(f=>f.evaluate(captureMessageMenu)));
      // The center of a video card is the SVG play control, which does not open
      // the message menu. Use a point inside the card away from that control.
      const position={x:hit.x,y:hit.y};
      await target.click({button:'right',timeout:3500,...(position?{position}:{})});
      await new Promise(r=>setTimeout(r,250));
      const token=String(Date.now());let menus=await Promise.all(menuSurfaces.map(async(f,i)=>({surface:f,token:token+'f'+i,value:await f.evaluate(inspectReactionChoices,token+'f'+i)})));
      this.lastReactionDiagnostic={messageId,structure,frames:menus.map((m,i)=>({frame:i,...m.value}))};
      let selected;
      for(const emoji of emojis){selected=menus.map(m=>({menu:m,choice:m.value.choices.find(c=>c.emoji===emoji)})).find(c=>c.choice);if(selected)break;}
      if(!selected){
        for(const frame of menuSurfaces){if(await frame.evaluate(markMoreReactions)){await frame.locator('[data-bridge-more-reactions="true"]').first().click({timeout:8000});await new Promise(r=>setTimeout(r,200));break;}}
        menus=await Promise.all(menuSurfaces.map(async(f,i)=>({surface:f,token:token+'more'+i,value:await f.evaluate(inspectReactionChoices,token+'more'+i)})));
        this.lastReactionDiagnostic.frames=menus.map((m,i)=>({frame:i,...m.value}));
        for(const emoji of emojis){selected=menus.map(m=>({menu:m,choice:m.value.choices.find(c=>c.emoji===emoji)})).find(c=>c.choice);if(selected)break;}
      }
      const choice=selected?.choice;
      if(probeOnly)return {supported:!!choice,probeOnly:true};
      if(verifyOnly){const verified=!!choice?.selected&&choice.fresh;return {supported:!!choice,verified,readOnly:true,emoji:choice?.emoji,reason:verified?'已核验原消息新菜单中的本账号选中状态':'未取得本账号已选择该表情的证据；未点击表情。'};}
      if(!choice)return {supported:false,reason:'此消息菜单没有可核验的贴表情选项'};
      if(choice.selected)return {supported:true,verified:true,emoji:choice.emoji};
      const before=await surface.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});
      // Do not toggle an existing reaction when self ownership is not exposed.
      if(before.count)return {supported:false,reason:'原消息已有同款表情，避免反复点击撤销'};
      const current=await this.scan();
      if(!matchesPeer(current.peer,owner))throw new Error('会话已切换，已取消表情回应');
      checkWork();submitted=true;
      await selected.menu.surface.locator('[data-bridge-reaction-choice="'+selected.menu.token+'-'+choice.index+'"]').click({timeout:3500});
      for(let i=0;i<10;i++){
        await new Promise(r=>setTimeout(r,300));const after=await this.scan();
        if(!matchesPeer(after.peer,owner))throw new UncertainDelivery('表情回应后会话已切换');
        const evidence=await surface.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});
        if(evidence.count>before.count)return {supported:true,verified:true,emoji:choice.emoji};
      }
      throw new UncertainDelivery('已点击消息表情，但未能核验贴到原消息，不重复点击');
    }catch(e){if(submitted)e.uncertain=true;else if(/intercepts pointer events/.test(e.message)){e.notSubmitted=true;e.retryable=true;e.code='OVERLAY_BLOCKED';}throw e;}
    finally{if(surface){await this.page.keyboard.press('Escape').catch(()=>{});await Promise.all(menuSurfaces.map(f=>f.evaluate(()=>{
      document.removeEventListener('contextmenu',globalThis.__douyinBridgeContextListener,true);
      const scroll=globalThis.__douyinBridgeReactionScroller;if(scroll?.isConnected)scroll.scrollTop=scroll.scrollHeight;
      delete globalThis.__douyinBridgeReactionScroller;delete globalThis.__douyinBridgeVisibleBefore;delete globalThis.__douyinBridgeContextListener;delete globalThis.__douyinBridgeContextEvent;
    }).catch(()=>{})));}this.sending=false;}
  }
  async acknowledge(owner,payload,text){
    let reactionStatus='not_requested';
    if(payload.mode!=='text'){
      try{
        const reaction=await this.react(owner,payload.messageId);
        if(reaction.verified){this.lastReceipt={method:'reaction',emoji:reaction.emoji};return this.lastReceipt;}
        reactionStatus='unavailable';
        this.log('贴消息表情不可用，改用文字确认：'+reaction.reason);
      }catch(e){
        reactionStatus=e.uncertain?'uncertain':'blocked';
        this.log('表情确认未完成，未重复点击；改用一条文字确认：'+e.message);
      }
    }
    await this.send(owner,text,{plainText:true});this.lastReceipt={method:'text',reactionStatus};return this.lastReceipt;
  }
  async composerState(){await this.scan();return this.chatFrame?this.chatFrame.evaluate(inspectComposers):[];}
  async resolveVideo(message) {
    checkWork();const signal=workSignal();
    if(!/^\d{12,24}$/.test(message.awemeId))throw new Error('分享卡片没有有效的视频 ID，暂未读到视频正文');
    if(!this.context)throw new Error('请先登录抖音助手账号');
    const tab=await this.context.newPage();let found=null;
    const abort=()=>tab.close().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
    const capture=async response=>{
      if(!/\/aweme\/(v\d+\/)?web\/aweme\/detail|\/aweme\/detail/.test(response.url()))return;
      try{const j=await response.json();const a=j.aweme_detail||j.data?.aweme_detail;if(String(a?.aweme_id)===message.awemeId)found=a;}catch{}
    };
    tab.on('response',capture);
    try {
      await raceWork(tab.goto('https://www.douyin.com/video/'+message.awemeId,{waitUntil:'domcontentloaded',timeout:60000}));
      let src='';
      for(let i=0;i<30;i++) {
        checkWork();
        if(found?.video?.play_addr?.url_list?.length)break;
        src=await tab.evaluate(()=>document.querySelector('video')?.currentSrc||'');
        if(safeMediaUrl(src))break;
        await new Promise(r=>setTimeout(r,500));
      }
      const urls=found?.video?.bit_rate?.map(b=>b.play_addr?.url_list?.[0]).filter(Boolean)||[];
      const url=[found?.video?.play_addr?.url_list?.[0],...urls,src,message.mediaUrl].find(safeMediaUrl);
      if(!url)throw new Error('视频正文获取失败：可能需要重新登录、处理验证，或该视频已不可访问');
      return {url,title:found?.desc||message.title||'抖音视频 '+message.awemeId,author:found?.author?.nickname||'',seconds:(found?.video?.duration||0)/1000,source:'https://www.douyin.com/video/'+message.awemeId};
    } finally {signal?.removeEventListener('abort',abort);await tab.close();}
  }
  async download(url,destination,maxBytes=300*1024*1024) {
    checkWork();const signal=workSignal();
    if(!safeMediaUrl(url))throw new Error('拒绝非抖音媒体地址');
    const cookies=await this.context.cookies(url);
    const response=await fetch(url,{headers:{Referer:'https://www.douyin.com/', 'User-Agent':await this.page.evaluate(()=>navigator.userAgent),Cookie:cookies.map(c=>c.name+'='+c.value).join('; ')},signal:AbortSignal.any([AbortSignal.timeout(180000),...(signal?[signal]:[])])});
    if(!response.ok)throw new Error('视频下载失败 HTTP '+response.status);
    if(!safeMediaUrl(response.url))throw new Error('视频下载跳转到了不支持的域名');
    if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('视频超过本次处理上限 '+Math.round(maxBytes/1024/1024)+' MB');
    const {open}=await import('node:fs/promises');const file=await open(destination+'.part','w');let size=0,head=Buffer.alloc(0);
    try {
      for await(const chunk of response.body){checkWork();size+=chunk.length;if(size>maxBytes)throw new Error('视频超过本次处理上限 '+Math.round(maxBytes/1024/1024)+' MB');if(head.length<32)head=Buffer.concat([head,Buffer.from(chunk)]).subarray(0,32);await file.write(chunk);}
      if(!head.includes(Buffer.from('ftyp')))throw new Error('下载结果不是有效 MP4，未进行视频学习');
      await file.close();await rename(destination+'.part',destination);return size;
    } catch(e){await file.close().catch(()=>{});await unlink(destination+'.part').catch(()=>{});throw e;}
  }
  async close(){await this.context?.close();}
}
export class UncertainDelivery extends Error {constructor(message){super(message);this.uncertain=true;}}
import {operationContext,checkWork,workSignal,raceWork} from './execution.mjs';
