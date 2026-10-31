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
    config:{enabled:false,owner:null,coordinator:'',targets:[],maxVideoSeconds:1800,model:'',reasoningEffort:'',fastMode:false,autoRoute:true,contextBudget:48000},
    conversations:{activeNeed:'website-1',budget:48000,needs:[{id:'website-1',title:'网站需求',summary:'主色绿色，禁止红色',seq:1,contextTokens:2400}]},
    runtime:{browser:'closed',codex:false},counts:{knowledge:0,runningTasks:0,queuedTasks:0},
    knowledge:[],tasks:[],outbox:[],messages:[],events:[]
  };
  const catalog={defaults:{model:'fixture-sol',effort:'max'},models:[{model:'fixture-sol',displayName:'Fixture Sol',supportedReasoningEfforts:['low','high','max'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]}]};
  let preferencesSaved;
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');
      if(req.url==='/api/preferences'){let text='';for await(const b of req)text+=b;preferencesSaved=JSON.parse(text);Object.assign(state.config,preferencesSaved);res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/targets'){let text='';for await(const b of req)text+=b;state.config.targets=JSON.parse(text).targets;res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/models'){res.end(JSON.stringify(catalog));return;}
      if(req.url==='/api/needs/new'){let text='';for await(const b of req)text+=b;const title=JSON.parse(text).title;const n={id:'created-need',title,seq:1,contextTokens:0,summary:''};state.conversations.needs.push(n);state.conversations.activeNeed=n.id;res.end(JSON.stringify(n));return;}
      if(req.url==='/api/needs/switch'){state.conversations.activeNeed='website-1';res.end(JSON.stringify(state.conversations.needs[0]));return;}
      res.end(JSON.stringify(req.url==='/api/state'?state:req.url==='/api/threads'?threads:req.url==='/api/codex/reconnect'?{deferred:false,auth:{status:'ready'}}:[]));return;
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
    assert.equal(state.config.targets[0].id,'long-thread-id');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'重新连接 Codex'}).click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已读取本机当前 Codex 登录'));
    await page.waitForFunction(()=>document.querySelectorAll('#defaultModel option').length===2);
    await page.selectOption('#defaultModel','fixture-sol');await page.selectOption('#defaultEffort','max');await page.locator('#fastMode').check();await page.locator('#autoRoute').uncheck();await page.locator('#contextBudget').fill('16000');await page.getByRole('button',{name:'保存默认配置'}).click();
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('默认配置已保存'));
    assert.deepEqual(preferencesSaved,{model:'fixture-sol',reasoningEffort:'max',fastMode:true,autoRoute:false,contextBudget:16000});
    await page.locator('#newNeedTitle').fill('烹饪参考');await page.getByRole('button',{name:'新建并切换对话'}).click();await page.waitForFunction(()=>document.querySelector('#currentNeed').textContent.includes('烹饪参考'));
    await page.locator('[data-switch-need="website-1"]').click();await page.waitForFunction(()=>document.querySelector('#currentNeed').textContent.includes('网站需求'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});
