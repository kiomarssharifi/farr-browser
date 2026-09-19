'use strict';
/*
 * farr-browser as an MCP server (stdio). Live-session tools go to the daemon,
 * which is started on first use; read, get and skills run in this process.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const pkg = require('../package.json');
const client = require('./client');
const reader = require('./reader');
const skills = require('./skills');
const health = require('./health');
const log = require('./log');
const { ACTIONS } = require('./sessions');

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });

const TOOLS = [
  {
    name: 'open',
    description: 'Open a live browser session on a URL. Returns a session id and a look: one line per actionable element, each with a ref (e12 link "Pricing" → /pricing). robots.txt is honoured; a refusal page is reported as blocked.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: str('absolute http(s) URL'), country: str('optional: use one of your proxies tagged with this country code') } },
  },
  {
    name: 'look',
    description: 'The page as it is now, as a look. Refs that survive keep their names; refs to elements that are gone are refused if used.',
    inputSchema: { type: 'object', required: ['session'], properties: {
      session: str('session id from open'), filter: str('only lines whose label or link contains this'),
      limit: num('maximum actionable lines (default 150)'), inViewOnly: bool('only what is on screen'),
      text: bool('also append the page text as markdown'),
    } },
  },
  {
    name: 'do',
    description: `Act on the page: ${ACTIONS.join(', ')}. Returns what measurably changed and the next look. A stale ref is refused and never clicked. A control that buys, pays, orders, bids, deletes, sends, transfers or cancels is refused unless allow is true. confirm() dialogs are dismissed unless you first call action "dialog" with value "accept".`,
    inputSchema: { type: 'object', required: ['session', 'action'], properties: {
      session: str('session id'), action: { type: 'string', enum: ACTIONS },
      ref: str('element ref from the last look, e.g. e12'),
      value: { description: 'text to type, option to select, URL for goto, tab index, key, wait target (text, ms, or {selector|url|text|ms}), scroll direction, or accept/dismiss for dialog' },
      key: str('key for press, e.g. Enter'), submit: bool('for type: press Enter afterwards'),
      allow: bool('permit a control that looks irreversible; only when the user has asked for exactly this'),
      timeout: num('ms'),
    } },
  },
  {
    name: 'shot',
    description: 'Screenshot of the current page (JPEG). With marks, the refs from the last look are drawn on it. Costs far more tokens than a look; look first.',
    inputSchema: { type: 'object', required: ['session'], properties: { session: str('session id'), marks: bool('draw refs'), fullPage: bool('whole page, not just the viewport'), ref: str('screenshot only this element') } },
  },
  {
    name: 'close',
    description: 'Close a live session. With trace, returns every step it took (also works after the session closed on its own).',
    inputSchema: { type: 'object', required: ['session'], properties: { session: str('session id'), trace: bool('return the trace') } },
  },
  {
    name: 'read',
    description: 'Read a URL once and return it as markdown (links, tables and headings kept). robots.txt and pacing apply.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: str('absolute http(s) URL'), country: str('optional proxy country'), maxChars: num('default 20000'), browser: bool('render with the browser first (for pages that need JavaScript)') } },
  },
  {
    name: 'get',
    description: 'Download a URL to a file. With pdf, an HTML page\'s own PDF link is followed and the result must be a PDF.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: str('absolute http(s) URL'), out: str('file path to write'), pdf: bool('follow the page\'s PDF link'), country: str('optional proxy country') } },
  },
  {
    name: 'skills',
    description: 'List the site skills, their intents and each intent\'s argument names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill',
    description: 'Run one intent of a site skill and get typed rows. Call skills first for the argument names.',
    inputSchema: { type: 'object', required: ['id', 'intent'], properties: { id: str('skill id'), intent: str('intent name'), args: { type: 'object', description: 'the intent\'s arguments' } } },
  },
  {
    name: 'health',
    description: 'Measured health: Node, config, browser, daemon, proxies, skills.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'log',
    description: 'The most recent operations from the run log.',
    inputSchema: { type: 'object', properties: { n: num('how many lines (default 30)') } },
  },
];

function asText(obj) {
  const { look, ...rest } = obj;
  const parts = [JSON.stringify(rest, null, 1)];
  if (look) parts.push(look);
  return parts.join('\n\n');
}

async function handle(name, a = {}) {
  switch (name) {
    case 'open': return client.call('open', { url: a.url, country: a.country, caller: 'mcp' });
    case 'look': return client.call('look', a);
    case 'do': return client.call('do', a);
    case 'shot': return client.call('shot', a);
    case 'close': return client.call('close', a);
    case 'read': return reader.read(a.url, a);
    case 'get': return reader.get(a.url, a);
    case 'skills': return skills.list();
    case 'skill': return skills.run(a.id, a.intent, a.args || {});
    case 'health': return health.run();
    case 'log': return { entries: log.tail(Number(a.n) || 30) };
    default: throw new Error(`unknown tool ${name}`);
  }
}

async function main() {
  const server = new Server({ name: 'farr-browser', version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const out = await handle(name, args || {});
      if (name === 'shot' && out.image) {
        const { image, ...meta } = out;
        return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'image', data: image, mimeType: out.mime }] };
      }
      if (name === 'read' && out.markdown != null) {
        const { markdown, ...meta } = out;
        return { content: [{ type: 'text', text: JSON.stringify(meta) + '\n\n' + markdown }] };
      }
      return { content: [{ type: 'text', text: asText(out) }] };
    } catch (e) {
      const { message, stack, ...extra } = e; // eslint-disable-line no-unused-vars
      const head = e.refused ? `REFUSED: ${e.message.replace(/^refused: /, '')}` : `ERROR: ${e.message}`;
      const { look, ...rest } = extra;
      const body = [head];
      if (Object.keys(rest).length) body.push(JSON.stringify(rest));
      if (look) body.push(look);
      return { isError: true, content: [{ type: 'text', text: body.join('\n\n') }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

module.exports = { main, TOOLS, handle };
