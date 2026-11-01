import { chromium } from 'playwright-core';

// The Windows release drives the page logic in Edge. macOS has no Edge, so
// the bundled Chromium runs the same page code there. A machine without any
// usable browser skips the case with the reason instead of failing with an
// opaque launch error.
export const browserChannel = process.env.BRIDGE_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined);

export async function launchTestBrowser(t) {
  try {
    return await chromium.launch({ channel: browserChannel, headless: true });
  } catch (e) {
    const message = String(e?.message || e);
    if (!/is not found|Executable doesn't exist|ENOENT|browserType\.launch/i.test(message)) throw e;
    if (t?.skip) t.skip('本机没有可用的测试浏览器：' + message.split('\n')[0]);
    return null;
  }
}
