'use strict';
/*
 * Bring your own proxy.
 *
 * farr-browser ships with no proxies and knows no provider. You list the ones you
 * have in config.json, each optionally tagged with a country code:
 *
 *   "proxies": [
 *     { "server": "http://127.0.0.1:8080" },
 *     { "server": "socks5://127.0.0.1:1080", "country": "DE", "default": true }
 *   ]
 *
 * A request that names a country gets a proxy tagged with that country (round
 * robin when there are several) or a refusal if there is none. A request that
 * names no country uses a proxy marked "default", or goes direct.
 */
const { Refused } = require('./errors');

const SCHEMES = /^(http|https|socks5):\/\//i;
let turn = 0;

function validate(list) {
  if (!Array.isArray(list)) throw new Error('config "proxies" must be a list');
  return list.map((p, i) => {
    if (!p || typeof p.server !== 'string' || !SCHEMES.test(p.server)) {
      throw new Error(`proxies[${i}].server must start with http://, https:// or socks5://`);
    }
    let u;
    try { u = new URL(p.server); } catch (e) { throw new Error(`proxies[${i}].server is not a URL: ${p.server}`); }
    if (u.username || u.password) {
      throw new Error(`proxies[${i}]: credentials in the proxy URL are not supported`);
    }
    return {
      server: p.server,
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'socks5:' ? 1080 : u.protocol === 'https:' ? 443 : 80),
      country: p.country ? String(p.country).toUpperCase() : null,
      default: !!p.default,
    };
  });
}

/**
 * Choose a proxy for one request or session.
 * @returns {{server:string, country:string|null}|null} null means "go direct"
 */
function pick(list, { country } = {}) {
  const all = validate(list || []);
  if (country) {
    const want = String(country).toUpperCase();
    const match = all.filter((p) => p.country === want);
    if (!match.length) {
      const have = [...new Set(all.map((p) => p.country).filter(Boolean))];
      throw new Refused(`no proxy is tagged with country ${want}` +
        (have.length ? ` (configured: ${have.join(', ')})` : ' (no proxies with a country are configured)'),
        { noProxy: true });
    }
    return match[turn++ % match.length];
  }
  const defaults = all.filter((p) => p.default);
  return defaults.length ? defaults[turn++ % defaults.length] : null;
}

/** The shape Playwright takes. */
function forPlaywright(p) {
  return p ? { server: p.server } : undefined;
}

module.exports = { validate, pick, forPlaywright };
