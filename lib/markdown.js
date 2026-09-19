'use strict';
/*
 * HTML to markdown that keeps what an agent can act on: headings, links (made
 * absolute), lists, tables, code and emphasis. Scripts, styles, navigation,
 * forms and hidden elements are dropped.
 *
 * It is a small tolerant tokenizer, not a validating HTML parser. The same
 * function serves plain HTTP reads and browser-rendered pages, so both give the
 * same dialect.
 */

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'head',
  'nav', 'footer', 'aside', 'form', 'button', 'select', 'textarea', 'dialog', 'object']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr']);
const PARA = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption',
  'details', 'address', 'center']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
  yen: '¥', laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°',
  times: '×', sect: '§', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à',
  aacute: 'á', acirc: 'â', ccedil: 'ç', iacute: 'í', oacute: 'ó',
  ocirc: 'ô', uacute: 'ú', ntilde: 'ñ',
};

function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (x) { return m; }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED, e)) return NAMED[e];
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
  });
}

function tokens(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (t[0] !== '<' || t === '<') { out.push({ text: t }); continue; }
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    if (t[1] === '/') { out.push({ close: tag }); continue; }
    const attrs = {};
    const ar = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2] || ''))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ open: tag, attrs, empty: VOID.has(tag) || /\/\s*>$/.test(t) });
    if (tag === 'script' || tag === 'style') {
      const rest = html.slice(re.lastIndex);
      const end = new RegExp(`</${tag}\\s*>`, 'i').exec(rest);
      re.lastIndex += end ? end.index + end[0].length : rest.length;
      out.push({ close: tag });
    }
  }
  return out;
}

