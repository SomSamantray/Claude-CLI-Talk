'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const CLI_CONNECT_DIR = path.join(os.homedir(), '.cli-connect');
const CLAUDE_DIR      = path.join(os.homedir(), '.claude');
const COMMANDS_DIR    = path.join(CLAUDE_DIR, 'commands');
const CLAUDE_MD       = path.join(CLAUDE_DIR, 'CLAUDE.md');
const SETTINGS_FILE   = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_JSON     = path.join(os.homedir(), '.claude.json');
const DEFAULT_PORT    = 27182;

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', name), 'utf8');
}

async function setup() {
  console.log('Setting up CLI-Connect v2...\n');

  // 1. Directories
  fs.mkdirSync(CLI_CONNECT_DIR, { recursive: true });
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(COMMANDS_DIR, { recursive: true });

  // 2. Auth token
  const tokenFile = path.join(CLI_CONNECT_DIR, 'token');
  if (!fs.existsSync(tokenFile)) {
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    console.log('✔ Auth token generated');
  } else {
    console.log('✔ Auth token already exists');
  }

  // 3. Port
  const portFile = path.join(CLI_CONNECT_DIR, 'port');
  if (!fs.existsSync(portFile)) {
    fs.writeFileSync(portFile, String(DEFAULT_PORT));
    console.log(`✔ Port set to ${DEFAULT_PORT}`);
  } else {
    console.log(`✔ Port: ${fs.readFileSync(portFile, 'utf8').trim()}`);
  }

  // 4. Deploy server.js to ~/.cli-connect/
  const serverSrc = path.join(__dirname, '..', 'server.js');
  const serverDst = path.join(CLI_CONNECT_DIR, 'server.js');
  fs.copyFileSync(serverSrc, serverDst);

  // Also copy the templates directory (server.js uses peer template)
  const tmplSrcDir = path.join(__dirname, '..', 'templates');
  const tmplDstDir = path.join(CLI_CONNECT_DIR, 'templates');
  fs.mkdirSync(tmplDstDir, { recursive: true });
  for (const f of fs.readdirSync(tmplSrcDir)) {
    fs.copyFileSync(path.join(tmplSrcDir, f), path.join(tmplDstDir, f));
  }

  // Always re-copy templates (ensures latest versions)
  for (const f of fs.readdirSync(tmplSrcDir)) {
    fs.copyFileSync(path.join(tmplSrcDir, f), path.join(tmplDstDir, f));
  }

  // Write minimal package.json (no postinstall — avoids recursion)
  const pkgDst = path.join(CLI_CONNECT_DIR, 'package.json');
  const minPkg = {
    name: 'cli-connect-hub',
    version: '2.0.0',
    private: true,
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.0.0',
      express: '^4.18.0',
      'node-notifier': '^10.0.0',
      uuid: '^9.0.0'
    }
  };
  fs.writeFileSync(pkgDst, JSON.stringify(minPkg, null, 2));

  // Install deps if not present
  const nmDir = path.join(CLI_CONNECT_DIR, 'node_modules');
  if (!fs.existsSync(nmDir)) {
    console.log('Installing server dependencies...');
    execSync('npm install --production', { cwd: CLI_CONNECT_DIR, stdio: 'inherit' });
  }
  console.log('✔ Server files deployed to ~/.cli-connect/');

  // 5. Configure MCP in settings.json (SSE URL — not stdio bridge)
  configureMCP();

  // 6. Append CLAUDE.md block (idempotent)
  updateClaudeMd();

  // 7. Write /sessions slash command
  const sessionsTmpl = readTemplate('sessions.md.tmpl');
  fs.writeFileSync(path.join(COMMANDS_DIR, 'sessions.md'), sessionsTmpl);
  console.log('✔ /sessions command installed');

  // 8. Write /listen slash command
  const listenContent = `You are entering dedicated listener mode for CLI-Connect.

Announce: "👂 Listener mode active. Waiting for tasks..."

Then loop indefinitely:
1. Call cli_connect__wait_for_message
2. TASK message → announce "📨 Task from [sender]", execute it, call cli_connect__reply with result
3. REPLY message → display "📬 [sender] replied", call cli_connect__acknowledge
4. Timeout (inbox: "timeout") → immediately loop to step 1
Never stop. Never ask for input. Loop until Ctrl+C.
`;
  fs.writeFileSync(path.join(COMMANDS_DIR, 'listen.md'), listenContent);
  console.log('✔ /listen command installed');

  const port = fs.readFileSync(portFile, 'utf8').trim();
  console.log(`
✔ Setup complete (v2 — pure MCP SSE)

MCP endpoint: http://127.0.0.1:${port}/sse
Config:       ~/.claude/settings.json updated
CLAUDE.md:    updated

To start the server:  cli-connect start
Then open Claude Code normally — no special launch needed.
`);
}

