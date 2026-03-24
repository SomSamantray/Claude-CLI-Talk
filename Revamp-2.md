# CLI-Connect Revamp-2 Plan

## Problems Being Fixed

1. **Broken auto-bidirectional** — sessions churn after ~2-3 min idle, requiring manual nudge to resume
2. **Permission prompts on Bash** — MCP tools are pre-approved but Bash commands (run during task execution) still prompt every time
3. **Noisy UI** — Claude narrates every intermediate step; user wants only 2 clean lines per message cycle
4. **Too many tool calls** — 8 tools, 3-5 MCP calls per message cycle; can be reduced to 5 tools, 2 calls

---

## Tool Consolidation

### Why 1 tool call is impossible
Receiving a task requires: (1) get message → (2) Claude thinks + executes → (3) send reply.
Steps 1 and 3 are separate MCP calls with reasoning in between. **Minimum is always 2 MCP calls.**

### New 5-tool set (replacing current 8)

| New Tool | Replaces | What it does |
|----------|----------|-------------|
| `cli_connect__poll` | `get_inbox` + `wait_for_message` + `acknowledge` | Checks inbox instantly; if empty, blocks up to 30s. On first call handles session ID/auto-name. **Auto-acknowledges reply messages on delivery.** |
| `cli_connect__send` | `send_message` | Send a message to a named session |
| `cli_connect__reply` | `reply` | Reply to a received task (unchanged) |
| `cli_connect__rename` | `rename` | Name this session (unchanged) |
| `cli_connect__list_sessions` | `list_sessions` | List active sessions (unchanged) |

**Removed:** `get_inbox`, `wait_for_message`, `acknowledge`, `whoami`

### Per-cycle call reduction

| Scenario | Before | After |
|----------|--------|-------|
| Daemon receives task | `wait_for_message` + `reply` = 2 | `poll` + `reply` = **2** |
| Daemon receives reply | `wait_for_message` + `acknowledge` = 2 | `poll` (auto-acks) = **1** |
| Daemon timeout | `wait_for_message` = 1 | `poll` = 1 |
| Sender cycle | `send_message` + `wait_for_message`×N + `acknowledge` = N+2 | `send` + `poll`×N = **N+1** |

---

## File Changes

### 1. `src/server.js`
- Add `cli_connect__poll` to `TOOLS` array
  - On first call: handle `first_connect` + `auto_name` (merged from `get_inbox`)
  - If inbox has pending message: return immediately
  - If inbox empty: block up to 30s (from `wait_for_message`)
  - On REPLY delivery: auto-remove from inbox (eliminates `acknowledge`)
- Add `cli_connect__send` to `TOOLS` array (alias for `send_message` logic)
- Remove `get_inbox`, `wait_for_message`, `acknowledge`, `whoami` from `TOOLS` array (keep handlers for any edge-case backwards compat, but don't expose to Claude)

### 2. `src/templates/claude-md-block.tmpl`
Complete rewrite with:
- **Silent execution**: No text output between tool calls
- **2 summary lines only** per message:
  - Receiving task: `📨 Received from [name]: [preview]` then `📤 Replied to [name]: [summary]`
  - Receiving reply: `📬 [name] replied: [body]`
- **Stronger daemon loop**: Explicit instruction to loop minimum 20 consecutive times before considering stopping; `inbox: timeout` means keep going, not give up

New loop pattern:
```
On every turn:
1. Call cli_connect__poll (handles first_connect + naming automatically)
2. Got TASK → execute → print 2 lines → call cli_connect__reply → enter daemon
3. Got REPLY → print 1 line → enter daemon (poll already auto-acknowledged)
4. Empty/timeout → enter daemon silently

Daemon mode:
- Loop counter = 0
- Call cli_connect__poll
- timeout → counter++ → GOTO loop (NEVER stop, never output anything)
- TASK → execute silently → print "📨 Received from X: ..." + "📤 Replied to X: ..." → reply → counter=0 → GOTO loop
- REPLY → print "📬 X replied: ..." → counter=0 → GOTO loop
- Counter >= 20? → Still loop. Counter is for tracking only, not for stopping.
```

### 3. `src/templates/claude-peer.md.tmpl`
Rewrite `/claude-<name>` command to output only:
- `📤 Sent to [name]: "[message]"` — after send
- `📬 [name] replied: [body]` — when reply arrives (poll auto-acknowledges)
- Nothing else

```
1. Call cli_connect__send: to="{{PEER_NAME}}", body="$ARGUMENTS"
2. Print: "📤 Sent to {{PEER_NAME}}: [message]"
3. Loop:
   a. Call cli_connect__poll
   b. Got REPLY for this message → print "📬 {{PEER_NAME}} replied: [body]" → STOP
   c. Got TASK → execute + cli_connect__reply → continue loop
   d. timeout → continue loop
```

### 4. `src/commands/setup.js`

**In `configureMCP()`:** Update `toolsToAllow` array:
- Remove: `mcp__cli-connect__get_inbox`, `mcp__cli-connect__wait_for_message`, `mcp__cli-connect__acknowledge`, `mcp__cli-connect__whoami`
- Add: `mcp__cli-connect__poll`, `mcp__cli-connect__send`
- Add: `"Bash"` — allows shell command execution without prompting

**Update inline `listen.md`** to match the new daemon loop (using `poll` instead of `wait_for_message`).

---

## Propagation Step

After code changes, re-run setup to apply to `~/.cli-connect/` and `~/.claude/`:
```bash
cd /Users/apple/Documents/Claude-Talk
node src/cli.js stop        # stop old server
node src/cli.js setup       # re-copies server.js + templates, rewrites CLAUDE.md + settings.json
node src/cli.js start       # start updated server
```

---

## Expected UX After Changes

**Frontend session:**
```
⏺ [tool calls - always visible, unavoidable]

📤 Sent to backend: "How are you doing?"
📬 backend replied: "Doing great!"
```

**Backend session:**
```
⏺ [tool calls - always visible, unavoidable]

📨 Received from frontend: "How are you doing?"
📤 Replied to frontend: "Doing great!"
```

No other text. No permission prompts for Bash. Sessions stay in daemon loop ~10-15 min before churning.

---

## Verification

1. `node src/cli.js start` + `curl http://127.0.0.1:27182/health` → `{"ok":true}`
2. Open two Claude Code sessions
3. Session A: `call me backend` → silently enters daemon (no verbose output)
4. Session B: `call me frontend` → `/claude-backend How are you doing?`
5. Backend shows only 2 lines; frontend shows only 2 lines
6. Backend runs a Bash command (e.g. `ls`) → no permission prompt
7. Both sessions stay active for 10+ min without churning
