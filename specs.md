# CLI-Connect — Product Specification

**Version:** 1.0
**Architecture:** Option C — HTTP REST Hub
**Target:** Same-machine multi-session Claude Code coordination

---

## What Is This

CLI-Connect lets N interactive Claude Code terminal sessions on the same machine send tasks to each other, receive responses asynchronously, and discover active peers — all without leaving Claude Code.

**Example:**
```
Session A (agentA): /claude-agentB analyze auth.py and write unit tests
→ agentB auto-executes the task on its next turn
→ agentB's response appears back in agentA automatically
```

---

## User Flow

### First-Time Setup (once per machine)
```bash
npx cli-connect setup
# ✔ Server running on port 27182
# ✔ MCP bridge configured in Claude Code
# ✔ CLAUDE.md updated
# Ready. Start sessions with: cli-connect new <name>
```

### Starting a Session
```bash
cli-connect new backend
# Registers "backend" with the hub
# Opens Claude Code with SESSION_NAME=backend
# Generates /claude-backend slash command for all other active sessions
```

### Sending a Task (from inside Claude Code)
```
/claude-frontend refactor the login component
→ "Message dispatched to frontend (ID: abc123). I'll notify you when they reply."
→ Session A continues working (non-blocking)
```

### Receiving a Task (Session B, automatic)
```
📨 Incoming task from backend: refactor the login component
[Claude B executes automatically]
→ Sends reply back to backend when done
```

### Receiving a Reply (Session A, automatic)
```
📬 frontend replied: Refactored LoginComponent — extracted AuthForm, 3 files changed
```

### Listing Active Sessions
```
/sessions
→ backend (you) — idle
→ frontend     — processing (1 queued)
→ tests        — idle
```

### Stopping a Session
```bash
cli-connect stop backend
# Deregisters from hub, removes /claude-backend command from peers
```

---

## Architecture

```
Claude Session A          Claude Session B
┌──────────────┐          ┌──────────────┐
│ MCP Bridge   │          │ MCP Bridge   │
│ (per session)│          │ (per session)│
└──────┬───────┘          └──────┬───────┘
       │ HTTP POST/GET            │ HTTP POST/GET
       ▼                          ▼
┌─────────────────────────────────────┐
│        Express.js Hub               │
│        localhost:27182              │
│  • session registry (in-memory)     │
│  • per-session message queues       │
│  • SSE push for instant notify      │
│  • persist.json (crash recovery)    │
└─────────────────────────────────────┘

~/.cli-connect/
  server.js         ← Express hub
  mcp-bridge.js     ← MCP server (Claude tool wrapper)
  cli-connect       ← CLI entry point
  token             ← auth token (hex, localhost security)
  port              ← actual port (default 27182)
  persist.json      ← state snapshot, written on every mutation
  server.pid
  server.log

~/.claude/
  CLAUDE.md         ← global inbox-check instruction (appended by setup)
  commands/
    claude-backend.md     ← dynamically created per active peer
    claude-frontend.md
    sessions.md           ← always present (/sessions command)
```

---

## Components

### 1. Express Hub (`server.js`, ~250 lines)

The only source of truth. Runs once per machine as a system service.

**REST API:**
```
GET  /health
GET  /sessions
POST /sessions/register       { name, pid }
DEL  /sessions/:name
POST /sessions/:name/heartbeat

POST /messages/send           { from, to, body }  → { messageId, queued, position? }
GET  /messages/inbox/:name    → { messages: [...] }
POST /messages/reply          { originalId, from, body }
POST /messages/acknowledge    { messageId }
GET  /messages/status/:id
GET  /events/:name            (SSE stream for push notifications)
```

All requests require: `X-CLI-Connect-Token: <token>`

**State schema (in-memory, mirrored to persist.json):**
```js
{
  sessions: {
    "backend": { pid, registeredAt, lastSeen, processing: false }
  },
  queues: {
    "backend": [{ id, from, to, body, status, sentAt }]
  },
  replies: {
    "msg-uuid": { body, from, repliedAt }
  }
}
```

**Queue behavior:** If target session has `processing: true`, incoming messages append to queue. On `reply`, server sets `processing: false` and returns next queued message on next `get_inbox` call.

**Crash recovery:** `persist.json` is written synchronously on every state mutation. On startup, hub reads `persist.json` and restores state. Message loss window: zero (write-before-respond pattern).

---

### 2. MCP Bridge (`mcp-bridge.js`, ~100 lines)

A thin MCP server spawned by Claude Code. Reads `~/.cli-connect/token` and `~/.cli-connect/port` at startup. Translates MCP tool calls into HTTP requests using Node 18+ built-in `fetch`.

**MCP Tools exposed to Claude:**
```
cli_connect__get_inbox          → GET  /messages/inbox/:SESSION_NAME
cli_connect__send_message       → POST /messages/send
cli_connect__reply              → POST /messages/reply
cli_connect__acknowledge        → POST /messages/acknowledge
cli_connect__list_sessions      → GET  /sessions
cli_connect__message_status     → GET  /messages/status/:id
```

Also maintains an optional SSE connection to `/events/:SESSION_NAME`. When SSE fires, calls `node-notifier` for an OS toast notification.

**Claude Code settings.json entry (added by setup):**
```json
{
  "mcpServers": {
    "cli-connect": {
      "command": "node",
      "args": ["~/.cli-connect/mcp-bridge.js"]
    }
  }
}
```

