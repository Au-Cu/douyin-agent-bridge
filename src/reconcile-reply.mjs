import {matchesPeer} from './douyin.mjs';
import {matchesOutgoingText} from './chat-text.mjs';

// Explicit, read-only recovery: inspect the original chat and reconcile an
// exact outgoing quote. This path never sends, retries or invokes the model.
export async function reconcileQuotedReply({store,chats,adapter,id}){
  const out=store.db.prepare('SELECT * FROM outbox WHERE id=?').get(String(id));
  if(!out||out.kind!=='text'||out.status!=='uncertain')throw new Error('此文字回复无需核验');
  const payload=JSON.parse(out.payload||'{}'),target=chats.deliveryTarget(payload,out.peer);
  if(!target||target.type!=='group'||!payload.replyToMessageId)throw new Error('仅支持仍启用的群聊原生引用回复');
  const origin=store.db.prepare('SELECT body FROM bot_messages WHERE id=? AND peer=? AND revision=?').get(payload.botId,out.peer,payload.chatRevision),message=origin?JSON.parse(origin.body):null;
  if(!message?.sender||message.id!==payload.replyToMessageId)throw new Error('原消息记录不完整，保持需要核实');
  const scan=await adapter.scanPeer(target);chats.guard(payload,out.peer);
  if(!matchesPeer(scan.peer,target))throw new Error('原聊天身份未通过核验');
  const candidates=scan.messages.filter(m=>m.direction==='out'&&m.sender===target.selfUid&&m.created>=out.created-1500&&m.replyTo?.messageId===payload.replyToMessageId&&matchesOutgoingText(m,out.body,{replyToMessageId:payload.replyToMessageId,replyToSender:message.sender}));
  if(candidates.length!==1)return {verified:false,matches:candidates.length};
  const verified=store.confirmTextDelivery(out.id,candidates[0].id);
  if(verified){store.mergeOutboxPayload(out.id,{deliveryRecheck:{verified:true,at:Date.now(),method:'exact_native_quote'}});chats.reconcile();}
  return {verified,matches:1};
}
