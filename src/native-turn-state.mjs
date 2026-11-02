// Read only the exact submitted turn. A chat can already be executing a newer
// turn, so its overall active/idle flag is not evidence about this task.
export async function nativeTurnState(client, threadId, turnId, timeoutMs=5000) {
  const response=await client.request('thread/read',{threadId,includeTurns:true},timeoutMs);
  const thread=response?.thread;
  if(!thread||thread.id&&thread.id!==threadId)return {state:'unknown',turnId};
  const turn=thread.turns?.find(t=>t.id===turnId);
  if(!turn)return {state:'unknown',turnId};
  const state={inProgress:'active',completed:'completed',failed:'failed',interrupted:'interrupted'}[turn.status]||'unknown';
  return {state,turnId,turn};
}
