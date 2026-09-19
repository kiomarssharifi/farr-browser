'use strict';
/*
 * Live sessions: a browser page that stays open between an agent's calls, so the
 * agent can look, act, and look again instead of scripting a whole visit blind.
 *
 *   open(url)                 -> session id + the first look
 *   look(session)             -> the page as it is now
 *   act(session, action, ref) -> what measurably changed, plus the next look
 *   shot(session)             -> a screenshot, optionally with refs drawn on it
 *   close(session)            -> done; optionally the trace of every step
 *
 * What every session inherits, on every navigation however it is triggered
 * (goto, a clicked link, a submitted form, a script): robots.txt is honoured and
 * the per-site pacing interval is kept. What every action inherits: the safety
 * refusal (lib/gate.js), stale-ref refusal (lib/look.js), and dialogs dismissed
 * unless acceptance was armed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const robots = require('./robots');
const pacing = require('./pacing');
const proxies = require('./proxies');
const gate = require('./gate');
const L = require('./look');
const md = require('./markdown');
const blocked = require('./blocked');
const log = require('./log');
const { launch } = require('./browser');
const { Refused } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACTIONS = ['click', 'type', 'select', 'press', 'check', 'uncheck', 'hover', 'scroll', 'wait',
  'goto', 'back', 'forward', 'reload', 'tab', 'closetab', 'dialog'];
const NEEDS_REF = new Set(['click', 'type', 'select', 'check', 'uncheck', 'hover']);

/* Runs in the page: a few numbers that change when something happens. */
function stateInPage() {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  return {
    title: document.title,
    textLength: (document.body && document.body.innerText || '').length,
    nodes: document.querySelectorAll('*').length,
    inputs: [...document.querySelectorAll('input,select,textarea')].filter(vis).length,
    openDialogs: [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog]')].filter(vis).length,
  };
}

class Sessions {
  constructor(cfg = config.load()) {
    this.cfg = cfg;
    this.paths = config.ensureHome();
    this.sessions = new Map();
    this.browser = null;
    this.browserWhich = null;
    this.launching = null;
  }

