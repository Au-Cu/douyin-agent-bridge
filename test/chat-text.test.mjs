import test from 'node:test';import assert from 'node:assert/strict';
import { toPlainChatText,comparableChatText } from '../src/chat-text.mjs';
import { DouyinAdapter } from '../src/douyin.mjs';
import { splitReply } from '../src/engine.mjs';

test('抖音回复去掉 Markdown 格式，保留段落、编号、链接和代码原文',()=>{
  const input='# 学习结果\n\n**看到了变化**\n- 第一项\n- `a_b * c`\n\n[参考](https://example.com/a)\n\n```js\nconst size = 2 ** 3;\n```';
  const output=toPlainChatText(input);assert.equal(output,'学习结果\n\n看到了变化\n• 第一项\n• a_b * c\n\n参考（https://example.com/a）\n\nconst size = 2 ** 3;');assert.equal(toPlainChatText(output),output);
});
test('表格转成易读纯文本；常见 LaTeX 公式保留含义且无定界符',()=>{
  const table='| 方案 | 效果 |\n| --- | --- |\n| **A** | 简洁 |\n| B | 清晰 |';assert.equal(toPlainChatText(table),'方案：A；效果：简洁\n方案：B；效果：清晰');
  const math=String.raw`计算：$v = \frac{d}{t}$，平方是 \(x^{2}\)，根号是 $$\sqrt{a+b}$$。`;
  assert.equal(toPlainChatText(math),'计算：v = (d)/(t)，平方是 x²，根号是 √(a+b)。');
  assert.equal(toPlainChatText(String.raw`路径 D:\Files\app，价格 $99。`),String.raw`路径 D:\Files\app，价格 $99。`);
});
test('长回复优先在段落边界分开发送，emoji 不切成半个字符',()=>{
  const first='第一段。'.repeat(50),second='第二段。'.repeat(50);const parts=splitReply(first+'\n\n'+second,250);assert.equal(parts[0],first);assert.equal(parts[1],second);
  const emoji=splitReply('你'.repeat(449)+'🙂你好',450);assert.equal(Array.from(emoji[0]).length,450);assert.ok(!emoji.some(p=>/[\uD800-\uDBFF]$/.test(p)));
});
test('长中文说明自动按语句分段，文字和标点不丢失',()=>{
  const original='这里是视频中的一个变化，需要结合画面理解。'.repeat(12);const output=toPlainChatText(original);
  assert.ok(output.includes('\n\n'));assert.equal(output.replace(/\n/g,''),original);
});
test('发送时保留换行；平台回执压缩空白后仍能确认相同消息',async()=>{
  const owner={chatKey:'owner',peerUid:'uid'};let body='',pressed=false;
  const adapter=new DouyinAdapter({root:'unused'});adapter.page={keyboard:{insertText:async t=>body=t,press:async()=>{pressed=true;}}};
  adapter.chatFrame={evaluate:async()=>[{index:0,text:''}],locator:()=>({nth:()=>({click:async()=>{}})})};
  adapter.scan=async()=>({peer:owner,messages:pressed?[{id:'out',direction:'out',text:comparableChatText(body)}]:[]});
  await adapter.send(owner,'**开始**\n\n1. 看画面\n2. 看变化');assert.equal(body,'开始\n\n1. 看画面\n2. 看变化');
});