function configureMCP() {
  // Write to ~/.claude.json (where Claude Code reads user-level MCPs from)
  let claudeJson = {};
  try {
    if (fs.existsSync(CLAUDE_JSON)) {
      claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    }
  } catch (_) {}

  const port = (() => {
    try { return fs.readFileSync(path.join(CLI_CONNECT_DIR, 'port'), 'utf8').trim(); } catch (_) { return '27182'; }
  })();

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  // Remove old stdio config if present
  if (claudeJson.mcpServers['cli-connect']?.command) {
    console.log('  (Removing old stdio MCP config)');
  }

  // Set SSE config — Claude Code detects SSE from url field alone (no 'type' needed)
  claudeJson.mcpServers['cli-connect'] = {
    url: `http://127.0.0.1:${port}/sse`
  };

  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(claudeJson, null, 2));
  console.log('✔ MCP SSE endpoint configured in ~/.claude.json');

  // Also ensure cli-connect tools are pre-approved in ~/.claude/settings.json
  let settings = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (_) {}
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  const toolsToAllow = [
    'mcp__cli-connect__get_inbox',
    'mcp__cli-connect__rename',
    'mcp__cli-connect__whoami',
    'mcp__cli-connect__send_message',
    'mcp__cli-connect__reply',
    'mcp__cli-connect__acknowledge',
    'mcp__cli-connect__list_sessions',
    'mcp__cli-connect__wait_for_message'
  ];
  for (const t of toolsToAllow) {
    if (!settings.permissions.allow.includes(t)) {
      settings.permissions.allow.push(t);
    }
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log('✔ Tool permissions updated in ~/.claude/settings.json');
}

function updateClaudeMd() {
  const startMarker = '<!-- CLI-CONNECT-START -->';
  const endMarker   = '<!-- CLI-CONNECT-END -->';
  const newBlock    = readTemplate('claude-md-block.tmpl');

  let existing = '';
  try {
    if (fs.existsSync(CLAUDE_MD)) existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch (_) {}

  if (existing.includes(startMarker)) {
    // Replace existing block (handles v1 → v2 upgrade)
    const before = existing.substring(0, existing.indexOf(startMarker));
    const after  = existing.indexOf(endMarker) !== -1
      ? existing.substring(existing.indexOf(endMarker) + endMarker.length)
      : '';
    fs.writeFileSync(CLAUDE_MD, before + newBlock + after);
    console.log('✔ CLAUDE.md block updated (v2)');
  } else {
    fs.writeFileSync(CLAUDE_MD, existing + '\n' + newBlock + '\n');
    console.log('✔ CLAUDE.md updated with CLI-Connect v2 instructions');
  }
}

// Start server in background (used by `cli-connect start`)
function startServer() {
  const pidFile    = path.join(CLI_CONNECT_DIR, 'server.pid');
  const serverPath = path.join(CLI_CONNECT_DIR, 'server.js');
  const logFile    = path.join(CLI_CONNECT_DIR, 'server.log');

  if (!fs.existsSync(serverPath)) {
    throw new Error('Server not deployed. Run `cli-connect setup` first.');
  }

  // Check if already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`Server already running (PID ${pid}).`);
      return;
    } catch (_) { /* not running */ }
  }

  const out   = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: CLI_CONNECT_DIR
  });
  child.unref();
  console.log(`✔ Server started (PID ${child.pid})`);
  console.log(`  Logs: cli-connect logs`);
}

// Stop server
function stopServer() {
  const pidFile = path.join(CLI_CONNECT_DIR, 'server.pid');
  if (!fs.existsSync(pidFile)) {
    console.log('Server is not running (no PID file).');
    return;
  }
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`✔ Server stopped (PID ${pid}).`);
    fs.unlinkSync(pidFile);
  } catch (e) {
    console.log(`Could not stop server: ${e.message}`);
    try { fs.unlinkSync(pidFile); } catch (_) {}
  }
}

module.exports = { setup, startServer, stopServer };
