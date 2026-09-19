'use strict';
/*
 * Skills: a site-specific recipe that answers one question ("intent") with typed
 * rows instead of prose.
 *
 * A skill is a JSON file. Built-in skills live in the package's skills/ folder;
 * your own go in ~/.farr-browser/skills/ (or $FARR_BROWSER_HOME/skills/). See the
 * README for the format. A skill only fetches through the same polite path as
 * `read`: robots.txt, pacing, your proxies. It never logs in.
 */
const fs = require('fs');
const path = require('path');

const config = require('./config');
const reader = require('./reader');
const blocked = require('./blocked');
const log = require('./log');
const { launch } = require('./browser');
const { Refused } = require('./errors');

const BUILTIN = path.join(__dirname, '..', 'skills');
const TYPES = new Set(['string', 'number', 'url', 'integer']);

function validate(skill) {
  const errs = [];
  if (!skill || typeof skill !== 'object') return ['not an object'];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.id || '')) errs.push('id must be lowercase letters, digits and dashes');
  if (!Array.isArray(skill.domains) || !skill.domains.length) errs.push('domains must be a non-empty list');
  if (!skill.intents || typeof skill.intents !== 'object' || !Object.keys(skill.intents).length) errs.push('intents must name at least one intent');
  for (const [name, it] of Object.entries(skill.intents || {})) {
    const at = `intents.${name}`;
    if (typeof it.url !== 'string') errs.push(`${at}.url must be a URL template`);
    if (!['html', 'json'].includes(it.format)) errs.push(`${at}.format must be "html" or "json"`);
    if (it.format === 'html' && typeof it.rows !== 'string') errs.push(`${at}.rows must be a CSS selector`);
    if (it.format === 'json' && it.rows != null && typeof it.rows !== 'string') errs.push(`${at}.rows must be a dotted path`);
    if (!it.fields || !Object.keys(it.fields).length) errs.push(`${at}.fields must name at least one field`);
    for (const [f, spec] of Object.entries(it.fields || {})) {
      if (spec.type && !TYPES.has(spec.type)) errs.push(`${at}.fields.${f}.type must be one of ${[...TYPES].join(', ')}`);
    }
    for (const v of (String(it.url || '').match(/\{(\w+)\}/g) || [])) {
      const k = v.slice(1, -1);
      if (!(it.input && it.input[k])) errs.push(`${at}.url uses {${k}} but input does not declare it`);
    }
  }
  return errs;
}

/** Every skill found, and every file that failed to load, with the reason. */
function loadAll() {
  const dirs = [BUILTIN, config.paths().skills];
  const skills = new Map();
  const invalid = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const file = path.join(dir, f);
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        const errs = validate(s);
        if (errs.length) invalid.push({ file, errors: errs });
        else skills.set(s.id, { ...s, file }); // a user skill with the same id replaces a built-in one
      } catch (e) {
        invalid.push({ file, errors: [e.message] });
      }
    }
  }
  return { skills, invalid };
}

/** The catalogue an agent reads: ids, intents, and each intent's real argument names. */
function list() {
  const { skills, invalid } = loadAll();
  return {
    skills: [...skills.values()].map((s) => ({
      id: s.id,
      description: s.description || '',
      domains: s.domains,
      intents: Object.fromEntries(Object.entries(s.intents).map(([n, it]) => [n, {
        description: it.description || '',
        input: it.input || {},
        fields: Object.keys(it.fields),
      }])),
    })),
    invalid,
  };
}

function buildUrl(it, args) {
  const values = {};
  for (const [k, spec] of Object.entries(it.input || {})) {
    let v = args[k];
    if (v == null || v === '') v = spec.default;
    if (v == null || v === '') {
      if (spec.required !== false) throw new Refused(`missing argument "${k}"${spec.description ? `: ${spec.description}` : ''}`);
      v = '';
    }
    v = String(v);
    if (spec.spaces) v = v.replace(/ /g, spec.spaces);
    values[k] = v;
  }
  const unknown = Object.keys(args).filter((k) => !(it.input && it.input[k]));
  if (unknown.length) {
    throw new Refused(`unknown argument(s) ${unknown.join(', ')}; this intent takes: ${Object.keys(it.input || {}).join(', ') || 'nothing'}`);
  }
  // Values are URL-encoded; "path": true keeps slashes; "raw": true inserts the value as is
  // (the result must still fall inside the skill's domains).
  return it.url.replace(/\{(\w+)\}/g, (m, k) => {
    const spec = it.input[k];
    if (spec.raw) return values[k];
    const enc = encodeURIComponent(values[k]);
    return spec.path ? enc.replace(/%2F/gi, '/') : enc;
  });
}

