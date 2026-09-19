'use strict';
/*
 * End to end: the CLI starts the daemon on first use, a session survives
 * between separate commands, and the MCP server exposes the tools.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const { startServer, tempHome } = require('./helpers');

const home = tempHome();
const BIN = path.join(__dirname, '..', 'bin', 'farr-browser');
const MCP = path.join(__dirname, '..', 'bin', 'farr-browser-mcp');

function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, FARR_BROWSER_HOME: home }, timeout: 120000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => {
  await cli('daemon', 'stop');
  await srv.close();
});

test('CLI: open starts the daemon, the session lives across commands, refusals exit 2', async () => {
  const open = await cli('open', `${srv.base}/shop.html`, '--json');
  assert.equal(open.code, 0, open.stderr);
  const r = JSON.parse(open.stdout);
  const buy = r.look.split('\n').find((l) => l.includes('Buy now')).split(' ')[0];

  const refused = await cli('do', r.session, 'click', buy);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /^refused: e\d+ looks irreversible/);

  const look = await cli('look', r.session);
  assert.equal(look.code, 0);
  assert.match(look.stdout, /^# A product$/m);

  const status = await cli('daemon', 'status', '--json');
  assert.equal(JSON.parse(status.stdout).sessions, 1);

  const close = await cli('close', r.session, '--trace');
  assert.equal(close.code, 0);
  assert.match(close.stdout, /refused/);

  const read = await cli('read', `${srv.base}/table.html`);
  assert.match(read.stdout, /\| alpha \| 1\.5 \|/);
  const robots = await cli('read', `${srv.base}/private/secret.html`);
  assert.equal(robots.code, 2);

  const log = await cli('log', '--json');
  const verbs = JSON.parse(log.stdout).entries.map((e) => e.verb);
  assert.ok(verbs.includes('open') && verbs.includes('do') && verbs.includes('read'));
});

test('MCP: lists the tools and serves read and a live session', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, FARR_BROWSER_HOME: home } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ['close', 'do', 'get', 'health', 'log', 'look', 'open', 'read', 'shot', 'skill', 'skills'].sort());

    const read = await client.callTool({ name: 'read', arguments: { url: `${srv.base}/table.html` } });
    assert.match(read.content[0].text, /\| beta \| 2\.25 \|/);

    const open = await client.callTool({ name: 'open', arguments: { url: `${srv.base}/confirm.html` } });
    const session = /"session": "(s[0-9a-f]+)"/.exec(open.content[0].text)[1];
    const shot = await client.callTool({ name: 'shot', arguments: { session } });
    assert.equal(shot.content[1].type, 'image');
    const stale = await client.callTool({ name: 'do', arguments: { session, action: 'click', ref: 'e999' } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /^REFUSED: e999 is stale/);
    await client.callTool({ name: 'close', arguments: { session } });
  } finally {
    await client.close();
  }
});
