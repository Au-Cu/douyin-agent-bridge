import {listenBrowserFixture} from './fixture-http.mjs';
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
    config:{enabled:false,owner:null,coordinator:'',targets:[],maxVideoSeconds:1800,model:'',reasoningEffort:'',fastMode:false,autoRoute:true,contextBudget:48000,uiPanels:{setup:false,model:false,targets:false,storage:true}},
    conversations:{activeNeed:'website-1',budget:48000,needs:[{id:'website-1',title:'网站需求',summary:'主色绿色，禁止红色',seq:1,contextTokens:2400}]},
    runtime:{browser:'closed',codex:false},counts:{knowledge:0,runningTasks:0,queuedTasks:0},
    knowledge:[],tasks:[],outbox:[],messages:[],events:[]
  };
  const reaction=(stage,sent,total=1,errors=[])=>({stage,sent,total,pending:0,uncertain:0,unavailable:sent===total?0:total-sent,errors});
  state.work=[{id:'operation-A',number:1,title:'修改首页',kind:'text',status:'blocked',detail:'只有首页任务等待写入权',receipts:[reaction('roger',0,1,['此消息菜单没有可核验的贴表情选项']),reaction('active',0,0),reaction('done',0,0)],replies:[],targets:[]},{id:'operation-B',number:2,title:'整理资料',kind:'text',status:'done',detail:'资料任务与回复已完成',receipts:['roger','active','done'].map(s=>reaction(s,1)),replies:[{id:'reply-B',status:'sent',notification:false}],targets:[]}];
  const catalog={defaults:{model:'fixture-sol',effort:'max'},models:[{model:'fixture-sol',displayName:'Fixture Sol',supportedReasoningEfforts:['low','high','max'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]}]};
  state.work[0].canInterrupt=true;state.work[0].retries=[{label:'目标：网站',taskStatus:'queued',wait:{paused:false,nextAttempt:1793500000000},events:[{attempt:1,at:1793499900000,outcome:'blocked',reason:'写入锁被占用 <blocked>',legacy:false},{attempt:2,at:1793499960000,outcome:'blocked',reason:'写入锁仍被占用',legacy:false}]}];state.work.push({id:'command-C',title:'/帮助',kind:'control',status:'done',detail:'帮助已送达',receipts:[],replies:[],targets:[]});let interrupted;
  let preferencesSaved;
  const server=http.createServer(async(req,res)=>{
    const requestUrl=new URL(req.url,'http://localhost');
    if(req.url.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');
      if(req.url==='/api/preferences'){let text='';for await(const b of req)text+=b;preferencesSaved=JSON.parse(text);Object.assign(state.config,preferencesSaved);state.config.uiPanels.model=true;res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/targets'){let text='';for await(const b of req)text+=b;state.config.targets=JSON.parse(text).targets;state.config.uiPanels.targets=true;res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/ui/panels'){let text='';for await(const b of req)text+=b;Object.assign(state.config.uiPanels,JSON.parse(text));res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/archive'){let text='';for await(const b of req)text+=b;const b=JSON.parse(text);state.work.find(w=>w.id===b.id).archived=b.archived;res.end(JSON.stringify({ok:true}));return;}
      if(req.url==='/api/tasks/interrupt'){let text='';for await(const b of req)text+=b;interrupted=JSON.parse(text).id;const w=state.work.find(w=>w.id===interrupted);w.status='cancelled';w.canInterrupt=false;res.end(JSON.stringify({state:'stopped',number:w.number}));return;}
      if(requestUrl.pathname==='/api/state'){const scope=requestUrl.searchParams.get('work')||'current',status=requestUrl.searchParams.get('status')||'all';res.end(JSON.stringify({...state,work:state.work.filter(w=>(scope==='all'||(scope==='archived'?!!w.archived:!w.archived))&&(status==='all'||w.status===status))}));return;}
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
  await listenBrowserFixture(server);
  let browser;
  try{
    browser=await chromium.launch({channel:process.env.BRIDGE_TEST_BROWSER||'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelector('#storagePanel')&&!document.querySelector('#storagePanel').open);
    await page.locator('[data-operation="operation-A"]').waitFor();const cardA=page.locator('[data-operation="operation-A"]'),cardB=page.locator('[data-operation="operation-B"]');assert.match(await cardA.textContent(),/任务 1：修改首页/);assert.match(await cardA.textContent(),/收到：未送达/);assert.doesNotMatch(await cardA.textContent(),/整理资料/);assert.match(await cardB.textContent(),/任务 2：整理资料/);assert.match(await cardB.textContent(),/完成：已送达/);assert.equal(await cardA.locator('.work-details').getAttribute('open'),null);
    assert.match(await cardA.locator('.retry-summary').textContent(),/第 2 次 · 受阻，尚未提交/);assert.match(await cardA.locator('.retry-summary').textContent(),/计划下次重试/);assert.equal(await cardA.locator('.retry-details li').count(),2);assert.equal(await cardA.locator('.retry-details blocked').count(),0);await cardA.locator('.retry-details>summary').click();
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
    await page.waitForFunction(()=>!document.querySelector('#modelPanel').open);assert.equal(await page.locator('#targetsPanel').evaluate(e=>e.open),false);
    await page.locator('#modelPanel>summary').click();await page.waitForFunction(()=>document.querySelector('#modelPanel').open);await page.waitForFunction(()=>!document.querySelector('#modelPanel').open===false);
    await page.locator('#newNeedTitle').fill('烹饪参考');await page.getByRole('button',{name:'新建并切换对话'}).click();await page.waitForFunction(()=>document.querySelector('#currentNeed').textContent.includes('烹饪参考'));
    await page.locator('[data-switch-need="website-1"]').click();await page.waitForFunction(()=>document.querySelector('#currentNeed').textContent.includes('网站需求'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.waitForFunction(()=>!document.querySelector('#targetsPanel').open);await page.locator('#targetsPanel>summary').click();await page.waitForFunction(()=>document.querySelector('#targetsPanel').open);await page.waitForTimeout(150);
    await page.reload();await page.locator('[data-operation="operation-A"]').waitFor();assert.equal(await page.locator('#modelPanel').evaluate(e=>e.open),true);assert.equal(await page.locator('#targetsPanel').evaluate(e=>e.open),true);
    await page.selectOption('#workStatus','done');await page.waitForFunction(()=>document.querySelectorAll('#taskList .work-card').length===1);assert.equal(await page.locator('#workScope').inputValue(),'all');assert.match(await page.locator('#taskList').textContent(),/整理资料/);
    await page.selectOption('#workStatus','all');await page.selectOption('#workScope','current');await page.locator('[data-operation="operation-A"] [data-archive-kind="task"]').click();await page.waitForFunction(()=>!document.querySelector('[data-operation="operation-A"]'));
    await page.selectOption('#workScope','archived');await page.locator('[data-operation="operation-A"]').waitFor();assert.match(await page.locator('#taskList').textContent(),/恢复显示/);await page.locator('[data-operation="operation-A"] [data-archive-kind="task"]').click();await page.waitForFunction(()=>!document.querySelector('[data-operation="operation-A"]'));
    await page.selectOption('#workScope','current');await page.locator('[data-operation="operation-A"]').waitFor();
    await page.selectOption('#workStatus','all');await page.locator('[data-fold-key="commands"]>summary').click();await page.locator('[data-operation="operation-A"] .work-details>summary').click();await page.locator('[data-operation="operation-A"] .retry-details>summary').click();await page.waitForTimeout(5700);
    assert.equal(await page.locator('[data-fold-key="commands"]').evaluate(e=>e.open),true);assert.equal(await page.locator('[data-operation="operation-A"] .work-details').evaluate(e=>e.open),true);assert.equal(await page.locator('[data-operation="operation-A"] .retry-details').evaluate(e=>e.open),true);
    await page.getByRole('button',{name:'中断任务 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-operation="operation-A"]').textContent.includes('已取消'));assert.equal(interrupted,'operation-A');
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});
