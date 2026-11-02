import {realpath,stat} from 'node:fs/promises';import {join,sep} from 'node:path';
// Images are materialized by trusted preprocessing, never model-selected paths.
export async function chatInput(root,input,images=[]){
  if(!Array.isArray(images)||images.length>25)throw new Error('群聊画面数量超过限制');
  const result=[{type:'text',text:JSON.stringify(input)}];if(!images.length)return result;
  const realRoot=await realpath(root),base=await realpath(join(root,'chat-media'));if(base!==join(realRoot,'chat-media'))throw new Error('群聊画面目录不能链接到其他本机目录');
  for(const image of images){const path=await realpath(image);if(!path.startsWith(base+sep)||!path.endsWith('.jpg')||(await stat(path)).size>2*1024*1024)throw new Error('群聊只接受本轮预处理的有限画面');result.push({type:'localImage',path});}
  return result;
}
