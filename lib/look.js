'use strict';
/*
 * A "look": what an agent needs to see of a page to act on it, and little else.
 *
 * One line per thing that can be acted on, each with a ref, plus the h1-h3
 * headings that say where on the page it is:
 *
 *   # Pricing
 *   e12 link "Pricing" → /pricing
 *   e13 input:email "Email" = "a@b.c"
 *   e14 button "Subscribe"
 *
 * REFS ARE HELD ON THIS SIDE, never written into the page (no attribute, no
 * global), so the site cannot see them. An element that survives from one look to
 * the next keeps its ref; a new element gets a new number; numbers are never
 * reused within a session. So a ref from an old look either still points at the
 * very element it named, or it is refused as stale. It never silently points at
 * whatever now sits in the same place.
 */

/* Runs in the page: the actionable elements, as one array (kept as a handle). */
function collectInPage(opts) {
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=radio]',
    '[role=switch]', '[role=combobox]', '[role=option]', '[role=searchbox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', 'h1', 'h2', 'h3',
  ].join(',');
  const out = [];
  const seen = new Set();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll(SEL)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (opts.includeHidden || visible(el)) out.push(el);
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return out;
}

/* Runs in the page: a plain description of each element in the array. */
function describeInPage(els) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      const wrap = el.closest('label');
      if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
      if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return clean(el.value);
      return clean(el.placeholder || el.name || el.title || '');
    }
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && clean(img.alt)) return clean(img.alt);
    return clean(el.title || '');
  };
  const vh = innerHeight;
  const vw = innerWidth;
  return els.map((el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind = role || tag;
    if (tag === 'a') kind = 'link';
    if (tag === 'input') kind = `input:${(el.type || 'text').toLowerCase()}`;
    if (/^h[1-3]$/.test(tag)) kind = tag;
    const d = { kind, label: labelOf(el).slice(0, 90) };
    if (tag === 'a') {
      d.target = el.getAttribute('target') || undefined;
      try {
        const u = new URL(el.href, location.href);
        d.href = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
        d.absHref = u.href;
      } catch (e) { d.href = el.getAttribute('href'); }
    }
    if (tag === 'input' || tag === 'textarea') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') d.checked = !!el.checked;
      else if (t === 'password') { if (el.value) d.value = '***'; }
      else if (el.value) d.value = String(el.value).slice(0, 60);
    }
    if (tag === 'select') {
      const o = el.options[el.selectedIndex];
      d.value = o ? clean(o.textContent).slice(0, 40) : '';
      d.options = [...el.options].slice(0, 12).map((x) => clean(x.textContent).slice(0, 30));
      if (el.options.length > 12) d.moreOptions = el.options.length - 12;
    }
    const ex = el.getAttribute('aria-expanded');
    if (ex != null) d.expanded = ex === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') d.disabled = true;
    const r = el.getBoundingClientRect();
    d.inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const form = el.form || el.closest('form');
    if (form && (tag === 'button' || (tag === 'input' && /^(submit|image)$/i.test(el.type)))) {
      const type = (el.getAttribute('type') || 'submit').toLowerCase();
      if (tag === 'input' || type === 'submit') {
        try { d.formAction = new URL(el.getAttribute('formaction') || form.getAttribute('action') || '', location.href).href; } catch (e) { /* none */ }
      }
    }
    return d;
  });
}

function render(ref, d) {
  if (/^h[1-3]$/.test(d.kind)) return `${'#'.repeat(Number(d.kind[1]))} ${d.label}`;
  let s = `${ref} ${d.kind}${d.label ? ` "${d.label}"` : ' (no label)'}`;
  if (d.href) s += ` → ${d.href.length > 70 ? d.href.slice(0, 67) + '...' : d.href}`;
  if (d.target === '_blank') s += ' (new tab)';
  if (d.value != null && d.value !== '') s += ` = "${d.value}"`;
  if (d.checked != null) s += d.checked ? ' [x]' : ' [ ]';
  if (d.options) s += ` {${d.options.join(' | ')}${d.moreOptions ? ` | +${d.moreOptions}` : ''}}`;
  if (d.expanded != null) s += d.expanded ? ' (open)' : ' (closed)';
  if (d.disabled) s += ' (disabled)';
  return s;
}

