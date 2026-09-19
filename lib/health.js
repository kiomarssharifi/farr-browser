'use strict';
/*
 * Health: measured, not assumed. Each check says ok, warn or fail and why.
 */
const fs = require('fs');
const net = require('net');

const config = require('./config');
const proxies = require('./proxies');
const skills = require('./skills');
const client = require('./client');
const { launch } = require('./browser');

function tcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const end = (ok, why) => { s.destroy(); resolve({ ok, ms: Date.now() - t0, why }); };
    s.setTimeout(timeoutMs, () => end(false, 'timeout'));
    s.once('connect', () => end(true));
    s.once('error', (e) => end(false, e.code || e.message));
  });
}

async function run({ browser = true } = {}) {
  const checks = [];
  const add = (name, state, detail) => checks.push({ check: name, state, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'fail', `Node.js ${process.versions.node}${major >= 18 ? '' : ' (18 or newer is required)'}`);

  let cfg = null;
  try {
    cfg = config.load();
    add('config', 'ok', fs.existsSync(config.paths().config) ? config.paths().config : 'defaults (no config.json)');
  } catch (e) { add('config', 'fail', e.message); }

  try {
    const p = config.ensureHome();
    fs.accessSync(p.home, fs.constants.W_OK);
    add('state directory', 'ok', p.home);
  } catch (e) { add('state directory', 'fail', e.message); }

  if (browser) {
    try {
      const { browser: b, which } = await launch(cfg || config.DEFAULTS);
      const v = b.version();
      await b.close();
      add('browser', 'ok', `${which}, version ${v}`);
    } catch (e) { add('browser', 'fail', e.message); }
  }

  const d = await client.running();
  add('daemon', 'ok', d
    ? `pid ${d.pid}, ${d.sessions}/${d.max} sessions, up ${d.uptime_s} s`
    : 'not running (it starts on the first `open`)');

  if (cfg) {
    let list = [];
    try { list = proxies.validate(cfg.proxies); } catch (e) { add('proxies', 'fail', e.message); }
    if (!list.length) add('proxies', 'ok', 'none configured; requests go direct');
    for (const p of list) {
      const r = await tcp(p.host, p.port);
      add(`proxy ${p.server}${p.country ? ` [${p.country}]` : ''}`, r.ok ? 'ok' : 'fail', r.ok ? `reachable in ${r.ms} ms` : `unreachable: ${r.why}`);
    }
  }

  const sk = skills.list();
  add('skills', sk.invalid.length ? 'warn' : 'ok', `${sk.skills.length} loaded` +
    (sk.invalid.length ? `; ${sk.invalid.length} invalid: ` + sk.invalid.map((x) => `${x.file} (${x.errors[0]})`).join('; ') : ''));

  const worst = checks.some((c) => c.state === 'fail') ? 'fail' : checks.some((c) => c.state === 'warn') ? 'warn' : 'ok';
  return { overall: worst, checks };
}

module.exports = { run };
