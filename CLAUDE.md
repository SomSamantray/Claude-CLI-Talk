# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI-Connect is a local messaging system that lets multiple Claude Code terminal sessions on the same machine send tasks to each other and receive responses asynchronously. It uses an HTTP REST hub (Express.js) as the backbone, with a thin MCP bridge that exposes the hub's API as Claude tools.

## Commands

```bash
# Install dependencies
npm install

# Start the hub server (dev mode)
node src/server.js

# Run the CLI
node src/cli.js <command>

# Run tests
npm test

# Run a single test file
node --test src/__tests__/<file>.test.js

# Lint
npm run lint

# Full setup (installs system service + configures Claude Code)
node src/cli.js setup

# Start a named session (registers + launches Claude Code)
node src/cli.js new <name>

# Verify hub is running
curl http://localhost:$(cat ~/.cli-connect/port)/health
```

## Architecture

The system has 5 components that work together:

**1. Express Hub (`src/server.js`)** — The single source of truth. Runs as a system service (once per machine). Holds session registry and per-session message queues in memory, mirrored to `~/.cli-connect/persist.json` on every state mutation for crash recovery. All inter-session communication flows through this process.

**2. MCP Bridge (`src/mcp-bridge.js`)** — A thin MCP server spawned by Claude Code (one per session). Reads `~/.cli-connect/token` and `~/.cli-connect/port` at startup. Translates Claude's MCP tool calls into HTTP requests to the hub using Node 18+ built-in `fetch`. Also maintains an optional SSE connection for push notifications.

**3. CLI Tool (`src/cli.js`)** — Handles setup, session lifecycle (`new`/`stop`), and generates dynamic slash command files in `~/.claude/commands/`. The `new <name>` command registers with the hub, generates `~/.claude/commands/claude-<name>.md` for all active peers, then launches `SESSION_NAME=<name> claude`.

**4. CLAUDE.md Global Instruction** — The `setup` command appends a block to `~/.claude/CLAUDE.md` (guarded by `<!-- CLI-CONNECT-START/END -->` markers) that instructs every Claude session to call `cli_connect__get_inbox` at the start of every turn. This is how auto-execute works — no OS-level stdin injection, just Claude following instructions.

**5. Dynamic Slash Commands** — `~/.claude/commands/claude-<peer>.md` files generated at session registration time. These are standard Claude Code custom slash commands. When a session deregisters, its command file is deleted.

## Key Data Flow

```
/claude-agentB <task>
  → Claude calls cli_connect__send_message MCP tool
  → MCP bridge: POST /messages/send to hub
  → Hub queues message for agentB (or sets processing if idle)
  → (Optional) SSE push + OS toast to agentB

agentB's next turn:
  → CLAUDE.md fires → Claude calls cli_connect__get_inbox
  → Hub returns queued message, marks processing: true
  → Claude executes task → calls cli_connect__reply
  → Hub stores reply in agentA's queue, sets processing: false

agentA's next turn:
  → get_inbox returns reply → Claude displays it → calls cli_connect__acknowledge
```

## State Schema

The hub's in-memory state (also in `~/.cli-connect/persist.json`):
```js
{
  sessions: { "<name>": { pid, registeredAt, lastSeen, processing } },
  queues:   { "<name>": [{ id, from, to, body, status, sentAt }] },
  replies:  { "<msgId>": { body, from, repliedAt } }
}
```

## Auth

All HTTP requests to the hub require `X-CLI-Connect-Token: <token>` header. The token is a 32-byte hex string at `~/.cli-connect/token`, generated at setup. The MCP bridge and CLI tool read this file at startup. The token is embedded into generated slash command templates at generation time.

## Runtime Files (not in repo)

All runtime state lives in `~/.cli-connect/` (outside the repo):
- `token` — auth token
- `port` — active port (default 27182)
- `persist.json` — state snapshot
- `server.pid`, `server.log`

Slash commands live in `~/.claude/commands/` and are generated/deleted by the CLI tool.

## MCP Tools Reference

| Tool | HTTP call |
|------|-----------|
| `cli_connect__get_inbox` | `GET /messages/inbox/:SESSION_NAME` |
| `cli_connect__send_message` | `POST /messages/send` |
| `cli_connect__reply` | `POST /messages/reply` |
| `cli_connect__acknowledge` | `POST /messages/acknowledge` |
| `cli_connect__list_sessions` | `GET /sessions` |
| `cli_connect__message_status` | `GET /messages/status/:id` |

## Known Constraints

- **Delivery is "next-turn"**: Messages land when the target session's Claude starts its next conversation turn. SSE + OS toast (via `node-notifier`) alerts the user to trigger that turn.
- **No native binary addons**: Pure JavaScript only. `better-sqlite3` and similar are explicitly excluded. Node 18+ required for built-in `fetch` and `crypto`.
- **Session re-registration on restart**: The hub auto-starts as a system service, but individual sessions must run `cli-connect new <name>` again after machine restart.
