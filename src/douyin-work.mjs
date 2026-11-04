export function inspectWorkPage(id){
  if(location.origin!=='https://www.douyin.com'||!['/video/'+id,'/note/'+id].includes(location.pathname))return null;
  const roots=[window._ROUTER_DATA,window.__NEXT_DATA__,window.SIGI_STATE];
  for(const script of document.querySelectorAll('script#RENDER_DATA,script[type="application/json"]')){
    const raw=script.textContent;
    try{roots.push(JSON.parse(raw));}catch{try{roots.push(JSON.parse(decodeURIComponent(raw)));}catch{}}
  }
  const seen=new WeakSet(),stack=roots.filter(x=>x&&typeof x==='object');let detail=null,left=30000;
  while(stack.length&&left--){
    const x=stack.pop();if(!x||typeof x!=='object'||seen.has(x))continue;seen.add(x);
    if(String(x.aweme_id||x.awemeId||x.itemId||'')===id&&(x.video||x.images||x.image_list||x.imageList)){detail=x;break;}
    for(const value of Object.values(x))if(value&&typeof value==='object')stack.push(value);
  }
  const note=location.pathname.startsWith('/note/');
  const players=[...document.querySelectorAll('video')];
  const video=!note&&players.length===1?players[0]:null;
  const text=document.body?.innerText||'';
  return {detail,note,title:document.title,src:video?.currentSrc||'',seconds:Number.isFinite(video?.duration)?video.duration:0,verification:[...document.querySelectorAll('iframe[src*="captcha"],[id*="captcha"]')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'),unavailable:/作品不存在|作品已删除|作品不可见/.test(text)};
}

export function workMedia(message,page,detail,safeUrl){
  const id=message.awemeId,a=[detail,page?.detail].find(x=>String(x?.aweme_id||x?.awemeId||x?.itemId||'')===id);
  const list=x=>typeof x==='string'?[x]:Array.isArray(x)?x:x?.url_list||x?.urlList||[];
  const urls=(...values)=>[...new Set(values.flatMap(list).filter(safeUrl))];
  const title=a?.desc||message.title||page?.title||'抖音作品 '+id,author=a?.author?.nickname||'';
  const images=[a?.images,a?.image_list,a?.imageList,a?.image_post_info?.images,a?.imagePostInfo?.images].find(x=>Array.isArray(x)&&x.length);
  if(images){
    const slides=images.map(x=>({urls:urls(x?.download_url_list,x?.origin_image,x?.originImage,x,x?.display_image,x?.displayImage),motionUrls:urls(x?.video?.play_addr,x?.video?.playAddr,x?.live_photo?.video?.play_addr,x?.livePhoto?.video?.playAddr)}));
    if(slides.some(s=>s.urls.length||s.motionUrls.length))return {kind:'album',slides,title,author,source:'https://www.douyin.com/note/'+id};
  }
  if(page?.note||Number(a?.aweme_type)===68)return null;
  const video=a?.video,variants=video?.bit_rate||video?.bitRate;
  const addresses=urls(video?.play_addr,video?.playAddr,...(Array.isArray(variants)?variants.map(b=>b?.play_addr||b?.playAddr):[]),page?.src,message.mediaUrl);
  if(!addresses.length)return null;
  return {url:addresses[0],urls:addresses,title,author,seconds:Number(video?.duration||0)/1000||page?.seconds||0,source:'https://www.douyin.com/video/'+id};
}

export function workUnavailable(page){
  if(page?.verification)return new Error('作品页出现抖音安全验证，请在专用窗口完成验证后重试。');
  if(page?.unavailable)return new Error('抖音作品页显示该作品已删除或不可见。');
  return new Error(page?.note?'已打开抖音图文，但未找到与该作品匹配的原图。':'已打开抖音作品页，但未找到与该作品匹配的原片地址。');
}

export function validWorkDownload(head,image){
  if(!image)return head.includes(Buffer.from('ftyp'));
  return head[0]===0xff&&head[1]===0xd8||head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    ||/^GIF8[79]a$/.test(head.toString('ascii',0,6))
    ||head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'
    ||/^(?:avif|avis|heic|mif1)$/.test(head.toString('ascii',8,12))&&head.toString('ascii',4,8)==='ftyp';
}
