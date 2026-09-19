'use strict';
/*
 * Live sessions against local fixture pages. Needs a browser: Playwright's
 * Chromium (`npx playwright install chromium`) or an installed Chrome.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, tempHome } = require('./helpers');

tempHome({ maxSessions: 3, idleSeconds: 1 });
const { Sessions } = require('../lib/sessions');
const config = require('../lib/config');

let srv;
let mgr;
test.before(async () => { srv = await startServer(); mgr = new Sessions(config.load()); });
test.after(async () => { await mgr.shutdown(); await srv.close(); });

/** The ref printed on the look line that contains `text`. */
function refOf(look, text) {
  const line = look.split('\n').find((l) => /^e\d+ /.test(l) && l.includes(text));
  assert.ok(line, `no line containing "${text}" in:\n${look}`);
  return line.split(' ')[0];
}

test('open returns a session and a look with refs for the link and the form', async () => {
  const r = await mgr.open({ url: `${srv.base}/index.html` });
  assert.match(r.session, /^s[0-9a-f]{6}$/);
  assert.match(r.look, /^# Fixture home$/m);
  assert.match(r.look, /^e\d+ link "About page" → \/about\.html$/m);
  assert.match(r.look, /^e\d+ input:text "Query"$/m);
  assert.match(r.look, /^e\d+ button "Search"$/m);

  const typed = await mgr.act({ session: r.session, action: 'type', ref: refOf(r.look, 'Query'), value: 'hello', submit: true });
  assert.equal(typed.changed, true);
  assert.match(typed.delta.url, /\/search\?q=hello$/);
  assert.match(typed.look, /^# Results for hello$/m);

  const back = await mgr.act({ session: r.session, action: 'back' });
  assert.match(back.delta.url, /index\.html$/);
  const went = await mgr.act({ session: r.session, action: 'goto', value: `${srv.base}/about.html` });
  assert.match(went.look, /^# About$/m);
  await mgr.close({ session: r.session });
});

test('"Buy now" is refused without allow and pressed with it', async () => {
  const r = await mgr.open({ url: `${srv.base}/shop.html` });
  const buy = refOf(r.look, 'Buy now');
  await assert.rejects(mgr.act({ session: r.session, action: 'click', ref: buy }),
    (e) => e.refused && e.irreversible && /label says "buy now"/i.test(e.message));
  const page = mgr.sessions.get(r.session).page;
  assert.equal(await page.textContent('#status'), 'idle');

  // an ordinary button is not affected
  const ok = await mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'Show details') });
  assert.equal(ok.changed, true);

  const done = await mgr.act({ session: r.session, action: 'click', ref: buy, allow: true });
  assert.match(done.note, /allowed irreversible action/);
  assert.equal(await page.textContent('#status'), 'bought');
  await mgr.close({ session: r.session });
});

test('a harmless label on a form posting to /checkout is refused by its URL, allowed with allow', async () => {
  const r = await mgr.open({ url: `${srv.base}/shop.html` });
  const cont = refOf(r.look, 'Continue');
  await assert.rejects(mgr.act({ session: r.session, action: 'click', ref: cont }),
    (e) => e.irreversible && /submits a form to .*\/checkout/.test(e.message));
  assert.equal(srv.hits.filter((h) => h === 'POST /checkout').length, 0);
  const done = await mgr.act({ session: r.session, action: 'click', ref: cont, allow: true });
  assert.match(done.delta.url, /\/checkout$/);
  assert.equal(srv.hits.filter((h) => h === 'POST /checkout').length, 1);
  await mgr.close({ session: r.session });
});

test('after the page changes, the old ref is refused and a fresh look comes back', async () => {
  const r = await mgr.open({ url: `${srv.base}/change.html` });
  const old = refOf(r.look, 'Old item');
  const replace = refOf(r.look, 'Replace list');
  const changed = await mgr.act({ session: r.session, action: 'click', ref: replace });
  assert.equal(changed.changed, true);
  assert.match(changed.look, /New item/);
  // the button survived the change and keeps its ref
  assert.equal(refOf(changed.look, 'Replace list'), replace);
  const before = mgr.sessions.get(r.session).page.url();
  await assert.rejects(mgr.act({ session: r.session, action: 'click', ref: old }),
    (e) => e.stale && /Nothing was done/.test(e.message) && /New item/.test(e.look));
  assert.equal(mgr.sessions.get(r.session).page.url(), before);

  // and after a navigation, every old ref is refused
  const nav = await mgr.act({ session: r.session, action: 'click', ref: refOf(changed.look, 'New item') });
  assert.match(nav.delta.url, /about\.html$/);
  await assert.rejects(mgr.act({ session: r.session, action: 'click', ref: replace }), (e) => e.stale === true);
  await mgr.close({ session: r.session });
});

