# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] - unreleased

First public version.

### Added
- Live sessions held by a local daemon: `open`, `look`, `do`, `shot`, `close`,
  with a per-session trace that outlives the session, a session cap and an idle
  timeout.
- Looks: one line per actionable element with a ref; refs survive between looks
  while their element does, and are never reused.
- Refusals: stale refs; controls that buy, pay, order, bid, delete, send,
  transfer or cancel (by label or by form action) unless `allow: true`;
  `confirm()` dialogs dismissed unless acceptance is armed.
- Reports of new tabs, downloads, dialogs and navigations stopped by robots.txt.
- `read` (page as markdown) and `get` (download, optionally following a page's
  own PDF link).
- robots.txt (RFC 9309) on every request, every redirect hop and every
  main-frame navigation in a session; unreadable robots.txt means refusal.
- Per-site pacing, including `Crawl-delay`.
- Bring-your-own proxies (http, https, socks5) with optional country tags.
- Declarative site skills (HTML or JSON) with two examples: Wikipedia infoboxes
  and the books.toscrape.com catalogue.
- MCP server `farr-browser-mcp` with the tools open, look, do, shot, close,
  read, get, skills, skill, health, log.
- `health` and `log` commands.
