import { chromium } from 'playwright-core';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { toPlainChatText,comparableChatText } from './chat-text.mjs';

// Executed inside the dedicated, locally logged-in browser. No cookies or tokens leave it.
// Share-card extraction follows the publicly documented React message shape used by
// Aaron-gx/douyin-fire-desktop; this module is an independent, receive-only-first adapter.
export function scanConversation() {
  const visible=e=>!!(e&&e.getClientRects().length);
  const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
  const id=v=>v==null?'':typeof v==='object'?(v.toString?.()!=='[object Object]'?String(v):''):String(v);
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
  const messages=[];const seen=new Set();let unknownDirection=0,withoutIdentity=0;
  for(const row of rows) {
    const m=reactMessage(row);if(!m)continue;
    let p=m.parsedContent;
    if(!p){try{p=typeof m.content==='string'?JSON.parse(m.content):m.content;}catch{p={text:m.content};}}
    p=p||{};
    const messageId=id(m.serverId||m.serverMessageId||m.server_message_id||m.messageId||m.msgId||m.id);
    const conversation=id(m.conversationId||m.conversation_id||m.conversationShortId||m.conversation_short_id);
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
    const videoEl=row.querySelector('video');
    const mediaUrl=p.video?.play_addr?.url_list?.[0]||p.video_url||videoEl?.currentSrc||'';
    const kind=awemeId||videoEl?'video':text?'text':'unsupported';
    messages.push({id:messageId,conversation,sender,direction:side,created,kind,text,lineBreaks,awemeId,title:clean(p.content_title||p.title||p.desc),mediaUrl});
  }
  messages.sort((a,b)=>a.created-b.created);
  const inbound=messages.filter(m=>m.direction==='in');
  const last=inbound.at(-1);
  const peer=last?{chatKey:last.conversation||'peer:'+last.sender,peerUid:last.sender,displayName:clean(title?.textContent)||last.sender}:null;
  return {url:location.href,title:clean(title?.textContent),peer,messages,diagnostics:{rows:rows.length,parsed:messages.length,unknownDirection,withoutIdentity},loginRequired:!messages.length&&/扫码登录|登录后.*消息|验证码登录/.test(document.body.innerText)};
}

export function isOwnerMessage(message,owner,armedAt) {
  if(!owner||message.direction!=='in'||message.sender!==owner.peerUid)return false;
  if((message.conversation||'peer:'+message.sender)!==owner.chatKey)return false;
  // Do not interpret newly rendered old history as fresh user commands.
  return message.created>0&&message.created>=armedAt-1500&&['text','video'].includes(message.kind);
}

export function safeMediaUrl(value) {
  try {
    const u=new URL(value);
    const allowed=['douyin.com','iesdouyin.com','amemv.com','douyinvod.com','douyincdn.com','bytecdn.cn','byteimg.com','ibytedtos.com','bytecdn.com','douyinpic.com'];
    return u.protocol==='https:'&&allowed.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  } catch{return false;}
}

export function inspectComposers() {
  return [...document.querySelectorAll('[contenteditable="true"],textarea')].map((el,index)=>{
    const rect=el.getBoundingClientRect();const clone=el.cloneNode(true);
    // Slate / Draft editors render their prompt inside the editable surface.
    // Placeholder text and zero-width caret markers are not a user's draft.
    clone.querySelectorAll('[data-slate-placeholder],[data-placeholder],[class*="placeholder" i]').forEach(n=>n.remove());
    let text=el.tagName==='TEXTAREA'?el.value:clone.textContent||'';
    if(clone.querySelector('img,[data-slate-void="true"]'))text+='[非文字内容]';
    text=text.replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').trim();
    const visible=rect.width>0&&rect.height>0&&getComputedStyle(el).visibility!=='hidden';
    return {index,visible,x:rect.x,y:rect.y,width:rect.width,height:rect.height,text,tag:el.tagName,role:el.getAttribute('role'),className:String(el.className).slice(0,180),score:(visible?10000:0)+(rect.x>innerWidth*.25?1000:0)+rect.y};
  }).filter(e=>e.visible).sort((a,b)=>b.score-a.score);
}

