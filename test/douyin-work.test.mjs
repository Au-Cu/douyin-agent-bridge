import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinAdapter,scanConversation} from '../src/douyin.mjs';
import {launchTestBrowser} from './browser.mjs';

test('a video share that redirects to a note returns the ordered original images for the exact work',async t=>{
  const browser=await launchTestBrowser(t);if(!browser)return;
  const context=await browser.newContext();
  const id='1234567890123456',origin='https://www.douyin.com',one='https://p3-pc-sign.douyinpic.com/one.webp',two='https://p3-pc-sign.douyinpic.com/two.gif';
  try{
    await context.route(origin+'/video/'+id,route=>route.fulfill({status:302,headers:{location:origin+'/note/'+id}}));
    const data={other:{aweme_id:'1234567890123000',images:[{url_list:[two]}]},match:{aweme_id:id,aweme_type:68,images:[{url_list:[one]},{url_list:[two]}],video:{play_addr:{url_list:['https://v.douyinvod.com/music.mp4']}}}};
    await context.route(origin+'/note/'+id,route=>route.fulfill({contentType:'text/html',body:'<script id="RENDER_DATA" type="application/json">'+encodeURIComponent(JSON.stringify(data))+'</script><video src="https://v.douyinvod.com/related.mp4"></video>'}));
    const adapter=new DouyinAdapter({root:'unused'});adapter.context=context;
    const work=await adapter.resolveVideo({awemeId:id});
    assert.equal(work.kind,'album');assert.deepEqual(work.slides.map(slide=>slide.urls),[[one],[two]]);
  }finally{await browser.close();}
});

test('native image attachment accepts platform resources and ignores a URL in ordinary text',async t=>{
  const browser=await launchTestBrowser(t);if(!browser)return;
  try{
    const page=await browser.newPage(),url='https://p3-pc-sign.douyinpic.com/original.gif';
    await page.setContent('<div class="RightPanelHeadertitle">fixture</div><div class="messageMessageBoxcontentBox" data-direction="in" style="height:42px">fixture</div><div class="messageMessageBoxcontentBox" data-direction="in" style="height:42px">fixture</div>');
    await page.evaluate(url=>document.querySelectorAll('.messageMessageBoxcontentBox').forEach((row,i)=>{
      row.__reactProps$fixture={message:{messageType:i?7:27,serverId:String(9000000000000+i),sender:'900001',conversationId:'chat',createTime:Date.now(),content:JSON.stringify(i?{text:url}:{resource_url:{origin_url_list:[url,'https://example.com/untrusted.gif'],still_url_list:['https://p3-pc-sign.douyinpic.com/first-frame.jpg']}})}};
    }),url);
    const [image,text]=(await page.evaluate(scanConversation)).messages;
    assert.equal(image.awemeId,image.id);assert.deepEqual(image.nativeImageUrls,[url]);
    assert.equal(text.kind,'text');assert.equal(text.nativeImageUrls,undefined);
  }finally{await browser.close();}
});
