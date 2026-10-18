# Nebula Nodes MCP setup

To connect a Krea account for Nebula's agents and Canvas/Create generation,
use **Settings → Connections → Krea**. [Krea MCP setup](KREA-MCP.md) explains
sign-in, saved connection choices and workspace billing.

Nebula includes a local stdio MCP server that lets an agent work on the
person's open canvas: read it, build on it, run nodes and look at what they
made. It suits clients without a shell (Claude Desktop, Cursor) as well as
coding agents. The normal FastAPI backend must already be running because the
MCP process reads the same authoritative graph state as the canvas and CLI.

Configure an MCP host to launch:

```text
<repo>/backend/.venv/bin/python <repo>/backend/mcp_server.py --url http://127.0.0.1:8000
```

[Connect your agent](#connect-your-agent) does this for you: Settings (or
`nebula mcp connect <app>`) gives the agent its own token, cursor name and
color, and daily limit, and shows the exact config for Hermes, OpenClaw,
Claude Desktop, Claude Code, Cursor or Codex.

The server exposes these tools for building and running (see
[Building and running over MCP](#building-and-running-over-mcp)):

- `find_nodes`: node types to build with, best matches first, each with
  `runsWith` (key, free, krea, nous) and a list `price` at default settings.
  `ready_only=false` also lists nodes that can't run here, with what's
  `missing`. "free" is at the node's defaults: a row with `needsKeyFor` (the
  Video QC nodes) calls a provider in another mode.
- `describe_node`: one node type's ports, params (options, defaults, ranges)
  and list prices by the params that set them. A local node that still calls
  a provider also has `runsWithOptions`: readiness per value of the param that
  picks the provider (Cinema Scene's `scene.base.model`, a QC node's `mode`),
  and a note when another value would run with the keys set here. A QC
  node's `pricedWhen` lists the price rows of its paid modes (Jev). A
  multi-provider node (FLUX.2, FLUX 3, Krea 3) has `providerChoice` and
  `routes`: per provider, its `params` exactly as the card shows them there
  (values cut, ranges narrowed, `onlyWhen`; a setting the provider doesn't
  offer is absent and named in `hides`), `price`, `priceUnconfirmed`, `note`
  and `block`. A saved value of a setting the route doesn't offer stops the
  run when another route would use it. The fix comes as `fixes` (plain param
  edits) on a `propose_change` cost entry; a run error or the estimate gives
  it as a sentence in its message. `_provider` changes go through
  `propose_change`. See
  [Provider routes](PROVIDER-ROUTES.md#hidden-settings-paramvisiblewhen).
- `edit_canvas`: adds nodes, wires, param changes, renames and moves in one
  call, all or nothing. Same shape as `propose_change`.
- `remove_from_canvas`: deletes nodes or single wires, all or nothing.
- `run_nodes`: runs a node and what feeds it (or the whole canvas) under the
  person's spending limits. Returns outputs with small inline previews, or
  `running` and a run id.
- `get_run` / `cancel_run`: collect or stop a run that is still going.
- `view_output`: a node's output as an image (videos as three frames, image
  lists as tiles), or as text.
- `get_spend_limits`: the limits and what this session has used.
- `list_projects` / `open_project` / `new_project`: list the person's saved
  projects, switch the canvas to one, or start a new, empty one. The project
  that was open is saved as it is. The person's canvas follows, shows a note
  naming the agent, and offers a button back to the project they had open.
  Start new work in a new project rather than emptying the canvas: clearing
  a canvas that has nodes can't be undone, so the backend refuses it from
  agents.

And these canvas tools:

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
| `Authorization: Agent <token>` (in-app chats, from their Nebula MCP server or CLI) | Claude, Codex | Verified by the token registry |
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
| `node.renamed` | a node got a new name on the canvas (or went back to its model name) | `from`, `to` |
| `edge.added` / `edge.removed` | wired / unwired | source, target and handles |
| `selection.changed` | the selected set changed | `nodeIds`, `count` |
| `run.started` / `run.finished` / `run.failed` / `run.cancelled` | per node, attributed to whoever started the run | `runId`, `error` |
| `run.skipped` | a gate upstream (Jev Decide's On Pass / On Fail) withheld the node's input, so it never ran | `runId`, `reason`, `gateNodeId` |
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

### Who counts as the person

Some actions are the person's alone. The backend knows the person by one
secret per launch, the **person token** (`backend/services/person_session.py`,
checked in `backend/services/person_gate.py`):

- Browser dev: `backend/devserver.py` makes it and prints (or, with
  `--open`, opens) `http://localhost:5173/#nebula-person=<token>&backend=<origin>`.
  The canvas moves it into that tab's sessionStorage, strips it from the
  address bar, and from then on talks only to that backend (no port
  discovery). It never goes into an environment variable, argv or a file.
- Packaged app: Electron main makes it, writes it to the sidecar's stdin, and
  hands it over IPC only to the app's own main frame. With
  `NEBULA_DESKTOP_DEBUG_PORT` set there is no token at all, so person-only
  actions stay locked and the window says why.

  Checked in the packaged app (2026-10-13; Electron 44, validation bundle,
  isolated profile; `desktop/README.md` and `implementation-notes.md` have
  the method):
  - The renderer's page origin is `file://`. Its HTTP requests carry **no**
    `Origin` header and send no CORS preflight, and it reads responses
    without `Access-Control-Allow-Origin`, so CORS plays no part; the token is
    the only gate. Its `/ws` handshake sends `Origin: file://`, which
    `services/local_guard.py` allows.
  - With the token: `PUT /api/settings` 200 (403 without), `GET
    /api/agent/spend` answers `limited: false` (`limited: true` without), the
    `/ws` hello gets `proposalSync` (a wrong token gets `personRequired`), and
    the Krea connection status reads `disconnected` while check and disconnect
    answer 200 (403 `person_required` without). The smoke run
    (`npm run test:smoke`, isolated profiles) repeats all of these.
  - While the app runs, no process has `nebula-connector-session` in its argv,
    and neither the person token nor any provider key or the Krea vault key is
    in any of its processes' argv or environment (`ps -E`). Keys and the vault
    key go over the sidecar's stdin after the token
    (`services/launch_secrets.py`); before this check they were in its
    environment. Provider keys and `NEBULA_APP_TOKEN`/`NEBULA_AGENT_TOKEN`
    inherited from a launching terminal are dropped from it as well
    (`sidecar.mjs` `INHERITED_CREDENTIAL_ENV_KEYS`).

The canvas sends it as `X-Nebula-Person` on every write and on
`GET /api/agent/spend`, in a `{type: "hello"}` frame on `/ws`, and as
`personToken` on every `/ws/chat` send. A request is the person's only when it
carries no agent marker (`Authorization: Agent`,
`X-Nebula-Agent`, `X-Nebula-Client`) and does carry a valid token. `Origin`
proves nothing: any local program can write `Origin: http://localhost:5173`.
(The Host/Origin guard in `services/local_guard.py` still keeps websites out.)

Person-only, refused with 403 `person_required` otherwise:

- creating and deleting pins; accepting and rejecting proposals (plus the
  per-proposal accept key, sent only to a `/ws` that said hello as the person);
- `PUT /api/settings` (every field), `DELETE /api/settings/api-keys/{provider}`,
  `POST /api/credentials/update`, and `POST /api/agents/codex/login/chatgpt`
  (it runs `codex logout` first, clearing the person's Codex sign-in);
- starting or releasing a run approved on Accept (`approvalId` on
  `/api/execute` and `/api/execute-node`, `DELETE /api/canvas/approvals/{id}`;
  see Proposals below);
- Krea connect, check, disconnect and trial (`/api/krea/connection/connect`,
  `/api/krea/connection/check`, `DELETE /api/krea/connection`,
  `/api/krea/trial`). `GET /api/krea/connection`, `/api/krea/tools` and
  `/api/krea/tools/call` stay open;
- making, limiting, coloring and revoking connected-agent tokens
  (`/api/agent/spend/apps`; see Connect your agent below);
- starting any `/ws/chat` turn (Claude, Codex), so no chat
  workspace or agent token is minted without the person;
- `POST /api/enhance-prompt`, the Create button's rewrite. The gate comes
  first; then prompts over 4,000 characters get a 413 that says so, and more
  than 20 calls a minute get a 429. Each call logs provider, length and outcome
  (never the prompt) to `nebula.enhance_prompt`. An agent that wants a prompt
  rewritten writes it itself, or adds a text node (`claude-chat`,
  `gpt-4o-chat`, `gemini-chat`), whose run is held to the spending limits.

Everything else, including running nodes, is open to agents and held to the
spending limits. The person isn't limited.

Every process the backend starts (agents, the Commons reader, ffmpeg, the
Remotion renderer, git, `open`, `ps`, `sips`, `brctl`) gets the backend's
environment minus `NEBULA_PERSON_TOKEN`, `NEBULA_CONNECTOR_ENCRYPTION_KEY`,
`NEBULA_INJECTED_KEYS`, `NEBULA_CONNECTOR_SESSION`, `NEBULA_APP_TOKEN` and
`NEBULA_APP_TOKEN_FILE` (`services/child_env.py`). The desktop app no longer sets
the vault key or the injected keys in the backend's environment at all; the
scrub catches a hand-started backend that does.

Remaining risk, plainly: a program running as you with its own unsandboxed
shell can still read the token (the backend's memory, Chrome's on-disk Session
Storage and History). The token binds the in-app agents (Claude; Codex, whose
shell has no network; see "In-app agents use this server") and any client that reaches Nebula only through its MCP server,
CLI or API. It does not bind an outside agent with its own shell and network.
It is not a sandbox against hostile local code.

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
  `X-Nebula-Agent`, `X-Nebula-Client`), even an invalid
  one, and require the person token (see "Who counts as the person"). The
  CLI and MCP server never have it.
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

**Cost wording.** Proposals say how many paid model runs and free nodes
would run, and from which providers. Upstream nodes that have no outputs yet
are counted too, and then the count reads "up to", because the run cache may
skip some of them. `cost.estimate` adds up list prices in USD from
`backend/data/model_pricing.json`, where every price cites the vendor page it
came from: `{currency, low, high, open, unpriced, plan, plus}`. `low` and
`high` differ when a setting such as `auto` quality only resolves at run time
or a batch repeats a node. `open` is true when some paid node has no list
price (`unpriced`) or has a cost the vendor doesn't price up front (`plus`,
e.g. input images), so the real total can be higher. Krea runs billed to a
Krea account's plan are listed in `plan`. `estimate` is `null` when no node
in the run has a list price. Each entry in `cost.nodes` carries its own
`price` ({low, high} or null). These are list prices, not a quote.

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
- Accept approves values, not just node ids (`backend/services/run_approvals.py`).
  Accept refuses (409, invalidated) if anything the listed runs would start
  changed since the proposal was made: a node's settings, its wires in, or a
  node gone. After Accept, every node those runs can start is locked against
  edits by anyone but the person until the canvas starts the run: set params,
  `apply`, wire, unwire and delete on them return 409 ("in a run the person
  approved ... hasn't started yet"). The canvas sends the approval id from the
  accept response with its run (also when the run waits for another to
  finish), and the backend starts it only if the live graph and the request
  still match what was accepted ("changed since you accepted" otherwise; the
  person can then run it by hand). An approval is used up by that run, and
  also ends when the person dismisses the waiting run, on import, project
  switch or Clear canvas, and after 30 minutes.

Who can accept: only the person, enforced in three layers.

1. `POST /api/canvas/proposals/{id}/accept` and `/reject` apply the same
   person gate as pins (no agent marker, and the person token).
2. They also need the proposal's accept key in `X-Nebula-Proposal-Key`. The
   key is random per proposal, sent only over `/ws` sockets that said hello
   with the person token (`proposalOpened` / `proposalSync`), and never appears in the REST views,
   the snapshot, the journal or MCP results.
3. There is no accept command in the CLI or MCP server.

In-app agents (Claude, Codex) are never handed the person token: it
is in no environment, argv or file the backend gives them. Codex can read the
browser's storage on disk but its shell has no network to use it with (see
"In-app agents use this server").

Before the click, the bar's "See what Accept writes" list shows every value
Accept will write: new nodes' params and `from → to` for changed params, in
full (up to 4,000 characters per value, with a marker beyond that). These
values reach only the browser (`personValues` in `proposalOpened` /
`proposalSync`); agents see the shortened, redacted view. If a param the
proposal changes was edited after the proposal was made, Accept fails with
409 and the proposal closes as invalidated, so it never overwrites a newer
edit. A proposal arriving while the person reads another never replaces the
one on screen.

Remaining risk: a program running as the same user with its own unsandboxed
shell can read the person token (see "Who counts as the person"), say hello
on `/ws`, receive the keys and accept. These layers stop an agent from
approving its own proposal through Nebula's tools and API; they are not a
sandbox against hostile local code.

### Spending limits

The person decides what agents may spend, in **Settings > Preferences**:

- **Ask before costly runs** (default $1): the canvas asks the person before
  a run that could cost this much, and an agent run at or over it is refused.
  Off means no per-run limit.
- **Per chat session**: the most one agent chat may run in total.
- **Agents outside Nebula chats**: what every agent without a Nebula chat
  (Claude Desktop, terminal tools, scripts) may run together over the last 24
  hours. Unset, it is the per-session amount. Restarting Nebula doesn't reset it.
- **Krea plan runs**: how many runs one chat, or the outside agents over 24
  hours, may bill to the signed-in Krea plan. Default 10 until you pick a
  number; "Ask every time" (0) makes every plan run a proposal, and only "No
  limit" lifts it.
- **Limit a model**: a per-run limit that replaces the general one for that
  model, a session budget for it (for outside agents, over 24 hours), or both.
- **Connect your agent**: a token per outside agent app, with its own optional
  daily limit (see "Connect your agent" below).

Any limit also makes an agent ask before running a node with no list price,
since Nebula can't check it. That includes a Video QC node in vision-llm mode (it calls a vision model,
which has no list price; Jev mode is priced per request) and a node whose priced setting arrives by wire (Krea Kling 3.0's
`multi_prompt` port), or is set to something the price list doesn't cover
(multi-shot Kling). Free nodes always pass. The person's own runs from the
canvas are never limited.

