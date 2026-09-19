'use strict';
/*
 * One plain HTTP request, no browser. Uses Playwright's request client because it
 * speaks http and socks5 proxies without extra dependencies. Redirects are NOT
 * followed here: the caller follows them one hop at a time so that robots.txt and
 * pacing apply to every hop.
 */
const { request } = require('playwright');
const pkg = require('../package.json');

const USER_AGENT = `farr-browser/${pkg.version} (+${pkg.homepage || 'https://www.npmjs.com/package/farr-browser'})`;

async function fetchOnce(url, { proxy, timeoutMs = 30000, method = 'GET', maxBytes = 50 * 1024 * 1024 } = {}) {
  const ctx = await request.newContext({
    proxy,
    userAgent: USER_AGENT,
    timeout: timeoutMs,
  });
  try {
    const res = await ctx.fetch(url, { method, maxRedirects: 0, failOnStatusCode: false, timeout: timeoutMs });
    const body = await res.body();
    if (body.length > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    return { status: res.status(), headers: res.headers(), url: res.url(), body };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

module.exports = { fetchOnce, USER_AGENT };