---

### 3. CLI Tool (`cli-connect`)

Commands:
```
cli-connect setup              → full first-time installation
cli-connect new <name>         → register session + launch Claude Code
cli-connect stop <name>        → deregister + cleanup commands
cli-connect list               → show active sessions
cli-connect status             → hub health + session summary
cli-connect logs [--tail N]    → tail server.log
cli-connect restart            → restart hub service
```

`cli-connect new <name>` does:
1. `POST /sessions/register { name }`
2. Writes `~/.claude/commands/claude-<name>.md` for all OTHER active peers
3. Writes `~/.claude/commands/sessions.md` (refresh)
4. Launches `SESSION_NAME=<name> claude`
5. Starts heartbeat: `POST /sessions/<name>/heartbeat` every 30s

`cli-connect stop <name>` does:
1. `DELETE /sessions/<name>`
2. Deletes `~/.claude/commands/claude-<name>.md`
3. Refreshes `sessions.md`

---

### 4. CLAUDE.md Global Instruction

Appended to `~/.claude/CLAUDE.md` by setup. Idempotent (guarded by marker comments).

```markdown
<!-- CLI-CONNECT-START -->
## Inter-Session Messaging (CLI-Connect)

At the beginning of EVERY conversation turn, before anything else:
1. Call MCP tool `cli_connect__get_inbox` (no arguments).
2. For messages with type "task":
   - Announce: "📨 Incoming task from [sender]: [body preview]"
   - Execute the task as if the user had typed it
   - After completing, call `cli_connect__reply` with originalId and response summary
3. For messages with type "reply":
   - Display: "📬 [sender] replied: [body]"
   - Call `cli_connect__acknowledge` with the message id
4. Empty inbox → proceed silently.
<!-- CLI-CONNECT-END -->
```

---

### 5. Dynamic Slash Commands

**`~/.claude/commands/claude-agentB.md`** (generated per active peer):
```markdown
Send a task to agentB and continue working asynchronously.

1. Call MCP tool `cli_connect__send_message`:
   - to: "agentB"
   - body: "$ARGUMENTS"
2. Tell the user: "Message dispatched to agentB (ID: [messageId]).
   I'll notify you when they reply."
3. Do NOT wait or block. Continue your current task.
```

**`~/.claude/commands/sessions.md`** (always present):
```markdown
List all active CLI-Connect sessions on this machine.

Call MCP tool `cli_connect__list_sessions` and display:
- Session name, status (idle/processing), pending message count, active since
```

---

## Installation Flow (`npx cli-connect setup`)

```
1. Install package
2. Generate auth token → ~/.cli-connect/token
3. Find free port (default 27182) → ~/.cli-connect/port
4. Write server.js, mcp-bridge.js, cli-connect to ~/.cli-connect/
5. Register hub as system service:
     macOS:   ~/Library/LaunchAgents/com.cli-connect.hub.plist
     Linux:   ~/.config/systemd/user/cli-connect-hub.service
     Windows: Task Scheduler (schtasks /create, runs at login)
6. Start service immediately
7. Verify: GET /health → {"ok":true}
8. Add MCP config to ~/.claude/settings.json
9. Append instruction block to ~/.claude/CLAUDE.md
10. Write ~/.claude/commands/sessions.md
11. Print success + next steps
```

---

## Tech Stack

| Package | Purpose |
|---------|---------|
| `express` | HTTP hub server |
| `@modelcontextprotocol/sdk` | MCP server (mcp-bridge) |
| `node-notifier` | Cross-platform OS toast notifications |
| `commander` | CLI argument parsing |
| `uuid` | Message ID generation |
| Node 18+ `fetch` (built-in) | HTTP client in MCP bridge |
| Node 18+ `crypto` (built-in) | Token generation |

**No native binary addons. Pure JavaScript. Node 18+ required.**

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backbone | HTTP REST | Universal, curl-debuggable, no native deps |
| Auto-execute | CLAUDE.md + get_inbox | Only portable option across all terminal types |
| Delivery timing | On next Claude turn | Fundamental Claude Code constraint (no stdin injection) |
| Notification | SSE + node-notifier toast | Best-effort real-time, polling as always-on fallback |
| Persistence | persist.json on every write | Crash safety without SQLite binary |
| Auth | Token file (localhost-only) | Prevents accidental cross-process calls |
| Session naming | User-chosen via `cli-connect new <name>` | Predictable, memorable |
| Slash commands | Dynamic .md files per peer | Native Claude Code custom command system |

---

## Constraints & Limitations

- **Same machine only** (by design for v1.0)
- **"Next turn" delivery latency**: Messages are delivered when the target session's Claude starts its next turn — not in real-time. SSE + OS notification alerts the user to interact with the target session.
- **No terminal injection**: Claude Code does not support programmatic stdin injection. Auto-execute requires the user to have an active conversation in the target session.
- **Session persistence**: Sessions must be re-registered with `cli-connect new <name>` after machine restart (hub auto-starts, but sessions don't auto-register).

---

## Future Extensions (out of scope for v1.0)

- Broadcast messages to all sessions simultaneously
- Session groups (send to "all-workers")
- Message history / audit log
- Web dashboard UI (trivially addable on top of REST API)
- Cross-machine support via optional cloud relay