How it works (`backend/services/agent_spend.py`):

- Every run route checks it (`/api/execute`, `/api/execute-node`,
  `/api/graph/run`, `/api/quick`, `/api/cinema/generate-shot`), after the
  graph is validated, for any caller that isn't the person's canvas (the same
  person gate as pins and proposals).
- The cost is the upper estimate at list prices over every node the run
  includes, batches counted. Nebula can't know in advance what the cache will
  skip, so the estimate never undercounts.
- A cinema scene counts as its base image model (`scene.base.model`, default
  `seedream-4-5`), once per shot, and falls under that model's own limits. A
  base without a list price means the run must be proposed. A shot request
  with `variations` counts once per variation, because each one runs again
  with the cache off.
- A run counts against the session when it starts, at that estimate. Nodes
  that made no provider request get their share back, because they can't
  have cost anything:
  - a node that stops at its own key check before any provider request (its
    handler raises `MissingCredentialError`);
  - a node that never reached its handler: answered from the cache, held
    back by an upstream failure, or the run stopped first. This is settled
    when the run ends (`execution/provider_calls.py`);
  - every node of a request refused after the check but before the run
    started.

  A node whose handler was called stays counted, even if it failed. The
  limit is still checked on the whole estimate first, since what the cache
  skips is only known by running. The keys are not: each run route reads
  settings once and hands the same snapshot to the check and to the run, so
  the route priced (a dual-route node, which vision model QC calls) is the
  route billed.
