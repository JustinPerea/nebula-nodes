# Nebula Nodes MCP setup

To connect a Krea account for Nebula's agents and Canvas/Create generation,
use **Settings → Connections → Krea**. [Krea MCP setup](KREA-MCP.md) explains
sign-in, saved connection choices and workspace billing.

Nebula includes a local stdio MCP server that exposes the active canvas
selection to external agents. The normal FastAPI backend must already be
running because the MCP process reads the same authoritative graph state as the
canvas and CLI.

Configure an MCP host to launch:

```text
<repo>/backend/.venv/bin/python <repo>/backend/mcp_server.py --url http://127.0.0.1:8000
```

The server exposes three tools:

- `get_selected_nodes`: selected node IDs, display names, bounded/redacted
  parameters, output-port availability, and connections touching the
  selection.
- `look_at_canvas`: the canvas as data, so an agent doesn't need a
  screenshot. It returns the browser's viewport and visible area, every node
  with its run state, position, size and whether it is on screen, redacted
  parameters, output availability, wires, the selection, and agent cursors.
  `view.stale` is true when no browser has reported for 30 seconds.
- `point_at`: moves the agent's cursor on the canvas to a node, a port or a
  flow-space point, with an optional line of narration (`say`) and an
  optional drag gesture (`from_node_id`/`from_port`). The cursor is named
  after `$NEBULA_AGENT_NAME`, or the MCP client's own name.

Selection is ephemeral. It is not written into `.nebula` graph files or
`~/.nebula/state.json`. Unknown or deleted node IDs are reported only as stale
IDs and are never presented as live handles.

The same context is available without MCP through:

```bash
nebula selection
```

## Agent cursors and `nebula look`

Agents that change the canvas over HTTP get a live cursor in the browser, so
the person can watch where they work. The backend names the cursor from the
request:

| Request carries | Cursor name | Notes |
|---|---|---|
| `Authorization: Agent <token>` (in-app Claude/Codex chats) | Claude, Codex | Verified by the token registry |
| `X-Daedalus-Caller` | Daedalus | Set by the Daedalus runtime |
| `X-Nebula-Agent: <name>` | that name | Self-reported; set `NEBULA_AGENT_NAME` for the CLI |
| none of these (the browser itself) | no cursor | Your own clicks never spawn one |

Creating, wiring, setting, running, removing and unwiring nodes move the
cursor automatically (a wire shows as a drag from port to port). To point or
narrate explicitly:

```bash
NEBULA_AGENT_NAME="Claude Code" nebula point n2 --say "Checking this prompt"
nebula point n2.prompt --from n1.text --say "Wiring the prompt in"
nebula look          # the canvas as text; --json for the full snapshot
```

The REST surface is `POST /api/canvas/cursor`, `GET /api/canvas/snapshot`, and
`POST /api/canvas/view` (the browser's own report of viewport, node bounds and
run states; never persisted). Cursors and view reports live in memory only and
cursors expire two minutes after their last event.
