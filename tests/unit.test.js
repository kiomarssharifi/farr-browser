'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempHome } = require('./helpers');

tempHome();
const robots = require('../lib/robots');
const gate = require('../lib/gate');
const markdown = require('../lib/markdown');
const proxies = require('../lib/proxies');
const pacing = require('../lib/pacing');
const skills = require('../lib/skills');
const blocked = require('../lib/blocked');

test('robots: longest rule wins, Allow wins ties, wildcards and anchors', () => {
  const p = robots.parse([
    'User-agent: *', 'Disallow: /private/', 'Allow: /private/open', 'Disallow: /*.pdf$', 'Crawl-delay: 2',
    '', 'User-agent: farr-browser', 'Disallow: /only-for-us/',
  ].join('\n'));
  // the specific group applies to us, not "*"
  assert.equal(robots.check(p, '/only-for-us/x').allowed, false);
  assert.equal(robots.check(p, '/private/x').allowed, true);
  const star = robots.parse('User-agent: *\nDisallow: /private/\nAllow: /private/open\nDisallow: /*.pdf$\n');
  assert.equal(robots.check(star, '/private/x').allowed, false);
  assert.equal(robots.check(star, '/private/open/1').allowed, true);
  assert.equal(robots.check(star, '/a/b.pdf').allowed, false);
  assert.equal(robots.check(star, '/a/b.pdf?x=1').allowed, true);
  assert.equal(robots.check(star, '/').allowed, true);
});

test('robots: an unreadable robots.txt refuses, a missing one allows', async () => {
  robots.clearCache();
  const down = async () => { throw new Error('connection reset'); };
  const r1 = await robots.allows('http://unreadable.test/page', { fetchImpl: down });
  assert.equal(r1.allowed, false);
  assert.match(r1.why, /could not be read/);
  robots.clearCache();
  const r5 = await robots.allows('http://five.test/page', { fetchImpl: async () => ({ status: 503, headers: {}, body: Buffer.from('') }) });
  assert.equal(r5.allowed, false);
  const r4 = await robots.allows('http://none.test/page', { fetchImpl: async () => ({ status: 404, headers: {}, body: Buffer.from('') }) });
  assert.equal(r4.allowed, true);
});

test('gate: irreversible labels and form actions are caught, ordinary ones are not', () => {
  for (const label of ['Buy now', 'Place order', 'Pay', 'Delete account', 'Send', 'Transfer funds', 'Place bid',
    'Cancel subscription', 'Jetzt kaufen', 'Supprimer']) {
    assert.equal(gate.check({ label }).irreversible, true, label);
  }
  for (const label of ['Search', 'Next page', 'Sender details', 'Payload', 'Show details', 'Cancel', 'About']) {
    assert.equal(gate.check({ label }).irreversible, false, label);
  }
  assert.equal(gate.check({ label: 'Continue', formAction: 'https://shop.test/checkout' }).irreversible, true);
  assert.equal(gate.check({ label: 'Continue', formAction: 'https://shop.test/search' }).irreversible, false);
});

test('markdown: keeps headings, links, tables; drops scripts and navigation', () => {
  const html = '<nav><a href="/x">menu</a></nav><h1>Title</h1><p>See <a href="/about">about</a>.</p>' +
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>var x="<p>no</p>"</script>';
  const md = markdown.fromHtml(html, { base: 'https://site.test/page' });
  assert.match(md, /^# Title/m);
  assert.match(md, /\[about\]\(https:\/\/site\.test\/about\)/);
  assert.match(md, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.doesNotMatch(md, /menu|no</);
});

test('proxies: country tags, defaults, and refusal when none match', () => {
  const list = [{ server: 'http://127.0.0.1:1' }, { server: 'socks5://127.0.0.1:2', country: 'de' }, { server: 'http://127.0.0.1:3', default: true }];
  assert.equal(proxies.pick(list, { country: 'DE' }).server, 'socks5://127.0.0.1:2');
  assert.equal(proxies.pick(list, {}).server, 'http://127.0.0.1:3');
  assert.equal(proxies.pick([], {}), null);
  assert.throws(() => proxies.pick(list, { country: 'FR' }), /no proxy is tagged with country FR/);
  assert.throws(() => proxies.validate([{ server: 'ftp://x' }]), /must start with/);
});

test('pacing: the interval is the larger of config and Crawl-delay', () => {
  const cfg = { pacing: { minIntervalMs: 1000, sites: { 'slow.test': 5000 } } };
  assert.equal(pacing.intervalFor('a.test', cfg, null), 1000);
  assert.equal(pacing.intervalFor('a.test', cfg, 3), 3000);
  assert.equal(pacing.intervalFor('slow.test', cfg, 1), 5000);
});

test('pacing: two requests to one host are spaced', async () => {
  const cfg = { pacing: { minIntervalMs: 200, sites: {} } };
  const t0 = Date.now();
  await pacing.wait('spaced.test', { cfg });
  await pacing.wait('spaced.test', { cfg });
  assert.ok(Date.now() - t0 >= 190);
});

test('blocked: refusal statuses and check pages are recognised', () => {
  assert.ok(blocked.classify({ status: 403 }));
  assert.ok(blocked.classify({ status: 200, title: 'Just a moment...' }));
  assert.equal(blocked.classify({ status: 200, title: 'Welcome' }), null);
});

test('skills: validation, URL building and typing', () => {
  const good = { id: 'demo', domains: ['site.test'], intents: { list: { url: 'https://site.test/{q}', format: 'json', input: { q: { required: true } }, fields: { a: {} } } } };
  assert.deepEqual(skills.validate(good), []);
  assert.ok(skills.validate({ id: 'Bad Id', domains: [], intents: {} }).length >= 3);
  assert.equal(skills.buildUrl({ url: 'https://w.test/wiki/{t}', input: { t: { spaces: '_' } } }, { t: 'Ada Lovelace' }), 'https://w.test/wiki/Ada_Lovelace');
  assert.throws(() => skills.buildUrl(good.intents.list, {}), /missing argument "q"/);
  assert.throws(() => skills.buildUrl(good.intents.list, { q: 1, nope: 2 }), /unknown argument/);
  assert.equal(skills.coerce('£1,234.50', 'number'), 1234.5);
  assert.equal(skills.coerce('/b/1', 'url', 'https://s.test/list'), 'https://s.test/b/1');
  const { skills: all, invalid } = skills.loadAll();
  assert.deepEqual(invalid, []);
  assert.ok(all.has('wikipedia') && all.has('books-toscrape'));
});