  /* ------------------------------------------------------------ plumbing */
  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = launch(this.cfg).then(({ browser, which }) => {
        this.browser = browser;
        this.browserWhich = which;
        browser.on('disconnected', () => {
          for (const s of this.sessions.values()) s.lost = s.lost || 'the browser exited';
          this.browser = null;
        });
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  must(id) {
    const s = this.sessions.get(id);
    if (!s) {
      const live = [...this.sessions.keys()];
      throw new Refused(`no live session '${id}'` + (live.length ? ` (open: ${live.join(', ')})` : ' (none are open)') +
        `. Sessions close after ${this.cfg.idleSeconds} s idle; \`close ${id} --trace\` still shows what it did.`, { lost: true });
    }
    if (s.lost) {
      this.close({ session: id, reason: `lost: ${s.lost}` }).catch(() => {});
      throw new Refused(`session '${id}' was lost (${s.lost}); its last URL was ${s.url}. Open a new one.`, { lost: true, url: s.url });
    }
    s.lastUsed = Date.now();
    return s;
  }

  current(s) {
    if (s.page && !s.page.isClosed()) return s.page;
    s.pages = s.pages.filter((p) => !p.isClosed());
    s.page = s.pages.length ? s.pages[s.pages.length - 1] : null;
    if (!s.page) s.lost = 'every tab was closed';
    return s.page;
  }

  trace(s, row) {
    s.step += 1;
    const entry = { step: s.step, ts: new Date().toISOString(), ...row };
    s.trace.push(entry);
    try {
      fs.mkdirSync(this.paths.traces, { recursive: true });
      fs.appendFileSync(path.join(this.paths.traces, `${s.id}.jsonl`), JSON.stringify(entry) + '\n');
    } catch (e) { /* never fatal */ }
  }

  watch(s, page) {
    if (s.pages.includes(page)) return;
    s.pages.push(page);
    page.on('dialog', async (d) => {
      const armed = s.nextDialog;
      s.nextDialog = null;
      const rec = { type: d.type(), message: d.message().slice(0, 300) };
      try {
        // A dialog must be answered or the page hangs. The default answer is the one
        // that does nothing: an alert is acknowledged, anything else is dismissed.
        if (armed && armed.accept) { await d.accept(armed.text); rec.answered = 'accepted'; }
        else if (d.type() === 'alert') { await d.accept(); rec.answered = 'acknowledged'; }
        else { await d.dismiss(); rec.answered = 'dismissed'; }
      } catch (e) { rec.answered = `failed: ${String(e.message).slice(0, 80)}`; }
      s.events.dialogs.push(rec);
    });
    page.on('download', async (dl) => {
      const rec = { name: dl.suggestedFilename(), url: dl.url().slice(0, 200) };
      const p = (async () => {
        try {
          const dir = path.join(this.paths.downloads, s.id);
          fs.mkdirSync(dir, { recursive: true });
          rec.path = path.join(dir, dl.suggestedFilename().replace(/[^\w.\- ]+/g, '_') || 'download');
          await dl.saveAs(rec.path);
          rec.bytes = fs.statSync(rec.path).size;
        } catch (e) { rec.error = String(e.message).slice(0, 120); }
      })();
      s.pending.push(p);
      await p;
      s.events.downloads.push(rec);
    });
    page.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) s.lastStatus.set(page, r.status());
      } catch (e) { /* frame gone */ }
    });
    page.on('crash', () => { s.lost = 'the page crashed'; });
  }

  drain(s) {
    const e = s.events;
    s.events = { dialogs: [], downloads: [], tabs: [], refusedNavigations: [] };
    const out = {};
    if (e.dialogs.length) out.dialogs = e.dialogs;
    if (e.downloads.length) out.downloads = e.downloads;
    if (e.tabs.length) out.tabs = e.tabs;
    if (e.refusedNavigations.length) out.refusedNavigations = e.refusedNavigations;
    return out;
  }

  async robotsOrRefuse(s, url) {
    const r = await robots.allows(url, { proxy: proxies.forPlaywright(s.proxy), cacheSeconds: this.cfg.robots.cacheSeconds });
    if (!r.allowed) throw new Refused(`refused: ${url} — ${r.why}. Nothing was loaded.`, { robots: true });
    return r;
  }

  /* Every main-frame navigation passes here, however it was triggered. */
  async guard(s, route, request) {
    let isMain = false;
    try { isMain = request.isNavigationRequest() && request.frame().parentFrame() === null; } catch (e) { isMain = false; }
    const url = request.url();
    if (!isMain || !/^https?:/i.test(url)) return route.fallback();
    const r = await robots.allows(url, { proxy: proxies.forPlaywright(s.proxy), cacheSeconds: this.cfg.robots.cacheSeconds });
    if (!r.allowed) {
      s.events.refusedNavigations.push({ url: url.slice(0, 200), why: r.why });
      return route.abort('blockedbyclient');
    }
    await pacing.wait(new URL(url).host, { cfg: this.cfg, crawlDelay: r.crawlDelay });
    return route.fallback();
  }

  async doLook(s, opts = {}) {
    const page = this.current(s);
    if (!page) throw new Refused(`session '${s.id}' has no open tab`, { lost: true });
    const r = await L.look(page, s.refState, opts);
    s.url = page.url();
    let text = r.text;
    const tabs = s.pages.filter((p) => !p.isClosed());
    if (tabs.length > 1) {
      text += '\n\ntabs: ' + tabs.map((p, i) => `${p === page ? '*' : ''}${i}:${p.url().slice(0, 60)}`).join('  ');
    }
    if (opts.text) {
      const m = await md.fromPage(page, { maxChars: Number(opts.maxChars) || 6000 }).catch(() => null);
      if (m && m.markdown) text += '\n\n--- page text ---\n' + m.markdown;
    }
    return text;
  }

  async blockedNow(s) {
    const page = this.current(s);
    if (!page) return null;
    const title = await page.title().catch(() => '');
    return blocked.classify({ status: s.lastStatus.get(page), title });
  }

  /* ----------------------------------------------------------------- open */
  async open({ url, country, caller = 'unknown' } = {}) {
    const done = log.timed('open', { url, caller });
    if (!url || !/^https?:\/\//i.test(String(url))) { done('refused'); throw new Refused('open needs an absolute http(s) URL'); }
    if (this.sessions.size >= this.cfg.maxSessions) {
      const list = [...this.sessions.values()].map((x) => `${x.id} (${new URL(x.url).host}, idle ${Math.round((Date.now() - x.lastUsed) / 1000)} s)`);
      done('refused', { detail: 'session cap' });
      throw new Refused(`all ${this.cfg.maxSessions} sessions are in use: ${list.join('; ')}. Close one first.`, { capped: true });
    }
    const proxy = proxies.pick(this.cfg.proxies, { country });
    const s = {
      id: 's' + crypto.randomBytes(3).toString('hex'), caller, proxy, url,
      created: Date.now(), lastUsed: Date.now(), pages: [], page: null, context: null,
      refState: L.newState(), step: 0, trace: [], nextDialog: null, lost: null, pending: [],
      lastStatus: new WeakMap(), events: { dialogs: [], downloads: [], tabs: [], refusedNavigations: [] },
    };
    try {
      await this.robotsOrRefuse(s, url);
      const browser = await this.ensureBrowser();
      s.context = await browser.newContext({
        proxy: proxies.forPlaywright(proxy), acceptDownloads: true, viewport: { width: 1280, height: 900 },
      });
      s.context.setDefaultTimeout(this.cfg.timeoutMs);
      await s.context.route('**/*', (route, request) => this.guard(s, route, request));
      s.page = await s.context.newPage();
      this.watch(s, s.page);
      s.context.on('page', (p) => {
        if (s.pages.includes(p)) return;
        this.watch(s, p);
        s.page = p;
        s.events.tabs.push(`opened ${p.url() || 'a new tab'}`);
        L.reset(s.refState).catch(() => {});
      });
      try {
        await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
      } catch (e) {
        if (s.events.refusedNavigations.length) {
          throw new Refused(`refused: ${s.events.refusedNavigations[0].url} — ${s.events.refusedNavigations[0].why}`, { robots: true });
        }
        throw new Refused(`${url} did not load: ${String(e.message).split('\n')[0].slice(0, 160)}`);
      }
      const b = await this.blockedNow(s);
      if (b) throw new Refused(`blocked: ${url} — ${b.reason}. farr-browser does not work around this.`, { blocked: b });
      this.sessions.set(s.id, s);
      const look = await this.doLook(s);
      this.trace(s, { did: `open ${url}`, outcome: 'ok', url: s.page.url() });
      done('ok', { session: s.id });
      return { session: s.id, proxy: proxy ? { server: proxy.server, country: proxy.country } : null, ...this.drain(s), look };
    } catch (e) {
      done(e.blocked ? 'blocked' : e.refused ? 'refused' : 'error', { detail: String(e.message).slice(0, 200) });
      this.sessions.delete(s.id);
      if (s.context) await s.context.close().catch(() => {});
      throw e;
    }
  }

  /* ----------------------------------------------------------------- look */
  async look({ session, filter, limit, inViewOnly, text, maxChars } = {}) {
    const s = this.must(session);
    const look = await this.doLook(s, { filter, limit: limit ? Number(limit) : undefined, inViewOnly, text, maxChars });
    log.write({ verb: 'look', session: s.id, url: s.url, verdict: 'ok' });
    return { session: s.id, ...this.drain(s), look };
  }

  /* ------------------------------------------------------------------- do */
  async act({ session, action, ref, value, key, submit, allow, timeout, look: wantLook } = {}) {
    const s = this.must(session);
    const done = log.timed('do', { session: s.id, action, ref });
    action = String(action || '').toLowerCase();
    if (!ACTIONS.includes(action)) {
      done('refused');
      throw new Refused(`unknown action '${action}'. One of: ${ACTIONS.join(', ')}`);
    }
    const page = this.current(s);
    if (!page) throw new Refused(`session '${s.id}' has no open tab`, { lost: true });

    const before = { url: page.url(), state: await page.evaluate(stateInPage).catch(() => null), tabs: s.pages.filter((p) => !p.isClosed()).length };
    let target = null;
    let did = action;
    let note = '';

    if (NEEDS_REF.has(action) || (ref && (action === 'press' || action === 'scroll'))) {
      if (!ref) { done('refused'); throw new Refused(`'${action}' needs a ref from the last look, e.g. "e12"`); }
      const r = await L.resolve(s.refState, ref);
      if (r.stale) {
        const fresh = await this.doLook(s).catch(() => null);
        this.trace(s, { did: `${action} ${ref}`, outcome: `refused: stale (${r.why})` });
        done('stale', { detail: r.why });
        throw new Refused(`${ref} is stale: ${r.why}. Nothing was done. Here is the page as it is now.`, { stale: true, look: fresh });
      }
      target = r;
      did = `${action} ${ref} "${r.d.label}"`;
    }

    /* The safety refusal: anything that presses, submits or confirms. */
    const pressing = action === 'click' || action === 'check' || (action === 'type' && submit) ||
      (action === 'press' && /^(enter|return|space| )$/i.test(String(key || value || '')));
    if (pressing && target) {
      let formAction = target.d.formAction;
      if (!formAction && (action === 'type' || action === 'press')) {
        formAction = await target.el.evaluate((n) => {
          const f = n.form || n.closest('form');
          try { return f ? new URL(f.getAttribute('action') || '', location.href).href : ''; } catch (e) { return ''; }
        }).catch(() => '');
      }
      const g = gate.check({ label: action === 'click' || action === 'check' ? target.d.label : '', formAction });
      if (g.irreversible && !allow) {
        this.trace(s, { did, outcome: `refused: ${g.why}` });
        done('refused', { detail: `irreversible: ${g.why}` });
        throw new Refused(`refused: ${ref} looks irreversible — ${g.why}. Nothing was pressed. ` +
          'If this is really intended, repeat the call with allow: true.', { irreversible: true, why: g.why });
      }
      if (g.irreversible) note = `allowed irreversible action: ${g.why}`;
    }

    const T = Number(timeout) || 10000;
    try {
      switch (action) {
        case 'click': {
          if (target.d.kind === 'link' && target.d.absHref && /^https?:/i.test(target.d.absHref)) {
            await this.robotsOrRefuse(s, target.d.absHref).catch((e) => {
              throw new Refused(`refused: the link ${ref} leads to ${target.d.absHref}, which robots.txt disallows. Nothing was clicked.`, { robots: true });
            });
          }
          await target.el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await target.el.click({ timeout: T });
          break;
        }
        case 'hover': await target.el.hover({ timeout: T }); break;
        case 'check': await target.el.check({ timeout: T }); break;
        case 'uncheck': await target.el.uncheck({ timeout: T }); break;
        case 'type': {
          if (value == null) throw new Refused("'type' needs a value");
          await target.el.fill(String(value), { timeout: T });
          if (submit) await target.el.press('Enter');
          did += ` = "${/password/.test(target.d.kind) ? '***' : String(value).slice(0, 60)}"${submit ? ' + Enter' : ''}`;
          break;
        }
        case 'select': {
          if (value == null) throw new Refused("'select' needs a value (an option's text or value)");
          const v = String(value);
          await target.el.selectOption({ label: v }, { timeout: T }).catch(() => target.el.selectOption(v, { timeout: T }));
          did += ` = "${v}"`;
          break;
        }
        case 'press': {
          const k = String(key || value || '');
          if (!k) throw new Refused("'press' needs a key, e.g. Enter, Escape, ArrowDown");
          if (target) await target.el.press(k, { timeout: T }); else await page.keyboard.press(k);
          did += ` ${k}`;
          break;
        }
        case 'scroll': {
          if (target) { await target.el.scrollIntoViewIfNeeded({ timeout: T }); break; }
          const dir = String(value || 'down').toLowerCase();
          const dy = { up: -0.85, down: 0.85, top: -1e7, bottom: 1e7 }[dir];
          if (dy == null) throw new Refused("'scroll' needs a ref, or value up, down, top or bottom");
          await page.evaluate((f) => window.scrollBy(0, Math.abs(f) > 100 ? f : innerHeight * f), dy);
          did += ` ${dir}`;
          break;
        }
        case 'wait': {
          const w = value;
          if (w == null || w === '') throw new Refused("'wait' needs a value: text to wait for, a number of ms, or {selector|url|text|ms}");
          const spec = typeof w === 'object' ? w : /^\d+$/.test(String(w)) ? { ms: Number(w) } : { text: String(w) };
          const ms = Number(timeout) || 15000;
          if (spec.ms) await sleep(Math.min(Number(spec.ms), 60000));
          else if (spec.selector) await page.waitForSelector(spec.selector, { timeout: ms, state: 'visible' });
          else if (spec.url) await page.waitForURL((u) => String(u).includes(spec.url), { timeout: ms });
          else if (spec.text) await page.getByText(spec.text).first().waitFor({ timeout: ms });
          else throw new Refused(`'wait' understood none of text, selector, url, ms in ${JSON.stringify(spec)}`);
          did += ` ${JSON.stringify(spec)}`;
          break;
        }
        case 'goto': {
          const u = String(value || '');
          if (!/^https?:\/\//i.test(u)) throw new Refused("'goto' needs an absolute http(s) URL as its value");
          await this.robotsOrRefuse(s, u);
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs });
          did += ` ${u}`;
          break;
        }
        case 'back': await page.goBack({ timeout: T, waitUntil: 'commit' }); break;
        case 'forward': await page.goForward({ timeout: T, waitUntil: 'commit' }); break;
        case 'reload': await page.reload({ timeout: T, waitUntil: 'domcontentloaded' }); break;
        case 'tab': {
          const tabs = s.pages.filter((p) => !p.isClosed());
          const i = Number(value);
          if (!Number.isInteger(i) || !tabs[i]) throw new Refused(`'tab' needs a tab index 0..${tabs.length - 1}`);
          s.page = tabs[i];
          await s.page.bringToFront().catch(() => {});
          await L.reset(s.refState);
          did += ` ${i}`;
          break;
        }
        case 'closetab': {
          if (s.pages.filter((p) => !p.isClosed()).length < 2) throw new Refused('this is the only tab; use close to end the session');
          await page.close();
          s.page = null;
          await L.reset(s.refState);
          break;
        }
        case 'dialog': {
          const dismiss = value === false || value === 'false' || value === 'dismiss';
          s.nextDialog = { accept: !dismiss, text: typeof value === 'string' && !['accept', 'true', 'dismiss', 'false'].includes(value) ? value : undefined };
          did += dismiss ? ' (the next dialog will be dismissed)' : ' (the next dialog will be ACCEPTED)';
          break;
        }
        default: break;
      }
    } catch (e) {
      if (e.refused) {
        this.trace(s, { did, outcome: `refused: ${e.message.replace(/^refused: /, '')}` });
        done('refused', { detail: String(e.message).slice(0, 200) });
        throw e;
      }
      const msg = String(e.message).split('\n')[0].slice(0, 200);
      const refusedNav = s.events.refusedNavigations.length ? s.events.refusedNavigations : null;
      this.trace(s, { did, outcome: `failed: ${msg}` });
      done('error', { detail: msg });
      const fresh = await this.doLook(s).catch(() => null);
      throw new Refused(`${did} failed: ${msg}`, { look: fresh, ...(refusedNav ? { refusedNavigations: refusedNav } : {}) });
    }

    // Let the page settle, then measure what changed.
    if (!['wait', 'dialog', 'hover', 'scroll'].includes(action)) {
      await sleep(300);
      const p = this.current(s);
      if (p && p.url() !== before.url && !['back', 'forward'].includes(action)) {
        await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      } else if (['back', 'forward'].includes(action)) {
        await sleep(300);
      }
    }
    await Promise.all(s.pending.splice(0));
    const now = this.current(s);
    const after = { url: now ? now.url() : null, state: now ? await now.evaluate(stateInPage).catch(() => null) : null, tabs: s.pages.filter((p) => !p.isClosed()).length };
    const delta = {};
    if (after.url !== before.url) delta.url = `${before.url} → ${after.url}`;
    if (after.tabs !== before.tabs) delta.tabs = `${before.tabs} → ${after.tabs}`;
    if (before.state && after.state) {
      for (const k of Object.keys(after.state)) {
        if (after.state[k] !== before.state[k]) delta[k] = `${before.state[k]} → ${after.state[k]}`;
      }
    }
    const events = this.drain(s);
    const changed = Object.keys(delta).length > 0 || Object.keys(events).length > 0;
    if (now) s.url = now.url();

    const out = { session: s.id, did, changed, delta, ...events };
    if (note) out.note = note;
    if (after.url !== before.url) {
      const b = await this.blockedNow(s);
      if (b) out.blocked = { ...b, message: 'the page is a refusal, not content; farr-browser does not work around it' };
    }
    if (!changed && ['click', 'press', 'select', 'check', 'uncheck'].includes(action)) {
      out.warning = 'nothing measurably changed: the control may have no effect, or its effect is not in the page';
    }
    this.trace(s, { did, outcome: changed ? 'changed' : 'no change', delta, ...events });
    done('ok', { detail: note || undefined });
    const refsGone = s.refState.refs.size === 0;
    if (wantLook !== false && now && action !== 'dialog' && (changed || refsGone)) {
      out.look = await this.doLook(s).catch(() => undefined);
    }
    return out;
  }

  /* ----------------------------------------------------------------- shot */
  async shot({ session, marks = false, fullPage = false, ref } = {}) {
    const s = this.must(session);
    const page = this.current(s);
    if (!page) throw new Refused(`session '${s.id}' has no open tab`, { lost: true });
    let drawn = 0;
    if (marks) {
      if (!s.refState.refs.size) await this.doLook(s);
      for (const [name, r] of s.refState.refs) {
        if (!r.d.inView) continue;
        const ok = await r.frame.evaluate(([a, i, label]) => {
          const el = a[i];
          if (!el || !el.isConnected) return false;
          const b = el.getBoundingClientRect();
          if (b.width < 2 || b.height < 2) return false;
          let host = document.getElementById('__farr_browser_marks');
          if (!host) {
            host = document.createElement('div');
            host.id = '__farr_browser_marks';
            host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
            document.documentElement.appendChild(host);
          }
          const box = document.createElement('div');
          box.style.cssText = `position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;` +
            'outline:2px solid #d11;box-sizing:border-box';
          const tag = document.createElement('div');
          tag.textContent = label;
          tag.style.cssText = 'position:absolute;left:0;top:0;transform:translateY(-100%);background:#d11;color:#fff;' +
            'font:bold 11px/13px monospace;padding:0 3px;white-space:nowrap';
          if (b.top < 14) tag.style.transform = 'none';
          box.appendChild(tag);
          host.appendChild(box);
          return true;
        }, [r.arr, r.i, name]).catch(() => false);
        if (ok) drawn++;
      }
    }
    let buf;
    try {
      if (ref) {
        const r = await L.resolve(s.refState, ref);
        if (r.stale) throw new Refused(`${ref} is stale: ${r.why}`, { stale: true });
        buf = await r.el.screenshot({ type: 'jpeg', quality: 75 });
      } else {
        buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: !!fullPage });
      }
    } finally {
      if (marks) {
        for (const f of page.frames()) {
          await f.evaluate(() => { const h = document.getElementById('__farr_browser_marks'); if (h) h.remove(); }).catch(() => {});
        }
      }
    }
    this.trace(s, { did: `shot${marks ? ' with marks' : ''}${fullPage ? ' full page' : ''}`, outcome: `${buf.length} bytes` });
    log.write({ verb: 'shot', session: s.id, url: page.url(), verdict: 'ok' });
    return { session: s.id, url: page.url(), mime: 'image/jpeg', bytes: buf.length, marks: drawn, image: buf.toString('base64') };
  }

  /* ---------------------------------------------------------------- close */
  async close({ session, trace = false, reason = 'closed by caller' } = {}) {
    const s = this.sessions.get(session);
    if (!s) {
      const out = { session, closed: false, note: 'no such live session (already closed?)' };
      if (trace) out.trace = this.traceOf(session);
      return out;
    }
    this.sessions.delete(session);
    this.trace(s, { did: 'close', outcome: reason });
    await s.context.close().catch(() => {});
    log.write({ verb: 'close', session, url: s.url, verdict: 'ok', detail: reason });
    const out = { session, closed: true, steps: s.step, reason };
    if (trace) out.trace = s.trace;
    return out;
  }

  traceOf(id) {
    const f = path.join(this.paths.traces, `${String(id).replace(/[^\w-]/g, '')}.jsonl`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      session: s.id, caller: s.caller, url: s.url, tabs: s.pages.filter((p) => !p.isClosed()).length,
      steps: s.step, age_s: Math.round((Date.now() - s.created) / 1000), idle_s: Math.round((Date.now() - s.lastUsed) / 1000),
      proxy: s.proxy ? s.proxy.country || 'default' : null, lost: s.lost || undefined,
    }));
  }

  /** Close sessions that are lost, idle too long, or too old. */
  async reap() {
    const now = Date.now();
    const closed = [];
    for (const s of [...this.sessions.values()]) {
      let why = null;
      if (s.lost) why = `lost: ${s.lost}`;
      else if (now - s.lastUsed > this.cfg.idleSeconds * 1000) why = `idle for more than ${this.cfg.idleSeconds} s`;
      else if (now - s.created > this.cfg.maxAgeSeconds * 1000) why = `older than ${this.cfg.maxAgeSeconds} s`;
      if (why) { await this.close({ session: s.id, reason: `closed automatically: ${why}` }); closed.push(s.id); }
    }
    return closed;
  }

  async shutdown() {
    for (const id of [...this.sessions.keys()]) await this.close({ session: id, reason: 'daemon stopping' }).catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}

module.exports = { Sessions, ACTIONS };
