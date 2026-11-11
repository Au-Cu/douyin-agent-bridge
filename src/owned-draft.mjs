import {comparableChatText} from './chat-text.mjs';

// Only a persisted, pre-submit draft from THIS outbox row may be removed.
// A timer and identical text alone never prove ownership or non-delivery.
export async function recoverOwnedDraft({draft,saved,body,quoteId='',quote,clear,now=Date.now()}){
  if(!draft?.text||!saved||saved.state!=='prepared'||saved.body!==body||saved.quoteId!==quoteId||comparableChatText(saved.text)!==comparableChatText(draft.text))return false;
  if(quoteId){const q=await quote();if(q.ids.length!==1||q.ids[0]!==quoteId)return false;}
  if(now-saved.created<15000)throw Object.assign(new Error('本轮自动草稿仍在等待，15 秒后核验并恢复'),{code:'OWNED_DRAFT_WAIT',notSubmitted:true});
  if((saved.recoveries||0)>=2)throw Object.assign(new Error('自动草稿已恢复两次仍未发送，请在面板检查或取消发送'),{code:'OWNED_DRAFT_EXHAUSTED',notSubmitted:true});
  await clear(draft);return true;
}

export function clearOwnedComposer({index,expected}){
  const scope=this?.document?this:globalThis,document=scope.document,e=document.querySelectorAll('[contenteditable="true"],textarea')[index];
  if(!e)throw new Error('输入框已变化，未清理草稿');
  const clone=e.cloneNode(true);clone.querySelectorAll('[data-slate-placeholder],[data-placeholder],[class*="placeholder" i]').forEach(n=>n.remove());
  if(clone.querySelector('img,[data-slate-void="true"]'))throw new Error('输入框包含非文字内容，未清理草稿');
  clone.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));clone.querySelectorAll('div,p').forEach(n=>{n.prepend('\n');n.append('\n');});
  const norm=s=>String(s||'').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\s+/g,' ').trim();
  if(norm(e.tagName==='TEXTAREA'?e.value:clone.textContent)!==norm(expected))throw new Error('草稿已被修改，未清理');
  e.focus();if(e.tagName==='TEXTAREA'){e.value='';e.dispatchEvent(new scope.Event('input',{bubbles:true}));}
  else{const range=document.createRange();range.selectNodeContents(e);const selection=scope.getSelection();selection.removeAllRanges();selection.addRange(range);if(!document.execCommand('delete',false))throw new Error('无法清理自动草稿');}
  return true;
}
