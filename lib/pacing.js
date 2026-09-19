'use strict';
/*
 * Per-site pacing: never two requests to one host closer together than the
 * configured interval (or the site's robots.txt Crawl-delay, whichever is
 * longer). The last-request times are kept in a small file in the state
 * directory so separate commands respect each other too. It is best-effort
 * across processes, strict within one.
 */
const fs = require('fs');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = new Map();       // host -> last request time in this process
const chains = new Map();      // host -> promise, so concurrent callers queue

function readShared() {
  try { return JSON.parse(fs.readFileSync(config.paths().pacing, 'utf8')); } catch (e) { return {}; }
}

function writeShared(host, at) {
  try {
    const p = config.ensureHome();
    const all = readShared();
    all[host] = at;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [h, t] of Object.entries(all)) if (t < cutoff) delete all[h];
    fs.writeFileSync(p.pacing, JSON.stringify(all));
  } catch (e) { /* best effort */ }
}

/** The interval in ms that applies to a host. */
function intervalFor(host, cfg, crawlDelay) {
  const pacing = (cfg && cfg.pacing) || {};
  const site = pacing.sites && pacing.sites[host];
  const base = site != null ? Number(site) : Number(pacing.minIntervalMs || 0);
  const robots = crawlDelay != null ? Number(crawlDelay) * 1000 : 0;
  return Math.max(base, robots);
}

/**
 * Wait until a request to `host` is allowed, then record it.
 * @returns {Promise<number>} how many ms were waited
 */
function wait(host, { cfg = config.load(), crawlDelay = null } = {}) {
  const prev = chains.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const gap = intervalFor(host, cfg, crawlDelay);
    const last = Math.max(local.get(host) || 0, readShared()[host] || 0);
    const ms = Math.max(0, last + gap - Date.now());
    if (ms > 0) await sleep(ms);
    const now = Date.now();
    local.set(host, now);
    writeShared(host, now);
    return ms;
  });
  chains.set(host, next.catch(() => {}));
  return next;
}

module.exports = { wait, intervalFor };
