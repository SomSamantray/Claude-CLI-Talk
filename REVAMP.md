# CLI-Connect v2 Revamp Plan

## Problem with v1

Two-process architecture required `SESSION_NAME` env var set *before* Claude Code started:

```
mcp-bridge.js (stdio, per-session) → server.js (HTTP hub)
```

Result: sessions had to launch via `cli-connect new <name>`, never via normal `claude` command. MCP tools silently unavailable if launched wrong way.

---

## v2 Architecture: Single MCP SSE Server

```
Claude Code Session A ──┐
Claude Code Session B ──┤──▶ ~/.cli-connect/server.js  (port 27182)
Claude Code Session C ──┘    ├─ GET /sse      (MCP SSE endpoint)
                             ├─ POST /messages (MCP message handler)
                             ├─ GET /health   (status check)
                             ├─ GET /sessions (named sessions list)
                             └─ persist.json  (crash safety)
```

**One process. All sessions connect to same server. No env vars. No special launch command.**

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| HTTP server | Express.js | Already in use; hosts SSE + REST |
| MCP transport | `SSEServerTransport` (@modelcontextprotocol/sdk) | Claude Code–native SSE support |
| MCP server | `Server` (@modelcontextprotocol/sdk) | One instance per connected session |
| Message IDs | `uuid` v9 | Already in use |
| Persistence | `persist.json` (JSON file) | No binary deps; crash safe |
| CLI | `commander` | Already in use |
| Notifications | `node-notifier` | OS toast on new message |
| Auth | 32-byte hex token in `~/.cli-connect/token` | Prevents local process abuse |

**Removed:** stdio bridge, heartbeat loop, `SESSION_NAME` env var, system service registration.

---

## settings.json Change

**Before (v1 — stdio):**
```json
"mcpServers": {
  "cli-connect": { "command": "node", "args": ["...mcp-bridge.js"], "env": { "SESSION_NAME": "unknown" } }
}
```

**After (v2 — SSE):**
```json
"mcpServers": {
  "cli-connect": { "type": "sse", "url": "http://localhost:27182/sse" }
}
```

Claude Code connects to the URL automatically on startup. No process spawning.

---

## User Flow (Step by Step)

### Day 0 — One-time Setup
```
1. cd CLI-Connect && npm install
2. node src/cli.js setup
   → generates ~/.cli-connect/token
   → writes ~/.cli-connect/port (27182)
   → copies server.js to ~/.cli-connect/server.js
   → updates ~/.claude/settings.json  (SSE URL)
   → appends CLI-Connect block to ~/.claude/CLAUDE.md
   → writes ~/.claude/commands/sessions.md
3. node src/cli.js start
   → server starts in background, PID written to ~/.cli-connect/server.pid
```

### Every Working Day — Start Server
```
node src/cli.js start   (or add to shell profile: ~/.bashrc / PowerShell $PROFILE)
```

### Opening a Session
```
1. Open Claude Code (any terminal, any folder — normal launch)
2. Claude auto-connects to SSE server
3. CLAUDE.md fires → Claude calls cli_connect__get_inbox
4. Server assigns random short name e.g. "oak-17"
5. Claude announces: "🔌 Connected as oak-17. Say 'call me backend' to name this session."
```

### Naming a Session
```
User: "call me backend"
Claude: calls cli_connect__rename("backend")
Server: creates ~/.claude/commands/claude-backend.md
        deletes ~/.claude/commands/claude-oak-17.md (if existed)
Claude: "✔ This session is now 'backend'. Other sessions can reach you via /claude-backend."
```

### Sending a Task (Session A → Session B)
```
In Session A (named "frontend"):
  User types: /claude-backend analyze auth.py and write unit tests

  Slash command template instructs Claude to call cli_connect__send_message:
    { to: "backend", body: "analyze auth.py and write unit tests" }

  Server: stores message in backend's inbox queue
          triggers OS toast to backend window (node-notifier)
  Claude: "📤 Dispatched to backend (ID: abc-123). Continuing your work."
```

### Receiving & Executing (Session B)
```
In Session B (named "backend"):
  User sends any message → CLAUDE.md fires → cli_connect__get_inbox called
  Server returns: [{ id: "abc-123", from: "frontend", type: "task", body: "analyze auth.py..." }]
  Claude: "📨 Incoming task from frontend: analyze auth.py..."
          [executes the task]
          calls cli_connect__reply({ originalId: "abc-123", body: "Found 3 issues in auth.py. Created 8 tests." })
  Server: stores reply in frontend's inbox
          triggers OS toast to frontend window
```

### Receiving a Reply (Session A)
```
In Session A (named "frontend"):
  User sends any message → CLAUDE.md fires → cli_connect__get_inbox called
  Server returns: [{ type: "reply", from: "backend", body: "Found 3 issues..." }]
  Claude: "📬 backend replied: Found 3 issues in auth.py. Created 8 tests."
          calls cli_connect__acknowledge({ messageId: "..." })
```

### Session Ends
```
User closes Claude Code window
→ SSE connection drops
→ Server auto-removes session from registry
→ Server deletes ~/.claude/commands/claude-backend.md
→ No cleanup needed by user
```