- Whose total a run counts against:
  - `chat:<session>`: the in-app Claude and Codex chats each get
    their own session budget, from the agent token Nebula mints for each chat.
  - `outside:shared`: everything else (outside agents, scripts). A name or
    header is the caller's to set, so renaming can't buy a fresh budget, and
    the key is the same every launch, so restarting the backend can't either.
    It counts events from the last 24 hours: a refund lands at the time of
    the run it refunds, never in a later window, and older events are dropped
    when the file is saved. Budgets from before this change
    (`unverified:<launch>`) were folded in once, counted at their last update.
  - `outside:app:<id>`: an app the person gave a token (below). Its own daily
    limit applies, and its runs also count in `outside:shared`; both are
    checked and the stricter wins, so a token never adds headroom.

  Totals are kept in `~/.nebula/agent-spend.json`.
- Krea plan runs: a node billed to the signed-in Krea plan has no per-call
  price (Krea charges compute units it doesn't publish per model), so it is
  counted as runs: batch runs times a cinema scene's shots times variations.
  A run that would go over "Krea plan runs" needs a proposal. Left unset, the
  limit is 10; a saved value Nebula can't read counts as 0 (every plan run
  asks), and only the person's "No limit" (`null`) lifts it. The runs are
  always counted and shown, and the same give-back rules apply. An agent
  can't move a node onto the plan itself; anything that isn't the person
  gets a 403 pointing at `propose_change` when it would change `_kreaAuth`,
  or bring in a node that offers both modes already set to `mcp`:
  - edits: `edit_canvas` (`/api/graph/apply`), `nebula set`/`create`
    (`/api/graph/node`), `/api/graph/node-and-connect`, `/api/graph/cluster`
    and `/api/graph/import`;
  - project snapshots: `PUT /api/projects/{id}` and `/api/projects/recover`
    (opening a project loads its snapshot onto the canvas), compared with the
    live canvas and the project as saved;
  - runs that take nodes in the request: `/api/execute`, `/api/execute-node`
    and `/api/quick`. A node there may bill only the way the canvas node with
    its id and definition does; any other node starts on the API token. A
    run's params are written back to the canvas only onto a node of the same
    definition, and for a run that isn't the person's only what the run
    itself changed, never `_kreaAuth`.

  Proposals carry `_kreaAuth`, and the person's Accept applies it. Nodes that
  offer only the plan (Krea Files, Moodboards) have nothing to switch.
