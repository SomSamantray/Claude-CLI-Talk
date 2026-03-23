#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { spawn } = require('child_process');

const CLI_CONNECT_DIR = path.join(os.homedir(), '.cli-connect');
const CLAUDE_DIR      = path.join(os.homedir(), '.claude');
const COMMANDS_DIR    = path.join(CLAUDE_DIR, 'commands');

program
  .name('cli-connect')
  .description('CLI-Connect v2 — Multi-session Claude Code messaging (pure MCP SSE)')
  .version('2.0.0');

// ── new ────────────────────────────────────────────────────────────────────
program
  .command('new <name>')
  .description('Start a named Claude Code session and pre-register its slash command')
  .action(async (name) => {
    // 1. Ensure commands dir exists
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });

    // 2. Generate ~/.claude/commands/claude-<name>.md from peer template
    const tmplPath = path.join(CLI_CONNECT_DIR, 'templates', 'claude-peer.md.tmpl');
    if (!fs.existsSync(tmplPath)) {
      console.error('Templates not found. Run `cli-connect setup` first.');
      process.exit(1);
    }
    const tmpl = fs.readFileSync(tmplPath, 'utf8');
    const cmdContent = tmpl.replace(/\{\{PEER_NAME\}\}/g, name);
    const cmdFile = path.join(COMMANDS_DIR, `claude-${name}.md`);
    fs.writeFileSync(cmdFile, cmdContent);
    console.log(`✔ /claude-${name} command ready for other sessions`);

    // 3. Reserve the name on the hub so get_inbox returns auto_name on first connect
    //    (no human "call me <name>" typing required)
    const portFile = path.join(CLI_CONNECT_DIR, 'port');
    let port = '27182';
    try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch (_) {}
    const tokenFile = path.join(CLI_CONNECT_DIR, 'token');
    let token = '';
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (_) {}
    try {
      const res = await fetch(`http://127.0.0.1:${port}/reserve-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CLI-Connect-Token': token },
        body: JSON.stringify({ name })
      });
      if (res.ok) {
        console.log(`✔ Name "${name}" reserved — Claude will auto-connect as "${name}"`);
      }
    } catch (_) {
      console.warn(`  (Hub not reachable — Claude will need "call me ${name}" manually)`);
    }

    // 4. Launch Claude Code in this terminal
    console.log(`\n🚀 Starting Claude Code as session "${name}"...`);

    const child = spawn('claude', [], {
      stdio: 'inherit',
      env: { ...process.env, CLI_CONNECT_SESSION: name },
      shell: true
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error('Claude Code not found. Install it first: https://claude.ai/code');
      } else {
        console.error('Failed to launch Claude:', err.message);
      }
      process.exit(1);
    });

    child.on('exit', (code) => process.exit(code || 0));
  });

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