function absolute(href, base) {
  if (!href || /^(javascript:|data:|#)/i.test(href)) return '';
  try { return base ? new URL(href, base).href : href; } catch (e) { return href; }
}

/** Prefer <main> or the largest <article> when it clearly holds the page. */
function mainPart(html) {
  let best = '';
  for (const tag of ['main', 'article']) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
    let m;
    while ((m = re.exec(html))) if (m[0].length > best.length) best = m[0];
    if (best) break;
  }
  return best && best.length > 1000 && best.length > html.length * 0.3 ? best : html;
}

/**
 * @param {string} html
 * @param {{base?:string, maxChars?:number, preferMain?:boolean}} opts
 */
function fromHtml(html, { base = '', maxChars = 0, preferMain = true } = {}) {
  html = String(html || '');
  if (preferMain) html = mainPart(html);
  let out = '';
  let dropTag = null;
  let dropDepth = 0;
  let pre = 0;
  const lists = [];
  let link = null;
  let table = null;
  let row = null;
  let cell = null;

  const write = (s) => { if (cell) cell.text += s; else out += s; };
  const breakLines = (n) => {
    if (cell || !out) return;
    const have = /\n*$/.exec(out)[0].length;
    if (have < n) out += '\n'.repeat(n - have);
  };

  for (const t of tokens(html)) {
    if (t.text != null) {
      if (dropTag) continue;
      let s = decode(t.text);
      if (!pre) {
        s = s.replace(/\s+/g, ' ');
        if (!cell && /(^|\n)$/.test(out)) s = s.replace(/^ /, '');
      }
      if (s) write(s);
      continue;
    }
    if (t.open) {
      const tag = t.open;
      if (dropTag) { if (tag === dropTag && !t.empty) dropDepth++; continue; }
      if (DROP.has(tag) || t.attrs.hidden != null || t.attrs['aria-hidden'] === 'true') {
        if (!t.empty) { dropTag = tag; dropDepth = 1; }
        continue;
      }
      if (/^h[1-6]$/.test(tag)) { breakLines(2); write('#'.repeat(Number(tag[1])) + ' '); }
      else if (PARA.has(tag)) breakLines(2);
      else if (tag === 'br') write(cell ? ' ' : '\n');
      else if (tag === 'hr') { breakLines(2); write('---'); breakLines(2); }
      else if (tag === 'ul' || tag === 'ol') { lists.push({ ordered: tag === 'ol', n: 0 }); breakLines(lists.length > 1 ? 1 : 2); }
      else if (tag === 'li') {
        breakLines(1);
        const l = lists[lists.length - 1] || { ordered: false, n: 0 };
        l.n++;
        write('  '.repeat(Math.max(0, lists.length - 1)) + (l.ordered ? `${l.n}. ` : '- '));
      }
      else if (tag === 'blockquote') { breakLines(2); write('> '); }
      else if (tag === 'pre') { breakLines(2); write('```\n'); pre++; }
      else if (tag === 'code' && !pre) write('`');
      else if (tag === 'strong' || tag === 'b') write('**');
      else if (tag === 'em' || tag === 'i') write('*');
      else if (tag === 'a') link = { href: absolute(t.attrs.href, base), start: (cell ? cell.text : out).length };
      else if (tag === 'img') { const alt = (t.attrs.alt || '').trim(); if (alt) write(`[image: ${alt}]`); }
      else if (tag === 'table') { breakLines(2); table = { rows: [] }; }
      else if (tag === 'tr' && table) row = [];
      else if ((tag === 'td' || tag === 'th') && row) cell = { text: '', head: tag === 'th' };
      else if (tag === 'dt' || tag === 'summary') { breakLines(2); write('**'); }
      else if (tag === 'dd') { breakLines(1); write(': '); }
      continue;
    }
    // closing tag
    const tag = t.close;
    if (dropTag) { if (tag === dropTag && --dropDepth === 0) dropTag = null; continue; }
    if (/^h[1-6]$/.test(tag) || PARA.has(tag) || tag === 'blockquote') breakLines(2);
    else if (tag === 'ul' || tag === 'ol') { lists.pop(); breakLines(lists.length ? 1 : 2); }
    else if (tag === 'li') breakLines(1);
    else if (tag === 'pre') { pre = Math.max(0, pre - 1); if (!out.endsWith('\n')) out += '\n'; write('```'); breakLines(2); }
    else if (tag === 'code' && !pre) write('`');
    else if (tag === 'strong' || tag === 'b') write('**');
    else if (tag === 'em' || tag === 'i') write('*');
    else if (tag === 'dt' || tag === 'summary') { write('**'); breakLines(1); }
    else if (tag === 'a' && link) {
      const holder = cell || null;
      const text = holder ? holder.text : out;
      const label = text.slice(link.start).replace(/\s+/g, ' ').trim();
      const md = label ? (link.href ? `[${label}](${link.href})` : label) : '';
      if (holder) holder.text = text.slice(0, link.start) + md; else out = text.slice(0, link.start) + md;
      link = null;
    }
    else if ((tag === 'td' || tag === 'th') && cell && row) {
      row.push({ text: cell.text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(), head: cell.head });
      cell = null;
    }
    else if (tag === 'tr' && row && table) { if (row.length) table.rows.push(row); row = null; }
    else if (tag === 'table' && table) {
      const rows = table.rows;
      table = null; row = null; cell = null;
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const fmt = (r) => '| ' + Array.from({ length: width }, (_, i) => (r[i] ? r[i].text : '')).join(' | ') + ' |';
        const lines = [fmt(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |'];
        for (const r of rows.slice(1)) lines.push(fmt(r));
        out += lines.join('\n');
        breakLines(2);
      }
    }
  }

  let md = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/(^|\n)#{1,6} *(?=\n|$)/g, '$1')
    .trim();
  if (maxChars && md.length > maxChars) {
    md = md.slice(0, maxChars) + `\n\n[truncated at ${maxChars} of ${md.length} characters]`;
  }
  return md;
}

/* Runs in the page: the richest content container, or the body. */
function contentInPage() {
  const body = document.body;
  if (!body) return { html: '', base: location.href, title: document.title };
  const total = (body.innerText || '').length;
  let best = body;
  let bestLen = 0;
  for (const el of document.querySelectorAll('main, article, [role=main]')) {
    const n = (el.innerText || '').length;
    if (n > bestLen) { best = el; bestLen = n; }
  }
  if (!(bestLen > 400 && bestLen >= total * 0.6)) best = body;
  return { html: best.outerHTML, base: document.baseURI || location.href, title: document.title };
}

async function fromPage(page, { maxChars = 0 } = {}) {
  const r = await page.evaluate(contentInPage);
  return { title: r.title, markdown: fromHtml(r.html, { base: r.base, maxChars, preferMain: false }) };
}

module.exports = { fromHtml, fromPage, decode, tokens };