- A refusal is a 403 whose message names the cost, the limit and the exact
  `nebula propose ... --run <node>` to send instead. Accepting a proposal is
  the person's approval, so the canvas runs it without checking a limit.
- Only the person can change the limits: `PUT /api/settings` refuses every
  change from anyone without the person token.

`nebula spend` (or `GET /api/agent/spend`) shows an agent its limits and what
its session has used. `budget` is `chat`, `shared` or `app`; outside callers
also get `outsideSpent`, the shared 24-hour total.

### Personal agents' session tokens

A personal agent (your own Claude Code, Codex, Gemini or custom ACP agent in the
chat panel, [PERSONAL-AGENTS.md](PERSONAL-AGENTS.md)) gets a session token
that Nebula writes to a 0600 file (`<state dir>/agent-tokens/<pid>/<session>.token`).
The `env` of this MCP server's entry in ACP `session/new` carries only the
file's path, as `NEBULA_AGENT_TOKEN_FILE`, with `NEBULA_AGENT_NAME` set to the
agent's name, because adapters may put that environment on a command line
(the Claude adapter's `claude --mcp-config <json>`). At startup this server
reads the file into its own `NEBULA_AGENT_TOKEN` and exits if the file is
missing, unreadable, open to other users or malformed. The token's record names its budget outright: `outside:personal:<agentId>`, inside
the shared outside budget, with its own line in Settings once it has spent in
the last 24 hours (`GET /api/agent/spend/apps` returns every one under
`personal`). `/api/agent/spend`
reports `budget: "shared"` for it. The token is revoked, and its file deleted,
when the chat session ends. `agent_spend.PERSONAL_AGENT_BUDGET = "chat"` would give each personal
chat its own session budget instead.

### Connect your agent

Bring an agent you already use (Hermes, OpenClaw, Claude Desktop, Claude Code,
Cursor, Codex or any other MCP client) onto the canvas. It stays in its own
app with its own memory, skills and tools, and calls Nebula's MCP server. On
the canvas it is a cursor with the name and color you gave it.

```mermaid
flowchart LR
  S["Settings > Connect your agent<br/>pick app, name, color, daily limit"] -->|"POST /api/agent/spend/apps<br/>(person only)"| T["App token<br/>saved to state/app-tokens/id.token (0600)"]
  T -->|"Settings shows the exact config<br/>(names the file, not the token)"| C["Agent app config<br/>(config.yaml, mcp.json, claude mcp add...)"]
  C -->|starts over stdio| M["backend/mcp_server.py<br/>NEBULA_URL or NEBULA_URL_FILE<br/>+ NEBULA_APP_TOKEN_FILE"]
  T -.->|read at startup| M
  M -->|"Authorization: Agent token"| B["Nebula backend<br/>its own spending line + named cursor"]
```

**In Settings.** Settings > Preferences > Agent spending > **Connect your
agent**: pick the app, name the agent, pick a cursor color (or keep the
automatic one) and a daily limit, then Connect. Nebula makes a token, writes
it to `<state dir>/app-tokens/<app id>.token` (`~/.nebula` for a dev backend;
the folder 0700, the file 0600, created without following symlinks and never
over an existing file; `services/app_token_file.py`), and shows the exact
config for that app. The config names the token file. It never holds the
token, so the token isn't in the app's config file, on a command line, in your
shell history or on the Settings screen. The store, `app-tokens.json` (mode
600), keeps only the token's SHA-256. Revoking the app deletes its token file;
at startup the backend also deletes any file whose app is no longer active
(revoked while the delete failed, say). If it can't read `app-tokens.json` at
startup, it deletes nothing. The `app-tokens` folder is protected like the
Commons store: graph and media paths and in-app agents can't read it.

To change a connected agent's cursor color later, click the color dot beside
its name in the list and pick another (or the automatic one).

Settings also shows the same setup as one `nebula mcp connect <app>
--token-file <file>` command for the apps the CLI can set up (Claude Code,
Codex, Claude Desktop, Cursor). See "From the terminal" below.

The `POST` response still carries the raw `token` field, for scripts that
call the route. Settings doesn't display it. For a plain token (no app picked,
or a packaged app) it shows the file's path and offers a "Show the token"
button for an app that can't read a file.