test('confirm() is dismissed by default and accepted only when armed', async () => {
  const r = await mgr.open({ url: `${srv.base}/confirm.html` });
  const ask = refOf(r.look, 'Ask me');
  const page = mgr.sessions.get(r.session).page;
  const first = await mgr.act({ session: r.session, action: 'click', ref: ask });
  assert.deepEqual(first.dialogs, [{ type: 'confirm', message: 'Are you sure?', answered: 'dismissed' }]);
  assert.equal(await page.textContent('#out'), 'answered no');
  await mgr.act({ session: r.session, action: 'dialog', value: 'accept' });
  const second = await mgr.act({ session: r.session, action: 'click', ref: ask });
  assert.equal(second.dialogs[0].answered, 'accepted');
  assert.equal(await page.textContent('#out'), 'answered yes');
  // arming is for one dialog only
  const third = await mgr.act({ session: r.session, action: 'click', ref: ask });
  assert.equal(third.dialogs[0].answered, 'dismissed');
  await mgr.close({ session: r.session });
});

test('robots.txt binds sessions: open, goto and a clicked link to a disallowed path are refused', async () => {
  await assert.rejects(mgr.open({ url: `${srv.base}/private/secret.html` }), (e) => e.robots === true);
  const r = await mgr.open({ url: `${srv.base}/tabs.html` });
  await assert.rejects(mgr.act({ session: r.session, action: 'goto', value: `${srv.base}/private/secret.html` }), (e) => e.robots === true);
  await assert.rejects(mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'Private area') }),
    (e) => e.robots === true && /Nothing was clicked/.test(e.message));
  // a navigation started by the page's own script is stopped too, and reported
  const scripted = await mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'Go by script') });
  assert.equal(scripted.refusedNavigations.length, 1);
  assert.match(scripted.refusedNavigations[0].why, /Disallow: \/private\//);
  assert.equal(srv.hits.filter((h) => h.includes('/private/')).length, 0);
  await mgr.close({ session: r.session });
});

test('new tabs and downloads are reported', async () => {
  const r = await mgr.open({ url: `${srv.base}/tabs.html` });
  const tab = await mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'new tab') });
  assert.ok(tab.tabs && tab.tabs.length === 1, JSON.stringify(tab));
  assert.equal(tab.delta.tabs, '1 → 2');
  assert.match(tab.look, /^# About$/m);
  assert.match(tab.look, /tabs: 0:.*\*1:/);
  await mgr.act({ session: r.session, action: 'tab', value: 0 });
  const look = await mgr.look({ session: r.session });
  const dl = await mgr.act({ session: r.session, action: 'click', ref: refOf(look.look, 'Download the file') });
  assert.equal(dl.downloads.length, 1);
  assert.equal(dl.downloads[0].name, 'file.txt');
  assert.equal(fs.readFileSync(dl.downloads[0].path, 'utf8'), 'hello file\n');
  await mgr.close({ session: r.session });
});

test('shot returns a JPEG, with refs drawn when asked', async () => {
  const r = await mgr.open({ url: `${srv.base}/index.html` });
  const s = await mgr.shot({ session: r.session, marks: true });
  const buf = Buffer.from(s.image, 'base64');
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  assert.ok(s.marks >= 3);
  // the overlay is gone afterwards
  assert.equal(await mgr.sessions.get(r.session).page.$('#__farr_browser_marks'), null);
  await mgr.close({ session: r.session });
});

test('close with trace lists every step, including refusals, and survives the close', async () => {
  const r = await mgr.open({ url: `${srv.base}/shop.html` });
  await mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'Buy now') }).catch(() => {});
  await mgr.act({ session: r.session, action: 'click', ref: refOf(r.look, 'Show details') });
  const c = await mgr.close({ session: r.session, trace: true });
  assert.equal(c.closed, true);
  const did = c.trace.map((t) => `${t.did} -> ${t.outcome}`);
  assert.match(did[0], /^open /);
  assert.ok(did.some((d) => /Buy now.*refused/.test(d)), did.join('\n'));
  assert.ok(did.some((d) => /Show details.*changed/.test(d)), did.join('\n'));
  const again = await mgr.close({ session: r.session, trace: true });
  assert.equal(again.closed, false);
  assert.equal(again.trace.length, c.trace.length);
});

test('the session cap refuses an extra session; idle sessions are closed', async () => {
  const a = await mgr.open({ url: `${srv.base}/about.html` });
  const b = await mgr.open({ url: `${srv.base}/about.html` });
  const c = await mgr.open({ url: `${srv.base}/about.html` });
  await assert.rejects(mgr.open({ url: `${srv.base}/about.html` }), (e) => e.capped === true);
  await new Promise((res) => setTimeout(res, 1200));
  const closed = await mgr.reap();
  assert.deepEqual(closed.sort(), [a.session, b.session, c.session].sort());
  await assert.rejects(mgr.look({ session: a.session }), (e) => e.lost === true);
});
