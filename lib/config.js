'use strict';
/*
 * Where farr-browser keeps its state, and the settings a user can change.
 *
 * Everything lives in one directory: FARR_BROWSER_HOME if set, otherwise
 * ~/.farr-browser. The optional config.json there is merged over the defaults.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  maxSessions: 4,            // live sessions the daemon holds at once
  idleSeconds: 600,          // a session unused this long is closed
  maxAgeSeconds: 4 * 3600,   // no session lives longer than this
  timeoutMs: 30000,          // default navigation and request timeout
  pacing: {
    minIntervalMs: 1000,     // at least this long between two requests to one host
    sites: {},               // per-host overrides: { "example.org": 5000 }
  },
  robots: {
    cacheSeconds: 3600,      // how long a fetched robots.txt is trusted
  },
  proxies: [],               // [{ "server": "socks5://127.0.0.1:1080", "country": "DE", "default": false }]
  browser: {
    channel: null,           // e.g. "chrome" to use an installed Google Chrome instead of Playwright's Chromium
    headless: true,
  },
});

function home() {
  return process.env.FARR_BROWSER_HOME || path.join(os.homedir(), '.farr-browser');
}

function paths() {
  const h = home();
  return {
    home: h,
    config: path.join(h, 'config.json'),
    socket: process.platform === 'win32'
      ? '\\\\.\\pipe\\farr-browser-' + Buffer.from(h).toString('hex').slice(-16)
      : path.join(h, 'daemon.sock'),
    daemonLog: path.join(h, 'daemon.log'),
    log: path.join(h, 'log.jsonl'),
    traces: path.join(h, 'traces'),
    downloads: path.join(h, 'downloads'),
    skills: path.join(h, 'skills'),
    pacing: path.join(h, 'pacing.json'),
  };
}

function ensureHome() {
  const p = paths();
  fs.mkdirSync(p.home, { recursive: true });
  return p;
}

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** The effective configuration. A broken config.json is an error, never silently ignored. */
function load() {
  const p = paths();
  let user = {};
  if (fs.existsSync(p.config)) {
    try {
      user = JSON.parse(fs.readFileSync(p.config, 'utf8'));
    } catch (e) {
      throw new Error(`cannot parse ${p.config}: ${e.message}`);
    }
  }
  const cfg = merge(DEFAULTS, user);
  if (process.env.FARR_BROWSER_CHANNEL) cfg.browser = { ...cfg.browser, channel: process.env.FARR_BROWSER_CHANNEL };
  return cfg;
}

module.exports = { DEFAULTS, home, paths, ensureHome, load, merge };
