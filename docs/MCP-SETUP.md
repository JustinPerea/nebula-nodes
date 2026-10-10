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

The server exposes these canvas tools:

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
- `wait_for_canvas_change`: blocks until the person (or another agent)
  changes the canvas, then returns what changed and who did it. It skips
  your own edits. If you also use the `nebula` CLI, set `NEBULA_AGENT_NAME`
  so both share one name; otherwise your CLI edits arrive as `anonymous`
  (the result then carries a `note`). Pass the returned `cursor` back as `since`; see
  [Watching for changes](#watching-for-changes).
- `resolve_pin`: answers one of the person's pinned notes (from
  `look_at_canvas` `pins`) with a one-line reply, which marks it resolved and
  moves the agent's cursor to it. See [Pins](#pins).
- `propose_change`: proposes new nodes, wires, param changes and runs as
  ghosts on the canvas. Nothing changes until the person clicks Accept. Use
  it before paid runs or reworking their graph. See [Proposals](#proposals).
- `get_proposal`: reads one of your proposals; `wait_seconds` (up to 300)
  waits for the person's decision. On accept it returns `idMap` (your refs to
  real node ids) and `runNodeIds` (what the canvas will run; don't run them
  yourself).
- `withdraw_proposal`: takes back one of your open proposals.

There is no accept tool. Only the person accepts, on the canvas.

Selection is ephemeral. It is not written into `.nebula` graph files or
`~/.nebula/state.json`. Unknown or deleted node IDs are reported only as stale
IDs and are never presented as live handles.

The same context is available without MCP through:

```bash
nebula selection
```

