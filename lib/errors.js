'use strict';

/**
 * A refusal is a deliberate "no" with a reason — not a crash. It carries extra
 * fields (stale, irreversible, robots, blocked, capped, lost, look) so a caller
 * can tell exactly why nothing happened.
 */
class Refused extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'Refused';
    this.refused = true;
    Object.assign(this, extra);
  }
}

/** A plain object safe to send over the wire. */
function toWire(err) {
  const { message, stack, name, ...extra } = err; // eslint-disable-line no-unused-vars
  return { ok: false, error: err.message, refused: !!err.refused, ...extra };
}

module.exports = { Refused, toWire };
