// Runs inside the authenticated chat page. Read only the visible conversation
// directory and exact SDK identities; no message body, nickname or cookie leaves it.
export function inspectInbox(){
  const scope=this?.document?this:globalThis,document=scope.document;
  const rows=[...document.querySelectorAll('[class*="conversationConversationItemwrapper"],[data-e2e="conversation-item"]')].filter(e=>e.getClientRects().length),entries=[];
  for(const row of rows){
    const ids=new Set(),counts=[],keys=new Set(),values=new Map();
    for(const e of [row,...row.querySelectorAll('*')].slice(0,12))for(const key of Object.keys(e).filter(k=>/^__react(?:Fiber|Props)\$/.test(k))){let f=e[key];for(let depth=0;depth<5&&f;depth++,f=f.return){const p=f.memoizedProps||f;for(const [v,explicit]of [[p.conversation,true],[p.conv,true],[p.conversationInfo,true],[p.data?.conversation,true],[p.item?.conversation,true]]){if(!v||typeof v!=='object')continue;
      for(const k of ['id','conversationId','conversation_id','conversationShortId','conversation_short_id','shortId']){const x=v[k];if(x!=null&&(typeof x!=='number'||Number.isSafeInteger(x))&&String(x)!=='[object Object]')ids.add(String(x));}
      // badgeCount can be an accumulated server counter even after this chat
      // was read. Prefer the explicit current unread fields, including zero.
      const unreadFields=['unreadCount','unread_count','unreadMessageCount','unread_message_count'];
      const valid=k=>typeof v[k]==='number'&&Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=1000000;
      for(const k of [...unreadFields,'badgeCount'])if(k in v){keys.add(k);if(valid(k))values.set(k,v[k]);}
      const current=unreadFields.filter(valid);for(const k of current.length?current:['badgeCount'].filter(valid))counts.push(v[k]);
    }}}
    const badges=[...row.querySelectorAll('[class*="badge" i],[class*="unread" i],[data-e2e*="unread"]')].filter(e=>e.getClientRects().length&&/^\d+\+?$/.test((e.textContent||'').trim()));
    for(const badge of badges)counts.push(Number(badge.textContent.trim().replace('+','')));
    const attr=row.getAttribute('data-conversation-id');if(attr)ids.add(attr);
    entries.push({ids:[...ids],unread:counts.length?Math.max(...counts):null,source:counts.length?(keys.size?'sdk':'badge'):'unknown',shape:{unreadKeys:[...keys],unreadValues:Object.fromEntries(values),badgeClasses:badges.slice(0,2).map(e=>String(e.className).slice(0,100))}});
  }
  return {entries,rows:rows.length};
}
