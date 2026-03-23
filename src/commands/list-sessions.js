'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CLI_CONNECT_DIR = path.join(os.homedir(), '.cli-connect');

function getPort() {
  try { return fs.readFileSync(path.join(CLI_CONNECT_DIR, 'port'), 'utf8').trim(); } catch (_) { return '27182'; }
}

function getToken() {
  try { return fs.readFileSync(path.join(CLI_CONNECT_DIR, 'token'), 'utf8').trim(); } catch (_) { return ''; }
}

async function listSessions(port) {
  port = port || getPort();
  const token = getToken();

  let sessions;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { 'X-CLI-Connect-Token': token }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ sessions } = await res.json());
  } catch (e) {
    console.log(`Cannot reach server on port ${port}: ${e.message}`);
    console.log('Run: cli-connect start');
    return;
  }

  if (!sessions || sessions.length === 0) {
    console.log('\nNo named sessions online.\n(Sessions appear after they call cli_connect__rename in Claude.)\n');
    return;
  }

  console.log(`\nNamed sessions (${sessions.length}):\n`);
  console.log('  Name'.padEnd(20) + 'ID'.padEnd(12) + 'Status'.padEnd(14) + 'Pending');
  console.log('  ' + '─'.repeat(52));
  for (const s of sessions) {
    const status = s.processing ? 'processing' : 'idle';
    console.log(`  ${s.name.padEnd(18)}${s.shortId.padEnd(12)}${status.padEnd(14)}${s.pending}`);
  }
  console.log();
}

module.exports = { listSessions };
