#!/usr/bin/env node
'use strict';

/**
 * CLI-Connect v2 — Combined MCP SSE Server + Message Hub
 *
 * One process handles everything:
 *   GET  /sse          → MCP SSE endpoint (one per Claude Code session)
 *   POST /messages     → MCP message handler (routed by sessionId query param)
 *   GET  /health       → status check
 *   GET  /sessions     → list named sessions (for CLI status command)
 *
 * Session identity is established AFTER connection via cli_connect__rename.
 * No SESSION_NAME env var. No special launch command needed.
 */

const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CLI_CONNECT_DIR = path.join(os.homedir(), '.cli-connect');
const PERSIST_FILE    = path.join(CLI_CONNECT_DIR, 'persist.json');
const TOKEN_FILE      = path.join(CLI_CONNECT_DIR, 'token');
const PORT_FILE       = path.join(CLI_CONNECT_DIR, 'port');
const PID_FILE        = path.join(CLI_CONNECT_DIR, 'server.pid');
const LOG_FILE        = path.join(CLI_CONNECT_DIR, 'server.log');
const COMMANDS_DIR    = path.join(os.homedir(), '.claude', 'commands');

const VERSION    = '2.0.0';
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Short ID generation  →  "oak-17", "fox-42"
// ---------------------------------------------------------------------------
const WORDS = ['oak', 'fox', 'bay', 'elm', 'ash', 'ivy', 'ray', 'dew', 'fir', 'fen',
               'arc', 'sol', 'neo', 'vim', 'zen', 'hex', 'dot', 'bit', 'kea', 'roe'];

function generateShortId() {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num  = Math.floor(10 + Math.random() * 90);
  return `${word}-${num}`;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
// connections: transportSessionId → { shortId, name|null, inbox[], mcpServer }
const connections = {};

// nameIndex: name → transportSessionId  (only named sessions)
const nameIndex = {};

// pendingNames: queue of { name, reservedAt } set by `cli-connect new <name>`
// Claimed by the next anonymous SSE connection's first get_inbox call
const pendingNames = [];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function saveState() {
  try {
    fs.mkdirSync(CLI_CONNECT_DIR, { recursive: true });
    // Only persist named sessions' inboxes — anonymous ones are ephemeral
    const snap = {};
    for (const [tid, conn] of Object.entries(connections)) {
      if (conn.name) snap[conn.name] = { inbox: conn.inbox };
    }
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ namedInboxes: snap }, null, 2));
  } catch (e) {
    logLine(`[WARN] saveState failed: ${e.message}`);
  }
}

function loadPersistedInbox(name) {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      return (data.namedInboxes?.[name]?.inbox) || [];
    }
  } catch (_) {}
  return [];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Slash command file management
// ---------------------------------------------------------------------------
function peerTemplate(peerName) {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'templates', 'claude-peer.md.tmpl'), 'utf8'
    ).replace(/{{PEER_NAME}}/g, peerName);
  } catch (_) {
    return `Send a task to ${peerName} and continue working asynchronously.\n\n` +
      `1. Call MCP tool \`cli_connect__send_message\`:\n` +
      `   - to: "${peerName}"\n` +
      `   - body: "$ARGUMENTS"\n` +
      `2. Tell the user: "Message dispatched to ${peerName} (ID: [messageId])."\n` +
      `3. Do NOT wait or block.\n`;
  }
}

function createSlashCommand(name) {
  try {
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });
    fs.writeFileSync(path.join(COMMANDS_DIR, `claude-${name}.md`), peerTemplate(name));
    logLine(`Created slash command: /claude-${name}`);
  } catch (e) {
    logLine(`[WARN] Could not create slash command for ${name}: ${e.message}`);
  }
}

function deleteSlashCommand(name) {
  try {
    const f = path.join(COMMANDS_DIR, `claude-${name}.md`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); logLine(`Deleted slash command: /claude-${name}`); }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function getToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return null; }
}

function authMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/sse' || req.path === '/messages') return next();  // public
  const token = getToken();
  if (!token) return next();                        // no token = open
  if (req.headers['x-cli-connect-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// MCP tool definitions  (v2.1 — consolidated 5-tool set)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'cli_connect__poll',
    description:
      'Your single inbox tool. Checks inbox immediately; if empty, blocks up to 30s for a message. ' +
      'On the very first call it also returns your session ID / auto_name. ' +
      'Reply messages are auto-acknowledged on delivery — no separate acknowledge call needed. ' +
      'Returns JSON: {"message":{...}} for a message, or {"inbox":"timeout"} when nothing arrived in 30s.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'cli_connect__send',
    description: 'Send a task to another named CLI-Connect session. Returns the sent_id you need to match the reply.',
    inputSchema: {
      type: 'object',
      properties: {
        to:   { type: 'string', description: 'Target session name' },
        body: { type: 'string', description: 'Task or message to send' }
      },
      required: ['to', 'body']
    }
  },
  {
    name: 'cli_connect__reply',
    description: 'Reply to a task message you received.',
    inputSchema: {
      type: 'object',
      properties: {
        originalId: { type: 'string', description: 'ID of the task message you are replying to' },
        body:       { type: 'string', description: 'Your reply / result summary' }
      },
      required: ['originalId', 'body']
    }
  },
  {
    name: 'cli_connect__rename',
    description: 'Give this session a memorable name. After renaming, others can reach you via /claude-<name>.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session name (alphanumeric, hyphens ok)' } },
      required: ['name']
    }
  },
  {
    name: 'cli_connect__list_sessions',
    description: 'List all active named CLI-Connect sessions on this machine.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// ---------------------------------------------------------------------------
// Tool handlers (factory — captures transportSessionId via closure)
// ---------------------------------------------------------------------------
function makeToolHandler(transportSessionId) {
  // Track whether this is the first get_inbox call for this connection
  let firstInboxCall = true;

  return async function handleTool(name, args) {
    const conn = connections[transportSessionId];
    if (!conn) throw new Error('Session connection not found.');

    switch (name) {

      // ── NEW v2.1 tools ────────────────────────────────────────────────────

      case 'cli_connect__poll': {
        const isFirst = firstInboxCall;
        firstInboxCall = false;

        // On first call, claim a pending name reservation
        let autoName = null;
        if (isFirst && !conn.name) {
          const now = Date.now();
          const idx = pendingNames.findIndex(p => now - p.reservedAt < 60000);
          if (idx !== -1) autoName = pendingNames.splice(idx, 1)[0].name;
        }

        const headerLines = [];
        if (isFirst) {
          headerLines.push(`session_id: ${conn.shortId}`);
          if (conn.name) headerLines.push(`session_name: ${conn.name}`);
          else {
            headerLines.push('first_connect: true');
            if (autoName) headerLines.push(`auto_name: ${autoName}`);
          }
        }

        // Helper: deliver a single message — auto-acks replies, marks tasks processing
        const deliver = (msg) => {
          if (msg.type === 'reply') {
            const i = conn.inbox.findIndex(m => m.id === msg.id);
            if (i !== -1) conn.inbox.splice(i, 1);  // auto-acknowledge
          } else {
            msg.status = 'processing';
          }
          saveState();
          // Compact output — only fields Claude needs
          const compact = { type: msg.type, id: msg.id, from: msg.from, body: msg.body };
          if (msg.originalId) compact.originalId = msg.originalId;
          const lines = [...headerLines, JSON.stringify(compact)];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        };

        // Check inbox immediately
        const pending = conn.inbox.find(m => m.status === 'pending');
        if (pending) return deliver(pending);

        // Return first_connect info immediately (don't block on first call)
        if (isFirst) {
          return { content: [{ type: 'text', text: [...headerLines, 'inbox: empty'].join('\n') }] };
        }

        // Block up to 60s
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            conn.waiter = null;
            resolve({ content: [{ type: 'text', text: 'timeout' }] });
          }, 60000);
          conn.waiter = (msg) => {
            clearTimeout(timer);
            conn.waiter = null;
            resolve(deliver(msg));
          };
        });
      }

      // ── Legacy wait_for_message — also increase timeout to 60s ───────────
      // (kept for backwards compat but not in TOOLS array)

      case 'cli_connect__send': {
        const { to, body } = args;
        const targetTid = nameIndex[to];
        const target = targetTid ? connections[targetTid] : null;
        if (!target) throw new Error(`No active session named "${to}". Use cli_connect__list_sessions to see who's online.`);

        const msgId = uuidv4();
        const msg = {
          id: msgId, from: conn.name || conn.shortId, to,
          body, type: 'task', status: 'pending',
          createdAt: new Date().toISOString(), repliedAt: null, reply: null
        };
        target.inbox.push(msg);
        if (target.waiter) target.waiter(msg);
        saveState();

        try {
          require('node-notifier').notify({
            title: `CLI-Connect: task from ${conn.name || conn.shortId}`,
            message: body.substring(0, 80)
          });
        } catch (_) {}

        return { content: [{ type: 'text', text: `sent_id: ${msgId}` }] };
      }

      // ── Legacy tools (kept for backwards compat, not exposed in TOOLS array) ─

      case 'cli_connect__get_inbox': {
        const isFirst = firstInboxCall;
        firstInboxCall = false;

        // On first call, claim a pending name reservation if one exists (from `cli-connect new <name>`)
        let autoName = null;
        if (isFirst && !conn.name) {
          const now = Date.now();
          // Expire reservations older than 60s, claim the oldest valid one
          const idx = pendingNames.findIndex(p => now - p.reservedAt < 60000);
          if (idx !== -1) {
            autoName = pendingNames.splice(idx, 1)[0].name;
            // Pre-set the name so it's claimed before rename is called
          }
        }

        const pending = conn.inbox.filter(
          m => m.status === 'pending' || m.status === 'processing'
        );

        // Mark first pending task as processing
        for (const m of pending) {
          if (m.status === 'pending' && m.type === 'task') {
            m.status = 'processing';
            break;
          }
        }
        if (pending.length) saveState();

        const lines = [];
        if (isFirst) {
          lines.push(`session_id: ${conn.shortId}`);
          if (conn.name) lines.push(`session_name: ${conn.name}`);
          else {
            lines.push(`first_connect: true`);
            if (autoName) lines.push(`auto_name: ${autoName}`);
          }
        }
        if (pending.length === 0) {
          lines.push('inbox: empty');
        } else {
          for (const m of pending) {
            lines.push(`\n[${m.type.toUpperCase()}] id:${m.id} from:${m.from}\n${m.body}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'cli_connect__whoami': {
        const text = conn.name
          ? `session_id: ${conn.shortId}\nsession_name: ${conn.name}`
          : `session_id: ${conn.shortId}\nsession_name: (not set — use cli_connect__rename to set one)`;
        return { content: [{ type: 'text', text }] };
      }

      case 'cli_connect__rename': {
        const { name } = args;
        if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
          throw new Error('Invalid name. Use alphanumeric characters (hyphens/underscores allowed).');
        }
        if (nameIndex[name] && nameIndex[name] !== transportSessionId) {
          throw new Error(`Name "${name}" is already taken by another active session.`);
        }

        const oldName = conn.name;
        if (oldName) {
          delete nameIndex[oldName];
          deleteSlashCommand(oldName);
        }

        // Restore any persisted inbox for this name
        if (!oldName || oldName !== name) {
          const persisted = loadPersistedInbox(name);
          if (persisted.length) conn.inbox = [...persisted, ...conn.inbox];
        }

        conn.name = name;
        nameIndex[name] = transportSessionId;
        createSlashCommand(name);
        saveState();

        return {
          content: [{
            type: 'text',
            text: `✔ This session is now named "${name}".\n` +
                  `Other sessions can reach you via /claude-${name}.\n` +
                  `Your short ID remains: ${conn.shortId}`
          }]
        };
      }

      case 'cli_connect__send_message': {
        const { to, body } = args;
        const targetTid = nameIndex[to];
        const target = targetTid ? connections[targetTid] : null;
        if (!target) throw new Error(`No active session named "${to}". Use cli_connect__list_sessions to see who's online.`);

        const msgId = uuidv4();
        const msg = {
          id: msgId, from: conn.name || conn.shortId, to,
          body, type: 'task',
          status: 'pending',
          createdAt: new Date().toISOString(),
          repliedAt: null, reply: null
        };
        target.inbox.push(msg);
        if (target.waiter) target.waiter(msg);
        saveState();

        // OS toast
        try {
          require('node-notifier').notify({
            title: `CLI-Connect: task from ${conn.name || conn.shortId}`,
            message: body.substring(0, 80)
          });
        } catch (_) {}

        const pending = target.inbox.filter(m => m.status === 'pending').length;
        const queued  = pending > 1;
        return {
          content: [{
            type: 'text',
            text: `Dispatched to ${to} (ID: ${msgId})${queued ? ` — queued (position ${pending})` : ''}.\nContinue your work; I'll notify you when they reply.`
          }]
        };
      }

      case 'cli_connect__reply': {
        const { originalId, body } = args;

        // Find the original message in this connection's inbox
        const original = conn.inbox.find(m => m.id === originalId);
        if (!original) throw new Error(`Message ${originalId} not found in your inbox.`);

        original.status = 'replied';
        original.repliedAt = new Date().toISOString();
        original.reply = body;

        // Deliver reply to sender's inbox
        const senderName = original.from;
        const senderTid  = nameIndex[senderName];
        const sender     = senderTid ? connections[senderTid] : null;

        const replyId = uuidv4();
        const replyMsg = {
          id: replyId, from: conn.name || conn.shortId, to: senderName,
          body, type: 'reply', originalId,
          status: 'pending',
          createdAt: new Date().toISOString(),
          repliedAt: null, reply: null
        };

        if (sender) {
          sender.inbox.push(replyMsg);
          if (sender.waiter) sender.waiter(replyMsg);
        } else {
          logLine(`[WARN] Sender "${senderName}" no longer connected; reply may be lost.`);
        }
        saveState();

        // OS toast to sender
        try {
          require('node-notifier').notify({
            title: `CLI-Connect: reply from ${conn.name || conn.shortId}`,
            message: body.substring(0, 80)
          });
        } catch (_) {}

        return { content: [{ type: 'text', text: `Reply sent to ${senderName} (ID: ${replyId}).` }] };
      }

      case 'cli_connect__acknowledge': {
        const { messageId } = args;
        const idx = conn.inbox.findIndex(m => m.id === messageId);
        if (idx === -1) throw new Error(`Message ${messageId} not found.`);
        conn.inbox.splice(idx, 1);
        saveState();
        return { content: [{ type: 'text', text: `Message ${messageId} acknowledged and removed from inbox.` }] };
      }

      case 'cli_connect__list_sessions': {
        const named = Object.values(connections).filter(c => c.name);
        if (named.length === 0) {
          return { content: [{ type: 'text', text: 'No named sessions online. Sessions appear here after they call cli_connect__rename.' }] };
        }
        const rows = named.map(c => {
          const pending = c.inbox.filter(m => m.status === 'pending').length;
          const proc    = c.inbox.filter(m => m.status === 'processing').length;
          const status  = proc ? 'processing' : 'idle';
          return `• ${c.name} (${c.shortId}) | ${status} | ${pending} pending`;
        });
        return { content: [{ type: 'text', text: rows.join('\n') }] };
      }

      case 'cli_connect__wait_for_message': {
        const pending = conn.inbox.find(m => m.status === 'pending');
        if (pending) {
          pending.status = 'processing';
          saveState();
          return { content: [{ type: 'text', text: JSON.stringify({ message: pending }) }] };
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            conn.waiter = null;
            resolve({ content: [{ type: 'text', text: JSON.stringify({ inbox: 'timeout' }) }] });
          }, 60000);
          conn.waiter = (msg) => {
            clearTimeout(timer);
            conn.waiter = null;
            msg.status = 'processing';
            saveState();
            resolve({ content: [{ type: 'text', text: JSON.stringify({ message: msg }) }] });
          };
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Build a per-connection MCP Server
// ---------------------------------------------------------------------------
function buildMCPServer(transportSessionId) {
  const mcpServer = new Server(
    { name: 'cli-connect', version: VERSION },
    { capabilities: { tools: {} } }
  );

  const handleTool = makeToolHandler(transportSessionId);

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logLine(`TOOL ${name} (session ${connections[transportSessionId]?.shortId || '?'})`);
    try {
      return await handleTool(name, args || {});
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return mcpServer;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
// Parse JSON body for all routes (including /messages)
// handlePostMessage accepts parsedBody param to skip internal raw-body reading
app.use(express.json());
app.use(authMiddleware);

app.use((req, _res, next) => {
  logLine(`${req.method} ${req.path}`);
  next();
});

// GET /health — public
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    sessions: Object.values(connections).filter(c => c.name).length
  });
});

// GET /sessions — named sessions list (for CLI status/list commands)
app.get('/sessions', (_req, res) => {
  const named = Object.values(connections)
    .filter(c => c.name)
    .map(c => ({
      name:    c.name,
      shortId: c.shortId,
      pending: c.inbox.filter(m => m.status === 'pending').length,
      processing: c.inbox.some(m => m.status === 'processing')
    }));
  res.json({ sessions: named });
});

// POST /reserve-name — called by `cli-connect new <name>` before launching Claude
// Queues a name so the next SSE connection's first get_inbox auto-claims it
app.post('/reserve-name', (req, res) => {
  const { name } = req.body || {};
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  // Remove any stale reservation for the same name
  const idx = pendingNames.findIndex(p => p.name === name);
  if (idx !== -1) pendingNames.splice(idx, 1);
  pendingNames.push({ name, reservedAt: Date.now() });
  logLine(`Reserved name "${name}" for next SSE connection`);
  res.json({ ok: true, name });
});

// GET /sse — new Claude Code session connects here
app.get('/sse', async (req, res) => {
  const shortId   = generateShortId();
  const transport = new SSEServerTransport('/messages', res);
  const tid       = transport.sessionId;

  connections[tid] = { shortId, name: null, inbox: [], mcpServer: null, transport, waiter: null };

  logLine(`SSE CONNECT shortId=${shortId} tid=${tid}`);

  const mcpServer = buildMCPServer(tid);
  connections[tid].mcpServer = mcpServer;

  // Auto-cleanup when client disconnects
  res.on('close', () => {
    const conn = connections[tid];
    if (conn) {
      logLine(`SSE CLOSE shortId=${conn.shortId} name=${conn.name || '(unnamed)'}`);
      if (conn.waiter) conn.waiter = null;
      if (conn.name) {
        delete nameIndex[conn.name];
        deleteSlashCommand(conn.name);
        saveState();
      }
      delete connections[tid];
    }
  });

  await mcpServer.connect(transport);
});

// POST /messages — MCP JSON-RPC handler (client posts here after GET /sse)
// Bypass handlePostMessage's raw-body reading by calling handleMessage directly
// (express.json() has already parsed req.body for us)
app.post('/messages', async (req, res) => {
  const tid = req.query.sessionId;
  const conn = connections[tid];
  if (!conn) {
    logLine(`POST /messages: session not found tid=${tid}`);
    return res.status(404).json({ error: 'Session not found' });
  }
  logLine(`POST /messages body=${JSON.stringify(req.body).substring(0, 80)}`);
  try {
    // handleMessage processes the JSON-RPC message and sends response via the SSE stream
    await conn.transport.handleMessage(req.body, {
      requestInfo: { headers: req.headers, url: undefined }
    });
    res.status(202).end('Accepted');
  } catch (err) {
    logLine(`POST /messages error: ${err.message}`);
    res.status(400).end(String(err.message));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let port = 27182;
try {
  port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10) || 27182;
} catch (_) {}

app.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(CLI_CONNECT_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  logLine(`CLI-Connect v${VERSION} hub started on http://127.0.0.1:${port}`);
  console.log(`CLI-Connect v${VERSION} running on http://127.0.0.1:${port}`);
  console.log(`MCP SSE endpoint: http://127.0.0.1:${port}/sse`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

function shutdown() {
  logLine('Server shutting down');
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}
