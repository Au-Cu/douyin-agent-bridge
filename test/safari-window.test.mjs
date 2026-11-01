import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SafariDouyinAdapter } from '../src/safari.mjs';

const CHAT = 'https://www.douyin.com/chat?isPopup=1';

// A stand-in for Safari that keeps one window's tab list and answers the same
// AppleScript calls the adapter makes. It reproduces the behaviour that broke
// the bridge: `make new document` appends the page as a new tab in the current
// window instead of leaving it as the first tab.
function fakeSafari({ tabs = [], windowId = 4242, marker = null, createAddsTab = true } = {}) {
  const state = { tabs: [...tabs], windowId, marker, scripts: [] };
  const fake = async script => {
    state.scripts.push(script);
    if (script.includes('make new document')) {
      const url = script.match(/URL:"([^"]+)"/)?.[1] || '';
      if (createAddsTab) state.tabs.push(url);
      return String(state.windowId);
    }
    if (script.includes('URL of every tab of window id')) return state.tabs.join('\n') + '\n';
    const target = script.match(/set t to tab (\d+) of window id (\d+)/);
    if (target) {
      const url = state.tabs[Number(target[1]) - 1] || '';
      if (!url.startsWith('https://www.douyin.com/')) return 'execution error: wrong origin';
      if (script.includes('douyin-codex-bridge-window')) {
        if (script.includes('getItem')) return JSON.stringify({ ok: true, value: state.marker });
        const uuid = script.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
        if (uuid) state.marker = uuid;
        return JSON.stringify({ ok: true, value: true });
      }
      return JSON.stringify({ ok: true, value: true });
    }
    return '';
  };
  return { fake, state };
}

test('Safari 把抖音页开成新标签时按 URL 定位，不假设它在第一个标签', async () => {
  const root = mkdtempSync(join(tmpdir(), 'safari-window-'));
  const { fake, state } = fakeSafari({ tabs: ['https://example.com/a', 'https://example.com/b'] });
  const adapter = new SafariDouyinAdapter({ root, executeAppleScript: fake });
  await adapter.open();
  assert.equal(adapter.windowId, 4242);
  assert.equal(state.tabs[2], CHAT);
  // The Douyin page is the third tab, so the bridge must act on that one.
  assert.equal(adapter.tabIndex, 3);
  const marked = state.scripts.find(s => s.includes('do JavaScript') && s.includes('douyin-codex-bridge-window'));
  assert.match(marked, /set t to tab 3 of window id 4242/);
  const saved = JSON.parse(readFileSync(join(root, 'browser-profile', 'safari-window.json'), 'utf8'));
  assert.equal(saved.tab, 3);
});

test('重启后沿用已保存的标签位置；标签挪动时重新按 URL 定位', async () => {
  const root = mkdtempSync(join(tmpdir(), 'safari-window-'));
  const first = fakeSafari({ tabs: ['https://example.com/a'] });
  await new SafariDouyinAdapter({ root, executeAppleScript: first.fake }).open();
  assert.equal(first.state.tabs.length, 2);

  // The same window and tab are still there, so the saved position is reused.
  const resumed = fakeSafari({ tabs: first.state.tabs, marker: first.state.marker });
  const adapter = new SafariDouyinAdapter({ root, executeAppleScript: resumed.fake });
  await adapter.open();
  assert.equal(adapter.windowId, 4242);
  assert.equal(adapter.tabIndex, 2);
  assert.equal(resumed.state.tabs.length, 2, '已经存在的页面不应重复打开');

  // The tab moved to another position and the saved marker no longer matches:
  // the bridge must find the page again instead of acting on the wrong tab.
  const moved = fakeSafari({ tabs: ['https://example.com/new', 'https://example.com/x', CHAT, 'https://example.com/a'], marker: first.state.marker });
  const again = new SafariDouyinAdapter({ root, executeAppleScript: moved.fake });
  await again.open();
  assert.equal(again.windowId, 4242);
  assert.equal(again.tabIndex, 3, '标签挪动后应重新定位，而不是再开一个重复页面');
  assert.equal(moved.state.tabs.filter(u => u.startsWith(CHAT)).length, 1);
});

test('窗口里没有抖音页时给出明确提示，不假装已经打开', async () => {
  const root = mkdtempSync(join(tmpdir(), 'safari-window-'));
  const { fake } = fakeSafari({ tabs: [], createAddsTab: false });
  const adapter = new SafariDouyinAdapter({ root, executeAppleScript: fake });
  await assert.rejects(adapter.open(), /未能在 Safari 中找到抖音私信页面/);
  assert.equal(adapter.windowId, 0);
});