// Inspect only a visible message context menu. Emoji identity must come from
// observable labels or a Unicode code point in the actual image URL.
export function captureMessageMenu(){
  globalThis.__douyinBridgeVisibleBefore=new WeakSet([...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'));
  // Keep the browser's own context menu from covering Douyin's reaction menu.
  // Do not stop propagation: the platform still handles its native web menu.
  const listener=e=>{if(e.target?.closest('[data-bridge-message-id]'))e.preventDefault();queueMicrotask(()=>{globalThis.__douyinBridgeContextEvent={type:e.type,button:e.button,trusted:e.isTrusted,prevented:e.defaultPrevented,targetClass:String(e.target?.className).slice(0,120)};});};
  globalThis.__douyinBridgeContextListener=listener;globalThis.__douyinBridgeContextEvent=null;document.addEventListener('contextmenu',listener,{once:true,capture:true});
}
export function inspectReactionChoices(token) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const before=globalThis.__douyinBridgeVisibleBefore;
  const appeared=before?[...document.querySelectorAll('body *')].filter(e=>!before.has(e)&&visible(e)):[];
  const freshMenus=appeared.filter(e=>{if(e.closest('[class*="messageMessageBoxcontentBox"],[data-bridge-message-id]')&&!e.matches('[role="menu"]'))return false;const text=e.innerText||'';return ['回复','复制','分享','转发','多选','删除','撤回'].filter(word=>text.includes(word)).length>=2;});
  const roots=[...new Set([...document.querySelectorAll('[role="menu"],[role="dialog"],[class*="MessageOperatePopBody"],[class*="contextmenu" i],[class*="context-menu" i],[class*="messageOperation" i],[class*="messageMenu" i],[class*="messageAction" i],[class*="rightClick" i],[class*="floatingPanel" i],[class*="popover" i],[class*="popper" i]'),...freshMenus])]
    .filter(e=>{const r=e.getBoundingClientRect();return visible(e)&&r.width<750&&r.height<650;});
  const candidates=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('button,[role="button"],img,[class*="emoji" i],[class*="reaction" i]')]))].filter(visible);
  const choices=[];
  for(const e of candidates){
    const img=e.matches('img')?e:e.querySelector('img');
    const label=[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-title'),e.textContent?.length<30?e.textContent:'',img?.alt,img?.title].filter(Boolean).join(' ').trim();
    const src=img?.getAttribute('src')||'';
    const value=label+' '+src;
    const emoji=/👌|\[OK\]|(?:^|[\s_/-])ok[_\s.-]?(?:hand)?(?:[\s_.?/-]|$)|(?:^|[^a-f\d])1f44c(?:[^a-f\d]|$)/i.test(value)?'👌':/👀|眼睛|围观|(?:^|[^a-f\d])1f440(?:[^a-f\d]|$)/i.test(value)?'👀':/🎉|庆祝|撒花|(?:^|[^a-f\d])1f389(?:[^a-f\d]|$)/i.test(value)?'🎉':/✅|完成|勾选|2705/i.test(value)?'✅':/💪|加油|肌肉|奋斗|1f4aa/i.test(value)?'💪':/🤠|牛仔|1f920/i.test(value)?'🤠':/👍|\[赞\]|\[强\]|点赞|(?:^|[^a-f\d])1f44d(?:[^a-f\d]|$)/i.test(value)?'👍':'';
    if(!emoji)continue;
    const target=e.closest('button,[role="button"]')||e;
    if(choices.some(c=>c.element===target))continue;
    const index=choices.length;target.setAttribute('data-bridge-reaction-choice',token+'-'+index);
    choices.push({element:target,index,emoji,label:label.slice(0,80),selected:target.getAttribute('aria-pressed')==='true'||target.getAttribute('data-state')==='checked'});
  }
  return {choices:choices.map(({element,...c})=>c),contextEvent:globalThis.__douyinBridgeContextEvent||null,menus:roots.map(r=>(r.innerText||'').trim().slice(0,200)).filter(Boolean).slice(0,5),appeared:appeared.filter(e=>!e.closest('[class*="messageMessageBoxcontentBox"],[data-bridge-message-id]')&&(e.matches('img,button,[role="button"]')||e.children.length===0)).slice(0,35).map(e=>({tag:e.tagName,className:String(e.className).slice(0,120),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('alt')||e.getAttribute('title')||'').slice(0,60)}))};
}

