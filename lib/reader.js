'use strict';
/*
 * One-shot reading and downloading, no live session.
 *
 *   read(url) -> the page as markdown (links, tables, headings kept)
 *   get(url)  -> the bytes, saved to a file; with pdf:true a page's own PDF link is followed
 *
 * Every request, including every redirect hop, is checked against robots.txt and
 * waits its turn under the per-site pacing interval. A refusal page is reported as
 * `blocked`, never returned as content.
 */
const fs = require('fs');
const path = require('path');

const config = require('./config');
const robots = require('./robots');
const pacing = require('./pacing');
const proxies = require('./proxies');
const http = require('./http');
const md = require('./markdown');
const blocked = require('./blocked');
const log = require('./log');
const { launch } = require('./browser');
const { Refused } = require('./errors');

/** GET a URL politely, following redirects one checked hop at a time. */
async function politeFetch(url, { country, cfg = config.load(), maxRedirects = 10 } = {}) {
  const proxy = proxies.forPlaywright(proxies.pick(cfg.proxies, { country }));
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const rule = await robots.allows(current, { proxy, cacheSeconds: cfg.robots.cacheSeconds });
    if (!rule.allowed) throw new Refused(`refused: ${current} — ${rule.why}. Nothing was fetched.`, { robots: true, url: current });
    await pacing.wait(new URL(current).host, { cfg, crawlDelay: rule.crawlDelay });
    const r = await http.fetchOnce(current, { proxy, timeoutMs: cfg.timeoutMs });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      current = new URL(r.headers.location, current).href;
      continue;
    }
    return { ...r, url: current, proxied: !!proxy };
  }
  throw new Refused(`too many redirects from ${url}`);
}

function typeOf(headers) {
  return String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

async function readRendered(url, { country, cfg, maxChars }) {
  const proxy = proxies.pick(cfg.proxies, { country });
  const rule = await robots.allows(url, { proxy: proxies.forPlaywright(proxy), cacheSeconds: cfg.robots.cacheSeconds });
  if (!rule.allowed) throw new Refused(`refused: ${url} — ${rule.why}. Nothing was fetched.`, { robots: true });
  await pacing.wait(new URL(url).host, { cfg, crawlDelay: rule.crawlDelay });
  const { browser } = await launch(cfg);
  try {
    const ctx = await browser.newContext({ proxy: proxies.forPlaywright(proxy) });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'load', timeout: cfg.timeoutMs });
    const title = await page.title();
    const b = blocked.classify({ status: res ? res.status() : null, title });
    if (b) throw new Refused(`blocked: ${url} — ${b.reason}. farr-browser does not work around this.`, { blocked: b });
    const m = await md.fromPage(page, { maxChars });
    return { url: page.url(), status: res ? res.status() : null, title: m.title, markdown: m.markdown, transport: 'browser' };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {string} url
 * @param {{country?:string, maxChars?:number, browser?:boolean}} opts
 */
async function read(url, { country, maxChars = 20000, browser = false } = {}) {
  const cfg = config.load();
  const done = log.timed('read', { url, country });
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Refused('read needs an absolute http(s) URL');
    let out;
    if (browser) {
      out = await readRendered(url, { country, cfg, maxChars });
    } else {
      const r = await politeFetch(url, { country, cfg });
      const type = typeOf(r.headers);
      const text = r.body.toString('utf8');
      const title = /html/.test(type) ? blocked.titleOf(text) : '';
      const b = blocked.classify({ status: r.status, title });
      if (b) throw new Refused(`blocked: ${r.url} — ${b.reason}. farr-browser does not work around this.`, { blocked: b });
      if (r.status >= 400) throw new Refused(`${r.url} answered HTTP ${r.status}`, { status: r.status });
      if (type === 'application/pdf' || r.body.slice(0, 5).toString() === '%PDF-') {
        throw new Refused(`${r.url} is a PDF; use get to download it`, { pdf: true });
      }
      let markdown;
      if (/html|xml/.test(type) || /^\s*</.test(text.slice(0, 200))) markdown = md.fromHtml(text, { base: r.url, maxChars });
      else markdown = maxChars && text.length > maxChars ? text.slice(0, maxChars) + `\n\n[truncated at ${maxChars} of ${text.length} characters]` : text;
      out = { url: r.url, status: r.status, title, markdown, transport: 'http' };
    }
    done('ok', { detail: `${out.markdown.length} chars via ${out.transport}` });
    return out;
  } catch (e) {
    done(e.blocked ? 'blocked' : e.refused ? 'refused' : 'error', { detail: String(e.message).slice(0, 200) });
    throw e;
  }
}

