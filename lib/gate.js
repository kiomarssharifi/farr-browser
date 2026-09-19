'use strict';
/*
 * The safety refusal.
 *
 * A control that buys, pays, orders, bids, deletes, sends, transfers or cancels is
 * REFUSED unless the call that presses it passes `allow: true`. Two things are
 * read: the control's own label (text, aria-label, value) and the URL of the form
 * it would submit. The page around it is not read, so a product page that says
 * "buy" everywhere can still be browsed; only the control that does it is stopped.
 *
 * This is a tripwire, not a proof. An unlabelled icon button, or a purchase button
 * labelled "Continue" on a form that posts to an innocent-looking URL, passes. What
 * it guarantees is narrower: no control that announces itself as irreversible is
 * pressed by accident.
 */

const WORDS = [
  // English
  'buy', 'buy now', 'purchase', 'pay', 'pay now', 'checkout', 'check out', 'place order',
  'place your order', 'order now', 'confirm order', 'confirm purchase', 'submit order',
  'submit payment', 'complete purchase', 'complete order', 'subscribe', 'upgrade',
  'start trial', 'start free trial', 'donate', 'bid', 'place bid', 'confirm bid',
  'delete', 'delete account', 'remove account', 'erase', 'destroy', 'wipe',
  'send', 'send money', 'send payment', 'transfer', 'withdraw',
  'cancel order', 'cancel subscription', 'cancel booking', 'cancel membership', 'cancel plan',
  'close account', 'deactivate', 'unsubscribe',
  'sell', 'sell now', 'place trade', 'confirm transaction', 'sign transaction', 'swap',
  // German
  'kaufen', 'jetzt kaufen', 'bestellen', 'jetzt bestellen', 'zahlungspflichtig bestellen',
  'kostenpflichtig bestellen', 'bezahlen', 'zur kasse', 'kasse', 'bieten', 'gebot abgeben',
  'abonnieren', 'löschen', 'senden', 'absenden', 'überweisen', 'kündigen', 'stornieren', 'verkaufen',
  // French
  'acheter', 'commander', 'payer', 'supprimer', 'envoyer', 'enchérir', 'résilier', 'vendre',
  // Italian
  'acquista', 'compra', 'ordina', 'paga', 'elimina', 'invia', 'vendi',
  // Spanish
  'comprar', 'pagar', 'pedir', 'eliminar', 'borrar', 'enviar', 'transferir', 'vender',
];

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Whole words only: "send" must not match "sender", "pay" must not match "payload". */
const LABEL_RE = new RegExp(
  `(^|[^\\p{L}\\p{N}])(${WORDS.map(escape).sort((a, b) => b.length - a.length).join('|')})($|[^\\p{L}\\p{N}])`,
  'iu');

/* A form's action URL often says what it does more honestly than its button. */
const ACTION_RE = /\/(checkout|payment|pay|purchase|buy|place-?order|order\/(place|confirm|submit)|delete|destroy|remove-account|withdraw|transfer|cancel|unsubscribe|bid)([/?#.]|$)/i;

/**
 * @param {{label?:string, formAction?:string}} target
 * @returns {{irreversible:boolean, why?:string}}
 */
function check({ label = '', formAction = '' } = {}) {
  const l = String(label).replace(/\s+/g, ' ').trim();
  const m = LABEL_RE.exec(l);
  if (m) return { irreversible: true, why: `its label says "${m[2]}" ("${l.slice(0, 80)}")` };
  let path = '';
  try { path = formAction ? new URL(formAction).pathname : ''; } catch (e) { path = String(formAction); }
  if (path && ACTION_RE.test(path)) return { irreversible: true, why: `it submits a form to ${String(formAction).slice(0, 120)}` };
  return { irreversible: false };
}

module.exports = { check, WORDS, LABEL_RE, ACTION_RE };
