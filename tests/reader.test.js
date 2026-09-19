'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { startServer, tempHome } = require('./helpers');

const home = tempHome();
const reader = require('../lib/reader');
const robots = require('../lib/robots');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

test('read: markdown keeps the table and the link', async () => {
  const r = await reader.read(`${srv.base}/table.html`);
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Table page');
  assert.match(r.markdown, /^# Measurements/m);
  assert.match(r.markdown, /\| Name \| Value \|\n\| --- \| --- \|\n\| alpha \| 1\.5 \|\n\| beta \| 2\.25 \|/);
  assert.ok(r.markdown.includes(`[about page](${srv.base}/about.html)`));
  assert.doesNotMatch(r.markdown, /Skip this navigation|not content/);
});

test('read: a path robots.txt disallows is refused, and nothing is fetched', async () => {
  const before = srv.hits.filter((h) => h.includes('/private/')).length;
  await assert.rejects(reader.read(`${srv.base}/private/secret.html`), (e) => e.refused && e.robots && /Disallow: \/private\//.test(e.message));
  assert.equal(srv.hits.filter((h) => h.includes('/private/')).length, before);
});

test('read: a redirect into a disallowed path is refused at the hop', async () => {
  await assert.rejects(reader.read(`${srv.base}/to-private`), (e) => e.robots === true);
  assert.equal(srv.hits.filter((h) => h === 'GET /private/secret.html').length, 0);
});

test('read: a refusal page is reported as blocked, not returned as content', async () => {
  await assert.rejects(reader.read(`${srv.base}/blocked`), (e) => e.refused && e.blocked && e.blocked.status === 503);
});

test('read: when robots.txt cannot be read, the reader refuses', async () => {
  const bad = await startServer({ robotsStatus: 500 });
  try {
    await assert.rejects(reader.read(`${bad.base}/index.html`), (e) => e.robots && /could not be read/.test(e.message));
  } finally { await bad.close(); }
});

test('get: follows a page\'s own PDF link and checks it is a PDF', async () => {
  const out = path.join(home, 'paper.pdf');
  const r = await reader.get(`${srv.base}/paper.html`, { pdf: true, out });
  assert.equal(r.followed, `${srv.base}/paper.pdf`);
  assert.equal(fs.readFileSync(out, 'utf8').slice(0, 5), '%PDF-');
});

test('get: plain download names the file from the server', async () => {
  const cwd = process.cwd();
  process.chdir(home);
  try {
    const r = await reader.get(`${srv.base}/file.txt`);
    assert.equal(path.basename(r.path), 'file.txt');
    assert.equal(fs.readFileSync(r.path, 'utf8'), 'hello file\n');
  } finally { process.chdir(cwd); }
});

test('proxies: a request asking for a country goes through that proxy', async () => {
  // A minimal forward proxy for plain http, counting what passes through it.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // Playwright tunnels through an http proxy with CONNECT, so support that too.
  proxy.on('connect', (req, client, head) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, p] = req.url.split(':');
    const upstream = net.connect(Number(p), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    pacing: { minIntervalMs: 0 }, proxies: [{ server: `http://127.0.0.1:${port}`, country: 'XX' }],
  }));
  robots.clearCache();
  try {
    const r = await reader.read(`${srv.base}/about.html`, { country: 'xx' });
    assert.match(r.markdown, /about page/);
    const target = new URL(srv.base).host;
    assert.ok(seen.some((u) => u.endsWith('/about.html') || u === `CONNECT ${target}`), `proxy saw: ${seen.join(', ')}`);
    await assert.rejects(reader.read(`${srv.base}/about.html`, { country: 'YY' }), /no proxy is tagged with country YY/);
  } finally {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ pacing: { minIntervalMs: 0 } }));
    proxy.closeAllConnections && proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  }
});

test('log: every read is recorded', () => {
  const lines = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.verb === 'read' && l.verdict === 'refused'));
  assert.ok(lines.some((l) => l.verb === 'read' && l.verdict === 'blocked'));
  assert.ok(lines.some((l) => l.verb === 'get' && l.verdict === 'ok'));
});
