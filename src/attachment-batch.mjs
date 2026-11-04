const waitMs=6500;
export const earlyCaptionMs=2200;
const plainText=message=>message.kind==='text'&&message.text?.trim()&&!/^\s*[/／]/.test(message.text);

export function attachmentBatch(message,now=Date.now()){
  return message.kind==='video'&&message.created>0?{...message,attachmentWaitUntil:now+waitMs}:message;
}

export function bufferAttachmentCaption(message,now=Date.now()){
  return plainText(message)&&!message.replyTo?.messageId&&message.sender&&message.created>0?{...message,attachmentTextWaitUntil:now+earlyCaptionMs}:message;
}

export function addAttachmentCaption(parent,message,now=Date.now(),{early=false,rogerQueued=false}={}){
  if(!plainText(message)||!message.sender||message.sender!==parent.sender)return null;
  if(parent.kind!=='video'||parent.attachmentWaitUntil<now||!parent.attachmentWaitUntil)return null;
  const delta=Number(message.created)-Number(parent.created);
  if(!Number.isFinite(delta)||delta<(early?-earlyCaptionMs:0)||delta>waitMs)return null;
  if(message.replyTo?.messageId&&message.replyTo.messageId!==(parent.platformId||parent.id))return null;
  const captions=parent.attachmentCaptions||[];
  if(captions.length>=6)return null;
  const remaining=6000-captions.reduce((total,item)=>total+item.text.length,0);
  if(remaining<message.text.length)return null;
  return {...parent,attachmentCaptions:[...captions,{id:message.platformId||message.id,text:message.text,...(rogerQueued?{rogerQueued:true}:{})}]};
}

export function attachmentInstructions(message){
  return (message.attachmentCaptions||[]).map(item=>item.text).join('\n');
}