function hostAllowed(url, domains) {
  const host = new URL(url).hostname.toLowerCase();
  return domains.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

function coerce(value, type, base) {
  if (value == null) return null;
  let v = String(value).replace(/\s+/g, ' ').trim();
  if (v === '') return null;
  if (type === 'number' || type === 'integer') {
    const m = /-?\d[\d,' ]*(\.\d+)?/.exec(v);
    if (!m) return null;
    const n = Number(m[0].replace(/[,' ]/g, ''));
    return type === 'integer' ? Math.trunc(n) : n;
  }
  if (type === 'url') {
    try { return new URL(v, base).href; } catch (e) { return null; }
  }
  return v;
}

function getPath(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* Runs in a script-free page built from the fetched HTML. */
function extractInPage({ rows, fields, limit }) {
  const out = [];
  for (const row of [...document.querySelectorAll(rows)].slice(0, limit)) {
    const rec = {};
    for (const [name, spec] of Object.entries(fields)) {
      const sels = spec.selector == null ? [null] : [].concat(spec.selector);
      let value = null;
      for (const sel of sels) {
        const el = sel ? row.querySelector(sel) : row;
        if (!el) continue;
        value = spec.attr ? el.getAttribute(spec.attr) : (el.innerText || el.textContent);
        if (value != null && String(value).trim() !== '') break;
      }
      rec[name] = value;
    }
    out.push(rec);
  }
  return out;
}

async function extractHtml(html, it, cfg) {
  const { browser } = await launch(cfg);
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    await ctx.route('**/*', (r) => r.abort());
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(extractInPage, { rows: it.rows, fields: it.fields, limit: it.limit || 200 });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Run one intent of one skill.
 * @returns {{skill, intent, url, count, rows, dropped}}
 */
async function run(id, intent, args = {}) {
  const cfg = config.load();
  const done = log.timed('skill', { skill: id, intent });
  try {
    const { skills } = loadAll();
    const s = skills.get(id);
    if (!s) throw new Refused(`no skill "${id}"; available: ${[...skills.keys()].join(', ') || 'none'}`);
    const it = s.intents[intent];
    if (!it) throw new Refused(`skill "${id}" has no intent "${intent}"; it has: ${Object.keys(s.intents).join(', ')}`);
    const { country, ...rest } = args;
    const url = buildUrl(it, rest);
    if (!hostAllowed(url, s.domains)) throw new Refused(`${url} is outside this skill's domains (${s.domains.join(', ')})`);

    const r = await reader.politeFetch(url, { country, cfg });
    const text = r.body.toString('utf8');
    const b = blocked.classify({ status: r.status, title: it.format === 'html' ? blocked.titleOf(text) : '' });
    if (b) throw new Refused(`blocked: ${r.url} — ${b.reason}. farr-browser does not work around this.`, { blocked: b });
    if (r.status >= 400) throw new Refused(`${r.url} answered HTTP ${r.status}`, { status: r.status });

    let raw;
    if (it.format === 'json') {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Refused(`${r.url} did not return JSON`); }
      let list = getPath(data, it.rows);
      if (list == null) list = [];
      if (!Array.isArray(list)) list = [list];
      raw = list.slice(0, it.limit || 200).map((row) => Object.fromEntries(
        Object.entries(it.fields).map(([name, spec]) => [name, getPath(row, spec.path != null ? spec.path : name)])));
    } else {
      raw = await extractHtml(text, it, cfg);
    }
    const required = it.required || [];
    const rows = [];
    let dropped = 0;
    for (const rec of raw) {
      const typed = Object.fromEntries(Object.entries(it.fields).map(([n, spec]) => [n, coerce(rec[n], spec.type || 'string', r.url)]));
      if (required.some((k) => typed[k] == null)) { dropped++; continue; }
      rows.push(typed);
    }
    done('ok', { detail: `${rows.length} rows` });
    return { skill: id, intent, url: r.url, count: rows.length, dropped, rows };
  } catch (e) {
    done(e.blocked ? 'blocked' : e.refused ? 'refused' : 'error', { detail: String(e.message).slice(0, 200) });
    throw e;
  }
}

module.exports = { list, run, validate, loadAll, buildUrl, coerce };
