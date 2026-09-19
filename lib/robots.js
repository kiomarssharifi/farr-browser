'use strict';
/*
 * robots.txt, read and obeyed.
 *
 * Matching follows RFC 9309: the group for the most specific matching user-agent
 * (else "*"); within it the longest matching rule wins, and on a tie Allow wins;
 * "*" matches any run of characters and "$" anchors the end.
 *
 * Fetch outcomes, also per RFC 9309:
 *   2xx          -> the rules apply
 *   4xx          -> no rules; crawling is allowed
 *   5xx, network -> we were told nothing, so we REFUSE rather than assume
 */
const { fetchOnce } = require('./http');

const AGENT = 'farr-browser';
const cache = new Map(); // origin -> { at, ttl, rec }

function parse(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const i = line.indexOf(':');
    if (!line || i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') { sitemaps.push(value); continue; }
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value === '') continue; // an empty Disallow allows everything
      cur.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = parseFloat(value);
      if (Number.isFinite(n)) cur.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function patternToRegExp(pattern) {
  let p = pattern;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

function groupFor(parsed, agent = AGENT) {
  const ua = agent.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      const len = a === '*' ? 0 : (ua.includes(a) ? a.length : -1);
      if (len > bestLen) { best = g; bestLen = len; }
    }
  }
  return best;
}

function check(parsed, pathAndQuery, agent = AGENT) {
  const g = groupFor(parsed, agent);
  if (!g || !g.rules.length) return { allowed: true, rule: null };
  let win = null;
  for (const r of g.rules) {
    if (!patternToRegExp(r.path).test(pathAndQuery)) continue;
    if (!win || r.path.length > win.path.length || (r.path.length === win.path.length && r.allow && !win.allow)) win = r;
  }
  if (!win) return { allowed: true, rule: null };
  return { allowed: win.allow, rule: `${win.allow ? 'Allow' : 'Disallow'}: ${win.path}` };
}

async function fetchRules(origin, { proxy, cacheSeconds = 3600, fetchImpl = fetchOnce } = {}) {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.rec;
  let rec;
  try {
    const r = await fetchImpl(`${origin}/robots.txt`, { proxy, timeoutMs: 15000 });
    if (r.status >= 200 && r.status < 300) {
      rec = { state: 'rules', parsed: parse(r.body.toString('utf8')) };
    } else if (r.status >= 300 && r.status < 400) {
      // One redirect is followed only if it stays on the same origin; otherwise treat as unreadable.
      const loc = r.headers.location ? new URL(r.headers.location, `${origin}/robots.txt`) : null;
      if (loc && loc.origin === origin) {
        const r2 = await fetchImpl(loc.href, { proxy, timeoutMs: 15000 });
        rec = r2.status >= 200 && r2.status < 300
          ? { state: 'rules', parsed: parse(r2.body.toString('utf8')) }
          : r2.status >= 400 && r2.status < 500 ? { state: 'none' } : { state: 'unreadable', why: `status ${r2.status}` };
      } else {
        rec = { state: 'unreadable', why: `redirected off-origin (${r.status})` };
      }
    } else if (r.status >= 400 && r.status < 500) {
      rec = { state: 'none' };
    } else {
      rec = { state: 'unreadable', why: `status ${r.status}` };
    }
  } catch (e) {
    rec = { state: 'unreadable', why: String(e.message).split('\n')[0].slice(0, 120) };
  }
  // A failure is not knowledge: keep it for one minute only.
  cache.set(origin, { at: Date.now(), ttl: rec.state === 'unreadable' ? 60000 : cacheSeconds * 1000, rec });
  return rec;
}

/**
 * May farr-browser fetch this URL?
 * @returns {{allowed:boolean, why:string, crawlDelay:number|null}}
 */
async function allows(url, opts = {}) {
  let u;
  try { u = new URL(url); } catch (e) { return { allowed: false, why: `not a URL: ${url}`, crawlDelay: null }; }
  if (!/^https?:$/.test(u.protocol)) return { allowed: false, why: `only http and https are supported (${u.protocol})`, crawlDelay: null };
  const rec = await fetchRules(u.origin, opts);
  if (rec.state === 'unreadable') {
    return { allowed: false, why: `robots.txt for ${u.host} could not be read (${rec.why}); refusing rather than assuming permission`, crawlDelay: null };
  }
  if (rec.state === 'none') return { allowed: true, why: 'no robots.txt', crawlDelay: null };
  const res = check(rec.parsed, u.pathname + u.search);
  const g = groupFor(rec.parsed);
  return {
    allowed: res.allowed,
    why: res.rule ? `robots.txt: ${res.rule}` : 'no rule matches',
    crawlDelay: g && g.crawlDelay != null ? g.crawlDelay : null,
  };
}

function clearCache() { cache.clear(); }

module.exports = { AGENT, parse, check, allows, groupFor, patternToRegExp, clearCache };