---

## Technical Flow (Step by Step)

### SSE Connection Lifecycle

```
1. Claude Code reads settings.json → sees type:"sse", url:"http://localhost:27182/sse"
2. Claude Code sends: GET /sse (with X-CLI-Connect-Token header)
3. server.js auth middleware validates token
4. new SSEServerTransport('/messages', res) created
   → SSEServerTransport assigns its own internal sessionId (UUID)
   → Sends SSE event: endpoint → /messages?sessionId=<uuid>
5. Claude Code now knows where to POST MCP requests
6. server.js creates: new Server({name:'cli-connect', version:'2.0.0'})
   → Calls buildMCPServer(transportSessionId) → registers all 7 tools
   → server.connect(transport)
7. Connection stored: connections[transport.sessionId] = { shortId, name:null, inbox:[], transport }
```

### MCP Tool Call Flow

```
Claude Code → POST /messages?sessionId=<uuid>
  { jsonrpc: "2.0", method: "tools/call", params: { name: "cli_connect__get_inbox", arguments: {} } }

server.js routes to: transport.handlePostMessage(req, res)
  → SSEServerTransport parses JSON-RPC
  → Calls registered tool handler (closure over transportSessionId)
  → Tool reads/writes connections[transportSessionId]
  → Returns result via SSE stream back to Claude Code
```

### Message Routing

```
Session A calls cli_connect__send_message({ to: "backend", body: "..." })
→ server finds connection where conn.name === "backend"
→ conn.inbox.push({ id: uuid, from: "frontend", type: "task", body, status: "pending" })
→ saveState() → persist.json updated
→ node-notifier toast fires on machine
→ Returns { messageId, queued }

Session B calls cli_connect__get_inbox()
→ server reads connections[B_transportId].inbox
→ filters pending/processing messages
→ marks first pending as "processing"
→ Returns messages array
```

---

## MCP Tools Reference

| Tool | Arguments | Returns | Side effects |
|------|-----------|---------|-------------|
| `cli_connect__get_inbox` | none | `{ session_id, session_name, first_connect, messages }` | Marks first pending → processing |
| `cli_connect__rename` | `{ name: string }` | `{ ok, name }` | Creates slash cmd file, deletes old one |
| `cli_connect__whoami` | none | `{ session_id, session_name }` | None |
| `cli_connect__send_message` | `{ to, body }` | `{ messageId, queued, position? }` | Adds to target inbox, OS toast |
| `cli_connect__reply` | `{ originalId, body }` | `{ ok, replyId }` | Adds to sender inbox, OS toast |
| `cli_connect__acknowledge` | `{ messageId }` | `{ ok }` | Removes message from inbox |
| `cli_connect__list_sessions` | none | `{ sessions: [...] }` | None — reads named sessions only |

---

## Files Changed vs v1

| File | Action |
|------|--------|
| `src/server.js` | **Rewrite** — SSE + MCP + hub combined |
| `src/mcp-bridge.js` | **Delete** |
| `src/commands/new-session.js` | **Delete** |
| `src/commands/setup.js` | **Modify** — SSE URL in settings.json, no service install |
| `src/cli.js` | **Modify** — remove `new` and `stop <name>` commands |
| `src/templates/claude-md-block.tmpl` | **Modify** — new CLAUDE.md instructions |
| `src/commands/list-sessions.js` | Keep |
| `src/commands/stop-session.js` | Keep (repurposed for server stop) |
| `src/templates/claude-peer.md.tmpl` | Keep |
| `src/templates/sessions.md.tmpl` | Keep |
| `package.json` | Keep (same deps) |

---

## State Schema (in-memory + persist.json)

```js
{
  connections: {
    "<transportSessionId>": {
      shortId: "oak-17",         // auto-assigned random name
      name: "backend",           // null until renamed
      inbox: [
        { id, from, to, body, type, status, createdAt, repliedAt, reply }
      ]
    }
  }
}
```

Named sessions only (where `name !== null`) are shown in `/sessions` API and `cli_connect__list_sessions`.

---

## CLI Commands After Revamp

```bash
cli-connect setup    # one-time: token, settings.json, CLAUDE.md, /sessions cmd
cli-connect start    # start server in background
cli-connect stop     # kill server
cli-connect status   # server PID, port, connected sessions, message counts
cli-connect list     # list named sessions
cli-connect logs     # tail server.log
```

---

## Verification Checklist

```bash
# Server
node src/cli.js start
curl http://localhost:27182/health
# → {"ok":true,"version":"2.0.0"}

# SSE connection (simulates Claude Code)
curl -N -H "X-CLI-Connect-Token: $(cat ~/.cli-connect/token)" http://localhost:27182/sse
# → event: endpoint / data: /messages?sessionId=xxx

# Two Claude Code sessions
# Session 1: opens → Claude announces "Connected as oak-17" → user: "call me backend"
# Session 2: opens → Claude announces "Connected as fox-42" → user: "call me frontend"
# Session 2: /claude-backend write hello world
# Session 1: receives task on next turn, executes, replies
# Session 2: sees reply on next turn
```
