import {spawn} from 'node:child_process';
import {mkdir,readFile,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {durableJson} from './durable.mjs';
import {toPlainChatText,comparableChatText,matchesOutgoingText} from './chat-text.mjs';
import {scanConversation,inspectComposers,markOwnerConversation,captureMessageMenu,inspectReactionChoices,markMoreReactions,inspectMessageReactions,safeMediaUrl,UncertainDelivery,matchesPeer} from './douyin.mjs';
import {checkWork,workSignal,operationContext} from './execution.mjs';
import {bindScanIdentity,applyVerifiedIdentity} from './chat-identity.mjs';
import {inspectInbox} from './inbox.mjs';
import {prepareQuote,inspectQuoteDraft,inspectQuoteSchema,inspectNativeMentionDraft,clickQuoteAction,allowComposerDraft,focusComposerEnd} from './quote-reply.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>'"'+String(s).replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const allowed='https://www.douyin.com/';
function osa(script){
  return new Promise((resolve,reject)=>{const child=spawn('/usr/bin/osascript',['-'],{stdio:['pipe','pipe','pipe']});let out='',err='';const permission=()=>Object.assign(new Error('请在系统设置的隐私与安全性中允许终端控制 Safari，并在 Safari 开发者设置启用“允许来自 Apple 事件的 JavaScript”。'),{code:'SAFARI_PERMISSION'});const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Safari 自动化超时，请检查系统授权和抖音窗口。'),{code:'SAFARI_TIMEOUT'}));},20000);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',()=>{clearTimeout(timer);reject(new Error('无法连接 Safari，请检查系统自动化授权。'));});child.on('exit',code=>{clearTimeout(timer);if(code===0)return resolve(out.trim());if(/1743|not authorized|not permitted|not allowed|enable.*javascript|javascript.*apple events|不允许|未获授权/i.test(err))return reject(permission());reject(new Error('Safari 窗口或网页不可操作，请检查抖音页面并重试。'));});child.stdin.end(script);});
}
// The bridge acts only in the window it created. A per-tab marker prevents an
// old numeric window id from accidentally selecting someone else's window.
export class SafariDouyinAdapter {
  constructor({root,log=()=>{},executeAppleScript=osa}){Object.assign(this,{root,log,executeAppleScript});this.status='closed';this.sending=false;this.windowId=0;this.tabIndex=0;this.marker='';this.page=null;this.tail=Promise.resolve();}
  async apple(script){const task=this.tail.catch(()=>{}).then(()=>this.executeAppleScript(script));this.tail=task;return task;}
  // Safari's AppleScript resolves a tab index unreliably when the index or
  // the window comes from a loop variable, so the whole tab list is fetched
  // in one call and the tab is located here by its URL.
  async tabUrls(windowId=this.windowId){
    const raw=await this.apple(`tell application "Safari"\nset parts to ""\nset urls to URL of every tab of window id ${Number(windowId)}\nrepeat with i from 1 to count of urls\nset parts to parts & (i as text) & tab & ((item i of urls) as text) & linefeed\nend repeat\nreturn parts\nend tell`);
    const urls=[];for(const line of String(raw||'').split('\n')){const m=line.match(/^(\d+)\t(.*)$/);if(m)urls[Number(m[1])-1]=m[2].trim();}return Array.from({length:urls.length},(_,i)=>urls[i]||'');
  }
  async findChatTab(windowId=this.windowId){
    const urls=await this.tabUrls(windowId);
    for(let i=urls.length-1;i>=0;i--)if(urls[i].startsWith(allowed+'chat'))return i+1;
    for(let i=urls.length-1;i>=0;i--)if(urls[i].startsWith(allowed)&&!urls[i].startsWith(allowed+'video/'))return i+1;
    return 0;
  }
  async findTabByUrl(url,windowId=this.windowId){
    const urls=await this.tabUrls(windowId);
    const same=value=>{try{const a=new URL(value),b=new URL(url);return a.origin===b.origin&&a.pathname===b.pathname;}catch{return false;}};
    for(let i=urls.length-1;i>=0;i--)if(same(urls[i]))return i+1;
    return 0;
  }
  saveWindow(){durableJson(join(this.root,'browser-profile','safari-window.json'),{id:this.windowId,marker:this.marker,tab:this.tabIndex});}
  async locateOwned(marker=this.marker){
    const urls=await this.tabUrls(),matches=[];
    for(let i=0;i<urls.length;i++)if(urls[i].startsWith(allowed)&&!urls[i].startsWith(allowed+'video/')){
      try{if(await this.evalTab('return sessionStorage.getItem("douyin-codex-bridge-window");',i+1)===marker)matches.push(i+1);}catch(e){if(['SAFARI_PERMISSION','SAFARI_TIMEOUT'].includes(e.code))throw e;}
    }
    if(matches.length!==1)throw new Error('未找到唯一的助手 Safari 标签，请重新打开并核验窗口');this.tabIndex=matches[0];this.marker=marker;this.saveWindow();return this.tabIndex;
  }
  async inTab(code,index){
    const owned=index===undefined;index??=this.tabIndex;
    // Relocation is a read-only preflight. Never retry the submitted script:
    // it may already have clicked a reaction or sent a message.
    if(owned&&this.marker){let valid=false;try{valid=await this.evalTab('return sessionStorage.getItem("douyin-codex-bridge-window");',index)===this.marker;}catch(e){if(['SAFARI_PERMISSION','SAFARI_TIMEOUT'].includes(e.code))throw e;}if(!valid)index=await this.locateOwned();}
    return this.evalTab(code,index,owned?this.marker:'');
  }
  async evalTab(code,index,marker=''){
    if(!Number.isInteger(this.windowId)||this.windowId<=0||!Number.isInteger(index)||index<1)throw new Error('请先打开项目的 Safari 抖音窗口');
    const markerCheck=marker?`if(sessionStorage.getItem('douyin-codex-bridge-window')!==${JSON.stringify(marker)})throw new Error('助手窗口已变化，请重新打开');`:'';
    const wrapper=`(()=>{try{${markerCheck}return JSON.stringify({ok:true,value:(()=>{${code}})()})}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)})}})()`;
    const result=await this.apple(`tell application "Safari"\nif not (exists window id ${this.windowId}) then error "window unavailable"\nset t to tab ${index} of window id ${this.windowId}\nif URL of t does not start with ${quote(allowed)} then error "wrong origin"\nreturn do JavaScript ${quote(wrapper)} in t\nend tell`);
    let parsed;try{parsed=JSON.parse(result);}catch{throw new Error('Safari 未返回可核验的页面结果');}if(!parsed.ok)throw new Error(parsed.error||'Safari 页面操作失败');return parsed.value;
  }
  async open(owner){
    if(this.page){try{await this.inTab('return true;');return;}catch(e){if(['SAFARI_PERMISSION','SAFARI_TIMEOUT'].includes(e.code))throw e;this.page=null;this.windowId=0;this.tabIndex=0;this.marker='';}}
    await mkdir(join(this.root,'browser-profile'),{recursive:true});const saved=join(this.root,'browser-profile','safari-window.json');let prior;
    try{prior=JSON.parse(await readFile(saved,'utf8'));if(!Number.isInteger(prior.id)||typeof prior.marker!=='string')prior=null;}catch{}
    if(prior){this.windowId=prior.id;this.tabIndex=0;try{await this.locateOwned(prior.marker);}catch(e){if(['SAFARI_PERMISSION','SAFARI_TIMEOUT'].includes(e.code))throw e;this.windowId=0;this.marker='';}}
    if(!this.windowId){
      const id=Number(await this.apple(`tell application "Safari"\nactivate\nmake new document with properties {URL:${quote(allowed+'chat?isPopup=1')}}\nreturn id of front window\nend tell`));
      if(!Number.isInteger(id)||id<=0)throw new Error('无法创建 Safari 窗口');this.windowId=id;this.tabIndex=0;
      // Safari may open the page as a new tab in the current window, so the
      // tab is found by its URL instead of assuming it is the first one.
      for(let i=0;i<40;i++){this.tabIndex=await this.findChatTab(id);if(this.tabIndex)break;await sleep(500);}
      if(!this.tabIndex){this.windowId=0;throw new Error('未能在 Safari 中找到抖音私信页面，请检查该窗口是否被关闭。');}
      const marker=randomUUID();let marked=false;
      for(let i=0;i<40;i++){try{await this.inTab('sessionStorage.setItem("douyin-codex-bridge-window",'+JSON.stringify(marker)+');return true;');marked=true;break;}catch(e){if(['SAFARI_PERMISSION','SAFARI_TIMEOUT'].includes(e.code)){this.windowId=0;throw e;}await sleep(500);}}
      if(!marked){this.windowId=0;throw new Error('请在 Safari 设置中允许来自 Apple 事件的 JavaScript，并在系统设置中允许终端控制 Safari。');}
      this.marker=marker;durableJson(saved,{id,marker,tab:this.tabIndex});
    }
    this.page={};this.status='waiting_login';if(owner)await this.restoreOwner(owner).catch(e=>this.log('请在 Safari 选回用户会话：'+e.message));
  }
  frameCode(path){return `let w=window;for(const i of ${JSON.stringify(path||[])}){const f=w.document.querySelectorAll('iframe')[i];if(!f)throw new Error('聊天页面已变化');const r=f.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=w.document.elementFromPoint(x,y);if(!r.width||!r.height||!(top===f||f.contains(top)))throw new Error('聊天页面被遮挡');w=f.contentWindow;if(!/^https:\\/\\/(www\\.)?douyin\\.com\\//.test(w.location.href))throw new Error('聊天页面来源已变化');}`;}
  async evaluate(fn,arg,path=this.framePath){return this.inTab(this.frameCode(path)+`return (${fn.toString()}).call(w,${JSON.stringify(arg??null)});`);}
  async scan({observeOnly=false}={}){
    if(!this.page)return {peer:null,messages:[],diagnostics:{},loginRequired:true};
    try{const result=await this.inTab(`const scan=(${scanConversation.toString()}),all=[];function walk(w,path){try{if(!/^https:\\/\\/(www\\.)?douyin\\.com\\//.test(w.location.href))return;all.push({path,value:scan.call(w)});const frames=[...w.document.querySelectorAll('iframe')];for(let i=0;i<frames.length;i++){const f=frames[i],r=f.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=w.document.elementFromPoint(x,y);if(r.width&&r.height&&(top===f||f.contains(top)))try{walk(f.contentWindow,path.concat(i))}catch{}}}catch{}}walk(window,[]);all.sort((a,b)=>Number(b.value.diagnostics.interactiveRows>0)-Number(a.value.diagnostics.interactiveRows>0)||b.value.messages.length-a.value.messages.length);return all[0]||null;`);
      const value=bindScanIdentity(this,result?.value||{peer:null,messages:[],diagnostics:{pages:1},loginRequired:true});if(!observeOnly){this.framePath=result?.path||[];this.lastScan=value;this.status=value.loginRequired?'waiting_login':value.peer?(value.diagnostics.interactiveRows===0?'blocked':'ready'):'select_chat';}return value;
    }catch(e){if(!observeOnly)this.status='blocked';throw e;}
  }
  async restoreOwner(owner){
    let clicked=false;for(let i=0;i<20;i++){const scan=await this.scan();if(matchesPeer(scan.peer,owner))return true;if(scan.loginRequired)return false;
      const n=await this.evaluate(markOwnerConversation,owner);this.lastSelectionDiagnostic=await this.inTab(this.frameCode(this.framePath)+'return w.__douyinBridgeChoiceDiagnostic||null;');if(n>1)throw new Error('联系人重名，需手动选择后核验账号');if(n===1&&(!clicked||i===10)){await this.inTab(this.frameCode(this.framePath)+'const e=w.document.querySelector("[data-bridge-owner-choice=\\"true\\"]");if(e)e.click();return !!e;');clicked=true;}await sleep(500);
    }throw new Error('未恢复到绑定账号，发送保持暂停');
  }
  ownerCheck(owner){return `const observed=(${applyVerifiedIdentity.toString()})((${scanConversation.toString()}).call(w),${JSON.stringify(this.verifiedIdentity||null)});if(!(${matchesPeer.toString()})(observed.peer,${JSON.stringify(owner)}))throw new Error('会话已切换，操作已停止');`;}
  async uiDiagnostics(){return {opened:!!this.page,frames:this.lastScan?[{main:!this.framePath?.length,...this.lastScan.diagnostics}]:[]};}
  async composerState(){await this.scan();return this.page?this.evaluate(inspectComposers):[];}
  async inbox(){return this.page?this.evaluate(inspectInbox):{entries:[],rows:0};}
  async quoteSchema(){return this.page?{...await this.evaluate(inspectQuoteSchema),nativeDraft:await this.evaluate(inspectNativeMentionDraft)}:null;}
  async send(owner,text,{plainText=false,replyToMessageId='',replyToSenderUid=''}={}){
    checkWork();if(this.sending)throw new Error('正在发送上一条回复');this.sending=true;let submitted=false;
    try{const scan=await this.scan();if(!matchesPeer(scan.peer,owner))throw new Error('请先在 Safari 选回绑定的用户会话');const body=plainText?String(text).trim():toPlainChatText(text),before=new Set(scan.messages.map(m=>m.id));let replyToSender=replyToSenderUid||scan.messages.find(m=>m.id===replyToMessageId)?.sender||'';
      if(replyToMessageId){const composer=(await this.evaluate(inspectComposers))[0];if(!composer||!await allowComposerDraft(fn=>this.evaluate(fn),composer.text,replyToMessageId,replyToSender))throw new Error('输入框已有草稿或不可读取，未准备引用');await prepareQuote({evaluate:(fn,arg)=>this.evaluate(fn,arg),wait:sleep,verify:async()=>{checkWork();if(!matchesPeer((await this.scan()).peer,owner))throw new Error('会话已切换，停止准备引用');},openMenu:async()=>{await this.evaluate(captureMessageMenu);await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`const e=w.document.querySelector('[data-bridge-quote-source="true"]');if(!e)throw new Error('原消息已变化');const r=e.getBoundingClientRect();e.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return true;`);},choose:async token=>{checkWork();await this.evaluate(clickQuoteAction,token);},diagnostic:v=>{this.lastQuoteDiagnostic=v;}},replyToMessageId);}
      const info=(await this.evaluate(inspectComposers))[0],prefix=info?.text||'';if(!info||!await allowComposerDraft(fn=>this.evaluate(fn),prefix,replyToMessageId,replyToSender))throw new Error('输入框已有其他草稿，未填写回复');const expectedBody=prefix?prefix+' '+body:body;
      const prepared=await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`(${focusComposerEnd.toString()}).call(w,${JSON.stringify({index:info.index,expected:prefix})});const e=w.document.querySelectorAll('[contenteditable="true"],textarea')[${info.index}];if(!w.document.execCommand('insertText',false,${JSON.stringify(prefix?' '+body:body)}))throw new Error('Safari 无法填写输入框');return e.tagName==='TEXTAREA'?e.value:e.innerText;`);
      if(comparableChatText(prepared)!==comparableChatText(expectedBody))throw new Error('输入内容未能完整核验，请检查未发送的草稿');checkWork();const again=await this.scan();if(!matchesPeer(again.peer,owner))throw new Error('会话已切换，请检查未发送的草稿');replyToSender||=again.messages.find(m=>m.id===replyToMessageId)?.sender||'';
      if(replyToMessageId){const quote=await this.evaluate(inspectQuoteDraft);if(quote.ids.length!==1||quote.ids[0]!==replyToMessageId)throw new Error('引用草稿已变化，已取消发送');}
      checkWork();if(operationContext.getStore()?.delivery)operationContext.getStore().delivery.submitted=true;submitted=true;
      await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`const info=(${inspectComposers.toString()}).call(w)[0];if(!info)throw new Error('未找到输入框');const e=w.document.querySelectorAll('[contenteditable="true"],textarea')[info.index],draft=e.tagName==='TEXTAREA'?e.value:e.innerText;if(String(draft).replace(/\\s+/g,' ').trim()!==${JSON.stringify(comparableChatText(expectedBody))})throw new Error('草稿已变化，请人工核实');e.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));return true;`);
      for(let i=0;i<15;i++){await sleep(400);const after=await this.scan();if(!matchesPeer(after.peer,owner))throw new UncertainDelivery('发送后会话发生变化，请在抖音确认是否已收到');const matches=after.messages.filter(m=>m.direction==='out'&&!before.has(m.id)&&matchesOutgoingText(m,body,{replyToMessageId,replyToSender}));if(matches.length===1){if(replyToMessageId&&matches[0].replyTo?.messageId!==replyToMessageId)throw new UncertainDelivery('消息已发出，但引用原消息尚未核验，不会自动重发');return {messageId:matches[0].id};}if(matches.length>1)throw new UncertainDelivery('检测到多条相同回复，无法确认本次送达');}
      throw new UncertainDelivery('已尝试发送，但未能确认回执；不会自动重复发送');
    }catch(e){if(submitted)e.uncertain=true;throw e;}finally{if(replyToMessageId&&this.page)await this.inTab(this.frameCode(this.framePath)+`w.document.removeEventListener('contextmenu',w.__douyinBridgeContextListener,true);delete w.__douyinBridgeContextListener;w.document.querySelectorAll('[data-bridge-quote-source],[data-bridge-quote-action]').forEach(e=>{e.removeAttribute('data-bridge-quote-source');e.removeAttribute('data-bridge-quote-action');});return true;`).catch(()=>{});this.sending=false;}
  }
  async react(owner,messageId,{probeOnly=false,emojis=['👌','[奋斗]','🎉']}={}){
    checkWork();
    if(this.sending)throw new Error('正在发送上一条回复');if(!/^\d{5,32}$/.test(messageId||''))return {supported:false,reason:'无法定位原消息'};this.sending=true;let submitted=false;
    try{const scan=await this.scan();if(!matchesPeer(scan.peer,owner))throw new Error('请选回绑定的用户会话');
      const opened=await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`const row=[...w.document.querySelectorAll('[data-bridge-message-id]')].find(e=>e.getAttribute('data-bridge-message-id')===${JSON.stringify(messageId)});if(!row)return false;const e=row.querySelector('[class*="MessageBoxContentactiveClickArea"]')||row,r=e.getBoundingClientRect(),x=r.x+Math.min(24,r.width/4),y=r.y+Math.min(24,r.height/4),top=w.document.elementFromPoint(x,y);if(!top||!(top===e||e.contains(top)))return false;(${captureMessageMenu.toString()}).call(w);e.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:x,clientY:y}));return true;`);
      if(!opened)return {supported:false,notSubmitted:true,retryable:true,reason:'原消息未显示或被弹层遮挡'};await sleep(250);const token=String(Date.now());let choices=await this.evaluate(inspectReactionChoices,token),choice;for(const emoji of emojis){choice=choices.choices.find(c=>c.emoji===emoji);if(choice)break;}
      if(!choice&&await this.evaluate(markMoreReactions)){await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`w.document.querySelector('[data-bridge-more-reactions="true"]')?.click();return true;`);await sleep(200);choices=await this.evaluate(inspectReactionChoices,token);for(const emoji of emojis){choice=choices.choices.find(c=>c.emoji===emoji);if(choice)break;}}
      if(probeOnly)return {supported:!!choice,probeOnly:true};if(!choice)return {supported:false,reason:'Safari 中此消息菜单没有可核验的贴表情选项'};if(choice.selected)return {supported:true,verified:true,emoji:choice.emoji};
      const before=await this.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});if(before.count)return {supported:false,reason:'原消息已有同款表情，避免重复点击撤销'};
      checkWork();submitted=true;await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`const e=w.document.querySelector('[data-bridge-reaction-choice="${token}-${choice.index}"]');if(!e)throw new Error('表情菜单已变化');e.click();return true;`);
      for(let i=0;i<10;i++){await sleep(300);const current=await this.scan();if(!matchesPeer(current.peer,owner))throw new UncertainDelivery('表情回应后会话已切换');const after=await this.evaluate(inspectMessageReactions,{messageId,emoji:choice.emoji});if(after.count>before.count)return {supported:true,verified:true,emoji:choice.emoji};}
      throw new UncertainDelivery('已尝试贴表情，但未能核验结果，不重复点击');
    }catch(e){if(submitted)e.uncertain=true;throw e;}finally{if(this.page)await this.inTab(this.frameCode(this.framePath)+this.ownerCheck(owner)+`w.document.removeEventListener('contextmenu',w.__douyinBridgeContextListener,true);delete w.__douyinBridgeContextListener;delete w.__douyinBridgeVisibleBefore;delete w.__douyinBridgeContextEvent;w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`).catch(()=>{});this.sending=false;}
  }
  async resolveVideo(message){
    checkWork();if(!/^\d{12,24}$/.test(message.awemeId||''))throw new Error('分享卡片没有有效的视频 ID');if(!this.page)throw new Error('请先登录抖音助手账号');
    const url=allowed+'video/'+message.awemeId,marker=randomUUID();await this.apple(`tell application "Safari"\ntell window id ${this.windowId}\nmake new tab with properties {URL:${quote(url)}}\nend tell\nend tell`);let index=0;for(let i=0;i<40;i++){index=await this.findTabByUrl(url);if(index)break;await sleep(500);}if(!index)throw new Error('无法打开视频标签页');let marked=false;
    try{for(let i=0;i<35;i++){checkWork();let value;try{value=await this.inTab(`const id=${JSON.stringify(message.awemeId)};if(location.pathname!=='/video/'+id)throw new Error('视频标签页已变化');${marked?`if(sessionStorage.getItem('douyin-codex-bridge-video')!==${JSON.stringify(marker)})throw new Error('视频标签页已变化');`:`sessionStorage.setItem('douyin-codex-bridge-video',${JSON.stringify(marker)});`}const video=document.querySelector('video');let found=null;const roots=[window._ROUTER_DATA,window.__NEXT_DATA__,window.SIGI_STATE];for(const s of document.querySelectorAll('script[type="application/json"],script#RENDER_DATA'))try{roots.push(JSON.parse(decodeURIComponent(s.textContent)))}catch{}const seen=new WeakSet(),stack=roots.filter(x=>x&&typeof x==='object');let left=30000;while(stack.length&&left--){const x=stack.pop();if(!x||typeof x!=='object'||seen.has(x))continue;seen.add(x);if(String(x.aweme_id||x.awemeId||x.itemId||'')===id&&x.video){found=x;break;}for(const v of Object.values(x))if(v&&typeof v==='object')stack.push(v);}return {id:String(found?.aweme_id||found?.awemeId||found?.itemId||''),url:found?.video?.play_addr?.url_list?.[0]||found?.video?.playAddr?.url_list?.[0]||video?.currentSrc||'',title:found?.desc||document.title||'',author:found?.author?.nickname||'',seconds:Number(found?.video?.duration||0)/1000||(Number.isFinite(video?.duration)?video.duration:0)};`,index);marked=true;}catch{}const candidate=[value?.url,message.mediaUrl].find(safeMediaUrl);if(value&&candidate)return {url:candidate,title:value?.title||message.title||'抖音视频 '+message.awemeId,author:value?.author||'',seconds:value?.seconds||0,source:url};await sleep(500);}
      throw new Error('Safari 未能取得原视频地址；请检查该视频的访问权限或重新登录。');
    }finally{if(marked)await this.apple(`tell application "Safari"\nif exists window id ${this.windowId} then\nset t to tab ${index} of window id ${this.windowId}\nif URL of t starts with ${quote(url)} then\nif (do JavaScript ${quote("sessionStorage.getItem('douyin-codex-bridge-video')")} in t) is ${quote(marker)} then close t\nend if\nend if\nend tell`).catch(()=>{});}
  }
  async download(url,destination,maxBytes=300*1024*1024){
    checkWork();if(!safeMediaUrl(url))throw new Error('拒绝非抖音媒体地址');const ua=await this.inTab('return navigator.userAgent;'),signal=workSignal(),response=await fetch(url,{headers:{Referer:allowed,'User-Agent':ua},signal:AbortSignal.any([AbortSignal.timeout(180000),...(signal?[signal]:[])])});
    if(!response.ok)throw new Error('Safari 视频下载失败 HTTP '+response.status+'，请检查平台登录或访问权限');if(!safeMediaUrl(response.url))throw new Error('视频下载跳转到了不支持的域名');if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('视频超过本机处理上限 300 MB');
    const file=await open(destination+'.part','w');let size=0,head=Buffer.alloc(0);try{for await(const chunk of response.body){checkWork();size+=chunk.length;if(size>maxBytes)throw new Error('视频超过本机处理上限 300 MB');if(head.length<32)head=Buffer.concat([head,Buffer.from(chunk)]).subarray(0,32);await file.write(chunk);}if(!head.includes(Buffer.from('ftyp')))throw new Error('下载结果不是有效 MP4，未进行视频学习');await file.close();await rename(destination+'.part',destination);return size;}catch(e){await file.close().catch(()=>{});await unlink(destination+'.part').catch(()=>{});throw e;}
  }
  async close(){this.page=null;this.status='closed';}
}
