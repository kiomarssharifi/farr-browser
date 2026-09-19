'use strict';
/*
 * The daemon: one process that holds the browser and every live session, so a
 * page stays open between an agent's calls. It listens on a local socket in the
 * state directory (never on a network port) and speaks one JSON request per
 * HTTP POST: {"method": "open", "params": {...}}.
 */
const fs = require('fs');
const http = require('http');

const config = require('./config');
const { Sessions } = require('./sessions');
const { toWire, Refused } = require('./errors');

async function serve({ quiet = false } = {}) {
  const cfg = config.load();
  const p = config.ensureHome();
  const say = (m) => { if (!quiet) process.stdout.write(`${new Date().toISOString()} ${m}\n`); };
  const mgr = new Sessions(cfg);

  if (process.platform !== 'win32' && fs.existsSync(p.socket)) {
    // A socket file left by a crashed daemon: remove it only if nothing answers on it.
    const alive = await new Promise((resolve) => {
      const req = http.request({ socketPath: p.socket, path: '/', method: 'POST' }, () => resolve(true));
      req.on('error', () => resolve(false));
      req.end('{"method":"ping"}');
    });
    if (alive) throw new Error(`a daemon is already running on ${p.socket}`);
    fs.unlinkSync(p.socket);
  }

  let server;
  const stop = async (why) => {
    say(`stopping: ${why}`);
    clearInterval(reaper);
    await mgr.shutdown();
    server.close();
    try { if (process.platform !== 'win32') fs.unlinkSync(p.socket); } catch (e) { /* gone */ }
  };

  const METHODS = {
    open: (a) => mgr.open(a),
    look: (a) => mgr.look(a),
    do: (a) => mgr.act(a),
    shot: (a) => mgr.shot(a),
    close: (a) => mgr.close(a),
    sessions: async () => ({ sessions: mgr.list(), max: cfg.maxSessions, idleSeconds: cfg.idleSeconds }),
    trace: async ({ session }) => ({ session, trace: mgr.sessions.has(session) ? mgr.sessions.get(session).trace : mgr.traceOf(session) }),
    ping: async () => ({ pid: process.pid, sessions: mgr.sessions.size, max: cfg.maxSessions, browser: mgr.browserWhich, uptime_s: Math.round(process.uptime()) }),
    shutdown: async () => { setTimeout(() => stop('shutdown requested').then(() => process.exit(0)), 50); return { stopping: true }; },
  };

  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let out;
      let method = '?';
      try {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        method = msg.method;
        const fn = METHODS[method];
        if (!fn) throw new Refused(`unknown method '${method}'`);
        out = { ok: true, ...(await fn(msg.params || {})) };
      } catch (e) {
        out = toWire(e);
        if (!e.refused) say(`error in ${method}: ${e.stack || e.message}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  const reaper = setInterval(() => {
    mgr.reap().then((closed) => { if (closed.length) say(`closed idle sessions: ${closed.join(', ')}`); }).catch(() => {});
  }, 15000);
  reaper.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p.socket, resolve);
  });
  if (process.platform !== 'win32') fs.chmodSync(p.socket, 0o600);
  say(`farr-browser daemon listening on ${p.socket} (up to ${cfg.maxSessions} sessions, idle close after ${cfg.idleSeconds} s)`);

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig).then(() => process.exit(0)));
  return { server, mgr, stop };
}

module.exports = { serve };
