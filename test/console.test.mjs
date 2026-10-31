import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('长聊天名从左侧显示、限定菜单宽度；缩小窗口和加入名单后不溢出、不丢失目标 ID', async () => {
  const longName = '研究页面切换与视频视觉效果 '.repeat(160);
  const threads = [{id:'long-thread-id',name:longName},{id:'short-thread-id',name:'其他聊天'}];
  const state = {
    config:{enabled:false,owner:null,coordinator:'',targets:[],maxVideoSeconds:1800},
    runtime:{browser:'closed',codex:false},counts:{knowledge:0,runningTasks:0,queuedTasks:0},
    knowledge:[],tasks:[],outbox:[],messages:[],events:[]
  };
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(req.url==='/api/state'?state:req.url==='/api/threads'?threads:[]));return;
    }
    const name=req.url==='/'?'index.html':req.url.slice(1);
    if(!['index.html','app.js','style.css'].includes(name)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.end(await readFile(new URL('../public/'+name,import.meta.url)));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByRole('button',{name:'读取本机聊天'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#threadSelect option').length===3);
    await page.selectOption('#threadSelect','long-thread-id');
    for(const width of [1100,390,1100]){
      await page.setViewportSize({width,height:900});
      await page.waitForFunction(()=>{
        const s=document.querySelector('#threadSelect'),o=s.selectedOptions[0],c=document.createElement('canvas').getContext('2d');
        c.font=getComputedStyle(s).font;return c.measureText(o.text).width<=s.clientWidth-30;
      });
      const info=await page.locator('#threadSelect').evaluate(s=>({
        value:s.value,title:s.title,label:s.selectedOptions[0].text,alignment:getComputedStyle(s).textAlign,
        direction:getComputedStyle(s).direction,overflow:document.documentElement.scrollWidth>innerWidth
      }));
      assert.equal(info.value,'long-thread-id');assert.equal(info.title,longName);
      assert.ok(info.label.startsWith('研究页面'));assert.ok(info.label.includes('…'));
      assert.equal(info.alignment,'left');assert.equal(info.direction,'ltr');assert.equal(info.overflow,false);
    }
    await page.locator('#targetAlias').fill('视频项目');await page.getByRole('button',{name:'加入名单'}).click();
    await page.setViewportSize({width:390,height:900});
    assert.equal(await page.locator('#targetList small').textContent(),longName);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});
