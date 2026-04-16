# Nebula Chat Panel — Handoff Document

## What to Build

A web-based chat panel in the Nebula Nodes frontend that acts as a frontend for Claude Code running in the background. The user types natural language, Claude Code executes with full skill access (including the nebula skill), and nodes appear on the canvas in real-time.

## Architecture

```
Browser Chat Panel ←→ WebSocket /ws/chat ←→ Backend spawns `claude -p` per message
                                              └→ claude -p --resume <session-id>
                                                  --dangerously-skip-permissions
                                                  --output-format stream-json
                                                  --model <selected-model>
                                                  "user message"
```

Each user message spawns a `claude -p` call with `--resume` to continue the same conversation. Claude Code manages session persistence internally — the backend just passes the session ID. This avoids managing persistent child processes, PTY buffering, or zombie processes.

## Requirements

1. **Chat panel** — sidebar or drawer in the frontend, alongside the node canvas
2. **Persistent sessions** — uses `claude --resume <session-id>` so conversation context carries across messages
3. **Model selection** — `/model sonnet`, `/model opus`, etc. intercepted client-side, changes the `--model` flag on subsequent calls
4. **Skip permissions** — every call includes `--dangerously-skip-permissions`
5. **Streaming output** — `--output-format stream-json` gives structured events (text, tool calls, errors). Stream these to the browser via WebSocket so the user sees Claude think in real-time
6. **Nebula skill fires automatically** — it's in `~/.claude/skills/nebula/`, Claude Code picks it up
7. **Canvas sync works** — CLI graph commands broadcast `graphSync` WebSocket events that the frontend already handles (this is already built and working)

## Key Technical Details

### Backend: `claude -p` with streaming

```python
import subprocess
import json

proc = subprocess.Popen(
    [
        "claude", "-p",
        "--resume", session_id,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--model", model,
        message,
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    cwd="/Users/justinperea/Documents/Projects/nebula_nodes",
)

# Read line by line, each line is a JSON event
for line in proc.stdout:
    event = json.loads(line)
    # Forward to browser via WebSocket
```

### Stream JSON event types (from Claude Code)

The `--output-format stream-json` emits these event types:
- `{"type": "assistant", "message": {...}}` — Claude's text response chunks
- `{"type": "tool_use", "tool": "Bash", "input": {...}}` — tool calls
- `{"type": "tool_result", ...}` — tool outputs
- `{"type": "result", "text": "..."}` — final response

Research the exact format by running: `echo "hello" | claude -p --output-format stream-json`

### Frontend: Chat Panel component

- Lives in `frontend/src/components/panels/ChatPanel.tsx`
- Toggle via toolbar button (like the existing Nodes/Settings panel toggles)
- Message list with user/assistant bubbles
- Input box at bottom with send button
- `/model <name>` intercepted before sending — updates local state, shows confirmation
- `/clear` starts a new session
- Tool calls shown inline (collapsible, like Claude Code's terminal output)
- Streaming text renders as it arrives

### Model Selection

- Default: `sonnet` (or whatever Claude Code defaults to)
- `/model opus` → sets `currentModel = "claude-opus-4-6"` in state
- `/model sonnet` → sets `currentModel = "claude-sonnet-4-6"`
- `/model haiku` → sets `currentModel = "claude-haiku-4-5-20251001"`
- Display current model in the chat panel header
- The `--model` flag is passed on every `claude -p` call

### Session Management

- On first message, generate a UUID session ID
- Store in frontend state (persists across messages, lost on page refresh)
- `/clear` generates a new session ID (fresh conversation)
- The `--resume` flag tells Claude Code to continue the conversation

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `backend/services/chat_session.py` | Create | Spawn claude process, stream output |
| `backend/main.py` | Modify | Add WebSocket endpoint `/ws/chat` |
| `frontend/src/components/panels/ChatPanel.tsx` | Create | Chat UI component |
| `frontend/src/components/panels/Toolbar.tsx` | Modify | Add chat toggle button |
| `frontend/src/store/uiStore.ts` | Modify | Add chat panel state |
| `frontend/src/styles/panels.css` | Modify | Chat panel styles |

## Existing Infrastructure to Leverage

- **WebSocket**: Already have `ConnectionManager` in main.py and `wsClient.ts` in frontend — but the chat needs its own WebSocket endpoint (`/ws/chat`) since it's a different protocol than execution events
- **Panel system**: `uiStore.ts` already has `togglePanel()` for library/settings panels — add 'chat' panel
- **Toolbar**: Already has buttons for Nodes, Settings, Save, Load, CLI — add Chat
- **Real-time canvas sync**: Already working — when Claude runs nebula commands, nodes appear on canvas via `graphSync` WebSocket events through the existing `/ws` connection

## Current Project State

- Branch: `feat/3d-mesh-support` — 19 commits, working tree clean
- 93 nodes defined, 112 tests passing
- CLI fully operational: 15 commands, all verified
- Nebula skill at `~/.claude/skills/nebula/SKILL.md` — working, tested with Sonnet
- Backend on :8000, frontend on :5173
- Real-time CLI→canvas sync via WebSocket (graphSync events) — works for graph mode, not quick mode
- CLI button in toolbar for manual import

## Known Issues / Notes

- `nebula quick` (one-shot mode) doesn't populate the CLIGraph, so no graphSync events fire. Only `nebula create`/`connect`/`run-all` (graph mode) syncs to canvas. The skill already knows both patterns.
- Settings.json has live API keys — don't commit it or push to GitHub
- The `claude` binary must be in PATH. On this machine it's installed via npm.
- `--output-format stream-json` format should be verified first — run a test and inspect the actual JSON structure before building the parser