## Agent cursors, `nebula look` and `nebula watch`

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
run states; never persisted), plus `GET /api/canvas/events` (the change
journal, below), `/api/canvas/pins` (the person's notes, below) and
`/api/canvas/proposals` (agents' proposals, below). Cursors, view reports,
the change journal and proposals live in memory only and are lost on
restart; cursors expire two minutes after their last event. Pins are the
person's content and persist with the project.

### Watching for changes

`nebula watch` tells an agent when the person changes something, instead of
the agent re-running `nebula look` in a loop. Each line names who did it:
an agent's name, `Person` (the browser), or `Unnamed client` (a CLI or
script that didn't set `NEBULA_AGENT_NAME`).

```bash
nebula watch                      # stream changes until Ctrl-C (skips your own)
nebula watch --once               # wait for the next batch, print it, exit
nebula watch --once --since 42    # resume after cursor 42 (printed at the end, and by `nebula look`)
nebula watch --kinds node,pin --json --timeout 120
```

`--once` waits up to 600 seconds by default and exits 2 when nothing
changed (`No canvas changes in 600s.`), 0 when it printed events, and 130 on
Ctrl-C. Agents whose shell tool has a time limit (Claude Code's Bash tool
stops commands after 120 s by default) should pass a shorter `--timeout`,
such as 100, and run the command again on exit 2; the in-app agents are told
to do this. A typical loop is `nebula look`, then `nebula watch --once --since
<cursor>` with the cursor from the line before. `--include-self` also shows
your own edits; `--as NAME` sets your name for that filtering.

| Kind | When | Data |
|---|---|---|
| `node.added` / `node.removed` | create, cluster, connect-and-create / delete | definition, name |
| `node.params` | a param changed (only keys whose value changed) | `keys`, redacted `values` |
| `node.moved` | a drag ended, auto-layout or paste moved nodes 8 px or more | `nodeIds`, `count` |
| `edge.added` / `edge.removed` | wired / unwired | source, target and handles |
| `selection.changed` | the selected set changed | `nodeIds`, `count` |
| `run.started` / `run.finished` / `run.failed` / `run.cancelled` | per node, attributed to whoever started the run | `runId`, `error` |
| `canvas.replaced` | import, project opened or created; node ids restart | `reason` |
| `canvas.cleared` | Clear canvas | |
| `pin.added` / `pin.removed` | the person left or deleted a note | `pinId`, `text`, `anchor` |
| `pin.resolved` | an agent answered a note | `pinId`, `text`, `reply` |
| `pin.detached` | a pinned node was deleted, or an import/clear removed it | `pinId`, `anchor` (where the node was) |
| `proposal.created` | an agent proposed a change | `proposalId`, `note`, `adds`, `wires`, `sets`, `runs`, `paidRuns` |
| `proposal.accepted` | the person accepted; the added nodes and wires follow as `node.added` / `edge.added` by the person | `proposalId`, `idMap`, `runNodeIds` |
| `proposal.rejected` | the person rejected | `proposalId`, `reason` |
| `proposal.withdrawn` / `proposal.expired` / `proposal.invalidated` | the agent took it back, 15 minutes passed, or the canvas changed under it | `proposalId`, `reason` |

Expiry is attributed to "Nebula" (a `system` actor), not to anyone.

`GET /api/canvas/events` is a long-poll. Query: `after` (an event cursor;
default "from now"), `journal` (the id from a previous response), `wait`
(seconds, capped at 25), `limit` (1–100), `kinds` (groups like `node` or
exact kinds like `node.params`) and `self=1` to include your own events. It
answers at once when newer events exist, otherwise waits. Resume with
`after=<cursor>`: the cursor also moves past events filtered out for you, so
your own edits never wake you. `gap: true` means the 500-event buffer
overwrote events you hadn't read, and `reset: true` means the backend
restarted; run `nebula look` in both cases. Every event carries the project
id it happened in. Param values go through the same redaction as the
snapshot, and outputs never appear.

### Pins

The person can pin a short note to a node or to a spot on the canvas for
agents ("warmer", "redo this one"): right-click a node and choose **Leave a
note for agents…**, right-click empty canvas for **Leave a note for agents
here…**, or use **Note** in the selection toolbar with one node selected.
Pins show as small badges on the node; hover or click one to read it, see
an agent's reply, or delete it.

Agents read open pins first in `nebula look` (a `PINS` section before
`NODES`), in the snapshot JSON (`pins`, open ones plus answers from the last
ten minutes), and as `pin.*` watch events. Treat an open pin as the person's
request: act on it, then answer in one line:

```bash
nebula pins                                            # list the notes
nebula pin resolve pin_8c41d2aa --say "Warmed the grade on n7"
```

The reply shows on the pin, and the agent's cursor moves there. Over MCP use
`resolve_pin(pin_id, reply)`. Resolving again replaces the reply.

Rules:

- Only the person creates and deletes pins; agents only answer them.
  `POST /api/canvas/pins` and `DELETE /api/canvas/pins/{id}` refuse any
  request that carries an agent marker (`Authorization: Agent`,
  `X-Daedalus-Caller`, `X-Nebula-Agent`, `X-Nebula-Client`), even an invalid
  one, and require a browser `Origin` (or, in the packaged app, the
  per-launch connector session). The CLI and MCP server send no `Origin`.
- `POST /api/canvas/pins/{id}/resolve` needs a named agent
  (`NEBULA_AGENT_NAME`, `--as`, or an in-app agent token).
- Text is plain text: whitespace collapsed, control characters dropped, 1–280
  characters for notes and replies. At most 100 open notes per project and
  200 in total (the oldest answered ones are dropped first).
- Pins persist with the project (on the project record, beside the canvas
  snapshot, so autosave never touches them) and switch with it. Deleting a
  pinned node leaves its pins where the node stood, marked detached; so does
  an import or Clear canvas that removes the node.

### Proposals

An agent can propose a change instead of making it: new nodes, wires, param
changes on existing nodes, and which nodes to run. The person sees ghost
nodes and dashed wires in the agent's colour and a bar at the bottom of the
canvas with **Show**, **Reject** and **Accept** (or **Accept & run (N
paid)**). They can drag ghosts before accepting; the nodes land where they
dropped them. Accept adds everything in one step (one undo) and starts the
runs from the canvas, as if the person had clicked Run. Use proposals before
anything that costs money or reworks the person's graph.

```bash
nebula propose --note "Widen the take and upscale it" \
  --add +up=topaz-image-upscale --param +up.upscale_factor=2 \
  --wire n4:image +up:image --set n4.aspect_ratio=16:9 \
  --run +up --wait --timeout 100
nebula proposal p_9a1c3e02 --wait     # check one later, or wait for the decision
nebula proposal withdraw p_9a1c3e02   # take it back
nebula proposals                      # what's waiting for the person
```

New nodes use refs (`+up`, letters, digits, `_` and `-`, up to 24); existing
nodes use their ids (`n4`). `--at +up=820,140` places a node; otherwise
Nebula puts new nodes to the right of the nodes they connect to, or in the
middle of the person's view, clear of existing nodes. `--file plan.json`
takes the same thing as JSON, which is also the `POST /api/canvas/proposals`
body and the `propose_change` arguments:

```json
{
  "note": "Widen the take and upscale it",
  "nodes": [{"ref": "+up", "definitionId": "topaz-image-upscale", "params": {"upscale_factor": 2}}],
  "edges": [{"source": "n4", "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
  "params": [{"nodeId": "n4", "params": {"aspect_ratio": "16:9"}}],
  "run": ["+up"]
}
```

`--wait` exits 0 when accepted (printing the new ids and what the canvas will
run), 3 when rejected (with the person's reason, if any), 4 when withdrawn,
expired or invalidated, and 2 on timeout (600 s default, still open).

**Cost wording.** Nebula has no price list, so it never shows a price.
Proposals say how many paid model runs and free nodes would run, and from
which providers. Upstream nodes that have no outputs yet are counted too,
and then the count reads "up to", because the run cache may skip some of
them. `cost.estimate` is always `null`.

Rules:

- Proposals are checked like direct edits: unknown node types, ports, params
  or wires, cycles and missing node ids are refused when proposed (400 or
  422), so the person never sees
  something that can't be added. Cinema scene params and World Labs
  durable-recovery nodes can't be proposed.
- Limits: 12 new nodes, 24 wires, 12 param changes and 6 run targets per
  proposal; 3 open per agent and 12 in total (429 beyond); a 160-character
  note. Proposals expire after 15 minutes.
- Deleting a node a proposal refers to invalidates it; so do import, opening
  another project and Clear canvas. If the canvas changed so that a
  proposal no longer fits, Accept fails with 409 and the proposal closes as
  invalidated.
- Proposals live in memory only and are lost on restart.
- Accepting never executes anything on the backend. The canvas starts the
  runs through the same path as its own Run button.

Who can accept: only the person, enforced in three layers.

1. `POST /api/canvas/proposals/{id}/accept` and `/reject` apply the same
   person gate as pins (no agent marker, browser `Origin` or the desktop
   connector session).
2. They also need the proposal's accept key in `X-Nebula-Proposal-Key`. The
   key is random per proposal, sent only over browser WebSockets
   (`proposalOpened` / `proposalSync`), and never appears in the REST views,
   the snapshot, the journal or MCP results.
3. There is no accept command in the CLI or MCP server.

In the packaged app, in-app agents (Claude, Codex, Hermes) start with
`NEBULA_CONNECTOR_SESSION` removed from their environment, so they cannot
borrow the desktop session for layer 1.

Before the click, the bar's "See what Accept writes" list shows every value
Accept will write: new nodes' params and `from → to` for changed params, in
full (up to 4,000 characters per value, with a marker beyond that). These
values reach only the browser (`personValues` in `proposalOpened` /
`proposalSync`); agents see the shortened, redacted view. If a param the
proposal changes was edited after the proposal was made, Accept fails with
409 and the proposal closes as invalidated, so it never overwrites a newer
edit. A proposal arriving while the person reads another never replaces the
one on screen.

Remaining risk: a program running as the same user on the same machine can
set any `Origin` header on the `/ws` handshake, receive the keys and accept,
or read the backend process's environment. These layers stop an agent from approving its own proposal by accident or through
the normal tools; they are not a sandbox against hostile local code.
