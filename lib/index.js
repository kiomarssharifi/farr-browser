'use strict';
/* Library entry point, for using farr-browser from your own Node.js code. */
module.exports = {
  Sessions: require('./sessions').Sessions,
  read: require('./reader').read,
  get: require('./reader').get,
  skills: require('./skills'),
  robots: require('./robots'),
  gate: require('./gate'),
  markdown: require('./markdown'),
  health: require('./health').run,
  client: require('./client'),
};