/** A page's own link to its PDF: citation meta tag, alternate link, or a link ending in .pdf. */
function findPdfLink(html, base) {
  const tries = [
    /<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']/i,
    /<link[^>]+type=["']application\/pdf["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/pdf["']/i,
    /<a[^>]+href=["']([^"'#?]+\.pdf(?:\?[^"']*)?)["']/i,
  ];
  for (const re of tries) {
    const m = re.exec(html);
    if (m) {
      try { return new URL(md.decode(m[1]), base).href; } catch (e) { /* try the next */ }
    }
  }
  return null;
}

function fileNameFor(url, headers) {
  const cd = String(headers['content-disposition'] || '');
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  let name = m ? decodeURIComponent(m[1]) : path.basename(new URL(url).pathname) || 'download';
  name = name.replace(/[^\w.\- ]+/g, '_');
  return name || 'download';
}

/**
 * @param {string} url
 * @param {{out?:string, pdf?:boolean, country?:string}} opts
 */
async function get(url, { out, pdf = false, country } = {}) {
  const cfg = config.load();
  const done = log.timed('get', { url, country, pdf });
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Refused('get needs an absolute http(s) URL');
    let r = await politeFetch(url, { country, cfg });
    let followed = null;
    const type0 = typeOf(r.headers);
    const title0 = /html/.test(type0) ? blocked.titleOf(r.body.toString('utf8')) : '';
    const b0 = blocked.classify({ status: r.status, title: title0 });
    if (b0) throw new Refused(`blocked: ${r.url} — ${b0.reason}. farr-browser does not work around this.`, { blocked: b0 });
    if (r.status >= 400) throw new Refused(`${r.url} answered HTTP ${r.status}`, { status: r.status });

    const isPdf = (x) => x.body.slice(0, 5).toString() === '%PDF-';
    if (pdf && !isPdf(r)) {
      if (!/html/.test(type0)) throw new Refused(`${r.url} is ${type0 || 'not HTML'} and not a PDF`);
      const link = findPdfLink(r.body.toString('utf8'), r.url);
      if (!link) throw new Refused(`${r.url} has no PDF link of its own (no citation_pdf_url, no PDF alternate, no .pdf link)`);
      followed = link;
      r = await politeFetch(link, { country, cfg });
      const b1 = blocked.classify({ status: r.status });
      if (b1) throw new Refused(`blocked: ${link} — ${b1.reason}. farr-browser does not work around this.`, { blocked: b1 });
      if (r.status >= 400) throw new Refused(`${link} answered HTTP ${r.status}`, { status: r.status });
      if (!isPdf(r)) throw new Refused(`${link} did not return a PDF (${typeOf(r.headers) || 'unknown type'})`);
    }
    const target = path.resolve(out || fileNameFor(r.url, r.headers));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, r.body);
    const res = { url: r.url, path: target, bytes: r.body.length, contentType: typeOf(r.headers) || null, followed };
    done('ok', { detail: `${res.bytes} bytes` });
    return res;
  } catch (e) {
    done(e.blocked ? 'blocked' : e.refused ? 'refused' : 'error', { detail: String(e.message).slice(0, 200) });
    throw e;
  }
}

module.exports = { read, get, politeFetch, findPdfLink };
