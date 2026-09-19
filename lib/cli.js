'use strict';
/*
 * The command line. Exit codes: 0 done, 1 error, 2 refused (a deliberate no:
 * robots.txt, the safety refusal, a stale ref, a blocked page, the session cap).
 */
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const client = require('./client');
const reader = require('./reader');
const skills = require('./skills');
const health = require('./health');
const log = require('./log');
const { ACTIONS } = require('./sessions');

const HELP = `farr-browser ${pkg.version} — a polite browser for AI agents

Setup:
  farr-browser install-browser [--with-deps]   download the browser this version was built for

Live sessions (a background daemon keeps the page open between calls):
  farr-browser open <url> [--country XX]
  farr-browser look <session> [--filter TEXT] [--limit N] [--text]
  farr-browser do <session> <action> [ref] [value] [--allow] [--submit] [--key K]
      actions: ${ACTIONS.join(', ')}
      e.g.  do s1a2b3 click e4
            do s1a2b3 type e7 "hello" --submit
            do s1a2b3 goto https://example.org/
            do s1a2b3 dialog accept
  farr-browser shot <session> [--marks] [--full] [--ref eN] [--out FILE]
  farr-browser close <session> [--trace]
  farr-browser sessions | trace <session>

One-shot:
  farr-browser read <url> [--country XX] [--max-chars N] [--browser]
  farr-browser get <url> [--pdf] [--out FILE] [--country XX]
  farr-browser skills
  farr-browser skill <id> <intent> [name=value ...]

Operate:
  farr-browser daemon [stop|status]
  farr-browser health
  farr-browser log [--n N]

Add --json to any command for machine-readable output.
Exit codes: 0 done, 1 error, 2 refused.
`;

const REF_FREE = new Set(['wait', 'goto', 'back', 'forward', 'reload', 'tab', 'closetab', 'dialog']);
const BOOL = new Set(['json', 'allow', 'submit', 'marks', 'full', 'trace', 'text', 'pdf', 'browser', 'help', 'in-view']);

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

function print(obj, flags) {
  if (flags.json) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); return; }
  const { look, ...rest } = obj;
  const lines = [];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  if (look) process.stdout.write('\n' + look + '\n');
}

