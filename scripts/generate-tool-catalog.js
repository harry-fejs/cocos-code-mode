#!/usr/bin/env node
'use strict';
// Offline entrypoint only: importing this script never loads extension/engine initializers.
const { main } = require('./cocos-api/extract-catalog');
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`gen:catalog: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