/** A fresh ref state for a new session. */
function newState() {
  return { counter: 0, frames: new Map(), refs: new Map() };
}

async function disposeFrames(frames) {
  for (const f of frames.values()) await f.arr.dispose().catch(() => {});
}

/** Forget every ref (on a tab switch): old names will be refused. */
async function reset(state) {
  const old = state.frames;
  state.frames = new Map();
  state.refs = new Map();
  await disposeFrames(old);
}

/**
 * Look at a page and update the session's ref state.
 * @param {{filter?:string, limit?:number, inViewOnly?:boolean, includeHidden?:boolean}} opts
 */
async function look(page, state, { filter, limit = 150, inViewOnly = false, includeHidden = false } = {}) {
  const frames = new Map();
  const refs = new Map();
  const lines = [];
  const want = filter ? String(filter).toLowerCase() : null;
  let shown = 0;
  let over = 0;
  let total = 0;

  const all = page.frames().filter((f) => !f.isDetached());
  for (let fi = 0; fi < all.length; fi++) {
    const frame = all[fi];
    let arr;
    let ds;
    try {
      arr = await frame.evaluateHandle(collectInPage, { includeHidden });
      ds = await frame.evaluate(describeInPage, arr);
    } catch (e) {
      if (arr) await arr.dispose().catch(() => {});
      continue; // a frame mid-navigation
    }
    // Which of these elements were already named in the previous look?
    let prevIndex = null;
    const prev = state.frames.get(frame);
    if (prev) {
      prevIndex = await frame.evaluate(([p, n]) => n.map((el) => p.indexOf(el)), [prev.arr, arr]).catch(() => null);
    }
    const names = ds.map((d, i) => {
      if (/^h[1-3]$/.test(d.kind)) return null;
      const j = prevIndex ? prevIndex[i] : -1;
      if (j >= 0 && prev.names[j]) return prev.names[j];
      state.counter += 1;
      return `e${state.counter}`;
    });
    frames.set(frame, { arr, names });

    let header = false;
    ds.forEach((d, i) => {
      const heading = names[i] === null;
      if (!heading) {
        total++;
        refs.set(names[i], { frame, arr, i, d });
      }
      if (inViewOnly && !d.inView) return;
      if (want && (heading || !`${d.label} ${d.href || ''}`.toLowerCase().includes(want))) return;
      if (heading && !d.label) return;
      if (!heading && shown >= limit) { over++; return; }
      if (fi > 0 && !header) { lines.push(`--- frame ${frame.url().slice(0, 90)}`); header = true; }
      if (!heading) shown++;
      lines.push(render(names[i], d));
    });
  }

  await disposeFrames(state.frames);
  state.frames = frames;
  state.refs = refs;

  const title = await page.title().catch(() => '');
  const foot = [];
  if (over) foot.push(`... ${over} more element(s) not shown; narrow with a filter or raise the limit (${total} on the page)`);
  if (want && !shown) foot.push(`nothing matches "${filter}" (${total} actionable element(s) on the page)`);
  return { text: [title || '(untitled)', page.url(), '', ...lines, ...foot].join('\n'), count: shown, total };
}

/** Turn a ref into a live element, or say why it cannot be used. */
async function resolve(state, ref) {
  const r = state.refs.get(ref);
  if (!r) {
    return { stale: true, why: `${ref} is not on the page as it is now (the page changed since the look that showed it)` };
  }
  if (r.frame.isDetached()) return { stale: true, why: `the frame that held ${ref} is gone` };
  let el;
  try {
    const h = await r.frame.evaluateHandle(([a, i]) => a[i], [r.arr, r.i]);
    el = h.asElement();
  } catch (e) {
    return { stale: true, why: `the page changed since your last look` };
  }
  if (!el) return { stale: true, why: `${ref} no longer resolves to an element` };
  const connected = await el.evaluate((n) => n.isConnected).catch(() => false);
  if (!connected) return { stale: true, why: `${ref} ("${r.d.label}") was removed from the page` };
  return { el, d: r.d, frame: r.frame };
}

module.exports = { look, resolve, reset, newState, render };
