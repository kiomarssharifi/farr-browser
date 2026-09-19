'use strict';
/*
 * Test helpers: a local HTTP server over tests/fixtures (no internet is used by
 * any test), and a throwaway state directory for farr-browser.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FIX = path.join(__dirname, 'fixtures');

function page(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

/**
 * Start the fixture server. `robots` replaces the robots.txt body; pass
 * { robotsStatus: 500 } to make robots.txt unreadable.
 */
function startServer({ robots = 'User-agent: *\nDisallow: /private/\n', robotsStatus = 200 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(`${req.method} ${u.pathname}`);
    const file = (name) => page(res, 200, fs.readFileSync(path.join(FIX, name), 'utf8'));
    switch (u.pathname) {
      case '/robots.txt':
        res.writeHead(robotsStatus, { 'content-type': 'text/plain' });
        return res.end(robotsStatus === 200 ? robots : 'error');
      case '/':
      case '/index.html': return file('index.html');
      case '/about.html': return file('about.html');
      case '/shop.html': return file('shop.html');
      case '/change.html': return file('change.html');
      case '/confirm.html': return file('confirm.html');
      case '/table.html': return file('table.html');
      case '/tabs.html': return file('tabs.html');
      case '/paper.html': return file('paper.html');
      case '/books.html': return file('books.html');
      case '/private/secret.html': return file('private-secret.html');
      case '/search':
        return page(res, 200, `<!doctype html><title>Results</title><h1>Results for ${String(u.searchParams.get('q')).replace(/[<>&]/g, '')}</h1>`);
      case '/checkout':
        return page(res, 200, '<!doctype html><title>Order received</title><h1>Order received</h1>');
      case '/file.txt':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' });
        return res.end('hello file\n');
      case '/paper.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.4\n% a tiny test file\n%%EOF\n');
      case '/blocked':
        return page(res, 503, '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>');
      case '/to-private':
        res.writeHead(302, { location: '/private/secret.html' });
        return res.end();
      case '/data.json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ meta: { n: 3 }, items: [
          { name: 'one', size: '10', link: '/x/1' }, { name: 'two', size: '20.5', link: '/x/2' }, { name: null, size: '1' },
        ] }));
      default:
        return page(res, 404, '<!doctype html><title>Not found</title><p>not found</p>');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, hits, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) });
  }));
}

/** A fresh state directory, with pacing off so tests are fast. */
function tempHome(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
  const cfg = { pacing: { minIntervalMs: 0 }, ...extra };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  process.env.FARR_BROWSER_HOME = home;
  return home;
}

module.exports = { startServer, tempHome, FIX };