Each config starts this checkout's server the same way:

- command: `<repo>/backend/.venv/bin/python` (the venv's own path, not the
  interpreter it links to);
- args: `<repo>/backend/mcp_server.py`;
- env: `NEBULA_APP_TOKEN_FILE` (the token file's absolute path), and where to
  find Nebula:
  - a dev backend (`backend/devserver.py`, uvicorn) has a port you chose, so
    the config has `NEBULA_URL`, the address the request arrived on;
  - the desktop app's sidecar gets a new port every launch, so the config has
    `NEBULA_URL_FILE` instead: `<state dir>/backend-url`, which the backend
    rewrites (mode 600) each time it starts and removes when it quits. The MCP
    server reads it on every call, so a client that started before you
    reopened Nebula still finds it, and says "Nebula isn't running" while the
    app is closed. It only accepts an `http` address on 127.0.0.1, localhost
    or ::1 (services/backend_address.py).

    The file also holds a secret made fresh each launch. Before the MCP
    server or the CLI sends the token, it checks the address: it sends a
    random challenge to `GET /api/agent/address-proof`, and only the backend
    that wrote the file can answer it (an HMAC keyed by that secret). So if
    Nebula crashed and left the file behind, and another program now holds
    that port, the program gets a challenge and never the token.

Requests from the MCP server and the CLI ignore `HTTP_PROXY` and similar
variables. Nebula is always on this machine, and httpx would otherwise send
even a 127.0.0.1 request, token and all, through a configured proxy.

A packaged app with a bundled Python has no checkout to point at yet; Settings
says so and offers a plain token. That waits for the desktop pass. The desktop
app running from this checkout is fine: its configs use `NEBULA_URL_FILE`.

**Before you paste it.** Settings and the CLI say both of these for every app:

- The agent's own scheduled jobs, cron tasks and automations can run Nebula
  nodes with this token while you aren't watching, up to its daily limit and
  the shared outside budget.
- The token is in its token file, which only your macOS user can read, and the
  config holds just the path. Any program running as you can still read the
  file and spend as the agent until you revoke the token. Revoking deletes the
  file.

**Connected before token files?** An app connected before this change has the
token itself in its config (`NEBULA_APP_TOKEN`), and it keeps working. Nebula
has only that token's hash, so it can't make a file for it. To move the app to
a token file, revoke it in Settings and connect it again.

#### Per app

Formats checked against each app's docs on 2026-10-13.

- **Hermes** ([MCP config reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md)).
  Add the entry under `mcp_servers` in `~/.hermes/config.yaml`, then run
  `/reload-mcp`. Nebula sets `trust: untrusted`, so Hermes asks you before any
  Nebula tool without `readOnlyHint` (everything that edits, runs or
  proposes). `hermes mcp add` has no env flag, so it can't carry the token
  file's path.

  ```yaml
  mcp_servers:
    nebula:
      command: "<repo>/backend/.venv/bin/python"
      args: ["<repo>/backend/mcp_server.py"]
      env:
        NEBULA_URL: "http://127.0.0.1:8000"
        NEBULA_APP_TOKEN_FILE: "/Users/you/.nebula/app-tokens/<app id>.token"
      trust: untrusted
  ```

- **OpenClaw** ([MCP](https://github.com/openclaw/openclaw/blob/main/docs/tools/mcp.md),
  [saved servers](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp/registry.md)).
  `openclaw mcp set nebula '<json>'` saves it under `mcp.servers`, but it
  refuses while the local Gateway runs: stop the Gateway, run it, start it
  again. With the Gateway running, use Control UI > Settings > MCP > Add
  server > Stdio instead and enter the command line; add the two environment
  variables if the form offers them. `openclaw mcp doctor` doesn't flag
  `NEBULA_APP_TOKEN_FILE`: it warns only about env keys ending in token,
  secret, password, api key and the like (it would flag an older config's
  `NEBULA_APP_TOKEN`). A remote Gateway would need an HTTP
  transport, which Nebula's MCP server doesn't have yet.
- **Claude Desktop** ([connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)).
  Claude menu > Settings > Developer > Edit Config opens
  `~/Library/Application Support/Claude/claude_desktop_config.json`. Add the
  `nebula` entry inside `mcpServers`, then quit and reopen Claude Desktop.
- **Claude Code** ([MCP](https://code.claude.com/docs/en/mcp)).
  `claude mcp add --scope user --env NEBULA_URL=... --env
  NEBULA_APP_TOKEN_FILE=... --transport stdio nebula -- <python>
  <mcp_server.py>`. An option has to sit
  between `--env` and the name, or Claude Code reads the name as another
  `KEY=value`. User scope is stored in `~/.claude.json`.
- **Cursor** ([MCP](https://cursor.com/docs/context/mcp)). The `nebula` entry
  inside `mcpServers` in `~/.cursor/mcp.json`, with `"type": "stdio"`.
- **Codex** ([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
  `codex mcp add nebula --env NEBULA_URL=... --env NEBULA_APP_TOKEN_FILE=... --
  <python> <mcp_server.py>`, or the `[mcp_servers.nebula]` table in
  `~/.codex/config.toml`. Add `tool_timeout_sec = 150` there: a run can take
  longer than Codex's 60-second default (`nebula mcp connect codex` sets it
  for you).
- **Other MCP clients**: the usual `{"mcpServers": {"nebula": {command, args,
  env}}}` block.

The printed commands (Claude Code, Codex, OpenClaw) carry only the file's
path, so running one leaves no token in your shell history or the process
list.

#### From the terminal: `nebula mcp connect`

```bash
nebula mcp connect <hermes|openclaw|claude-desktop|claude-code|cursor|codex|other> --token-file <file> [--print] [--yes]
nebula mcp connect <client> --paste-token [--name N] [--daily-usd N] [--print] [--yes]
nebula mcp disconnect <client> [--yes]
```

The CLI can't make tokens. Making one is the person's alone, and only the
canvas opened from the launch link holds the person token; the CLI is also
what agents run. So make the token in Settings and run the command it shows:
`--token-file` with the file Nebula saved the token to (or set
`$NEBULA_APP_TOKEN_FILE`). The CLI reads the file with the MCP server's own
strict reader (a regular file, not a symlink, owned by you, mode 600 or
tighter, holding one app token) and writes a config that names the file.

A token from before token files has no file. Give it in `$NEBULA_APP_TOKEN` or
pass `--paste-token` for a hidden prompt. That still works, but the config
then holds the token itself and the CLI says so. Without a token file, a
token or `--paste-token`, connect stops and says where to get one.

The CLI checks the token with Nebula and refuses a revoked token, one that isn't an app token, or an address
where something other than Nebula answers. If nothing answers, it writes
nothing (`--print` still prints). It finds Nebula at `--url`, else
`$NEBULA_URL`, else the address in `$NEBULA_URL_FILE` (for the desktop app, the
`backend-url` path its Settings config shows), else `http://localhost:8000`.
The config it writes uses the address Nebula reports for itself, so a desktop
config gets `NEBULA_URL_FILE` even if you passed this launch's `--url`. Then:

- **Claude Code, Codex**: runs the app's own `mcp add`. If the app already has
  a server named `nebula` (checked with `mcp get`, which looks in every
  scope), it stops and asks you to disconnect first, since `codex mcp add`
  would silently replace it.
  - With a token file only its path is on the command line. Codex: the CLI then
    adds `tool_timeout_sec = 150` to `config.toml` (keeping its mode) and checks
    the file parses back. If it doesn't, it removes the half-made entry.
  - With a pasted token: Codex gets a one-off placeholder on its command line,
    which the CLI swaps for the token in `config.toml`. `claude mcp add` can
    only take the token on its command line, so it is visible in the process
    list for the second the command runs; the CLI says so first.
- **Claude Desktop, Cursor**: shows the change as a diff (token masked), asks,
  copies the old file to `<file>.nebula-backup-<timestamp>` (mode 600) and
  writes the merged file with mode 600. Only `mcpServers.nebula` changes; a
  file that isn't valid JSON is never touched. When the old file had a nebula
  entry (a disconnect, or a connect that replaces one), its token is blanked
  out in the backup, so a revoked app leaves no working token behind.
- **Hermes, OpenClaw, other**: prints the config and where it goes. Nebula
  doesn't rewrite Hermes's YAML (it would lose your comments), and
  OpenClaw's own command needs its Gateway stopped.

`--print` only prints (with a placeholder path if there's no token file).
`--name` and `--daily-usd` fill in the Settings steps when you don't have a
token yet.
`disconnect` removes the entry the same way (Claude Code: `claude mcp remove
nebula` with no `--scope`, so an older local-scope entry goes too; or it prints
the app's remove command) and reminds you to revoke the token in Settings. Both refuse to run
inside an in-app agent (`NEBULA_AGENT_TOKEN` set). Run from a packaged app
(bundled Python), they say it isn't supported yet; the desktop app running
from this checkout is supported, through `NEBULA_URL_FILE`.

#### Under the hood

The MCP server and the `nebula` CLI send the token as `Authorization: Agent
<token>`. The MCP server reads its token files at startup (`backend/mcp_server.py`
`load_agent_token_file`, `load_app_token_file`). The first of these that is set
wins:

1. `NEBULA_AGENT_TOKEN`: an in-app chat's turn token.
2. `NEBULA_AGENT_TOKEN_FILE`: a personal agent's session token file.
3. `NEBULA_APP_TOKEN_FILE`: a connected app's token file. It replaces a
   `NEBULA_APP_TOKEN` set beside it. If it is set, it must be good: missing,
   unreadable, a symlink, open to other users or malformed, and the server
   prints why and exits instead of falling back to the raw token or to no
   token. That is what happens after a revoke.
4. `NEBULA_APP_TOKEN`: the token itself, from a config made before token files.

With 1 or 2 set, the app file isn't read. The backend scrubs
`NEBULA_APP_TOKEN` and `NEBULA_APP_TOKEN_FILE` from every process it starts,
so an in-app chat never spends as an app. The `nebula` CLI reads only
`NEBULA_AGENT_TOKEN` and `NEBULA_APP_TOKEN`, as before.

The agent shows by its name and color on the
canvas, and `get_spend_limits` reports `budget: "app"` with its
`appDailyUsd`. Settings lists what it spent in the last 24 hours. Revoking the
token makes its requests fail with 401; what it spent stays in the outside
total.

Routes, all person-only: `GET /api/agent/spend/apps` (the outside total, each
app, and `connect`: the clients on offer and whether this backend can point
them at a checkout), `POST /api/agent/spend/apps` `{name, dailyUsd, client?,
color?}` (returns the token, `tokenFile`, and `setup` when `client` is given),
`PUT
/api/agent/spend/apps/{id}` `{dailyUsd?, color?}`, `DELETE
/api/agent/spend/apps/{id}`. The config text comes from
`backend/services/agent_connect.py`, shared by Settings and the CLI.

Remaining risk: the token is still a bearer secret, now in one file in
Nebula's state dir instead of in each app's config. Mode 600 keeps other
macOS accounts out, not your own programs: an agent with its own shell can
read the file, or its MCP child's environment once the server has loaded it.
Anything that can read it can spend as the app, inside the app's limit and
the shared outside budget, until the person revokes it, which deletes the
file. Apps connected before token files keep the token in their config until
they are revoked and connected again.

### Building and running over MCP

`edit_canvas` and `remove_from_canvas` send one body to `POST /api/graph/apply`
(`backend/main.py`, parsed by `services/canvas_edits.py`). It takes the
proposal shape (`nodes` with `+refs`, `edges`, `params`) plus `rename`,
`move`, `remove` and `unwire`, stages all of it on a copy of the graph in that
order (unwire, remove, add and change, rename, move) with the validators the
single-edit routes use, and commits it at once. A bad wire or a missing node
leaves the canvas exactly as it was. Limits match proposals (12 new nodes, 24
wires, 12 param changes, 24 removals). Nodes with unresolved World Labs paid
state can't be removed. Krea nodes may name `_kreaAuth` only to keep the mode
they have: a change is refused with 403 and must be proposed (see Spending
limits). Other `_` params are refused. The route never runs anything and
is for agents only (the canvas edits through its own routes). `nebula apply`
is the CLI twin (see below).

A run from `run_nodes` is a CLI run (`POST /api/graph/run` with `wait`), so
it gets the same spending check and the same long-run handling. It waits 45
seconds by default because Codex gives each tool call 60 seconds unless
configured otherwise (in-app Codex gets 150); `get_run` waits again (up to 300). Finished image and
video outputs come back as small previews from
`GET /api/graph/node/{id}/preview`, which reads only files in Nebula's output
folder (external URLs are never fetched), downscales images to 512, 1024 or
1568 px and keeps each preview under 350 KB, since Claude Code caps a tool
result at 25,000 tokens.

`GET /api/agent/nodes` and `GET /api/agent/nodes/{id}` back `find_nodes` and
`describe_node`. Both use `services/node_readiness.py`, the same rule
`nebula context` uses, so the CLI and the MCP server agree on what can run.
`apiProvider: utility` only means "no top-level key". A local node that still
calls a provider says how in its definition's `providerVia` (`kind: model`
for Cinema Scene's base model, `kind: param` for the QC nodes' mode, with
`byValue` for a mode that needs its own key, like QC `jev` and
`TYPESAFE_API_KEY`), and readiness, the canvas badge, the run estimate and proposals all read it.
`backend/tests/test_node_readiness.py` fails when a utility handler that can
reach the network isn't declared, and pins `providerVia` to the handler
constants it describes. Its import walk fails closed: relative imports are
resolved, and dynamic imports or spawned processes count as network unless the
module is listed with a reason. `frontend/tests/lib/nodeKeys.test.ts` keeps the
canvas's TS copy of `providerVia` equal to the JSON one.

### In-app agents use this server

The chat panel's agents reach Nebula through this same MCP server, started by
their own CLI for each turn (`services/agent_profiles.py`,
`services/krea_agent_mcp.py`). Each turn has a token Nebula minted for that
chat (`Authorization: Agent`), which names the chat's own spending budget and
its private workspace. The token reaches the server by environment variable
name only, never in argv or a file:

| Agent | How the server is registered | Other Nebula access |
|---|---|---|
| Claude | `--mcp-config` with `env: {"NEBULA_AGENT_TOKEN": "${NEBULA_AGENT_TOKEN}"}`, which Claude Code expands from its own environment. Every tool is allowed by exact name (`mcp__nebula__look_at_canvas`, ...); a test compares the list with the server's registered tools. | The `nebula` CLI through Bash, for projects, save/load, keys and `commons fetch`. `ps` is denied. |
| Codex | `-c mcp_servers.nebula.*` with `env_vars = ["NEBULA_AGENT_TOKEN", "NEBULA_URL"]` (Codex gives stdio servers a filtered environment), `tool_timeout_sec = 150`, and the same exact tool list as `enabled_tools`, each with `approval_mode = "approve"` (with `approval_policy = "never"`, Codex otherwise refuses tools marked open-world, such as `run_nodes`). | None. Its shell has no network (`permissions.nebula-agent.network.enabled=false`), so `nebula`, curl and pip can't reach anything; MCP servers run outside that sandbox. |

- With a token, the server asks `GET /api/agent/context` for the turn's
  workspace once at start and confines local paths to it (as the CLI does);
  if that fails it exits, and the agent has no Nebula tools.
- Codex also runs with only reviewed features. `CODEX_DISABLED_FEATURES`
  turns off hooks, plugins, apps, skill MCP installs, browser and computer use,
  the in-app features, the daemon and the like. It also turns off
  `image_generation`, Codex's own image tool on the ChatGPT plan: images made
  that way skip the canvas, the spending limits and proposals, so Codex
  generates through Nebula nodes like the other agents. `code_mode_host` stays on:
  newer models (gpt-6.1-sol) call every tool through it. Checked live, its
  JavaScript has no `fetch`, `require` or `Deno`, and nothing from it reached
  the backend. Before every turn
  `codex features list` runs with the turn's exact `-c`/`--disable` flags (and
  an empty `CODEX_HOME`, standing in for `--ignore-user-config`, which that
  command doesn't take); any feature that is on and not in
  `CODEX_ALLOWED_FEATURES`, a turned-off name Codex no longer lists, or a
  failed check refuses the turn. A Codex update can therefore stop in-app
  Codex until the lists are reviewed; the error says which features.
- Codex's workspace keeps `.codex` and `.agents` unwritable, so a turn can't
  leave project config, hooks or skills for its next turn. Checked live with
  codex-cli 0.160.0: a planted `.codex/config.toml` MCP server and hooks file
  never start under `--ignore-user-config`.
- The Commons skill text the MCP server and in-app Codex get names only the
  `commons_*` tools. In-app Claude, whose shell reaches Nebula, also gets the
  `nebula commons` CLI twins (`backend/commons/skill_cli.md`). No primer sent
  to Codex names a `nebula` command.

### Long runs and graph edits from the CLI

`nebula run <node>` and `nebula run-all` wait up to 100 seconds (`--wait`),
which fits inside most agents' shell-tool limits. A run that takes longer,
like most video, keeps going on the backend; the command prints its run id
and exits 2:

```bash
nebula run n5                       # exit 2: "Still running after 100s (run 3f…)"
nebula result 3f… --wait 100        # 0 finished, 2 still running, 3 stopped
nebula cancel 3f…                   # stop it; outputs that finished stay
```

Finished outputs land on the canvas as each node completes, so a stopped
run keeps what it made. The backend remembers the last 50 finished CLI runs
until it restarts.

To build or change several things at once, `nebula apply` sends one plan to
`POST /api/graph/apply` (the route `edit_canvas` uses), and the backend
applies all of it or none of it:

```bash
nebula apply --note "Two takes" \
  --add +p=text-input --param +p.value="a lighthouse at dusk" \
  --add +wide=nano-banana --add +tight=nano-banana \
  --wire +p:text +wide:prompt --wire +p:text +tight:prompt \
  --rename +wide=Wide --move n3=400,120 --remove n7 --unwire n1:text n2:prompt
# Applied: added 3, wired 2, renamed 1, moved 1, removed 1, unwired 1.
#   +p → n8  Text Input
#   +wide → n9  Wide
#   +tight → n10  Nano Banana
nebula apply --file plan.json       # or --file - to read standard input
```

The plan is the one `nebula propose` takes (`nodes` with `+refs`, `edges`,
`params`) plus `rename`, `move`, `remove` and `unwire`, so a file of nodes,
edges and params can be proposed or applied as it is. `nebula apply` never
runs anything: a plan with `run` is refused before it's sent (propose it, or
apply it and then `nebula run`). Like proposals, it needs your agent name
(`$NEBULA_AGENT_NAME` or `--as`). `--json` prints the backend's result,
including `idMap`.

Other graph commands:

```bash
nebula delete n3 n4                 # nodes and their wires
nebula disconnect n1:text n2:prompt
nebula rename n2 "Hero shot"        # an empty name restores the model's
nebula move n2=400,120 n3=400,320   # canvas coordinates
nebula projects                     # saved projects; * is open
nebula project open <id>            # switch the canvas (not while a run is going)
nebula project new "Logo ideas"     # start a new, empty project and open it
nebula clear                        # refused when the canvas has nodes
nebula clear --force                # the person only: clears it anyway
```

Opening or starting a project keeps the one that was open as it is. When an
agent (or any script that isn't the person's own canvas) does it, the
person's canvas follows, says who switched it, and offers a button back.
The project's history names the agent.

`nebula clear` can't be undone, so it refuses when the open project has
nodes and points to `nebula project new` instead. `--force` clears anyway,
but only for the person: the backend refuses a clear (or a `nebula load`
over a canvas that has nodes) from anything that names an agent.

`nebula context` lists the definition ids that can run here: with your keys,
free, on the signed-in Krea account (marked `*`), or with a Nous sign-in.
