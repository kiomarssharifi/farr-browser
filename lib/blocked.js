'use strict';
/*
 * Is this response the site's content, or a refusal?
 *
 * A site may answer with an access-denied page or a "prove you are human" check
 * instead of what was asked for. farr-browser reports that as `blocked` and stops.
 * It never tries to get past it: the site has said no.
 */

const STATUS = new Set([401, 403, 407, 429, 451, 503]);
const TITLES = /\b(just a moment|attention required|access denied|verify you are human|are you a robot|checking your browser|request blocked|too many requests)\b/i;

/**
 * @param {{status?:number, title?:string, contentType?:string}} r
 * @returns {null|{status:number|null, reason:string}}
 */
function classify({ status, title } = {}) {
  if (status && STATUS.has(status)) {
    return { status, reason: `the site answered HTTP ${status}` };
  }
  if (title && TITLES.test(title)) {
    return { status: status || null, reason: `the page is a check or refusal page ("${String(title).slice(0, 80)}")` };
  }
  return null;
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

module.exports = { classify, titleOf };