export function markMoreReactions(){
  const roots=[...document.querySelectorAll('[role="menu"],[class*="MessageOperatePopBody"],[class*="contextmenu" i],[class*="messageMenu" i]')].filter(e=>e.getClientRects().length);
  for(const root of roots){
    const options=[...root.querySelectorAll('button,[role="button"],[class*="expand" i],[class*="more" i]')].filter(e=>e.getClientRects().length);
    const more=options.find(e=>/展开|更多|expand|more/i.test([e.getAttribute('aria-label'),e.getAttribute('title'),e.textContent,String(e.className)].join(' ')));
    if(more){more.setAttribute('data-bridge-more-reactions','true');return true;}
  }
  return false;
}

export function inspectMessageReactions({messageId,emoji}) {
  const row=[...document.querySelectorAll('[data-bridge-message-id]')].find(e=>e.getAttribute('data-bridge-message-id')===messageId);
  if(!row)return {found:false,count:0};
  const visible=e=>!!e.getClientRects().length;
  const containers=[...row.querySelectorAll('[class*="reaction" i],[class*="emojiReply" i],[class*="emojiResponse" i],[class*="MessageBoxContentBottomwrapper"],[data-e2e*="reaction"]')].filter(visible);
  const nodes=[...new Set(containers.flatMap(e=>[e,...e.querySelectorAll('img,[aria-label],[title]')]))];
  const pattern=emoji==='👌'?/👌|\[OK\]|ok[_-]?hand|1f44c/i:emoji==='👀'?/👀|眼睛|围观|1f440/i:emoji==='🎉'?/🎉|庆祝|撒花|1f389/i:emoji==='✅'?/✅|完成|勾选|2705/i:emoji==='💪'?/💪|加油|肌肉|奋斗|1f4aa/i:emoji==='🤠'?/🤠|牛仔|1f920/i:/👍|\[赞\]|\[强\]|点赞|1f44d/i;
  return {found:true,count:nodes.filter(e=>pattern.test([e.textContent,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('alt'),e.getAttribute('src')].filter(Boolean).join(' '))).length};
}

