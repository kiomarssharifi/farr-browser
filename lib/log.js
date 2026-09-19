'use strict';
/*
 * The run log: one JSON line per operation (open, do, read, get, skill, ...),
 * with what was asked, what happened and how long it took. `farr-browser log`
 * prints the tail. Logging must never break the operation it records.
 */
const fs = require('fs');
const config = require('./config');

function write(entry) {
  try {
    const p = config.ensureHome();
    const row = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(p.log, JSON.stringify(row) + '\n');
  } catch (e) { /* never fatal */ }
}

/** Start a timer; call the returned function with the verdict when done. */
function timed(verb, fields = {}) {
  const t0 = Date.now();
  return (verdict, extra = {}) => write({ verb, ...fields, ...extra, verdict, ms: Date.now() - t0 });
}

function tail(n = 50) {
  const p = config.paths();
  if (!fs.existsSync(p.log)) return [];
  const lines = fs.readFileSync(p.log, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
}

module.exports = { write, timed, tail };
