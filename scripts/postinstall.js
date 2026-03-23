#!/usr/bin/env node
'use strict';

/**
 * Runs automatically after `npm install`.
 * Triggers the full setup flow.
 */

// Skip in CI environments
if (process.env.CI || process.env.SKIP_CLI_CONNECT_SETUP) {
  process.exit(0);
}

const { setup } = require('../src/commands/setup');

setup().catch(err => {
  console.warn('CLI-Connect postinstall setup failed (non-fatal):', err.message);
  console.warn('Run `cli-connect setup` manually to complete installation.');
  process.exit(0); // non-fatal: don't break npm install
});