export function markOwnerConversation(name){
  document.querySelectorAll('[data-bridge-owner-choice]').forEach(e=>e.removeAttribute('data-bridge-owner-choice'));
  const rows=[...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')].filter(e=>e.getClientRects().length);
  const matches=rows.filter(e=>(e.innerText||'').split(/\n+/)[0].trim()===name);
  if(matches.length===1)matches[0].setAttribute('data-bridge-owner-choice','true');
  return matches.length;
}

export class DouyinAdapter {
  constructor({root,log=()=>{}}){Object.assign(this,{root,log});this.status='closed';this.sending=false;}
  async open(owner) {
    if(this.context)return;
    await mkdir(join(this.root,'browser-profile'),{recursive:true});
    this.context=await chromium.launchPersistentContext(join(this.root,'browser-profile'),{channel:'msedge',headless:false,viewport:{width:1280,height:860},args:['--disable-notifications']});
    this.context.on('close',()=>{this.context=null;this.page=null;this.status='closed';});
    this.page=this.context.pages().find(p=>p.url().startsWith('https://www.douyin.com/chat'))||this.context.pages()[0]||await this.context.newPage();
    await this.page.goto('https://www.douyin.com/chat?isPopup=1',{waitUntil:'domcontentloaded',timeout:60000});this.status='waiting_login';
    if(owner)await this.restoreOwner(owner).catch(e=>this.log('请在项目窗口选回用户会话：'+e.message));
  }
  async restoreOwner(owner){
    let clicked=false;
    for(let attempt=0;attempt<20;attempt++){
      const scan=await this.scan();
      if(scan.peer?.chatKey===owner.chatKey&&scan.peer?.peerUid===owner.peerUid)return true;
      if(scan.loginRequired)return false;
      for(const frame of this.page.frames()){
        if(!/^https:\/\/(www\.)?douyin\.com\//.test(frame.url()))continue;
        const count=await frame.evaluate(markOwnerConversation,owner.displayName);
        if(count>1)throw new Error('联系人重名，需手动选择后核验账号');
        if(count===1&&(!clicked||attempt===10)){await frame.locator('[data-bridge-owner-choice="true"]').click({timeout:3000});clicked=true;}
      }
      await new Promise(r=>setTimeout(r,500));
    }
    throw new Error('未恢复到绑定账号，发送保持暂停');
  }
  async scan() {
    if(!this.context)return {peer:null,messages:[],diagnostics:{},loginRequired:true};
    const candidates=this.context.pages().filter(p=>!p.isClosed()&&p.url().startsWith('https://www.douyin.com/chat'));
    const scans=[];
    for(const page of candidates)for(const frame of page.frames()){
      if(!/^https:\/\/(www\.)?douyin\.com\//.test(frame.url()))continue;
      try{scans.push({page,frame,value:await frame.evaluate(scanConversation)});}catch{}
    }
    const best=scans.sort((a,b)=>b.value.messages.length-a.value.messages.length)[0];
    const value=best?.value||{peer:null,messages:[],diagnostics:{pages:candidates.length},loginRequired:true};
    if(best){this.page=best.page;this.chatFrame=best.frame;}
    this.lastScan=value;
    this.status=value.loginRequired?'waiting_login':value.peer?'ready':'select_chat';return value;
  }
  async send(owner,text,{plainText=false}={}) {
    if(this.sending)throw new Error('正在发送上一条回复');
    this.sending=true;let submitted=false;
    try {
      let scan=await this.scan();
      if(scan.peer?.chatKey!==owner.chatKey||scan.peer?.peerUid!==owner.peerUid)throw new Error('请先在浏览器选回绑定的用户会话');
      const surface=this.chatFrame||this.page;
      const composer=(await surface.evaluate(inspectComposers))[0];
      if(!composer)throw new Error('未找到私信输入框，抖音页面可能已改版');
      const editor=surface.locator('[contenteditable="true"],textarea').nth(composer.index);
      if(composer.text)throw new Error('私信输入框有未发送的草稿，请先处理草稿');
      const body=plainText?String(text).trim():toPlainChatText(text);
      await editor.click();await this.page.keyboard.insertText(body);
      scan=await this.scan();
      if(scan.peer?.chatKey!==owner.chatKey||scan.peer?.peerUid!==owner.peerUid)throw new Error('会话已切换，已取消发送，请检查未发送的草稿');
      const before=new Set(scan.messages.map(m=>m.id));
      submitted=true;
      await this.page.keyboard.press('Enter');
      for(let i=0;i<15;i++) {
        await new Promise(r=>setTimeout(r,400));const after=await this.scan();
        if(after.peer?.chatKey!==owner.chatKey)throw new UncertainDelivery('发送后会话发生变化，请在抖音确认是否已收到');
        if(after.messages.some(m=>m.direction==='out'&&!before.has(m.id)&&comparableChatText(m.text)===comparableChatText(body)))return;
      }
      throw new UncertainDelivery('已按下发送，但未能确认回执；不会自动重复发送');
    } catch(e){if(submitted)e.uncertain=true;throw e;} finally {this.sending=false;}
  }
  async react(owner,messageId,{probeOnly=false,emojis=['👌','👀','👍']}={}) {
    if(this.sending)throw new Error('正在发送上一条回复');
    if(!/^\d{5,32}$/.test(messageId||''))return {supported:false,reason:'无法定位原视频消息'};
    this.sending=true;let submitted=false;let surface;let menuSurfaces=[];
    try{
      const scan=await this.scan();
      if(scan.peer?.chatKey!==owner.chatKey||scan.peer?.peerUid!==owner.peerUid)throw new Error('请选回绑定的用户会话');
      this.lastReactionDiagnostic={messageId,stage:'locating'};
      surface=this.chatFrame||this.page;
      if(surface.mainFrame)surface=surface.mainFrame();
      menuSurfaces=[...new Set([surface,...this.page.frames().filter(f=>/^https:\/\/([a-z\d-]+\.)?douyin\.com\//i.test(f.url()))])];
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
        if(current.peer?.chatKey!==owner.chatKey||current.peer?.peerUid!==owner.peerUid)throw new Error('会话已切换，停止查找原消息');
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
      await Promise.all(menuSurfaces.map(f=>f.evaluate(captureMessageMenu)));
      // The center of a video card is the SVG play control, which does not open
      // the message menu. Use a point inside the card away from that control.
      const bounds=await target.boundingBox();const position=bounds?{x:Math.min(24,bounds.width/4),y:Math.min(24,bounds.height/4)}:undefined;
      await target.click({button:'right',timeout:3500,...(position?{position}:{})});
      await new Promise(r=>setTimeout(r,250));
      const token=String(Date.now());let menus=await Promise.all(menuSurfaces.map(async(f,i)=>({surface:f,token:token+'f'+i,value:await f.evaluate(inspectReactionChoices,token+'f'+i)})));
      this.lastReactionDiagnostic={messageId,structure,frames:menus.map((m,i)=>({frame:i,...m.value}))};
      let selected;
      for(const emoji of emojis){selected=menus.map(m=>({menu:m,choice:m.value.choices.find(c=>c.emoji===emoji)})).find(c=>c.choice);if(selected)break;}
      if(!selected&&!probeOnly){
        for(const frame of menuSurfaces){if(await frame.evaluate(markMoreReactions)){await frame.locator('[data-bridge-more-reactions="true"]').first().click({timeout:2500});await new Promise(r=>setTimeout(r,200));break;}}
        menus=await Promise.all(menuSurfaces.map(async(f,i)=>({surface:f,token:token+'more'+i,value:await f.evaluate(inspectReactionChoices,token+'more'+i)})));
        this.lastReactionDiagnostic.frames=menus.map((m,i)=>({frame:i,...m.value}));
        for(const emoji of emojis){selected=menus.map(m=>({menu:m,choice:m.value.choices.find(c=>c.emoji===emoji)})).find(c=>c.choice);if(selected)break;}
      }
      const choice=selected?.choice;
      if(probeOnly)return {supported:!!choice,probeOnly:true};
      if(!choice)return {supported:false,reason:'此消息菜单没有可核验的贴表情选项'};
      if(choice.selected)return {supported:true,verified:true,emoji:choice.emoji};
      const before=await surface.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});
      // Do not toggle an existing reaction when self ownership is not exposed.
      if(before.count)return {supported:false,reason:'原消息已有同款表情，避免反复点击撤销'};
      const current=await this.scan();
      if(current.peer?.chatKey!==owner.chatKey||current.peer?.peerUid!==owner.peerUid)throw new Error('会话已切换，已取消表情回应');
      submitted=true;
      await selected.menu.surface.locator('[data-bridge-reaction-choice="'+selected.menu.token+'-'+choice.index+'"]').click({timeout:3500});
      for(let i=0;i<10;i++){
        await new Promise(r=>setTimeout(r,300));const after=await this.scan();
        if(after.peer?.chatKey!==owner.chatKey||after.peer?.peerUid!==owner.peerUid)throw new UncertainDelivery('表情回应后会话已切换');
        const evidence=await surface.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});
        if(evidence.count>before.count)return {supported:true,verified:true,emoji:choice.emoji};
      }
      throw new UncertainDelivery('已点击消息表情，但未能核验贴到原消息，不重复点击');
    }catch(e){if(submitted)e.uncertain=true;throw e;}
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
    if(!/^\d{12,24}$/.test(message.awemeId))throw new Error('分享卡片没有有效的视频 ID，暂未读到视频正文');
    if(!this.context)throw new Error('请先登录抖音助手账号');
    const tab=await this.context.newPage();let found=null;
    const capture=async response=>{
      if(!/\/aweme\/(v\d+\/)?web\/aweme\/detail|\/aweme\/detail/.test(response.url()))return;
      try{const j=await response.json();const a=j.aweme_detail||j.data?.aweme_detail;if(String(a?.aweme_id)===message.awemeId)found=a;}catch{}
    };
    tab.on('response',capture);
    try {
      await tab.goto('https://www.douyin.com/video/'+message.awemeId,{waitUntil:'domcontentloaded',timeout:60000});
      let src='';
      for(let i=0;i<30;i++) {
        if(found?.video?.play_addr?.url_list?.length)break;
        src=await tab.evaluate(()=>document.querySelector('video')?.currentSrc||'');
        if(safeMediaUrl(src))break;
        await new Promise(r=>setTimeout(r,500));
      }
      const urls=found?.video?.bit_rate?.map(b=>b.play_addr?.url_list?.[0]).filter(Boolean)||[];
      const url=[found?.video?.play_addr?.url_list?.[0],...urls,src,message.mediaUrl].find(safeMediaUrl);
      if(!url)throw new Error('视频正文获取失败：可能需要重新登录、处理验证，或该视频已不可访问');
      return {url,title:found?.desc||message.title||'抖音视频 '+message.awemeId,author:found?.author?.nickname||'',seconds:(found?.video?.duration||0)/1000,source:'https://www.douyin.com/video/'+message.awemeId};
    } finally {await tab.close();}
  }
  async download(url,destination,maxBytes=300*1024*1024) {
    if(!safeMediaUrl(url))throw new Error('拒绝非抖音媒体地址');
    const cookies=await this.context.cookies(url);
    const response=await fetch(url,{headers:{Referer:'https://www.douyin.com/', 'User-Agent':await this.page.evaluate(()=>navigator.userAgent),Cookie:cookies.map(c=>c.name+'='+c.value).join('; ')},signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw new Error('视频下载失败 HTTP '+response.status);
    if(!safeMediaUrl(response.url))throw new Error('视频下载跳转到了不支持的域名');
    if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('视频超过本机处理上限 300 MB');
    const {open}=await import('node:fs/promises');const file=await open(destination+'.part','w');let size=0,head=Buffer.alloc(0);
    try {
      for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new Error('视频超过本机处理上限 300 MB');if(head.length<32)head=Buffer.concat([head,Buffer.from(chunk)]).subarray(0,32);await file.write(chunk);}
      if(!head.includes(Buffer.from('ftyp')))throw new Error('下载结果不是有效 MP4，未进行视频学习');
      await file.close();await rename(destination+'.part',destination);return size;
    } catch(e){await file.close().catch(()=>{});await unlink(destination+'.part').catch(()=>{});throw e;}
  }
  async close(){await this.context?.close();}
}
export class UncertainDelivery extends Error {constructor(message){super(message);this.uncertain=true;}}
