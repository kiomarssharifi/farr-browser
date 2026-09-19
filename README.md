# farr-browser

farr-browser lets an AI agent use a web browser the way a careful person does: it opens a page, looks at what can be clicked or typed into, acts, and sees what changed. It keeps the page open between the agent's calls, refuses by default anything that would buy, pay, delete or send, and never acts on a stale view of the page. It also reads pages as clean markdown, downloads files, honours robots.txt and paces its requests to each site.

It runs on your own machine, uses the open-source [Playwright](https://playwright.dev) to drive Chromium, and works from the command line, from Node.js, or as an [MCP](https://modelcontextprotocol.io) server for any MCP client.

## Quickstart (5 minutes)

You need Node.js 20 or newer.

```bash
npm install -g farr-browser
farr-browser install-browser           # downloads the browser this version was built for

farr-browser read https://example.com  # the page as markdown
farr-browser open https://example.com  # a live session: prints a session id and a look
```

`open` starts a small background daemon the first time; it holds the page open. Its output looks like this:

```
session: s3f9a1c

Example Domain
https://example.com/

# Example Domain
e1 link "Learn more" → https://iana.org/domains/example
```

Each actionable element has a ref (`e1`). Use the session id and a ref:

```bash
farr-browser do s3f9a1c click e1      # prints what changed, then the new look
farr-browser do s3f9a1c back
farr-browser shot s3f9a1c --marks     # screenshot with the refs drawn on it
farr-browser close s3f9a1c --trace    # close, and list every step taken
```

`farr-browser health` checks the installation; `farr-browser --help` lists every command. If Playwright's Chromium is not installed, an installed Google Chrome or Microsoft Edge is used instead, and `health` says which.

## Commands

| Command | What it does |
|---|---|
| `open <url> [--country XX]` | Start a live session; print its id and the first look |
| `look <session> [--filter T] [--text]` | The page as it is now (`--text` adds the page as markdown) |
| `do <session> <action> [ref] [value]` | `click`, `type`, `select`, `press`, `check`, `uncheck`, `hover`, `scroll`, `wait`, `goto`, `back`, `forward`, `reload`, `tab`, `closetab`, `dialog` |
| `shot <session> [--marks] [--full] [--out F]` | Screenshot (JPEG) |
| `close <session> [--trace]` | End the session; `--trace` lists every step, also after the session closed on its own |
| `read <url> [--browser]` | One-shot read as markdown; `--browser` renders JavaScript first |
| `get <url> [--pdf] [--out F]` | Download; `--pdf` follows the page's own PDF link and checks the result is a PDF |
| `skills`, `skill <id> <intent> name=value` | List and run site skills |
| `daemon [stop\|status]`, `sessions`, `trace <session>` | Operate the daemon |
| `health`, `log [--n N]` | Measured health; the recent operations |

Examples of `do`:

```bash
farr-browser do s3f9a1c type e7 "hello world" --submit   # fill a field and press Enter
farr-browser do s3f9a1c select e9 "Newest first"
farr-browser do s3f9a1c wait "Results"                   # wait for text (or a number of ms)
farr-browser do s3f9a1c goto https://example.org/
farr-browser do s3f9a1c tab 0                            # switch tab
```

Add `--json` to any command for machine-readable output. Exit codes: `0` done, `1` error, `2` refused.

## Use it from an MCP client

The package installs `farr-browser-mcp`, a stdio MCP server with the tools `open`, `look`, `do`, `shot`, `close`, `read`, `get`, `skills`, `skill`, `health` and `log`. Add it to your client's MCP configuration, for example:

```json
{
  "mcpServers": {
    "farr-browser": { "command": "farr-browser-mcp" }
  }
}
```

With Claude Code: `claude mcp add farr-browser -- farr-browser-mcp`. Without a global install, use `"command": "npx", "args": ["-y", "-p", "farr-browser", "farr-browser-mcp"]`.

The live-session tools talk to the same daemon as the command line, so a session opened by one can be continued by the other.

## The safety model

These rules hold for every session, whichever way it is driven.

- **Stale refs are refused, never clicked.** A ref names one element. It keeps working while that element is on the page, and survives later looks. If the element is gone (the page re-rendered or navigated), using its ref is refused, nothing is done, and a fresh look comes back with the refusal. Ref numbers are never reused within a session, so an old ref can never point at something new.
- **Irreversible controls are refused unless you pass `allow: true`** (`--allow` on the command line). A control counts as irreversible when its label says buy, pay, order, bid, delete, send, transfer, cancel an order or subscription, and similar words in English, German, French, Italian and Spanish; or when the form it submits posts to a URL such as `/checkout`, `/payment`, `/delete` or `/transfer`. This is a tripwire, not a proof: a purchase button labelled "Continue" on a form with an innocent URL will pass. Pass `allow` only when a person has asked for exactly that action.
- **Dialogs.** An `alert()` is acknowledged. A `confirm()` or `prompt()` is dismissed, which is the answer that does nothing. To accept the next one, arm it first: `do <session> dialog accept`. Arming covers one dialog only.
- **Everything that happens is reported.** New tabs, downloads (saved under the state directory), dialogs and their answers, and navigations stopped by robots.txt appear in the result of the action that caused them. Every action reports what measurably changed (URL, title, amount of text, number of elements, tabs); "nothing changed" is reported as a warning.
- **robots.txt is honoured** for every request: one-shot reads, downloads, each redirect hop, skill requests, and every main-frame navigation in a live session, whether it comes from `goto`, a clicked link, a submitted form or the page's own script. If a site's robots.txt cannot be read (server error, network failure), farr-browser refuses rather than assuming permission. A missing robots.txt (HTTP 404) means no restrictions, as the standard says. Requests identify themselves as `farr-browser`.
- **Pacing.** Requests to one host are spaced by at least `pacing.minIntervalMs` (default 1000 ms), or by the site's `Crawl-delay`, whichever is longer. Per-site intervals can be set in the config.
- **Refusal pages are not content.** When a site answers with an access-denied or "are you a robot" page, or with HTTP 401, 403, 429 or 503, the result is reported as `blocked`. A bot challenge is reported as blocked and never worked around.
- **Limits.** The daemon holds at most `maxSessions` sessions (default 4); a session idle for `idleSeconds` (default 600) or older than `maxAgeSeconds` (default 4 hours) is closed. It listens only on a local socket in the state directory, readable by your user alone.

farr-browser never logs in, never imports cookies and stores no credentials. Each session starts with an empty browser profile that is discarded when it closes.

## Configuration

State and settings live in `~/.farr-browser/` (or the directory in `FARR_BROWSER_HOME`). Create `config.json` there to change the defaults:

```json
{
  "maxSessions": 4,
  "idleSeconds": 600,
  "timeoutMs": 30000,
  "pacing": { "minIntervalMs": 1000, "sites": { "slow.example.org": 5000 } },
  "browser": { "channel": null, "headless": true },
  "proxies": []
}
```

The same directory holds `log.jsonl` (one line per operation, shown by `farr-browser log`), `traces/` (one file per session), `downloads/`, `daemon.log` and your own `skills/`.

## Bring your own proxies

farr-browser ships with no proxies and is tied to no provider. List the ones you have, each optionally tagged with a two-letter country code:

```json
{
  "proxies": [
    { "server": "http://127.0.0.1:8080" },
    { "server": "socks5://127.0.0.1:1080", "country": "DE" },
    { "server": "socks5://127.0.0.1:1081", "country": "DE" },
    { "server": "http://proxy.internal:3128", "country": "US", "default": true }
  ]
}
```

- `--country DE` (or `country: "DE"` over MCP) uses a proxy tagged `DE`, taking turns when there are several. If none is tagged with that country, the request is refused rather than sent another way.
- A request without a country uses a proxy marked `"default": true`, or goes direct if there is none.
- Supported schemes: `http://`, `https://`, `socks5://`. Proxies that need a username and password are not supported in this version.
- robots.txt is fetched through the same proxy as the request it guards. `farr-browser health` checks that each proxy is reachable.

## Write a skill

A skill answers one question about one site with typed rows instead of prose. It is a JSON file; put yours in `~/.farr-browser/skills/`. This is the built-in Wikipedia skill:

```json
{
  "id": "wikipedia",
  "description": "Structured facts from Wikipedia article pages.",
  "domains": ["wikipedia.org"],
  "intents": {
    "infobox": {
      "description": "The label and value of every row in an article's infobox.",
      "input": {
        "title": { "required": true, "spaces": "_", "description": "article title, e.g. Ada Lovelace" },
        "lang": { "default": "en", "description": "language edition" }
      },
      "url": "https://{lang}.wikipedia.org/wiki/{title}",
      "format": "html",
      "rows": "table.infobox tr",
      "fields": {
        "label": { "selector": ["th.infobox-label", "th"] },
        "value": { "selector": ["td.infobox-data", "td"] }
      },
      "required": ["label", "value"]
    }
  }
}
```

```bash
farr-browser skill wikipedia infobox title="Ada Lovelace"
```

The parts:

- `domains`: the hosts the skill may fetch (subdomains included). A URL outside them is refused.
- `input`: the arguments. Each is URL-encoded into the `{name}` placeholders of `url`; `default` fills a missing value; `spaces` replaces spaces; `path: true` keeps slashes; `raw: true` inserts the value unencoded.
- `format`: `html` or `json`.
  - For `html`, `rows` is a CSS selector for one element per row, and each field has a `selector` (relative to the row; a list is tried in order; omit it to use the row itself) and optionally `attr` to read an attribute instead of the text. The page is parsed with JavaScript switched off and no sub-resources loaded.
  - For `json`, `rows` is a dotted path to the list (`data.items`, `1` for the second element of an array), and each field has an optional `path` (default: the field's name).
- `type` per field: `string` (default), `number`, `integer` or `url` (made absolute).
- `required`: rows missing any of these fields are dropped and counted in `dropped`.

Skills fetch through the same path as `read`: robots.txt, pacing and your proxies apply. `farr-browser skills` lists every skill with its intents and argument names; `farr-browser health` reports skill files that fail validation.

## Use it from Node.js

```js
const { Sessions, read } = require('farr-browser');

(async () => {
  const page = await read('https://example.com');
  console.log(page.markdown);

  const browser = new Sessions();          // in-process, no daemon
  const s = await browser.open({ url: 'https://example.com' });
  console.log(s.look);
  const r = await browser.act({ session: s.session, action: 'click', ref: 'e1' });
  console.log(r.delta, r.look);
  await browser.close({ session: s.session });
  await browser.shutdown();
})();
```

## Development

```bash
npm install
npx playwright install chromium
npm test
```

The tests run entirely offline against fixture pages served by a local HTTP server started inside each test.

## License

Apache License 2.0. Copyright 2026 Kiomars Sharifi. See `LICENSE` and `NOTICE`.
