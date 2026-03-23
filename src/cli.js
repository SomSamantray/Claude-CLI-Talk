#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CLI_CONNECT_DIR = path.join(os.homedir(), '.cli-connect');

program
  .name('cli-connect')
  .description('CLI-Connect v2 — Multi-session Claude Code messaging (pure MCP SSE)')
  .version('2.0.0');

// ── setup ──────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('One-time install: token, server files, settings.json, CLAUDE.md')
  .action(async () => {
    const { setup } = require('./commands/setup');
    try { await setup(); } catch (e) { console.error('Setup failed:', e.message); process.exit(1); }
  });

// ── start ──────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the MCP SSE server in the background')
  .action(() => {
    const { startServer } = require('./commands/setup');
    try { startServer(); } catch (e) { console.error(e.message); process.exit(1); }
  });

// ── stop ───────────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the background server')
  .action(() => {
    const { stopServer } = require('./commands/setup');
    try { stopServer(); } catch (e) { console.error(e.message); process.exit(1); }
  });

// ── status ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show server status and connected sessions')
  .action(async () => {
    const pidFile  = path.join(CLI_CONNECT_DIR, 'server.pid');
    const portFile = path.join(CLI_CONNECT_DIR, 'port');

    let pid  = null;
    let port = '27182';
    try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch (_) {}
    try { pid  = fs.readFileSync(pidFile,  'utf8').trim(); } catch (_) {}

    // Check if process alive
    let alive = false;
    if (pid) {
      try { process.kill(parseInt(pid), 0); alive = true; } catch (_) {}
    }

    if (!alive) {
      console.log('Hub: not running');
      console.log('Run: cli-connect start');
      return;
    }

    let health;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      health = await res.json();
    } catch (_) {
      console.log(`Hub: PID ${pid} alive but not responding on port ${port}`);
      return;
    }

    console.log(`\nHub: running (PID ${pid}, port ${port}, uptime ${health.uptime}s)`);

    const { listSessions } = require('./commands/list-sessions');
    await listSessions(port);
  });

// ── list ───────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List active named sessions')
  .action(async () => {
    const portFile = path.join(CLI_CONNECT_DIR, 'port');
    let port = '27182';
    try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch (_) {}
    const { listSessions } = require('./commands/list-sessions');
    await listSessions(port);
  });

// ── logs ───────────────────────────────────────────────────────────────────
program
  .command('logs')
  .description('Show server log')
  .option('-n, --tail <lines>', 'Lines to show', '50')
  .action((opts) => {
    const logFile = path.join(CLI_CONNECT_DIR, 'server.log');
    if (!fs.existsSync(logFile)) { console.log('No log file.'); return; }
    const lines = fs.readFileSync(logFile, 'utf8').split('\n');
    const n = parseInt(opts.tail, 10) || 50;
    console.log(lines.slice(-n - 1).join('\n'));
  });

program.parse(process.argv);
