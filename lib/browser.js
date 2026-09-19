'use strict';
/*
 * Launching the browser. Playwright's own Chromium is used by default
 * (`npx playwright install chromium`). If it is not installed, an installed
 * Google Chrome or Microsoft Edge is tried through Playwright's `channel`
 * option, and `which` says which one is running. Set browser.channel in
 * config.json (or FARR_BROWSER_CHANNEL) to choose explicitly.
 */
const { chromium } = require('playwright');

async function launch(cfg) {
  const b = (cfg && cfg.browser) || {};
  const headless = b.headless !== false;
  const tries = b.channel ? [b.channel] : [null, 'chrome', 'msedge'];
  const errors = [];
  for (const channel of tries) {
    try {
      const browser = await chromium.launch({ headless, ...(channel ? { channel } : {}) });
      return { browser, which: channel ? `channel ${channel}` : "Playwright's Chromium" };
    } catch (e) {
      errors.push(`${channel || 'chromium'}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
    }
  }
  throw new Error('no browser could be started. Run `npx playwright install chromium`. Tried: ' + errors.join(' | '));
}

module.exports = { launch };