async function main(argv) {
  const { pos, flags } = parse(argv);
  const cmd = pos[0];
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(HELP); return 0; }
  if (cmd === '--version' || cmd === 'version') { process.stdout.write(pkg.version + '\n'); return 0; }
  const need = (n, what) => { if (pos.length <= n) throw new Error(`${cmd} needs ${what}. See farr-browser --help`); return pos[n]; };

  try {
    switch (cmd) {
      case 'install-browser': {
        // Use the Playwright bundled with this package, never a separately fetched one:
        // `npx playwright install` can pull a newer Playwright whose browser build does not match.
        const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
        const args = [cli, 'install', 'chromium'];
        if (flags['with-deps']) args.push('--with-deps');
        const r = require('child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
        return r.status === null ? 1 : r.status;
      }
      case 'daemon': {
        if (pos[1] === 'stop') { const r = await client.running() ? await client.call('shutdown', {}, { autostart: false }) : { note: 'not running' }; print(r, flags); return 0; }
        if (pos[1] === 'status') { const r = await client.running(); print(r ? { running: true, ...r } : { running: false }, flags); return r ? 0 : 1; }
        await require('./daemon').serve();
        return new Promise(() => {}); // run until signalled
      }
      case 'open': print(await client.call('open', { url: need(1, 'a URL'), country: flags.country, caller: 'cli' }), flags); return 0;
      case 'look': print(await client.call('look', { session: need(1, 'a session id'), filter: flags.filter, limit: flags.limit, inViewOnly: !!flags['in-view'], text: !!flags.text }), flags); return 0;
      case 'do': {
        const session = need(1, 'a session id');
        const action = need(2, 'an action');
        const p = { session, action, allow: !!flags.allow, submit: !!flags.submit, key: flags.key, timeout: flags.timeout };
        if (REF_FREE.has(action) || ((action === 'press' || action === 'scroll') && !/^e\d+$/.test(pos[3] || ''))) {
          p.value = flags.value !== undefined ? flags.value : pos[3];
        } else {
          p.ref = pos[3];
          p.value = flags.value !== undefined ? flags.value : pos[4];
        }
        print(await client.call('do', p), flags);
        return 0;
      }
      case 'shot': {
        const session = need(1, 'a session id');
        const r = await client.call('shot', { session, marks: !!flags.marks, fullPage: !!flags.full, ref: flags.ref });
        const out = path.resolve(flags.out || `shot-${session}.jpg`);
        fs.writeFileSync(out, Buffer.from(r.image, 'base64'));
        delete r.image;
        print({ ...r, saved: out }, flags);
        return 0;
      }
      case 'close': {
        const r = await client.call('close', { session: need(1, 'a session id'), trace: !!flags.trace });
        if (!flags.json && r.trace) {
          const { trace, ...rest } = r;
          print(rest, flags);
          for (const t of trace) process.stdout.write(`${t.step}. ${t.ts} ${t.did} -> ${t.outcome}\n`);
          return 0;
        }
        print(r, flags);
        return 0;
      }
      case 'sessions': print(await client.call('sessions'), { ...flags, json: true }); return 0;
      case 'trace': print(await client.call('trace', { session: need(1, 'a session id') }), { ...flags, json: true }); return 0;
      case 'read': {
        const r = await reader.read(need(1, 'a URL'), { country: flags.country, maxChars: Number(flags['max-chars']) || undefined, browser: !!flags.browser });
        if (flags.json) print(r, flags);
        else process.stdout.write(r.markdown + '\n');
        return 0;
      }
      case 'get': print(await reader.get(need(1, 'a URL'), { out: flags.out, pdf: !!flags.pdf, country: flags.country }), flags); return 0;
      case 'skills': {
        const r = skills.list();
        if (flags.json) { print(r, flags); return 0; }
        for (const s of r.skills) {
          process.stdout.write(`${s.id} — ${s.description}\n`);
          for (const [n, it] of Object.entries(s.intents)) {
            process.stdout.write(`  ${n}(${Object.keys(it.input).join(', ')}) -> ${it.fields.join(', ')}: ${it.description}\n`);
          }
        }
        for (const x of r.invalid) process.stdout.write(`invalid: ${x.file}: ${x.errors.join('; ')}\n`);
        return 0;
      }
      case 'skill': {
        const args = {};
        for (const kv of pos.slice(3)) {
          const i = kv.indexOf('=');
          if (i < 1) throw new Error(`arguments are name=value, got "${kv}"`);
          args[kv.slice(0, i)] = kv.slice(i + 1);
        }
        if (flags.country) args.country = flags.country;
        const r = await skills.run(need(1, 'a skill id'), need(2, 'an intent'), args);
        print(r, { ...flags, json: true });
        return 0;
      }
      case 'health': {
        const r = await health.run();
        if (flags.json) print(r, flags);
        else {
          for (const c of r.checks) process.stdout.write(`${c.state.padEnd(4)} ${c.check}: ${c.detail}\n`);
          process.stdout.write(`overall: ${r.overall}\n`);
        }
        return r.overall === 'fail' ? 1 : 0;
      }
      case 'log': {
        const rows = log.tail(Number(flags.n) || 30);
        if (flags.json) print({ entries: rows }, flags);
        else for (const e of rows) process.stdout.write(`${e.ts} ${e.verb} ${e.verdict} ${e.url || e.session || e.skill || ''} ${e.ms != null ? e.ms + 'ms' : ''} ${e.detail || ''}\n`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    if (e.refused) {
      process.stderr.write(`refused: ${e.message.replace(/^refused: /, '')}\n`);
      if (e.look) process.stderr.write('\n' + e.look + '\n');
      return 2;
    }
    throw e;
  }
}

module.exports = { main, parse };
