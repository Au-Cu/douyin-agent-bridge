import {AsyncLocalStorage} from 'node:async_hooks';
export const operationContext=new AsyncLocalStorage();
export const interruptedError=()=>Object.assign(new Error('用户已强制中断该任务'),{code:'TASK_INTERRUPTED'});
export const workSignal=()=>operationContext.getStore()?.signal;
export async function browserRead(promise){
  // Only wrap observations. Releasing a timed-out mutation could let a late
  // click or key press run in another chat after its operation lease ended.
  const timeout=AbortSignal.timeout(6000),signal=workSignal();
  try{return await raceWork(promise,signal?AbortSignal.any([signal,timeout]):timeout);}
  catch(e){if(timeout.aborted&&!signal?.aborted)throw Object.assign(new Error('抖音页面读取超时，已退出本次检查，稍后重试。'),{code:'BROWSER_READ_TIMEOUT',notSubmitted:true});throw e;}
}
export function checkWork(){const context=operationContext.getStore();context?.guard?.();if(context?.signal?.aborted)throw context.signal.reason||interruptedError();}
export function trackStop(promise,context=operationContext.getStore()){
  let timer;const check=Promise.race([Promise.resolve(promise),new Promise(resolve=>timer=setTimeout(()=>resolve({confirmed:false,error:'停止核验超时，保留现场'}),10000))]).catch(e=>({confirmed:false,error:e.message})).finally(()=>clearTimeout(timer));context?.stopChecks?.add(check);return check;
}
export function raceWork(promise,signal=workSignal()){
  if(!signal)return promise;if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason||interruptedError());}
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason||interruptedError());signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
