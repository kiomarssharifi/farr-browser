'use strict';
/*
 * Talking to the daemon. If it is not running, it is started in the background
 * (its output goes to daemon.log in the state directory) and the call is retried.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const { Refused } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(method, params = {}, { timeoutMs = 180000 } = {}) {
  const { socket } = config.paths();
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`the daemon did not answer within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end(JSON.stringify({ method, params }));
  });
}

function notRunning(e) {
  return e && ['ENOENT', 'ECONNREFUSED'].includes(e.code);
}

async function running() {
  try { const r = await post('ping', {}, { timeoutMs: 3000 }); return r.ok ? r : null; } catch (e) { return null; }
}

function startDaemon() {
  const p = config.ensureHome();
  const out = fs.openSync(p.daemonLog, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'farr-browser'), 'daemon'], {
    detached: true, stdio: ['ignore', out, out], env: process.env,
  });
  child.unref();
}

/**
 * Call a daemon method. Returns the result on success; throws a Refused carrying
 * the daemon's fields when the daemon said no.
 */
async function call(method, params = {}, { autostart = true } = {}) {
  let r;
  try {
    r = await post(method, params);
  } catch (e) {
    if (!notRunning(e) || !autostart) throw e;
    startDaemon();
    const until = Date.now() + 20000;
    for (;;) {
      await sleep(250);
      if (await running()) break;
      if (Date.now() > until) throw new Error(`the daemon did not start; see ${config.paths().daemonLog}`);
    }
    r = await post(method, params);
  }
  if (!r.ok) {
    const { ok, error, ...extra } = r; // eslint-disable-line no-unused-vars
    throw new Refused(error, extra);
  }
  delete r.ok;
  return r;
}

module.exports = { call, running, post };
