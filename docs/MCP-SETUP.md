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

An agent's first call is `start_here` (the server's instructions say so).
One answer gives what a first turn needs, each part with its own budget so
the whole stays under about 7,000 tokens (28,000 characters), below Claude
Code's 10,000-token warning and its 50,000-character file cut:

| Part | What's in it | Past its budget |
|---|---|---|
| `canvas` | The open project, `view.stale`, the selection, other agents' cursors, and each node's id, name, `definitionId`, state, `onScreen`, `inputsFrom` and up to 8 params (each cut to 60 characters, redacted as `look_at_canvas` redacts them) | The first nodes in full (selected, then on screen), the rest as `others: {id: name}`, `truncated: true`, and "look_at_canvas gives every node" |
| `pins` | Open pins: id, text, anchor | The 10 newest, and `openCount` |
| `proposals` | Open proposals, briefly | 5, and `count` |
| `boards` | Every moodboard: id, name, `where` (`current`, `global` or the project's name), image count, analyzed or not, Direction cut to 80 characters. Boards in Recently deleted, or in a project there, are left out. `read` is how to read one (`moodboard_get(board="<id or exact name>")`; over the CLI `nebula moodboard show <id>`). `use` is how to put one on the canvas: the exact `edit_canvas` call for a Moodboard node (`nebula-moodboard`, the board in its `moodboard` param, sending from its `moodboard` port) connected to a Preview's `input` (or, over the CLI, the `nebula apply` flags) | 30 rows (this project, then Global, then the rest by last edit), `count`, and, when rows were cut, `more`: `moodboard_list(project_id=...)` lists a project's boards and Global's |
| `nodes` | The node types that run here, by category: `{id: price}` (`"free"`, `[low, high]` USD or `null`), `runsWith` for those that don't run on a key, and notes on modes, providers and Krea | Categories in a fixed order, cut at the budget, `rest: {category: count}`, and "find_nodes(category=…) gives the rest" (over the CLI "`nebula nodes --category <category>` lists the rest with prices"; `nebula context` also prints how many more can't run here and that `nebula nodes --all` lists them) |
| `spend` | The per-run limit, the budget kind, its limit and what is used, Krea plan runs. Outside agents share one 24-hour budget, so `usedUsd` is what all of them used; an app with a token also gets its own line (`limitUsd`, `usedUsd`) beside the shared one (`sharedLimitUsd`, `sharedUsedUsd`) | |
| `next` | `events.cursor` and the journal id for `wait_for_canvas_change`, then one line each: `describe`, `build`, `propose`, `point` and `pins`. Each is the exact call, its arguments named as the tool takes them (`describe_node(definition_id=...)`, `point_at(node_id=..., say=...)`); `build` is a whole `edit_canvas` plan (nodes `{ref, definitionId, params}`, edges `{source, sourceHandle, target, targetHandle}`, `arrange`), and `propose` says `propose_change` takes the same nodes and edges plus `params` and `run`. Over the CLI they are `nebula` commands with their real flags, so a first build needs neither `nebula apply --help` nor `nebula info nebula-moodboard` | |

No private note, image note, board note or pin reply history goes in. The
route is `GET /api/agent/start` (`?via=cli` words the hints for the CLI);
`nebula context` prints the same, and `nebula context --json` prints it as
it comes. Later turns use `look_at_canvas`, which stays the full snapshot.

A call with wrong arguments is refused before it runs, in one line naming
the tool's real ones, for every tool: `moodboard_get(id=...)` gets
"moodboard_get takes board (required), not id. Call
moodboard_get(board=...).", a name it doesn't take is refused even beside
the right ones ("run_nodes takes node_id, wait_seconds, ..., not node_ids
(did you mean node_id?)."), and a wrong type names the type ("point_at: x
must be a number, not "left". It takes ..."). Before, FastMCP sent
pydantic's report and ignored names a tool doesn't take. A node or connection in
another shape gets the same kind of line from `edit_canvas`,
`propose_change` and `nebula apply`/`propose --file`: a node with `type`
(or `kind`, `definition`, ...) is told the type goes in `definitionId`, and
a connection with `from`/`to` (or `sourcePort`/`targetPort`) is told it is
`{source, sourceHandle, target, targetHandle}`, with its own ends rewritten
when they read as node and port (`"+mb.moodboard"`). A connection with no port
(`{source, target}`, or `--wire +mb +pv:input`) is told the ports that end
has ("edges[0].sourceHandle must be a port id. Valid outputPorts on +mb
(nebula-moodboard): ['moodboard', ...]"), as a wrong port name is. These
lines copy back at most a few short params of the agent's node, never a
whole data URL. `point_at` with only `x` or only `y` is refused ("point_at
needs node_id, or x and y (both): you gave only x"). A node field `edit_canvas` and `propose_change` don't take is refused too, in one line: `x`/`y` are
told the place goes in `position` (or is left to Nebula), `name`/`label`/
`title` that a new node is named with `rename`, and anything else gets
the node shape `{ref, definitionId, params, position}`. Before, they
were dropped without a word.

The server's instructions stay under 3,000 characters, inside the 4,096
Claude Code shows, with the commons guide's two safety lines first in its
part. How to use moodboards, projects and Recently deleted is in those
tools' own descriptions.

The server exposes these tools for building and running (see
[Building and running over MCP](#building-and-running-over-mcp)):

- `start_here`: the first-turn answer above.
- `find_nodes`: node types to build with, best matches first, each with
  `runsWith` (key, free, krea, nous) and a list `price` at default settings,
  or `"by input size"` with a `priceNote` for a node priced from its input
  file (SeedVR2 Upscale: "$0.001 per megapixel of the larger of input and
  output, rounded up to a whole megapixel; priced from your image's size when
  you run it"). `ready_only=false` also lists nodes that can't run here, with what's
  `missing`. "free" is at the node's defaults: a row with `needsKeyFor` (the
  Video QC nodes) calls a provider in another mode. Every word of `query`
  must be in the id, name or description. Its CLI twin is `nebula nodes`
  (and `nebula find`), on the same route: by default the node types that
  run here, by category, each with `runsWith` and its price, then one line
  saying how many more need a key ("65 more need a key: `nebula nodes
  --category image --all` lists them with what each needs"); `--all` lists
  those too, each with its `missing`; `--json` prints the route's answer,
  which equals find_nodes' for the same query, category, ready_only and
  limit. find_nodes returns 20 rows by default (at most 100); `nebula nodes`
  has no limit unless `--limit N`, because a terminal table is read whole or
  piped and a category is never cut short.
- `describe_node`: one node type's ports, params (options, defaults, ranges)
  and list prices by the params that set them (`price.byInputSize` and
  `multiplyBy` on a price read from the input file, `price.unconfirmed` when
  the vendor's page doesn't state it exactly; a route has `priceBy`).
  `definition_id` is the id, or
  the node type's exact display name (any case, outer spaces ignored) when
  one node type has it: `describe_node(definition_id="Moodboard")` answers
  for `nebula-moodboard`, starting with `lookup` ("Moodboard is the Moodboard
  node: nebula-moodboard"). An id always wins; a name two node types share
  is refused with both ids; anything else gets "No node type '...'" with
  close matches, exact-name matches first. `nebula info` (and `nebula
  describe`) does the same, printing the `lookup` line first. Writes stay
  strict: `edit_canvas`, `propose_change`, `nebula apply`/`propose`/
  `create`/`quick` and a Style's `model_id` (`style_create`/`style_update`,
  `nebula style new/set --model`) take ids only, because they store and bill by id and a
  display name can be renamed or come to be shared; given a name they refuse
  with "unknown node definition 'moodboard': did you mean nebula-moodboard
  (Moodboard)?". (Before, `nebula create` stored a node of any type it was
  given and `nebula quick` tried to run it.) A local node that still calls
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
  A node with a Moodboard input has `moodboardAdapter`: what a connected Nebula
  moodboard does there, from the adapter table (contract 07 section 1.16) at
  the node's defaults on the route a run takes here (`route`, when it has
  more than one). `line` is the card's Moodboard line ("Board images: on ·
  up to 10 to Image Style Refs"). The rest are the entry's own fields as
  section 1.16 defines them, without its sources: `channel`, `default`,
  `handler`, `slots` (port, `label`, `max`, `sharesLimitWith`),
  `needsWired`, `never`, `textSlot`, `text`, `negativeField`, `weight`
  (without its `schema`), `order`, `syntax`, `syntaxReason`, `costPerRef`,
  `reason` and `unconfirmed`, among others. A node with a Moodboard port and
  no entry gets `channel: null` and a `note`. `variants`
  lists the param values (`byModel`) or routes (`byRoute`) that change them,
  with the fields they change (and `route`, when the value moves the run to
  another route). `nebula info` prints the same as a `MOODBOARD:` line and
  one line of detail.
- `edit_canvas`: adds nodes, connections, param changes, renames, moves, removals
  (`remove`) and unwires (`unwire`) in one call, all or nothing: everything
  `nebula apply` does, with no limit on how much one call adds. `arrange:
  true` has the canvas lay out the new nodes by their real size. `steps`
  sends a list of such plans one after another, with the checks and
  stop-and-report of `nebula apply`'s steps. Its result has `undo`, the token
  that takes the edit back (see
  [Undoing your own edit](#undoing-your-own-edit)). A proposal
  (`propose_change`) takes the same nodes, connections and params, but not moves,
  removals, unwires, `arrange`, `steps` or renames of nodes already on the
  canvas; it can name its own new nodes (`rename`). An unnamed node whose
  provider depends on the person's keys goes by its model without the
  gateway ("Grok Imagine 2.0" for a "Grok Imagine 2.0 (Krea)" node), on the
  person's card and everywhere Nebula names a node to you: `look_at_canvas`
  and `get_project` `name`, `edit_canvas`'s `added[].name`, proposals, run
  refusals, the cursor's bubble and the Agent log. The catalog and search
  (`find_nodes`, `describe_node`) keep the full name, and renaming a node to
  either form leaves it unnamed.
- `upload_file`: adds a local image, video, audio file or document to
  Nebula (`nebula upload <file>`): Nebula copies it into its output folder
  through `POST /api/uploads` and puts an Image Input, Video Input,
  Audio Input or Document Input holding the copy on the canvas; it returns
  `nodeId`, `kind`, `url`, `filePath` and `filename`. The copy is stored
  under a hashed name, so the node keeps the name the file was sent with:
  an Audio or Document Input's card shows it (cut in the middle when long,
  "quarterly-rep….pdf"), and `look_at_canvas` gives it as the node's
  `fileName`. It takes PNG, JPEG, GIF, WebP,
  MP4, MOV, WebM, WAV, MP3, M4A, AAC, FLAC, Ogg, PDF or text, checked by
  their bytes (20 MB for an image or document, 500 MB for a clip or sound).
  An optional `position` ({"x", "y"} in canvas coordinates, `nebula upload
  --at x,y`) puts the node there; without one it goes right of the other
  nodes. A file the person drops on the canvas goes the same way, at the
  drop point. The new
  node is credited to you in the history, `nebula watch` and
  `wait_for_canvas_change`, like any node you add. Do this
  before running a node priced from its input's size on a file of yours
  (see [Spending limits](#spending-limits)). An in-app chat's turn reads
  only its own workspace, and the read follows no links.
- `load_graph_file`: opens a graph file (`path`) as the person's Load graph
  does (`nebula load <file>`, Q123 a): a plain `.nebula` or `.json`, or a
  `.nebula.zip` bundle (a graph plus its files). A bundle streams to `POST
  /api/outputs/restore?rewriteLinks=true` with your own headers: its files
  are restored into Nebula's output folder and the graph comes back with its
  links pointing at them, checked as the canvas checks them
  (`services/graph_file_links.py`; a link to a file the bundle lacks becomes
  empty, with a warning). Under the 16 MB save limit the file replaces the
  open project's canvas (make a new project first, `new_project`, unless the
  person asked for that). A file over the limit opens as a new project named
  after the file, as the person's Load graph does (Q120): the import is
  first asked to refuse it (`refuseOverSaveLimit`), the project is made as
  `new_project` makes one, and the file loads there (`newProjectForFile`,
  which loads only into an empty project); the project that was open is left
  as it was. Returns `loaded`, `project`, `openedAsNewProject`,
  `previousProject` (and `open_project` in the `note` goes back),
  `nodeCount`, `edgeCount`, `idMap`, `filesRestored`, `warnings`,
  `savingPaused`, `size` and `note`; the new project's saving stays paused
  until it is under the limit, and `project_size` shows what's large. The
  path follows `upload_file`'s rules (an in-app chat's turn reads only its
  own workspace, protected files are refused, the read follows no links),
  files up to 528 MB.
- `remove_from_canvas`: deletes nodes or single connections, all or nothing.
  On the person's open canvas it is one undo step: one Cmd+Z puts the nodes
  back with their connections (as the person's own delete is, from the
  Delete key, the selection toolbar, the context menu or the Inspector; the
  Delete and Backspace keys, like every canvas shortcut, act only with focus
  on the canvas or its bars, never in a panel that owns its keys such as the
  Inspector or chat, nor behind a modal dialog). A delete (the person's,
  yours or another agent's) takes the nodes and their connections off the
  canvas the moment it is made; edits to them still waiting to be sent
  (the person's typing, yours) are dropped once Nebula confirms it, and a
  sync that still shows them meanwhile leaves them off. If Nebula refuses
  it, the nodes come back where they were, with their connections, not
  selected, with the usual line saying why, and the waiting edits go out.
  A Cmd+Z pressed while a delete is still on its way undoes nothing and
  says "Nothing was undone. Your last change was still saving."; once the
  delete has landed, one Cmd+Z brings the nodes back with their
  connections, on the canvas and in Nebula's graph, and Redo deletes them
  again. A Cmd+Z the person presses before another step has reached Nebula
  waits for Nebula's answer, then undoes it (a clear, an upload once its
  node is on the canvas, an accepted proposal, a model picked on an
  OpenRouter or Replicate node; a step Nebula refused undoes nothing, and
  says why: a refused clear, upload, accept or model pick each has its own
  line). That Cmd+Z is bound to the step it was pressed for, and a second
  Cmd+Z to the step below it. While its own step is still on its way it
  waits, even if something else lands meanwhile; a later step of the
  person's still on its way is no newer edit (the Cmd+Z applies beneath
  it). Your edits to a node that a waiting Cmd+Z holds are kept and show on
  the canvas once it lands, with their Agent log line and their own undo
  step (a run's outputs too); if Nebula doesn't answer an undo within 15 s
  it fails with "Couldn't undo that." and the reason, and the edits it held
  go out in order. An undo Nebula refuses leaves the canvas as Nebula's
  graph is. An edit or Cmd+Z still waiting when another project opens or a
  graph import replaces the canvas is never sent: it would land on the
  wrong project. A delete's change lands when Nebula's own sync takes its
  nodes off, which can come before its answer: no undo after that brings
  those nodes back to the canvas or to Nebula's graph unless it undoes
  that delete. A delete of several nodes
  is one step however its nodes' syncs arrive (one per node, with your edit
  or the person's typing between them): one Cmd+Z brings them all back. A
  sync that already took a node off makes its delete done, whatever its
  answer says, and undoing a delete puts back only what it removed (a node
  you added meanwhile stays). A clear the person issues after a Cmd+Z that
  is still waiting supersedes it: the Cmd+Z is dropped and the canvas ends
  cleared; an undo takes off only the nodes its own step added (a node you,
  another agent or the person added while that step was on its way stays),
  and always the ones it did add, even after a delete of one and its undo
  brought it back (adding a node from the library, a drop, the command
  palette, a Character or Moodboard drop and Creator's inserts are each
  their own step too); while an undo or redo is still on its way to
  Nebula, the person's next edits (typing, a delete, an added node) reach
  Nebula after it, in the order the person made them, so the graph you
  read never shows a later edit undone by an earlier Cmd+Z;
  a Cmd+Z never does nothing without a word: a step that ended up changing
  nothing is passed over (the press undoes the step below it), and a press
  whose step was taken back meanwhile (a refused clear) counts in the
  skipped line below; a Cmd+Z pressed after the clear undoes the clear once it lands,
  and a step taken while a clear was on its way never brings a cleared
  node back. If a newer edit has settled on top of its step by then
  (yours, another agent's, or the person's own later edit), it never undoes
  that edit instead: it is dropped, and the canvas says "Nothing was undone. Your last
  change was still saving." ("Nothing was redone. …" when only Cmd+Shift+Z
  presses were dropped); if some presses went through and some were
  dropped, the restore's line ends with what was skipped, undos and redos
  counted apart: "1 undo was skipped while a change was saving.", "2 undos
  and 1 redo were skipped while a change was saving." (Redo stays). The same line shows if Nebula hasn't answered
  within 15 s, or another project opens (the person's own switch, or your
  load into the open project, whose own notice stays beside it). A clear
  takes off only the nodes that were on the canvas when the person cleared,
  never one you added after it (even under a reused id such as n1), and an
  accept the person undid while it was on its way runs nothing (its
  approval goes back). Its
  result has `undo` too, which puts the nodes back with their params,
  outputs, names and connections, the person's pins on them, and the proposals
  the delete closed when they still fit. `removals` lists, per node it
  deleted, the pins it detached and the proposals it closed (each record
  also names its `projectId` and the node's `definitionId`, and `replaces`
  when it supersedes an earlier delete of the same node).
- `undo_canvas_edit`: takes one of your own edits back with its `undo.token`
  (or a steps plan's `undo.tokens`, newest first). A part someone changed
  since stays as it is and is listed in `skipped`; so does a node someone
  else ran since (reason `ran since`). Your own runs don't count.
- `run_nodes`: runs a node and what feeds it (or the whole canvas) under the
  person's spending limits. Returns outputs with small inline previews, or
  `running` and a run id. A run in which any node failed comes back
  `failed`, with each node's message in `errors` and what did finish in
  `results`; see [Building and running over MCP](#building-and-running-over-mcp).
- `get_run` / `cancel_run`: collect or stop a run that is still going.
  `get_run` also reads a run the person started on the canvas (its id is
  the `runId` of its `run.started` events): see
  [Runs the canvas started](#runs-the-canvas-started).
  `cancel_run` stops only runs an agent started (its own, another agent's,
  or an unnamed script's); a run the person started is theirs, and the
  refusal tells the agent to ask them to press Stop. See
  [Who may stop a run](#who-may-stop-a-run).
- `model_catalog` / `model_schema`: the models the universal nodes run.
  `model_catalog(provider, query, limit)` lists OpenRouter's, Nous Portal's
  or Quiver's models (`/api/openrouter/models`, `/api/nous/models`,
  `/api/quiver/models`, the routes the Inspector's pickers read), filtered by
  every word of `query`, and names the node and the param (`model`) the id
  goes in; OpenRouter and Nous rows carry `ports` ({inputs, outputs}, port
  ids). `model_schema(provider, model_id)` reads one model: its `ports`
  ({inputs, outputs}, each {id, label, dataType, required, multiple?}), the
  ports the node gets with that model, and the catalog row (`model`), or for
  Replicate (`/api/replicate/schema/{owner}/{name}`) the latest
  `versionId`, `params` (the other inputs, set as params of the same name)
  and the raw input and output schemas. They use the person's key and cost
  nothing; without the key the refusal names it. See
  [Universal nodes over MCP](#universal-nodes-over-mcp).
- `krea_discovery_tools` / `krea_discover`: the read-only Krea discovery
  calls (`list_models`, `get_model_schema`, `get_prompting_guide`,
  `list_styles`, `list_moodboards`, `get_node_apps`, `get_node_app_versions`,
  `list_node_types`) on the Krea account connected in Nebula, through
  `GET /api/krea/tools` and `POST /api/krea/tools/call`. They are the calls
  in-app turns also get from the `nebula_krea` server, with the same
  allow-list (`KREA_READONLY_TOOLS`), so an outside agent, which gets only
  this server, has them too. None generates, uploads or spends; anything
  else is refused before Krea is called.
- `view_output`: a node's output as an image (videos as three frames, image
  lists as tiles), or as text. For a node whose last run failed it returns
  the error instead of "no output yet"; if an older output is still on the
  card it returns that with a note that the last run failed.
- `get_spend_limits`: the limits and what this session has used.
- `list_projects` / `open_project` / `new_project`: list the person's saved
  projects, switch the canvas to one, or start a new, empty one. The project
  that was open is saved as it is. The person's canvas follows (from the
  Projects screen too, which opens the canvas), shows a note naming the
  agent, and offers a button back to the project they had open. Until the
  new canvas has loaded, their canvas is read-only: the project bar says
  "Opening “<project>”…" and Run says "Wait for “<project>” to open." What
  they typed before the switch is saved into the project they left; if that
  save fails it is kept as a new project, "<project> (recovered)", and a
  line says so with an Open copy button. The Projects
  screen also lists again whenever anyone makes, renames, deletes or restores
  a project (the `projectsChanged` socket event).
  Start new work in a new project rather than emptying the canvas: it keeps
  the person's work. Clearing a project that has nodes needs an explicit
  force from anyone (`nebula clear --force`, or `DELETE /api/graph?force=true`);
  on an open canvas the person can undo it. If they were editing when you
  cleared, that edit is lost and their canvas says so, naming you: "Codex
  cleared the canvas while you were editing “Text” for “Hero prompt”. That
  change wasn't saved." (a count from 4 settings, or settings on several
  nodes). Each `list_projects` row has the
  card's `cover` ({source, images}).
- `list_project_covers` / `set_project_cover`: the images a project's card
  can show (`images`, `pinned`, `pinnedBy`, `cover`) and setting its cover to
  one of them (or `""` for the automatic one). An agent sets it while the
  person hasn't pinned one; a cover the person pinned changes only through
  `propose_asset_change`. A pin whose image is gone (its node deleted) no
  longer counts (`pinned` and `pinnedBy` null, `lostPin` names it). See
  [Proposals outside the canvas](#proposals-outside-the-canvas).
- `rename_project`: renames a saved project (`project_id` or `"current"`,
  `name`) through `PUT /api/projects/{id}` `{name}`, the canvas header's own
  rename. Returns `project` and `previousName`; renaming back to
  `previousName` undoes it. Open canvases and the Projects screen show the
  new name at once (`projectsChanged` with `change: "renamed"`), and the
  journal gets `project.renamed` with `from` and `to`. CLI: `nebula project
  rename <id|current> <name>` (see
  [Long runs and graph edits from the CLI](#long-runs-and-graph-edits-from-the-cli)).
- `get_project`: reads a saved project without opening it, through
  `GET /api/projects/{id}?view=agent` (`services/project_view.py`). Nodes come
  exactly as `look_at_canvas` shows a live one
  (`services/agent_presence.redacted_node`: redacted params, which outputs
  exist and never their values, connections in, and a universal node's `ports`
  from its model with `_model_ports` left out of params), plus `state`,
  `position` and the last `error`; then the connections, `cover`, `open`, and `runHistory`, the
  newest 20 records of the canvas's Run History (`runHistoryCount` counts
  them all), each with its status, timing, `nodeIds` and which outputs it
  made, never its recipe's params or output values. Without `view` the route
  answers as before (the canvas loads it). Deleting a project over MCP waits
  on a decision about the open project. CLI: `nebula project show
  <id|current>` (`--json` prints this result).
- `project_size`: a project's size against the save limit and what takes the
  space (`project_id`, default `"current"`), through
  `GET /api/projects/{id}/size` (Q118). Read-only. The size is what a save
  measures (`services/project_size.py`: the snapshot as `json.dumps` writes
  it, UTF-8); for the open project, its stored snapshot with the live canvas
  overlaid. Returns `sizeBytes`, `limitBytes` (16 MiB, shown as "16 MB"),
  `size` and `limit` as the canvas words them, `overLimit`, `savingPaused`
  (the open project is over, so the person's canvas has paused saving it
  until it is smaller), `overByBytes`, `largest` (the largest rows of
  0.1 MiB and up, at most ten, largest first: a node's `nodeId`, `name`, `definitionId` and the `part`
  that takes most of it, "Text" for its params, "Stored outputs", "Embedded
  files" for data: URLs in params, "Node data"; or the project's own "Run
  history", "Connections", "Create draft", "Project settings"), `smaller` (`count`
  and `bytes` of the rest) and a `note`. Each row's `size` (and `smaller`'s)
  is to the nearest tenth of a MB, halves up, as the person's panel shows it;
  the project's own `size` rounds up while over the limit. Agents get no trim tool: they trim
  with `edit_canvas` and `remove_from_canvas`, under the person's existing
  approvals. An agent's edit (`POST /api/graph/apply`, `/api/graph/apply/undo`
  (`undo_canvas_edit`), `/api/graph/restore`, `/api/graph/node`,
  `PUT /api/graph/node/{id}`, `PUT /api/graph/node/{id}/label`,
  `/api/graph/connect`, `/api/graph/import`, `/node-and-connect`,
  `/cluster`) that would leave the open project over the limit, or larger
  while it is over, is refused 413 with `limit: "size"`, `sizeBytes`,
  `limitBytes` and its own `detail` naming `project_size`; nothing changes.
  The one exception is `load_graph_file`'s import into the empty project it
  made for a file over the limit (`newProjectForFile`). An
  edit that makes it smaller goes through, and the person's own edits and
  Load graph are never refused for size. A tab's save over the limit gets
  the same 413 fields with its `detail` unchanged ("Project snapshot exceeds
  the 16 MiB limit"). CLI: `nebula project size [<id>|current]` (`--json`
  prints this result).
- `moodboard_list`, `moodboard_get`, `moodboard_create`, `moodboard_add`,
  `moodboard_update`, `moodboard_edit`, `moodboard_analyze`, `moodboard_move`, `moodboard_delete`: the boards in
  Moodboard Studio, with their brief (Direction, Avoid, pinned colours, a
  hand-written brief, and the brief generators get). `moodboard_edit` moves,
  resizes and groups a board's cards (the Studio's Board view) in one checked
  edit, and its `undo` takes it back. `moodboard_analyze`
  with `dry_run` previews an analysis, optionally with other colour
  thresholds, and saves nothing; with `read_with="gemini-4-argon"` and
  `dry_run` it reads the references with that vision model (paid, moves
  nothing; `estimate_only` prices it first). `moodboard_move` and `character_move`
  move a board or a Character to Global or a canvas project (`to`:
  "global", "current", or a project's id or exact name). See
  [Moodboards from the CLI and MCP](#moodboards-from-the-cli-and-mcp).
- `list_trash` / `restore_from_trash`: what's in Recently deleted (moodboards,
  characters, Styles, projects), and bring one back with the same id.
  `list_trash` takes `kind` (`moodboard`, `character`, `style` or `project`),
  and `scope` (`global`, or `project` with `project_id`, an id or
  `"current"`; `project_id` alone means `project`) as the route does. See
  [Recently deleted](#recently-deleted). CLI: `nebula trash list --scope
  global|project --project <id|current>`.
- The Commons (the smart moodboard's analyzed references; only with
  `NEBULA_COMMONS_ENABLED=1`), all in the agent's brand scope (pass
  `brand`): `commons_search` and `commons_get` read references;
  `commons_add` adds one to a collection's inbox; `commons_comment` comments
  (`membership_id` picks the collection's thread); `commons_borrow` records
  an attribute taken from one. Since 2026-10-20 (Justin's Q63 b):
  `commons_collections` lists the collections (`{"collections": [...]}`;
  `commons_add` takes one's id), `commons_status` the analysis queue,
  worker and meters as structured state (not the Commons toolbar's
  wording; `evaluation_waiting` with `evaluation_assisted` says which
  pause holds analysis and what lifts it; analysis then resumes only if
  `worker.running`), `commons_borrowings` the
  recorded borrowings (`{"borrowings": [...]}`; `asset` narrows it),
  `commons_concentration` each reference's share of them, and
  `commons_fidelity` checks a borrowing against the output it was used in
  and saves the result. A reference whose analysis failed has
  `asset.analysis_state` `analysis_failed`, `asset.last_error` (the reader's
  own text, unchanged) and, since error-copy round 3, `asset.last_error_kind`:
  `unavailable` (network, a timeout or the provider down), `unreadable` (the
  model declined or couldn't read the image) or `other`. Curating (corrections, regions, a reference's role,
  why or inbox place) is the person's: agents propose it, see
  [Commons curation](#commons-curation). Each has a `nebula commons` twin.
- `style_list`, `style_get`, `style_create`, `style_update`, `style_delete`:
  the Styles in Create and the Assets panel (a prompt fragment, optionally a
  model and its settings). `style_update` returns `previous`, which undoes it
  as one checked write; `style_delete` moves one to Recently deleted. See
  [Styles from the CLI and MCP](#styles-from-the-cli-and-mcp).
- `get_settings`: what agents need from Settings, from `GET /api/settings`:
  `configured` (each provider key's name with `true` or `false`), `routing`,
  `executionMode`, `batchSizeCap`, `exportFolder` and `kreaConnectionMode`.
  No part of a key comes back. The route itself sends a set key's last 4
  characters only to the app (its person token); any other caller, `curl`
  or `nebula keys` included, gets a bare `***` (Justin, Q55 a). Only the
  person changes settings. CLI: `nebula keys` (set or not set; `--json`
  prints this result). It turns each key into true or false as this tool
  does, so even a reply that carried an ending would print none; the CLI
  never has the person token.
- `provider_status`: whether each key works, from `GET /api/health/providers`
  (free, read-only checks, never a generation; cached 5 minutes, `refresh`
  checks again), and the Krea account connection from
  `GET /api/krea/connection`. The sign-in link a pending Krea connection
  carries is left out (`signInPending: true` instead): it is the person's to
  open. A probe's `detail` never quotes a key: when a saved key can't be sent
  (a pasted line break or space, which httpx's error would quote whole), the
  detail says so instead (`services/settings._probe_error_detail`).
  CLI: `nebula providers` (`--refresh`, `--json`).

And these canvas tools:

- `get_selected_nodes`: selected node IDs, display names, bounded/redacted
  parameters, output-port availability, and connections touching the
  selection.
- `look_at_canvas`: the canvas as data, so an agent doesn't need a
  screenshot. It returns the browser's viewport and visible area, every node
  with its run state, position, size and whether it is on screen, redacted
  parameters, output availability, connections, the selection, and agent cursors.
  An input holding an uploaded file has `fileName`, the name it was uploaded
  with (`nebula look` prints it as `file:`).
  A node whose last run failed has `state: "error"` with the message in
  `error` (and the plain-language `errorHint`, when there is one). Where a
  provider quoted a key in that message (OpenAI's 401 shows its first and
  last characters), the key is `<key hidden>`; `get_project` and `get_run`
  errors are cleaned the same way (`services/key_echoes.py`).
  `view.stale` is true when no browser has reported for 30 seconds.
  `proposals` lists the open proposals (id, agent, note, status).
  `providerHolds` lists the paid starts Nebula holds, as graph export has
  them: `recoveries` (an accepted World Labs operation a rerun resumes
  instead of paying again) and `startAmbiguities` (a start Nebula couldn't
  confirm; the node won't start again until someone checks Marble and
  clears it). Agents can read them, not clear them.
- `point_at`: moves the agent's cursor on the canvas to a node, a port or a
  flow-space point, with an optional short line beside it (`say`, the
  agent's own action only) and an optional drag gesture
  (`from_node_id`/`from_port`). With only `say`, the line shows where the
  cursor already is and it doesn't move; an agent with no cursor yet gets
  one at the middle of the person's view, or at (0, 0) when no canvas has
  reported a view (the result's `placed` is `cursor`, `view` or `origin`;
  `nebula point --say "..."` does the same). The cursor is named after
  `$NEBULA_AGENT_NAME`, or the MCP client's own name. What the agent
  noticed goes in `post_note` instead (see [Updates](#updates)).
- `post_note` / `list_notes`: post what the agent noticed, a report or a
  suggestion, and read the list back. The person reads them under
  **Updates** in the top right of every screen (the canvas, Projects, the
  studios, the Commons), saved with the project. Updates posted with
  `board` are kept with that board: the person sees them in Moodboard
  Studio's corner under "This board" (above the project's) while that board
  is open, and on no other screen, so post without `board` to reach the
  person anywhere. See [Updates](#updates).
- `wait_for_canvas_change`: blocks until the person (or another agent)
  changes the canvas, then returns what changed and who did it. It skips
  your own edits. When the person undoes your edit with Cmd+Z, the events
  say so: each has `edit.undoes` (your `undo.editId`) and `edit.of` (you),
  and an `edit.undone` event follows (a `proposal.reopened` the undo brought
  back can come after it, since its fit check finishes later; a later
  `edit.undone` of that undo lists them in its `events`: every pin and
  proposal event, and at most 50 others, with `eventsTruncated: true` and
  `eventsTotal` when it left some out). If you also use the `nebula` CLI, set `NEBULA_AGENT_NAME`
  so both share one name; otherwise your CLI edits arrive as `anonymous`
  (the result then carries a `note`). Pass the returned `cursor` back as `since`; see
  [Watching for changes](#watching-for-changes). The wait holds only its own
  call: other calls on the same server, such as the main agent's while a
  Claude Code subagent waits (subagents share the parent's connection) or
  parallel tool calls, answer meanwhile. Pass `journal` (the id the cursor
  came with) too, so a cursor from before a restart comes back as `reset`. Every tool runs off the server's
  event loop; up to 32 long calls (waits, runs, link downloads) run at once,
  and the short calls have 16 threads of their own. A wait the client
  cancels stops at its next poll (within 25 s).
- `resolve_pin`: answers one of the person's pinned notes (from
  `look_at_canvas` `pins`) with a one-line reply, which marks it resolved and
  moves the agent's cursor to it. See [Pins](#pins).
- `propose_change`: proposes new nodes, connections, param changes and runs as
  ghosts on the canvas. Nothing changes until the person clicks Accept. Use
  it before paid runs or reworking their graph. When a node the run needs
  can't run here (no key, no Krea sign-in, a route that can't take it), the
  reply has a `warning` naming each one, so the agent can say so or propose
  another model. Such a proposal is kept, with the warning; if the agent
  then proposes something else instead, it withdraws the first
  (`withdrawWith` is the exact call). See [Proposals](#proposals).
- `get_proposal`: reads one of your proposals; `wait_seconds` (up to 300)
  waits for the person's decision. On accept it returns `idMap` (your refs to
  real node ids) and `runNodeIds` (what the canvas will run; don't run them
  yourself).
- `withdraw_proposal`: takes back one of your open proposals. Withdraw one
  that can't run here before proposing something else instead.
- `propose_asset_change`: proposes a change outside the canvas that is the
  person's call: a project cover they pinned, a board's Send notes to
  generators, or curating a Commons reference. They decide on the Projects
  screen, in Moodboard Studio or in the Commons; `get_proposal` and
  `withdraw_proposal` take its id. See
  [Proposals outside the canvas](#proposals-outside-the-canvas).

- `ask_person`: asks the person 1-5 short questions, for a decision only
  they can make (a direction, a name, a detail the agent can't find), not to
  announce work (that's `post_note`) or for a change to approve (that's
  `propose_change`). Each question has `text`, optional `options` (2-6),
  `multiple` and `allow_text`; the set takes a `note` and `node_ids`. The
  person answers from an Update with Answer. See
  [Questions for the person](#questions-for-the-person).
- `get_answers`: reads your question set; `wait_seconds` (up to 300) waits
  for the person, through a Nebula restart too. Only the agent that asked
  reads it.
- `withdraw_questions`: takes back one of your open question sets.
- `set_status`: says what you are working on, one line (with `node_id` on a
  node) that the person sees under your name in the Agents panel at the top
  of Updates; empty text clears it. It lasts until you replace or clear it,
  or until you make no call to Nebula for 10 minutes. A status is what you
  are working on; `point_at`'s `say` is a passing remark, and `post_note` a
  report. See [The Agents panel](#the-agents-panel).
- `list_agents`: the agents around in the open project, as the person's
  panel lists them: status, the cursor's last action, and how many
  questions and proposals of each wait for the person (counts only).

There is no accept tool. Only the person accepts, in Nebula.
There is no answer or dismiss tool either: only the person answers questions.

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

Creating, connecting, setting, running, removing and disconnecting nodes move the
cursor automatically (a connection shows as a drag from port to port). To point
explicitly, with a short line about your own action:

```bash
NEBULA_AGENT_NAME="Claude Code" nebula point n2 --say "Checking this prompt"
nebula point n2.prompt --from n1.text --say "Connecting the prompt"
nebula look          # the canvas as text; --json for the full snapshot
```

Every one of these actions is also listed in the canvas's **Agent log**
(bottom right, shown by default with or without the chat; hide it from its
own eye-off button or Settings > Preferences > "Agent log"): the agent's
name in its cursor colour, the cursor's words ("Added “Moodboard”", "Running
“Krea 2”", "Connecting “Prompt” to “Krea 2”", "Accepted"; a node by its name in
curly quotes, else its type's name), and the time. A params change names the
fields by the labels the card shows them under, in the card's order: "Set
“Aspect ratio”", "Set “Aspect ratio” and “Resolution”", and "Changed 3 settings" for
three or more on the cursor (the Agent log names them all; a universal
node's own fields follow the card's order too). A field the card shows no label for is left out of the bubble
and its count (with none labelled the cursor moves without words), and the
Agent log names it by its key instead, after the labelled fields ("Set
“Aspect ratio”, “Seed” and seed_mode", "Set seed_mode"), up to four names
and then a count ("Set “Aspect ratio”, “Seed”, seed_mode, cfg and 2 more"). Moodboard writes are listed there too
(your edit batch's `say`, else the journal's words: "Set aside #1 on board
Dusk"; "Analyzed board Dusk"), and so is a run of the
whole canvas ("Running 4 nodes"); neither has one place on the canvas, so
they move no cursor. The log is in the browser's memory only: the last 50
entries, gone on reload.

The REST surface is `POST /api/canvas/cursor` (a `target`, or only `say` to
narrate where the cursor is; it answers with `placed`), `GET /api/canvas/snapshot`, and
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
| `node.added` / `node.removed` | create, cluster, connect-and-create / delete | definition, name; `proposalId` when an accepted proposal added it |
| `node.params` | a param changed (only keys whose value changed) | `keys`, redacted `values`; `proposalId` when an accepted proposal set it |
| `node.moved` | a drag ended, auto-layout or paste moved nodes 8 px or more | `nodeIds`, `count` |
| `node.renamed` | a node got a new name on the canvas (or went back to its model name) | `from`, `to` |
| `edge.added` / `edge.removed` | connected / disconnected | source, target and handles; `proposalId` when an accepted proposal connected it |
| `selection.changed` | the selected set changed | `nodeIds`, `count` |
| `run.started` / `run.finished` / `run.failed` | per node, attributed to whoever started the run | `runId`, `error`; `proposalId` on the run the canvas starts for an accepted proposal |
| `run.cancelled` | a run stopped, attributed to whoever pressed Stop or called `cancel_run` (the starter when another backend took the Stop) | `runId`, `startedBy` (`kind`, `name`) |
| `run.skipped` | a gate upstream (Jev Decide's On Pass / On Fail) withheld the node's input, so it never ran | `runId`, `reason`, `gateNodeId` |
| `canvas.replaced` | import, project opened or created; node ids restart | `reason` |
| `canvas.cleared` | Clear canvas | |
| `project.cover` | a project's cover was pinned, changed or set back to automatic, by the person, an agent, or an accepted proposal (its summary ends "(accepted from <agent>)") | `projectId`, `projectName`, `cover` (the url, or null for automatic) |
| `commons.corrected` / `commons.region` / `commons.membership` | the person curated a Commons reference: a correction, a region drawn or changed, a membership's role, why or inbox place; or accepted an agent's [Commons proposal](#commons-curation) (the summary ends "(accepted from <agent>)") | `assetId`; `fieldPath`, `op` for a correction; `regionId`, `change` (`["added"]` or the fields changed) for a region; `membershipId`, `collectionId`, `change` (`["accepted"]` or the fields) for a membership. Never Commons text (no values, labels or whys) |
| `pin.added` / `pin.removed` | the person left or deleted a note | `pinId`, `text`, `anchor` |
| `pin.resolved` | an agent answered a note | `pinId`, `text`, `reply` |
| `pin.detached` | a pinned node was deleted, or an import/clear removed it | `pinId`, `anchor` (where the node was) |
| `pin.reattached` | the undo of that delete (the person's Cmd+Z or Undo, or an agent's `undo_canvas_edit`) put the node back, and the note is on it again as before | `pinId`, `text`, `anchor` (`{nodeId}`) |
| `proposal.created` | an agent proposed a change | `proposalId`, `note`, `adds`, `wires`, `sets`, `runs`, `paidRuns`; for a [proposal outside the canvas](#proposals-outside-the-canvas) `kind`, `targetId`, `targetName`, `change` instead of the graph counts (the decisions after it carry `kind` and `targetId` too) |
| `proposal.accepted` | the person accepted; the added nodes and connections follow as `node.added` / `edge.added` by the person (for a project cover, `project.cover` by the person) | `proposalId`, `idMap`, `runNodeIds`; outside the canvas `kind`, `targetId`, `targetName`, `applied` (what was set) |
| `proposal.rejected` | the person rejected | `proposalId`, `reason` |
| `proposal.withdrawn` / `proposal.expired` / `proposal.invalidated` | the agent took it back, 15 minutes passed, or the canvas changed under it | `proposalId`, `reason` |
| `proposal.reopened` | a proposal a node delete invalidated is open again: the undo of that delete put the node back and the proposal still passes Accept's checks (same id, same expiry; it's in the open list and the person's bar again) | `proposalId`, `agentId`, `note`; outside the canvas (a cover whose image went with the node) `kind`, `targetId`, `targetName` |
| `board.added` / `board.removed` / `board.frame` / `board.grouped` / `board.setAside` / `board.resized` / `board.noted` / `board.moved` / `board.cover` | a moodboard edit or save changed the board's images, cards or frames: one event per write, its kind the first of these that applies (`noted` an image's notes, `grouped` is a card into or out of a frame, `moved` 8 px or more, `cover` the image the board opens on) | `kinds` (every kind in the write), `refs` (`{number, id}` per image), `boardId`, `boardName`, `scope`; never any note text ("private note changed") |
| `board.fields` | a moodboard edit, save or undo changed the board's own fields, by the person (Moodboard Studio, an accepted proposal) or an agent (`moodboard_update`, `moodboard_edit`'s `restore`, `nebula moodboard set`, `--restore`): one event per write, after the `board.*` event above when the same write changed images too; a write that changes no field writes none | `fields` (the names that changed, in this order: `name`, `notes`, `mode`, `strength`, `direction`, `avoid`, `pinnedColors`, `clashMode`, `colorChoices`, `sendNotes`, `briefOverride`), `boardId`, `boardName`, `scope`; never a value: no Direction, Avoid, notes or brief text, no colour, no strength, not which way Send notes went. The cover is `board.cover` |
| `project.created` / `project.deleted` / `project.restored` | anyone made a project (new, or a stale tab's recovered copy), moved one to Recently deleted, or brought one back | `projectId`, `name`; `wasOpen` on a delete; `createdBy` when an agent made it |
| `project.renamed` | a project's name changed (saving the same name again isn't journaled) | `projectId`, `from`, `to` |
| `provider.hold` | a paid start was held (a World Labs recovery checkpoint, or a start Nebula couldn't confirm) or cleared, attributed to whoever started the run or cleared it | `hold` (`recovery` or `startAmbiguity`), `change` (`held` or `cleared`), `runId`, `kind`, `durable` |
| `edit.undone` / `edit.redone` | a whole edit was undone (an agent's `undo_canvas_edit`, or the person's Cmd+Z of a step the canvas knew the edit of) or redone; after the node and connection events it made and the pins it put back (`pin.reattached`), and before any `proposal.reopened` of the same undo, which can follow it | `editId` (the edit reverted), `of` (whose), `editKind`, `events` (that edit's event cursors, oldest first: every event journaled under it but its own `edit.undone`, its `pin.*` and `proposal.*` ones always, and at most 50 of the rest), `eventsTruncated: true` and `eventsTotal` (how many it had) when that cut some, `undid` (for an undo of an undo), `counts`, `skipped` |
| `note.posted` | an agent posted an update to the person (Updates, `post_note`) | `surface` (canvas or board), `noteId`, `about`, `refs` (up to 12), `text`; `boardId`, `boardName` on a board |
| `style.created` / `style.updated` / `style.deleted` / `style.restored` / `style.purged` | a Style was saved, changed, moved to Recently deleted, restored from it, or deleted for good, by the person (Create, the Assets panel) or an agent (`style_*`, `nebula style`) | `styleId`, `styleName`, `scope` (`global` or the project id); `fields` (what an update changed: `name`, `category`, `prompt`, `params`, `modelId`, `refImages`, `thumbnail`); never a prompt or a setting's value |

Events of a canvas edit carry `edit`: an agent's `edit_canvas`,
`remove_from_canvas` or `nebula apply` gives each of its events `edit: {id}`
(the reply's `undo.editId`). An undo's events carry `edit: {id, undoes, of}`:
the edit id it reverted and whose edit that was (`redoes` for a redo). The
person's Cmd+Z is linked only when the canvas's step came from that edit's
graphSync (its `edit.id`); a step without one (the person's own edits, an
older edit) is journaled as before, with "(undo)" and no `edit`.

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
id it happened in, which can be one closed since (an Update saved as the
person opened another project); the answer's own `projectId` is the project
open now. Param values go through the same redaction as the
snapshot, and outputs never appear.

### Claude Code channels (experiment)

With `--channel`, Nebula's MCP server pushes into a running Claude Code
session, so Claude hears your pins and edits without sitting in
`wait_for_canvas_change`. It is built on [Claude Code
channels](https://code.claude.com/docs/en/channels-reference), a research
preview: the flags, the protocol and this section may change, and a Claude
Code update can break it. The code is `backend/mcp_channel.py` (what to push
and when) and `serve_channel` in `backend/mcp_server.py` (how it hooks into the server).

It is off unless you start a session with it. Without `--channel` the server
is exactly the one above: same capabilities, instructions and tools.

**Try it.** Write a session-only MCP config, for example
`~/.nebula-listen.mcp.json` (mode 600, outside any repo). Copy the command,
args and env of your saved `nebula` server (`claude mcp get nebula` shows
them) and add `--channel`; it names your token file, never the token:

```json
{
  "mcpServers": {
    "nebula-listen": {
      "command": "/path/to/nebula_nodes/backend/.venv/bin/python",
      "args": ["/path/to/nebula_nodes/backend/mcp_server.py", "--channel"],
      "env": {
        "NEBULA_URL": "http://127.0.0.1:8000",
        "NEBULA_APP_TOKEN_FILE": "/path/to/your/app-token-file"
      }
    }
  }
}
```

Then, each time:

```bash
claude --mcp-config ~/.nebula-listen.mcp.json \
  --dangerously-load-development-channels server:nebula-listen \
  --disallowedTools "mcp__nebula__*"
```

`--disallowedTools "mcp__nebula__*"` takes the saved server's copies of the
same tools out of the session, so `nebula-listen` serves both the tools and the
pushes. It has to: the listener learns which proposals and runs are Claude's,
and when a turn is under way, from the tool calls it serves. Claude
Code first shows **WARNING: Loading development channels**; choose **I am
using this for local development**. In the debug log (`claude --debug-file
<file> ...`) the server then shows `Channel notifications registered`.

**What the development flag does.** It lets the one server you name put text
in front of Claude, skipping Anthropic's channel allowlist for that entry
(Nebula isn't on it during the preview). Nebula sends only its own summaries,
but text anyone can write on the canvas (a pin, a node or board name, another
agent's rename) can reach Claude through it, marked as data. Use it only with
a Nebula you run yourself. Anthropic's own warning (channels reference): "Don't
use it to run channels from untrusted sources." Never add `--channel` to
your saved `nebula` server: the server can't tell whether the session opted it
in (Claude Code doesn't acknowledge a push, and the `initialize` request looks
the same either way), so in an ordinary session it would push into nothing.
The server doesn't offer Claude Code's permission relay
(`claude/channel/permission`), so nobody can answer a permission prompt
through it.

**Requirements** (from Claude Code's channels pages, read 2026-10-20). Claude
Code 2.1.234 or later (tried with 2.1.304), signed in with claude.ai or a
Console API key: channels aren't available on Bedrock, Google Cloud or
Foundry. Channels need an individual account (Pro or Max, which need nothing
more) or an Owner's org switch: on a claude.ai Team or Enterprise seat an
Owner must first turn on Organization settings > Claude Code > Channels
(`channelsEnabled`), which allows channels for every seat in the org. The
development flag doesn't get past that switch, and until then the server's
tools work but nothing is pushed. (Nebula's own Team org keeps it off for
now; the experiment is tried on individual accounts.) It doesn't work with
`claude -p` or the Agent SDK: Claude Code ignores the flag there.

**What wakes Claude:**

- a pin you add, at once (pins under 1 s apart go together), as long as it
  is still open when it goes (below);
- your decision on one of its own proposals (accepted, rejected, expired or
  invalidated), from `propose_change` or `propose_asset_change`, unless it is
  already waiting for it in `get_proposal` or withdrew it. One an undo
  reopens counts again: its next decision wakes it too;
- the end of a run it started and stopped waiting for (`run_nodes` or
  `get_run` answered "running"), unless it is collecting it with `get_run`.
  The run the canvas starts for its accepted proposal counts as its own run:
  Nebula names the proposal in that run's events. A run you start yourself,
  even on the nodes the proposal listed, is yours. Reading your run with
  `get_run` never makes it Claude's;
- a change you make, 8 s after your last edit and 30 s at most after the
  first: a node added, removed, edited (its settings) or renamed, a connection
  made or removed, or a pin deleted;
- a run you start, once, when it ends (finished, failed or stopped), with its
  result: its status and how many nodes ran, the outputs being in `get_run`.
  Its start never wakes it, and a run still going after 5 minutes goes then,
  as still running. It counts as a change.

A change, or the end of your run, waits too while Claude is mid-turn (a
Nebula call running, or one in the last 20 s).

Some of your edits don't wake it on their own: a moodboard edit, and a
replaced or cleared canvas (another project opened, a graph loaded, Clear).
Each adds a line to the next push, whatever wakes it; a replaced or cleared
canvas also tells Claude to call `start_here`. A board write that only moved
cards is left out, like a node move; a card's weight (`board.resized`) is an
edit.

Selections and moves never wake it, nor do other agents, nor its own edits:
the listener long-polls `/api/canvas/events` under the tools' own name and
token, so Nebula leaves those out. The nodes, connections and settings an
accepted proposal applies are not counted as your edits (Nebula marks them
with `proposalId`; a node's name can't pass for one), nor is the board write
of an accepted `propose_asset_change` of Claude's own (turning on a board's
Send notes to generators, marked the same way). Another agent's accepted
board proposal still adds a line, since you made it happen. At most 20 wakes an
hour, 30 s apart; anything past a limit arrives with the next one (`held` says
how many waited), and past 100 waiting edits (or 100 pins) the push gives a
count and asks for `look_at_canvas`; a pile of edits never pushes a pin out.
After 2 hours with no activity from you (selections
and moves count) it stops listening, and the next Nebula tool result says so;
in Claude Code, /mcp > nebula-listen > Reconnect starts it again. If the
listener itself fails, it stops the same way (a stderr line, and the next
result says so) and the tools keep working. If Nebula keeps failing to answer
for one of Claude's runs (10 errors in a row, about 6 minutes), the listener
stops following it and the next result says to read it with `get_run`.

A push arrives as `<channel source="nebula-listen" wake="pin|proposal|run|change"
count="…" cursor="…" journal="…" project_id="…">`, with `held="…"` and
`gate="change"` when they apply. The text is written from the same events
`wait_for_canvas_change` returns: event summaries (redacted param values never
appear, only which params changed), the pin's text, a proposal's note and the
reason you gave, a run's status and how many nodes ran. Nothing else is
fetched, run outputs and errors stay in `get_run`, and moodboard events never
carry note text. Canvas text has its angle brackets and hidden characters
replaced, so it can't close or open a tag.

**What a woken turn may do** (plan v2.7 Q42 a and Q51 a). Some pushes are
gated (`gate="change"`): Claude may look (the read tools), point and say
something (`point_at`), post an Update (`post_note`), answer a pin and propose
(`propose_change`, `propose_asset_change` for a cover, a board's notes or the
Commons, `get_proposal`, `withdraw_proposal`). Edits, runs, project
switches, board writes and any tool not on that list are refused for that
turn, so it offers instead of editing under your hands. Which pushes:

- **Never gated:** a push that holds a pin of yours still open (whatever
  else it carries), and one for your accepting its proposal or for its own
  run's end. Those act
  like any turn, and none of them ends a gated turn's window early.
- **Always gated:** a push for a proposal you rejected, that expired or that
  was invalidated (it may only offer again), and a push carrying your edits:
  a change, the end of your run, a moodboard or canvas line, or lost events.
- **Both at once:** a push that carries your edits and an accept or its own
  run's end is gated, since the edits are your hands on the canvas.

A gated push goes only when Claude isn't mid-turn, so the gate never lands
on a turn already running. No push ever closes or shortens a gated turn's
window: a push that isn't gated (a pin too) waits until the window has
ended on its own terms, at least 60 s after the gated push and then 20 s
with no Nebula call and none running. A Nebula call still running (a
`get_proposal` or `wait_for_canvas_change` wait) keeps the window open,
however long it waits. The cost: a pin you add during a gated turn's window
waits for that window's end, at least a minute after the change push and
longer while that turn keeps calling Nebula. While a pin waits, no other
gated push goes, unless Nebula can't answer the check (below): a proposal
you reject meanwhile, and the edits you make meanwhile, go with the pin
when it does, in one push that isn't gated (it holds a pin). Edits from
your last 8 s before it goes are the exception: they aren't due yet (the
8 s quiet time), so they follow in a gated push of their own, at least
30 s later and once Claude has made no Nebula call for 20 s. So a pin waits
only for the window it came in, however long you keep editing. Claude
Code wouldn't give it to the running turn anyway (pushes that arrive while
Claude is busy are delivered together on its next turn), so sending it
sooner could only have freed the change turn to edit.

**Only a pin still open lifts the gate.** A pin wake needs a pin of yours
that is still open when it goes. A pin you delete, one any agent answers
(Claude's own `resolve_pin` included, even in a gated turn), and the pins
of a project that is no longer open (anyone's switch, or the open project's
delete) leave the waiting batch at once. A pin whose node is deleted stays:
it keeps its place on the canvas. When a push would hold pins, the listener
first asks Nebula which of them are still open (`GET /api/canvas/pins`), and
the push carries only the pins Nebula lists open on the project that is
open. That catches what its event feed can't show: a pin answered with the
`nebula` CLI under the same agent name (Nebula leaves an agent's own events
out of its feed), a delete lost while Nebula restarted, or a pin of the
project you just switched away from. A batch left with no pin goes gated,
like any batch carrying your edits. The check is a local request that
answers at once: a push waits for it a second at most, after which an
accept or the end of Claude's own run goes without the pins, and past 4 s
the check counts as failed. If Nebula can't answer the check, only the pins wait: it checks
again (5 s after the failure, doubling up to 60 s), every other push goes
meanwhile by its own rules, without them, and the server's log says so
once the check has failed for a minute. Once no pin waits (each was
answered, deleted or left with its project), a later pin's checks start
afresh, at 5 s. If Nebula refuses the check
(an error such as an agent token it no longer accepts), the pins are dropped
without a wake, and the log says how many. "Still open" means still open
when Nebula answered: a pin you delete in the moment between that answer and
the push, or before Claude Code hands the push over, still arrives as a pin
wake.

The gate lives in this MCP server process, and that has two gaps. Nebula
can't see where a Claude Code turn ends, so the timing is guessed from when
Nebula sends the push: the window lasts at least 60 s after it and until
Nebula has had no call for 20 s. That guess can miss both ways:

- A turn you type can be refused. If you type a request to Claude within
  that minute, it is refused the same way (in the live check Claude proposed
  the edit instead).
- A change turn can go ungated. If Claude is busy with other work (no Nebula
  call) when a gated push is sent, Claude Code hands it over on the next
  turn; if that is more than a minute later, the window has already ended
  and that turn may edit. The same happens when a woken turn, after its
  first minute, pauses more than 20 s between Nebula calls.

And it covers only this server's tools, not the `nebula` CLI or another
Nebula MCP server in the same session: Claude is told not to edit through
them in that turn, but nothing stops it. A later version moves the gate into
Nebula itself, where it covers every client. "5 minutes per turn" can't be
enforced either; after 5 minutes a gated turn's tool results say to wrap up.

**Stop** by restarting Claude Code without the flag.

**Nothing arrives?** Start with `claude --debug-file <file> …` and look for
`Channel notifications registered` or `Channel notifications skipped:
<reason>`. "blocked by org policy" means the Owner switch above. If the reason
is "negotiated a modern protocol revision", set
`MCP_PROTOCOL_NEGOTIATION=legacy`; with Nebula's MCP library (mcp 1.27.0,
newest revision 2025-11-25) the connection stays on the earlier handshake and
registers without it. The server writes a line to stderr when it starts
listening and when it stops. `NEBULA_CHANNEL_TRACE=<file>` appends the
client's `initialize` request to a file; the `NEBULA_CHANNEL_*` timing
variables in `mcp_channel.Limits` exist for tests.

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
- deleting for good from Recently deleted (`DELETE /api/trash/{kind}/{id}`,
  `POST /api/trash/empty`, `DELETE /api/projects/trash/{id}`,
  `POST /api/projects/trash/empty`). It can't be undone. The refusal tells an
  agent it can restore instead (see Recently deleted below);
- `POST /api/enhance-prompt`, the Create button's rewrite. The gate comes
  first; then prompts over 4,000 characters get a 413 that says so, and more
  than 20 calls a minute get a 429. Each call logs provider, length and outcome
  (never the prompt) to `nebula.enhance_prompt`. An agent that wants a prompt
  rewritten writes it itself, or adds a text node (`claude-chat`,
  `gpt-4o-chat`, `gemini-chat`), whose run is held to the spending limits.

Everything else, including running nodes, is open to agents and held to the
spending limits. The person isn't limited.

#### Who may stop a run

Agents stop only runs an agent started (Justin, 2026-10-20). The backend
records who started each run as it registers it (`ExecutionRunRecord.started_by`
in `services/execution_runs.py`: the person, a named agent, or anonymous), and
`DELETE /api/executions/{runId}` (the canvas's Stop, `cancel_run`, `nebula
cancel`) checks it before it records anything:

| Started by | The person stops it | A named agent stops it | Anonymous stops it |
|---|---|---|---|
| the person | yes | 403 `agent_refused` | 403 `person_required` |
| a named agent | yes | yes (any agent) | yes |
| anonymous | yes | yes | yes |

Anonymous is a caller with no agent marker and no person token: the `nebula`
CLI without `NEBULA_AGENT_NAME`, curl, a tab not connected as the person.
Its runs count as an agent's, since nothing proves the person started them;
its Stop is not the person's. So from the CLI by hand, `nebula cancel` still
stops what the CLI (or any agent) started, and a run started from the canvas
answers "ask them to press Stop in Nebula". A refused Stop leaves no durable
Stop intent, so no other backend stops the run either. A run ID that no run
here has used still takes the pre-admission Stop intent from anyone, as
before; one whose `/api/execute` is still being admitted is judged by the
journal's note of its starter. A run that already ended answers its status
to anyone, since nothing is left to stop.

Round 16 of PR #114: a Stop for a run ID this backend hasn't started yet
(the canvas's Stop racing its own `/api/execute`, or `cancel_run` on an id
whose start is still on its way) is kept, so that start never runs. Besides
the durable pre-admission intent (the cross-process filter, which a Stop
for an unknown run may compact at once), the backend keeps the ID in memory
for an hour (`ExecutionRunRegistry.tombstone`, up to 4,096 IDs, the oldest
dropped first; it never refuses new work, and it holds even when the
durable journal couldn't take the Stop). `/api/execute`, `/api/execute-node`
and shot runs (`/api/cinema/generate-shot`) check both at their first check
and again at the last one before the run is registered, with nothing
awaited in between, so a start that began before the Stop landed is refused
with 409 "run '<id>' was cancelled before it started" and nothing is sent or
spent. What each surface says:

- `DELETE /api/executions/{runId}` and `GET /api/executions/{runId}` answer
  `{"status": "cancelled", "pendingAdmission": true}`.
- `cancel_run` adds `next`: "Nebula hadn't started this run yet. The stop
  is recorded, and Nebula won't start a run with this id, so nothing runs
  and nothing is spent."
- `get_run` (and `GET /api/graph/runs/{runId}`) answers `status: "cancelled"`
  with `neverStarted: true` and `next`: "Stopped before it started. Nebula
  won't start a run with this id, so nothing ran and nothing was spent."
- `nebula cancel` prints "Run <id> hadn't started yet. Nebula won't start
  it now, so nothing runs and nothing is spent."; `nebula result` on that id
  prints "Run <id> was stopped before it started, so nothing ran and
  nothing was spent." (exit code as for any stopped run).

The canvas settles such a run as stopped (if the person pressed Stop) or as
not started, and it can be run again under a new ID.

Round 17 of PR #114 (review 16 L1): "never started" is said only when this
backend process saw that run's start begin (`ExecutionRunRegistry`
notes the ID as `/api/execute`, `/api/execute-node` or
`/api/cinema/generate-shot` takes it, before anything is awaited). An ID it
has no record of at all (a run from before Nebula restarted, or a typo) is
still stopped for good the same way, but the answers say so instead of
claiming nothing ran:

- `DELETE` and `GET /api/executions/{runId}` add `noRecord: true` beside
  `pendingAdmission`.
- `get_run` (and `GET /api/graph/runs/{runId}`) answers `status: "unknown"`
  with `noRecord: true` (no `neverStarted`), and `cancel_run` and `get_run`
  give `next`: "Nebula has no record of run <id>. If it started before
  Nebula restarted, check Run History for what it did."
- `nebula cancel` and `nebula result` print that same line; `nebula result`
  exits 1.

A run-admission refusal (507) names which store failed in `code`:
`run_safeguards` is the run-safety store (the paid-start fence, the
recovery journal, durable Stop state), and the canvas says "Couldn't start
the run. Nebula couldn't save its run safeguards, so nothing was started.
Restart Nebula, then try again." `project_store` is the project catalog
(an unreadable `catalog.json` or a storage error): nothing was started
either (the project is read before the run exists), but a restart doesn't
clear it, so the canvas gives its general line. Repairing the catalog or
the storage does, and the same start then works. Don't parse `detail`.

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

### Refusal text: the person's line, your detail

A refusal says one of two texts in `detail` (error-copy rounds 2 and 3,
`backend/services/refusal_copy.py`): the person's canvas and the Commons UI
get a line written for people ("That board isn't there anymore. Reload to
get the latest boards."), and everyone else (MCP, the CLI, a script, any
request with an agent marker) gets the specific text, unchanged: "Moodboard
'mb_1' not found", "Cannot delete n3: it has unresolved World Labs paid
state...". The choice is by who asks, never by what they may do: a request
with `X-Nebula-Agent`, `X-Nebula-Client` or an `Agent` token always gets the
specific text, and the Commons decides by its actor (its UI session is the
person). Parse status codes and your detail; don't match the person's lines.

Round 3b added the World Labs refusals to this split, with the same statuses
and the same checks: the status bar's "I've checked Marble" (`DELETE
/api/provider-start-ambiguities/...`: "Cannot acknowledge a World Labs
paid-start ambiguity while that provider handshake is still active", "World
Labs paid-start ambiguity changed; ..."), Run History's "Forget ID" (`DELETE
/api/provider-recoveries/...`: "World Labs recovery checkpoint changed; ..."),
a run start the paid-start guard refuses (`POST /api/execute`,
`/api/execute-node`, shot runs: "Fresh paid ... start is safety-locked ...",
"... already active ...", "... already has a recovery checkpoint ...", the
journals "at capacity") and a canvas edit that races the recovery journal.
You still get each text word for word; only the person's line is new.

Round 14 of PR #114 gave one World Labs state its own detail. When the
backend started, if Nebula couldn't journal a World Labs recovery ID it read
from the canvas, restoring a graph bundle (`POST /api/outputs/restore`,
`load_graph_file` or `nebula load` with a `.nebula.zip`) first retries that
journal write under the paid-start fence, as a run start does, then (since
round 15) writes the journal for real and reads it back, so the retry
succeeds only when the journal takes a write now. If it does, the restore
goes on. If the journal still can't be written, it refuses with 409:
"Cannot restore a graph bundle: Nebula retried saving its World Labs
recovery journal and couldn't write it. Restart the Nebula backend, then
try again." (`load_graph_file` and `nebula load` put the file's path
first). Retrying won't clear it; the person has to restart Nebula. The
person's canvas reads "Nebula couldn't save its World Labs safeguards.
Restart Nebula, then try again." under its own heading. If it's the
paid-start fence's own storage that can't be read or written, the restore
answers 507 "Cannot restore a graph bundle because Nebula cannot verify the
durable World Labs paid-start fence." instead, as any canvas replacement
does then; that is a different store, and restarting Nebula is the fix
there too. An edit that takes the fence (a param or model change, a node
delete, Clear, Accept, a canvas edit or replacement) clears the bootstrap
state the same way, only after a real journal write. A run start clears it
only when the run has World Labs work to claim; an ordinary run doesn't
touch it.

Round 3c gave a node's run error the same split. `error` stays the
handler's specific text, word for word, wherever agents read it: `get_run`
and `nebula result` (`errors`), `look_at_canvas` and `nebula look` (the
node's `error`, with `errorHint`), `view_output`, the run record, and the
journal. A handler may also write a line for the person (no ids, no
parameter names: "World Labs accepted this run, ... The node's Resume
Operation ID field keeps the job ..."); it rides beside `error` as the
additive `person` on the execution event and `errorPerson` in the graph the
canvas loads, and the card shows it. Since round 3c-2 every failure a
handler words itself carries one (often the same text, when it names no id,
path, parameter key or env var), and a plain "<KEY> is required" key check
reads "Add your OpenAI API key in Settings, then run the node again." on the
card. A provider's own text keeps no line: the card says "Couldn't run the
node." with the classifier's line or the general one, and the raw text behind
"Details". None of the texts you read changed. A Cinema shot that fails
keeps `error` on the shot's `output` as before and adds `errorCategory`,
`errorFriendly`, `errorPerson` and `errorRaw` (the full text when `error` was
cut) for the Cinema panel. Read `error`; don't parse `person` or the shot's
error* fields.

Round 3d gives a provider's answer a line too, from one table: a 401 or 403
reads "{Provider} didn't accept your API key. ...", a 402 or an exhausted
quota "Your {Provider} account is out of credits. ...", a 429 "{Provider} is
busy. ...", a 5xx "{Provider} is having trouble right now. ...", an empty
answer "{Provider} didn't return a result. ...", and a paid job Nebula stopped
waiting on "{Provider} is taking longer than usual. ...", naming the provider
the run called (a provider switcher's or Auto's route). Such a line rides as
`person` with the additive `providerText: true` on the execution event
(`errorProviderText` in the graph and on a shot's `output`): the card keeps
the provider's own words, your `error`, behind "Details". A failure Nebula
can't tell keeps today's line. `error` and every text you read are unchanged,
word for word.

Round 3f puts GM's rules on every card line (a final period, no dashes or
parentheses, "connected" for "wired", field labels as the node shows them,
"Nothing was sent to {Provider}.", one spelling per name and unit). Only the
person's lines changed: `error`, `errorHint`, `detail`, `missing` and every
text you read stay word for word. The slow-job line now reads "{Provider} took
too long, so Nebula stopped waiting. ...". Three fields are additive and for
the canvas only: the execution event's `provider` (`errorProvider` in the
graph and on a shot's `output`) is the provider the run called, from the
route it took, set only when that provider answered (a status, a job failure,
its own words), so a card with no line of its own says "Run the node again. If
it keeps failing, Details shows what {Provider} said."; a failure before
anything was sent leaves it empty and the card says "open Details"; each `cost.notReady`
row has a `person` line beside `missing`; and a project storage refusal
(507) adds `storage: "full"` beside `detail` when the disk is full. Don't
parse any of them.

The status is the one the provider's API answered, attached where Nebula
raised the error, never a number read out of the text (round 3d, part 2): a
storage upload's 403 or "Prompt is too long: 500 characters over" keeps
today's line. A job the provider took and then reported failed, cancelled or
expired never reads the key, busy or trouble line, and its `category`
(`errorCategory` on a shot) is never `auth`, even when its text says
"unauthorized" or "401" (an input the job couldn't fetch, not your key). Such
a job used to read `auth` and "The API key was rejected. ..." as `friendly`;
that was wrong, and is the one change you can see. Its other categories
(`rate_limit`, `timeout`, `quota`, ...) stay.

Round 3e gave the pre-run check the same split. A run the check refuses
(a missing key, an unconnected required input, a Batch over its cap, a connection
that no longer fits) still answers agents exactly as before: `run_nodes`,
`/api/graph/run` and `nebula run` list each node's `message` in `errors`,
word for word ("Missing API key: OPENAI_API_KEY", "Required input port
'prompt' is not connected", "Batch has 3 items, exceeding its
batch_size_cap of 2. ..."), and `look_at_canvas` / `nebula look` show it
as the node's `error`. Only the canvas's own answer (`/api/execute`,
`/api/execute-node`, a shot run) and the `validationError` socket event
gain an additive `person` on each error ("Add your OpenAI API key in
Settings, then run the node again.", "Connect a prompt, then run the node
again."), which the card shows; a check only agents or a damaged saved
graph reach has none, and the card reads the general line. The Paper source
routes (`/api/paper/...`, the person's) work the same way: `detail.message`
is unchanged and `detail.person` is the card's line, and a source record
keeps `lastError` beside the new `lastErrorPerson`. Read `message` /
`error` / `lastError`; never parse `person`.

### Numbers in request bodies

Every JSON request body (`application/json`, `application/*+json`, any
other type that starts with `application/json` such as
`application/json-seq`, which some routes accept, or no content type) is
checked once before any route reads it
(`backend/services/json_number_guard.py`, added inside the Host/Origin guard
and inside CORS). `NaN`, `Infinity`, `-Infinity`, and numbers too big for a
float (`1e400`, an integer like `10**400`, or one over 4,300 digits) get a
422 with one line, for example `{"detail": "JSON number out of range: 1e400.
Send a finite number between about -1.8e308 and 1.8e308."}`. Only number
tokens count: a string holding "NaN" or 400 digits is fine, and a body that
isn't JSON at all gets the route's own error. A body whose first character
rules out a JSON number (a zip sent with no content type) streams through
unread. Places that parse client JSON
themselves follow the same rule through `loads_checked`: the `/ws` and
`/ws/chat` frames (the chat socket answers an `error` event), proposal
accept and reject bodies, and `graph.json` in a restore bundle (400 "Invalid
graph.json: ...").

### Canvas writes: the project and the canvas they were made for

The person's canvas tab sends two headers with every request that changes
the graph or starts work on the canvas: `X-Nebula-Workspace-Revision` (the
project it holds open) and `X-Nebula-Canvas-Revision` (which canvas of that
project: a new one after every clear and every graph load or import).
Nebula refuses the write with 409 `{"detail": "This canvas is out of date.
Open the current project before editing or running it."}` when either names
something other than what is open now, so an edit made for one canvas never
lands on the nodes of the next (node ids start again at n1 after a clear or
a load).

Which routes: since round 20 every route that changes the graph or starts
work on the canvas is marked in the backend (`graph_write` in
`backend/main.py`), and the check reads the marker of the route a request
matches, not its path. That is every write under `/api/graph…`,
`/api/execute` and `/api/execute-node`, `/api/cinema…` and `/api/quick`,
plus `DELETE /api/provider-recoveries/{run_id}/{node_id}` and
`POST /api/uploads` when it adds a node (`create_node`). The upload checks in
the route, in the same step that adds the node, after the file is read and
probed: a drop made for a project or canvas that was switched or cleared
while it uploaded is refused, and no node is added. An upload without
`create_node` adds nothing and isn't checked. Every other non-GET route is
on a reviewed list of routes that don't touch the graph
(`backend/tests/test_round20_fence.py`); Stop (`DELETE /api/executions/…`)
stays open while the canvas follows an agent's switch.

A write that carries `X-Nebula-Tab` (only the canvas sends it) to one of
those routes must also carry `X-Nebula-Workspace-Revision`; without it, the
same 409. A tab that has let go of its project (it is following an agent's
switch) can't write into whatever is open next. Agents, the CLI, MCP and
scripts send none of these headers and are unchanged: their writes go to
the canvas open when they land. A script that sends `X-Nebula-Tab` is
treated as a canvas tab.

`/api/projects/…` isn't fenced this way. A project save names its project
by id (`PUT /api/projects/{id}` with the workspace revision in its body),
so when an agent's `open_project` or `new_project` switches away, the
person's canvas still saves its last edits into the project it left (the
handoff). For nodes Nebula already had, the project keeps Nebula's copy,
except the settings and names the tab lists as not yet sent
(`pendingParams: {nodeId: {key: value}}`, `pendingLabels: {nodeId: name or
null}` beside `snapshot`): those keys, read from the saved snapshot after
its checks, are merged per top-level setting onto Nebula's copy, so typing
still in its debounce is kept, and your edit to another setting of the same
node stays. Nodes only the tab had are added as they are. If a listed node
isn't in the save, is another kind of node in the project, or the lists are
malformed, the whole save is refused with 409 and the canvas keeps it as a
copy (the person sees that it wasn't saved).

The canvas revision is in every graphSync (`canvasRevision`), in
`GET /api/graph/export`, and in the answers of `DELETE /api/graph`,
`POST /api/graph/import`, and opening or making a project. It is the same
per-project counter undo restores use: a restore made for a canvas a clear
or an import replaced is refused. It is kept in the state dir
(`canvas-revisions.json`, written before the canvas changes), so a backend
restart keeps it: after a restart the canvas says the same revision and
writes the canvas held keep landing.

A run notes its canvas when it starts. If that canvas is cleared while the
run goes, the run's results and the settings its nodes changed are not
written back onto the new canvas (whose nodes may reuse the old ids); the
run's own events still report them.

Param writes merge per key. `PUT /api/graph/node/{id}` with `{"params":
{...}}` changes only the keys sent; a key not sent keeps its value, whoever
set it. The canvas sends only the keys the person changed, so your edit to
another setting of the same node is never written back over. Two writers
setting the same key: the later write wins (per top-level setting: a nested
object or list is replaced whole). (One exception: an agent that
changes a universal node's model sets the node's params for that model.)

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
`resolve_pin(pin_id, reply)`. Resolving again replaces the reply. The reply
is about your own answer; anything else you noticed goes in an update
(below).

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

### Updates

`say` is for your own action. What you noticed, a report or a suggestion
goes in an **update**: the person reads it in the Updates corner in the top
right, not at your cursor. The corner is on every screen (the canvas,
Projects, Moodboard Studio, the Commons, Creator Studio and the other
studios; Justin's Q107 a, 2026-10-21) and always shows the open project's
list, so an update reaches the person wherever they work; with no project
open (a first start with no projects yet) there is no list and no corner.
A card drops from the "Updates" chip for about four seconds and outlines the
nodes it names in your colour; the chip counts the updates the person
hasn't opened; the list keeps every one, newest first, with your name, the
time and a "Show on canvas" button that frames what it names (from another
screen it opens the canvas first). Updates are saved with the project (beside the
canvas snapshot, like pins, so autosave never touches them) and switch with
it. A moodboard's (posted with `board` / `--board`) are saved beside the board
(`<moodboards>/.notes/<id>.json`, never in the board file). While the person
has that board open in Moodboard Studio, the corner's list shows them first,
under "This board" ("kept with this board"), then the project's, with one
count for both; opening the list reads both, and with no board updates the
list is just the project's. "Show #12" / "Show on board" selects and frames
the images on the board. Every other screen shows only the project's list,
so leave out `board` to reach the person anywhere. You read them back with
`list_notes(board=...)` or `nebula notes --board <name>`.

```bash
nebula note "The two portrait branches use different seeds; I'll match them" --node n4 --node n7
nebula note "#12 reads painterly and dither" --board Dusk --ref 12   # shown in Moodboard Studio on Dusk, under This board
nebula note "You moved the lake into Painterly" --board Dusk --since-last-turn
nebula notes --unread                                   # the list, newest first
```

Over MCP: `post_note(text, board?, refs?, about?)` and
`list_notes(board?, unread?)`. The words "note" stay in the tool names; on
screen they are Updates. Every proposal posts its own Update with **Review**
and marks it with how it ended: a canvas one (`propose_change`, `nebula
propose`; see [Proposals](#proposals)) and one outside the canvas
(`propose_asset_change`; see [Proposals outside the canvas](#proposals-outside-the-canvas)).
Don't post an update to announce a proposal.

Rules:

- Text is one plain line, 1–240 characters. `refs` (at most 12) are node ids
  on the canvas, or image ids or numbers on a board; unknown ones are left
  out and listed in `dropped`, never outlined from a guess. On a board, `#12`
  in the text is saved as that image, so it always shows its current number
  ("(removed)" once it's gone); a `#n` not on the board refuses the update
  ("#45 isn't on this board").
- `about`: `sinceLastTurn` (what the person changed since your last turn; a
  newer one replaces your unread one) or `other` (the default). Other values
  are Nebula's own.
- No buttons: an agent's update carries no actions. Do the change, or propose
  it. Nebula's own updates (the board reader's results, from later versions)
  carry them.
- An update that quotes a private note (the person's own label on a board
  image) is refused (`note_quotes_private_note`): a whole note of 12 or more
  characters, or any 32-character run of a longer one, compared without case,
  punctuation or extra spaces. On the canvas every board the project can see
  is checked (its own and the Global ones).
- At most 6 a minute per agent per canvas or board (429
  `notes_rate_limited`); a proposal's Update is Nebula's, so it neither
  counts nor is refused. 200 kept per project and 100 per board, the oldest
  read ones dropped first.
- Agents post and list. Only the person marks updates read (opening the list
  marks them all; `{upTo}` reads that one and everything older, `{ids}` just
  those) or dismisses one: `POST .../agent-notes/read` and
  `.../{id}/dismiss` require the person token. A dismissed update stays in
  the list, greyed.
- Each update is one `note.posted` event in the change journal
  (`nebula watch --kinds note`); reading and dismissing aren't.
- REST: `GET`/`POST /api/canvas/agent-notes` and
  `/api/moodboards/{id}/agent-notes` (`?unread=1`), body `{text, refs?,
  about?}`, answer `{note, dropped, removed, unread}` (`removed`: updates
  that left the list to make room, such as your replaced "since its last
  turn" one). The `agentNotes` socket message (`op`: `sync`, `added`, `read`,
  `dismissed`, `acted`) keeps every tab's chip in step.
  A board `PUT` that sends `agentNotes` is refused (422).

### Proposals

An agent can propose a change instead of making it: new nodes, connections, param
changes on existing nodes, and which nodes to run. The person sees ghost
nodes and dashed connections in the agent's colour and a bar at the bottom of the
canvas with **Show**, **Reject** and **Accept** (or **Accept & run (N
paid)**). They can drag ghosts before accepting; the nodes land where they
dropped them. Accept adds everything in one step (one undo) and starts the
runs from the canvas, as if the person had clicked Run. Use proposals before
anything that costs money or reworks the person's graph.

**The Update.** Every canvas proposal also posts an Update in the Updates
corner (Justin's Q112 a, 2026-10-21), so the person hears of it on every
screen, not only on the canvas: "Claude Code proposes 3 changes on the
canvas" ("proposes 1 change", or "proposes a run on the canvas" when it
only runs nodes). Each new node, each connection and each existing node whose
params change counts as one change; runs and names don't. Nebula writes it
from that template, never from the agent's note (the note is the bar's), and
attributes it to the agent (`source: "nebula"`, `about: "proposal"`,
`proposal: {id, kind: "canvas", targetId: <project id>}`). Its one
**Review** action (`proposal.review`, `target: "canvas"`) takes the person
to the canvas from any screen, with that proposal shown in the bar and its
ghosts in view. Every proposal gets its own Update, on the list of the
project it was made in. None replaces another, with one exception: your next
proposal replaces the Update of one you withdrew yourself (the socket's
`removed`), so withdrawing and proposing again leaves one Update, not two; with no project open there is
none (`update: null`). It doesn't count against the agent's `post_note`
limit, so don't also post an update to announce the proposal. The view's
`update` is `{id, projectId}`. When the proposal closes the Update gets
`resolvedAt`, `resolvedBy`, `readAt` and an `outcome` in place of Review:
"Accepted", "Rejected" (never the person's reason), "Withdrawn by Claude
Code", "Expired" (on time, even when nobody reads proposals), "No longer
fits" (a node it needs was deleted, the canvas was cleared or replaced by an
import or another project, or what it changes was edited since), or
"Closed: Nebula restarted" (proposals live in memory; settled the next time
the list is read: `list_notes`, the person's tab reconnecting, a project
switch). The socket sends `agentNotes` op `added` and then `resolved` for
the open project. Agents read it with `list_notes` / `nebula notes`.

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
middle of the person's view, clear of existing nodes. `--rename
+up="Wide, upscaled"` names a new node: the ghost shows the name with the
model beside its ref ("+up · Topaz Image Upscale · proposed by Codex"), and
Accept applies it. A proposal can't rename a node already on the canvas
(422, "Rename existing nodes with edit_canvas (or `nebula rename`)"), and
`nebula propose` doesn't take `apply`'s `--move`, `--remove`, `--unwire` or
`--arrange` (each gets an error naming it). `--file plan.json` takes the
same thing as JSON, which is also the `POST /api/canvas/proposals` body and
the `propose_change` arguments:

```json
{
  "note": "Widen the take and upscale it",
  "nodes": [{"ref": "+up", "definitionId": "topaz-image-upscale", "params": {"upscale_factor": 2}}],
  "edges": [{"source": "n4", "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
  "params": [{"nodeId": "n4", "params": {"aspect_ratio": "16:9"}}],
  "rename": {"+up": "Wide, upscaled"},
  "run": ["+up"]
}
```

A named node's entry in the proposal has `name` (the given name) and
`model` (the model's own name); an unnamed one has only `name`, the name its
card will show (the model's, without the gateway for a node whose provider
depends on the keys).

`--wait` exits 0 when accepted (printing the new ids and what the canvas will
run), 3 when rejected (with the person's reason, if any), 4 when withdrawn,
expired or invalidated, and 2 on timeout (600 s default, still open).

**Cost wording.** Proposals say how many paid model runs and free nodes
would run, and from which providers: each entry in `cost.nodes` names the
provider its run would go through with the keys set (`provider`, and
`label` "paid · krea"), the route its `price` is for. A Krea copy that runs
on its maker's API with the person's key names the maker (Grok Imagine 2.0
on an xAI key: `xai`, priced at xAI's price, never Krea's; its `label` is
"paid · Grok Imagine 2.0 via xAI"), and a connection into a Krea-only input
(Grok's style images) keeps it on `krea`, named the same way ("paid · Grok
Imagine 2.0 via Krea"); the person's confirm rows name the same route
("Grok Imagine 2.0 via xAI · $0.06", "“Alt still” · Grok Imagine 2.0 via
Krea · price not listed"). When the canvas can't read the person's keys in
time, a row leaves the route out rather than name one that may be old
("“Grok Imagine 2.0” · $0.06", "“Alt still” · Grok Imagine 2.0 · $0.06"); the
price is still Nebula's. If
a route or price has moved by the time the person says yes, the confirm asks
again and says which node moved, named as its row reads now ("“Alt still”
changed while this was open."; two or three by name, "4 nodes changed while
this was open." past that), and its Run ignores clicks for half a second. Its
rows price the nodes whose route moved at the canvas's own route-aware
numbers, and the rest at the refusal's `estimate`.
Upstream nodes that have no outputs yet
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
`price` ({low, high} or null). A node priced from its input file's size is
priced from the file it would get (an upload, or an upstream output that
already exists); while that file doesn't exist yet it is in `unpriced` and
`awaitingInput`. These are list prices, not a quote.

**Nodes that can't run here.** `cost.notReady` lists every node the run
reads, upstream nodes with outputs included, that can't run here as set up,
as `[{ref, nodeId, name, missing, person}]`. `missing` is in the words `find_nodes`
and `describe_node` use (`node_readiness.instance_missing`, read at the
values Accept would write: "needs OPENAI_API_KEY in Settings > Providers",
a Krea sign-in, or why the chosen route can't take it), and the cost entry
of such a node has the same `missing`. `propose_change` and `nebula propose`
turn the list into a `warning` (`canvas_proposals.readiness_warning`), each
pointing at its own way to find a node that runs here: `find_nodes` for MCP,
`nebula nodes` for the CLI (its twin), and `GET /api/agent/nodes` in the HTTP reply. On
the canvas the ghost shows the ⚠ a real node shows, with the same title, and
the bar lists the nodes under its summary (three, then the rest in its
details), each in its `person` line ("GPT Image 2 needs your OpenAI API key.
Add it in Settings.", round 3f; read `missing`, not that). Both re-check keys as the person adds them, so a line goes away
once its key is set. Accept stays enabled, as the canvas's Run button does
for a node without its key: the run is refused at that node before any
provider is called, and the node shows why.

**Withdraw it before proposing something else.** A proposal that can't run
here is kept, with the warning (Justin's call, Q109: not refused, and
nothing is withdrawn for the agent). The warning ends with the call that
takes it back, and the reply's `withdrawWith` is that call on its own:
`withdraw_proposal(proposal_id="p_…")` for MCP, `nebula proposal withdraw
p_…` for the CLI (with `--as <name>` when the agent named itself with
`--as`), `DELETE /api/canvas/proposals/p_…` over HTTP. If the agent then
proposes something else instead, it withdraws the first, so the person has
one proposal to answer, not two. As a reminder, while the same agent still
has an open proposal on this canvas that can't run, its next proposal's
reply lists it in `stillOpen` (`[{id, note, withdrawWith}]`) and says so in
`reminder` ("Your proposal p_… is still open and can't run here; withdraw
it if this one replaces it: …"); `nebula propose` prints it as a
`reminder:` line. `nebula propose --json --wait` prints these as they
stand after the wait: once the person has decided, `withdrawWith` and the
warning's withdraw step are gone, and `stillOpen` keeps only proposals still
open. Other agents' proposals, and the agent's proposals that
can run, don't count. Open proposals in `start_here`, `nebula context` and
`nebula look` carry `cantRun` (how many of the run's nodes can't run here,
when any can't), so an agent that comes back later sees it too. The state
is the one read when each proposal was made.

Rules:

- Proposals are checked like direct edits: unknown node types, ports, params
  or connections, cycles and missing node ids are refused when proposed (400 or
  422), so the person never sees
  something that can't be added. Cinema scene params and World Labs
  durable-recovery nodes can't be proposed.
- Limits: 12 new nodes, 24 connections, 12 param changes and 6 run targets per
  proposal (the person reviews each item; direct edits have no such limit);
  3 open per agent and 12 in total (429 beyond); a 160-character
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
  changed since the proposal was made: a node's settings, its connections in, or a
  node gone. After Accept, every node those runs can start is locked against
  edits by anyone but the person until the canvas starts the run: set params,
  `apply`, connect, disconnect and delete on them return 409 ("in a run the person
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

### Questions for the person

When an agent reaches a decision only the person can make (which of two
directions, a name or wording that is theirs, a detail it can't find on the
canvas), it asks (Q125 item 1, 2026-10-24). A concrete change to approve is
a proposal instead, and what it noticed is an Update.

- **Ask:** MCP `ask_person(questions, note?, node_ids?)`, CLI
  `nebula ask --question "..." --option A --option B --question "..."` (`--multiple`
  and `--no-text` belong to the question before them; `--file` takes JSON),
  HTTP `POST /api/canvas/questions` with `{questions: [{text, options?,
  multiple?, allowText?}], note?, nodeIds?}`. 1-5 questions; `text` is one
  plain line (200 characters); `options` are 2-6 different choices (80
  characters each); `multiple` (default false) takes any number of them;
  `allowText` (default true) adds a typed answer, and a question with no
  options must allow it. `note` (160 characters) says why. `nodeIds` are
  checked like an Update's refs: unknown ones are dropped and listed in
  `dropped`. Needs an open project (the Update is kept with it). The answer
  is `{questions: {id, status, questions, answers, ...}}`.
- **The person answers:** the set posts one Update from the agent ("Claude
  Code has 2 questions.", with Answer, and Show on canvas when it names
  nodes). Answer opens the form in the Updates corner. They may skip any
  question; Send needs at least one answer; Dismiss closes the set with
  none. When it closes, its line goes past tense ("Claude Code asked 2
  questions." / "asked a question.", on the stored Update, so `list_notes`
  shows it too) and it says "Answered.", "Dismissed.",
  "Withdrawn by <agent>." (or "Closed when Nebula restarted." in the rare
  case a kept set can't be read back). The 200-Update cap never prunes the
  Update of an open set (at most 12 are open, so the cap holds); once the
  set closes its Update is pruned like any other. The questions
  and the answers are never on the Update, so other agents' `list_notes`
  never shows them.
- **Read:** MCP `get_answers(question_id, wait_seconds)`, CLI
  `nebula answers <id> [--wait N]` (with --wait: exit 0 answered, 2 no answer yet, 3
  dismissed, 4 withdrawn; without --wait it always exits 0, so read the status
  it prints), HTTP `GET /api/canvas/questions/{id}?wait=<seconds>` (25 at
  most per request). A wait (`wait_seconds`, `--wait`) rides through a
  Nebula restart: while Nebula isn't answering at all (refused, reset, no
  answer) it retries with a short backoff (0.25 s doubling to 2 s) within
  the wait, then keeps waiting; a real answer (404, 403, a 5xx) ends it as
  before, and so does Nebula still down when the wait runs out. A cancelled
  MCP call or Ctrl-C ends it at once. `get_proposal` doesn't retry
  (proposals don't survive a restart). Status is `open`, `answered`, `dismissed` or
  `withdrawn`; `answers` has `{questionId, answered, choices, text}` per
  question (`answered: false` for one the person skipped). Only the agent
  that asked reads its set: anyone else gets 404. The person's typed text is
  their message to that agent: it is never journaled or logged, and no
  socket but the person's own gets it.
- **Withdraw:** MCP `withdraw_questions(question_id)`, CLI
  `nebula questions withdraw <id>`, HTTP `DELETE /api/canvas/questions/{id}`. Only the asker.
- **Limits:** 3 open sets per agent and 12 in all. At the cap the refusal
  (429) says "You already have 3 open question sets. Wait for answers or
  withdraw one." and lists your open sets (`stillOpen`, each with
  `withdrawWith`, the exact call in your surface's words). Your own 3
  include sets in a project in Recently deleted (you can withdraw them);
  the 12 in all count only sets the person can answer now, so sets in
  Recently deleted don't hold other agents off.
- **No expiry; sets survive a restart:** a set waits until the person
  answers or dismisses it, or the agent withdraws it. It is kept with the
  project it was asked in (on the project's record, next to its pins and
  Updates), so a Nebula restart keeps it open with the same id and owner:
  `get_answers` from the same agent name still reads it, and the person can
  still answer from its Update. It stays with the project in Recently
  deleted and goes when the project is deleted for good (however that
  happens: emptied, purged one by one, or past its 30 days). An open set
  whose Update has left the project's list (only a hand-edited or damaged
  record: the 200-Update cap skips open sets' Updates) can't be answered
  any more, so it goes too. Answering doesn't
  depend on which project is open. Closed sets, with their answers, are
  readable for 30 minutes (at most 50), across restarts too. A gone id is
  a 404 whose detail says to ask again.
- **Events:** `question.asked`, `question.answered`, `question.dismissed`
  and `question.withdrawn` in the journal (`wait_for_canvas_change`,
  `nebula watch`) carry `{questionId, agentId, count}` only.

Who may answer: only the person, checked the way accepting a proposal is.
`POST /api/canvas/questions/{id}/answer` (`{answers: [{questionId,
choices?, text?}]}`) and `/dismiss` refuse any agent marker and need this
launch's person token (`require_person`), and also the set's answer key in
`X-Nebula-Proposal-Key` (the proposal key's header). The key goes only to
the person's browser sockets (`questionsOpened`, and `questionsSync` after
hello); `questionsClosed` goes only to them too, since it carries the
answers back. There is no answer tool or command for agents. The remaining
risk is the proposals' one (a program with its own unsandboxed shell as the
same user).

### The Agents panel

Q125 item 2 (Justin, 2026-10-24: "Yes, all four, in that order"). The top of
the Updates corner lists the agents working in the open project in two
groups: **Needs you** (an agent with open questions or proposals there,
longest wait first) and **Working** (everyone else around, most recent
first). Clicking a Working row shows its node on the canvas; clicking a
Needs-you row opens its oldest question set or proposal.

- **Set your status:** MCP `set_status(text, node_id?)`, CLI
  `nebula status "<text>" [--node nX]`, HTTP `POST /api/canvas/status` with
  `{text, nodeId?}`. One line, cleaned like a cursor's `say` (whitespace
  collapsed, 140 characters at most: a longer one is cut after its last
  whole word that fits when that keeps at least 100 characters, else cut
  hard (a long URL stays mostly whole), and ends in "…"; a hard cut never
  splits a character (an accent, an emoji sequence, a flag); `nodeId` must be a node on the open
  canvas. Empty text clears it (`set_status("")`, `nebula status --clear`).
  Only an identified agent sets one, and only its own: the browser gets 403,
  an unnamed caller 400, and the body takes no agent name. A bare
  `nebula status` still prints the nodes' run state.
- **How long it lasts:** until you replace or clear it, or until 10 minutes
  pass with no sign of you. Any request that names you counts (a status,
  a cursor move, an edit, a run, a question, a proposal, a read), checked
  once for every request (`RequestHeadersContext` in
  `services/agent_presence.py`). Statuses live in memory, like cursors: a
  restart clears them (open questions are kept with the project). Each
  belongs to the project open when it was set, and no other project's
  roster shows it. A node delete drops the node from a status on it, and so
  does any graph replace (a clear, a load, a project switch): the line
  stays.
- **Live:** every change is an `agentStatus` event on the socket
  (`change`: `set`, `cleared`, `expired` or `unanchored`, with the agent,
  the status or null, and a rising `rev`). Cursor events (`agentPresence`)
  carry `projectId` and, for actions the panel names, `did`: `{verb,
  nodeId, label, secondsAgo}` ("Added", "Connected", "Disconnected",
  "Changed", "Renamed", "Moved", "Removed", "Ran", ...; `secondsAgo` is how
  long ago that action was). Of a bare `point_at`, only pointing at a node
  ("Pointed at"), looking at a node ("Looked at") and looking at a spot
  ("Looked around") name an action; a click, a drag or a move to a spot
  keeps your last action. "Moved" is only a real node move. A single
  `nebula rename` or `nebula move` (the label and layout routes) now moves
  your cursor to that node too, like any other edit.
- **The roster:** MCP `list_agents()`, CLI `nebula agents [--json]`, HTTP
  `GET /api/canvas/agents`: `{projectId, agents, rev}`. One entry per agent
  around in the open project (a live cursor there, a live status there, or
  an open question set or proposal there, canvas or asset): `agent` (id,
  name, color, verified), `group` (`needsYou` or `working`), `status`
  (`{text, nodeId, secondsAgo}` or null), `lastAction` (`{verb, nodeId,
  label, secondsAgo}` from the cursor, `secondsAgo` the action's own, or null), `cursor` (`{nodeId, action,
  secondsAgo}` or null), `needsYou` (`{questions, proposals}`: the
  questions in its open sets, not the sets, and its open proposals; an
  asset proposal made with no project open, so with no Update, counts in
  whichever project is open), `waitingSeconds` (the oldest open item's
  age) and `activeSecondsAgo`.
  Counts only: never the text of another agent's questions, the person's
  answers, a proposal's note, or a cursor's `say`. Each entry also lists
  `pending` (that agent's placeholder ids on the open canvas) and `running`
  (`[{runId, nodeId, model, secondsAgo}]`: the nodes its runs are running
  now); an agent with only placeholders is listed too.

### Placeholders, the run mark and done cards

Q125 item 3 (Justin, 2026-10-24; GM - Design's rulings, 2026-10-25).

- **Placeholders (pending nodes):** MCP `edit_canvas(..., pending=True)`,
  CLI `nebula apply --add ... --pending`, HTTP `POST /api/graph/apply` with
  `"pending": true` makes the call's **new** nodes your placeholders while
  you set them up: the canvas draws a dashed outline in your colour and
  dims the preview with "<you> is setting this up." The reply lists them in
  `pending`. Only new nodes: `pending: true` with no new nodes is refused
  (422), and no agent marks a node already on the canvas or the person's.
  In a steps plan, put `"pending": true` on the step that adds them.
- **Making them ready:** `edit_canvas(pending=False, node_ids=["n4"])`,
  `nebula apply --ready n4 [--ready n5]`, HTTP `{"pending": false,
  "nodeIds": [...]}` (a step may name earlier steps' +refs). The reply has
  `ready` and `notPending`. Only the owner: naming another agent's
  placeholder refuses the whole call (403, nothing changes). They also turn
  normal, and nothing is ever deleted, when you run them (your run clears
  your own once it starts: a run refused before it starts, by the pre-call
  check, a cycle or the spending check, leaves them pending), after 10
  minutes with no request from you (the status line's rule and clock), when
  the person edits one (params, the model picker, name, a real move, a
  connection to or from it), or when the person runs one directly (its own Run; an
  accepted proposal's run is not that). The person's direct Run of a node
  runs what feeds it too, so every placeholder in that run turns normal and
  runs. Another agent's edit to it, or yours, leaves it pending.
- **Runs skip them:** every way to run (the toolbar Run, a node's Run,
  MCP `run_nodes`, `nebula run`, an accepted proposal's run) skips each
  placeholder and every node downstream that needs its output, before
  anything is priced: nothing is spent on them. Each gets a `skipped`
  event with an agent-readable reason ("Codex is still setting this up.",
  which the canvas's Skipped badge shows as "Skipped: Codex is still
  setting this up.", or "needs “Hero prompt”, which Codex is still setting
  up." for a node downstream, naming the placeholder by its name, or its
  type's name when it has none); run results list them in `skipped` beside
  a gate's skips;
  a canvas run's reply adds `pendingSkipped` ({count, placeholders,
  agents}: `count` is the placeholders and what needs them, `placeholders`
  the placeholders alone) for the line
  under Run ("Skipped 3 nodes Codex is still setting up.", "Skipped 3
  nodes the agents are still setting up." when they are more than one
  agent's), and the run's Agent log line ends with
  the same sentence. The cost the person sees before a run matches what it
  runs: a whole-canvas Run, Run selected and an accepted proposal's run
  leave the skipped nodes out (a proposal's `cost` adds `pendingSkipped`;
  a proposal whose whole run waits on them reads "runs nothing until Codex
  finishes 2 nodes", or "agents finish" for several, counting the
  placeholders themselves, and its button reads "Accept": Accept starts no
  run for it (it would skip every node; no Run history entry) and frees its
  approval, and nothing is queued for when you finish), and the person's
  direct Run of a node counts the placeholders it runs, with "Includes 2
  nodes Codex is still setting up." ("Includes 3 nodes the agents are
  still setting up." for several agents) under the cost. A proposal's run is
  priced when it is made, so a placeholder in it that turns normal before
  the run starts (its owner's `pending: false`, the idle rule) changes what
  it runs: Accept refuses it (409, "what it runs changed after it was
  proposed"), the approved run refuses it ("changed since you accepted"),
  and while an approved run waits to start, its placeholders can't be made
  ready (409). A placeholder's owner is part of the run's fingerprint.
- **The person confirms paid ones:** when the person's direct run would
  make a placeholder that calls a paid model normal (a node's Run, the
  Inspector, a Cinema shot's Generate, a replay of a node run or a shot
  from Run history), the canvas always asks first (whatever "Ask before
  costly runs" is set to), in one dialog that replaces the costly-run
  confirm: "Run 2 nodes Codex is still setting up?" ("Run 3 nodes the
  agents are still setting up?" for several agents), a row per paid
  placeholder with its agent's dot ("“Hero still” · FLUX · $0.04"; a node
  whose model is a free-text param names the chosen model as its card
  shows it, "“Writer” · openai/gpt-4o-mini · price not listed", so a switch
  to another model is a changed row, even when the node is named after its
  model; a Meshy node names its Model option and its mesh type, even at
  the default, "Mesh type: Smart Topology (Meshy T2)", since it picks the
  model that runs; a Krea node also names its
  sub-model setting as its card does, even at the default: "“Hero” · Krea 2
  · Variant: Medium · on your Krea plan", "Engine: …" on Magnific Creative,
  "Model: …" on Topaz Image Upscale and Topaz Standard, "Training Model: …" on Krea Style
  Train, "Grain model: …" on Topaz Bloom 2 and Wonder 3.5 while Grain is on
  (with Grain off no grain model runs), "Enhancement model: …" and "Frame
  interpolation model: …" on Topaz Video Upscale, "Frame interpolation
  model: …" on Topaz Starlight Precise, Starlight Precise 2.5, Astra, Astra
  2 and Hyperion 2.5, "Version: …" on a Krea node app, so switching one asks
  again; a required one with nothing chosen reads "Model: not chosen"
  ("Version: not chosen") and the row keeps its other parts, though such a
  run never reaches the dialog (a required field with nothing chosen, below): a setting is named when it chooses which model or engine runs, so
  Magnific Precise's Flavor (a style of the same engine) is not; Krea Style
  Search's free-text Model is a search filter, never named as the model),
  "price
  not listed", "price depends on its input" while an input's size is
  measured, "on your Krea plan"), then a muted row with no dot for every
  other paid node in the run ("“Shot 1” · Nano Banana · $0.07"), so every
  dollar in the total has a row, the free placeholders in one line, the
  run's total, then "Cancel" and "Run for $0.12" ("Run for up to $0.86" for
  a range; from Cinema "Generate for $0.12", "Generate for up to $0.50",
  "Generate"). The amount in the button and the total line is always in
  cents, rounded up to the next cent ($0.201 shows "$0.21", $10.481
  "$10.49", anything under a cent "$0.01"); the rows keep their own prices.
  A dollar amount shows only when it covers every paid row (a
  Krea-plan row costs nothing extra): with a row that has none the total
  reads "The listed prices total $0.43." and the button just "Run", and a
  footnote names those rows: "“Flux still” has no list price, so the run
  may cost more." (two by name, "3 nodes have no list price, …" for more);
  for rows priced by their input, "“Upscale” is priced by its input, so the
  run may cost more." / "“Upscale” and “Grade” are priced by their input,
  …"; both kinds together, or three or more priced by their input, "3 nodes
  have no price yet, so the run may cost more."; with nothing priced there
  is no total and no footnote. With many paid nodes the rows scroll inside
  the dialog (a Tab stop when they do), and the heading, total, footnote
  and buttons stay on screen; focus starts on Cancel. Cancel changes nothing. A price read from an input file (FLUX
  Video Upscale, SeedVR2) is measured while the dialog is open, and the
  row updates in place. When a node's route or price changes after the
  dialog first shows, it names the node above the rows, as its row reads
  now ("“Alt still” changed while this was open."; two or three by name,
  "4 nodes changed while this was open." past that), and the line stays;
  a node joining or leaving the run adds no such line (the line for
  placeholders that left the run covers it). A screen reader hears each
  change, and after any change in place (a row, a price, the heading) Run
  takes no click for 500 ms. Once it has shown, the dialog stays in charge of
  that run until it is sent or cancelled. It follows only that run's
  placeholders (another agent's elsewhere on the canvas never changes it):
  if their agents finish them while it is open, it reads "Run with Codex's
  changes?" / "Codex finished setting up this node." ("… these nodes." for
  two or more; "Run with the agents' changes?" / "The agents finished
  setting up these nodes." for several agents); if they leave the run
  (deleted, or disconnected) and none finished, "Run without the node Codex
  was setting up?" / "It's no longer in this run." ("Run without the nodes
  Codex was setting up?" / "They're no longer in this run."; several
  agents, "Run without the nodes the agents were setting up?"); if some
  finished and some left, the "changes" heading counting the finished ones,
  then "1 node Codex was setting up is no longer in this run." ("2 nodes …
  are no longer in this run."; several agents, "2 nodes the agents were
  setting up are no longer in this run."); and if some are still placeholders, the
  first heading counting only those, with the same line for any that left
  under its body. A replay from Run history sends its saved copy of every
  node, so it words what runs: a placeholder deleted from the canvas, or
  turned into another type and finished, counts as one that left (never
  "finished"), and its saved copy runs as a muted row priced in the total;
  one still a placeholder under another type is asked about, as Nebula
  does (it reads placeholders by id). A placeholder its agent changed after
  the run was saved (same type, other settings) runs at its saved settings,
  so the dialog says so: "Replay the saved version?" / "Codex changed
  “Grade” after the run was saved. The replay uses the saved settings."
  (two: "“Grade” and “Wide”"; three: "“Wide”, “Hero still” and
  “Grade”"; four or more: "4 nodes"; the names in the order of the rows
  under it; several agents, "The agents changed …"), with the saved
  version as a muted row; if placeholders are still being set up, the
  still-setting-up heading stays and that sentence goes under its body,
  before the left line. One finished with the saved settings reads "Run
  with Codex's changes?" as above. If anything changed by the time the
  person clicks, it asks again over the new run; a run with no placeholder
  left goes ahead without asking again only if its total is no higher than
  the one the person saw, every row in it was on screen exactly as it is
  now (the same node, model, Krea setting and price; a row now on another
  model or setting or at another price, even a cheaper one, asks again), and every "Not included"
  note in it was on screen, held to that total. If another run started
  first, a yes runs nothing and the canvas says "Nothing ran. Another run
  started first. Click “Run” again when it finishes." (from Cinema, "…
  Generate again when it finishes."); if a graph import is running,
  "Nothing ran. Nebula is still importing. Click “Run” again when it
  finishes." (from Cinema, "… Generate again when it finishes."). A notice
  that arrives while "Codex changed the canvas" offers its Undo shows above
  it and leaves the Undo in place. While the dialog is open, focus stays in
  it (if the rows stop scrolling while they have focus, focus moves to
  Cancel) and no key acts behind it: not Cmd+Enter, Delete or Backspace,
  Cmd+K, Cmd+O or any other canvas shortcut, nor Moodboard Studio's or the
  video editors' keys, wherever focus is (the same for every modal dialog,
  the keyboard shortcuts, the command palette and the mask painter
  included). Every modal dialog covers the whole window (the mask painter
  too), and nothing pressed or clicked inside one reaches
  what is behind it: arrows, Enter, Space and Escape in the Mesh or World
  preview never move, select or deselect its node, and a click or
  right-click there never selects it or opens its menu.
  The costly-run setting's browser confirm never follows it. A row wraps
  only between its parts, at the " · ", never inside one ("Grain model:
  gaussian", "on your Krea plan", a node's name), and its second line keeps
  the row's indent.
- **A required field nobody chose:** some Krea nodes have required fields
  with no default, and Krea refuses a request without them: Krea 2 (Large,
  Medium, Turbo), GPT Image 2.5 Flare and Sunburst, Recraft V4.1 Flash,
  Grok Imagine 2.0 and Z Image need an Aspect ratio and a Resolution; Flux
  1.1 Pro, Seedream 4 and 5, Wan 2.1 and 2.2, Magnific Creative and
  Precise, and Topaz Bloom, Bloom 2, Image Upscale, Standard and Wonder 3.5
  need a Width and a Height; Topaz Standard also needs its Model, a Krea
  node app its Version, Krea Style Train its Name. Nebula never fills one
  in. Only the route the run takes counts (the one `describe_node` and the
  run's price name): Krea's own API (a Krea token, or the person's Krea
  plan) needs every one of these. A copy that runs on its maker's API with
  the person's key needs only what that API sizes by: GPT Image 2.5 Flare
  and Sunburst with an OpenAI key, and Grok Imagine 2.0 with an xAI key,
  run without an Aspect ratio or Resolution (OpenAI picks the size, xAI
  leaves it out); Seedream 4 and 5 with a BytePlus key still need a Width
  and a Height. A connection into a Krea-only input (Grok's style images) keeps
  the run on Krea. With no key that can run it (or the plan not signed in),
  no field is named: the run is refused for the key or the sign-in first.
  Your `run_nodes` and `nebula run` get "Missing API key: KREA_API_TOKEN"
  (or every key a copy can use: "Missing API key: XAI_API_KEY or
  KREA_API_TOKEN"), the card "Add your Krea API token in Settings, then
  run the node again."; a run on the plan that isn't signed in gets
  "Connect your Krea account in Settings before running this recipe".
  A run that would send one with nothing in it is refused before anything
  runs or is priced, on every run path, and before any dialog (the canvas
  reads the keys and the plan's sign-in first when it hasn't yet, and
  checks again when the person says yes: a key removed or a connection made
  while the dialog was open refuses instead of sending, and a run whose
  route changed asks again with the new row): the canvas
  says "Nothing ran. Choose an aspect ratio for “Hero” first." for a
  picker ("… a model …", "… a version …", "… a resolution …") and "Nothing
  ran. Set a width for “Hero” first." for a value typed in ("… a height
  …", "… a name …"), naming only the first missing field in the card's
  order, and asks nothing. Your `run_nodes` and `nebula run` come back
  `failed` with that line, without "Nothing ran.", as that node's error
  (and in `error`, after "Nothing ran, so nothing was spent."), and the
  card shows the same line; `nebula quick` gets the same refusal (HTTP 400,
  naming the node type). A whole-canvas run that skips the node (a
  placeholder) isn't refused for it. Set the field with `edit_canvas` (or
  `nebula set`) before you run it, or leave it for the person to choose.
  `/api/execute-node` and `/api/cinema/generate-shot` enforce it: the
  person's run carries `confirmedPlaceholders` (exactly those paid
  placeholder ids) and `confirmedCost` (the amount the dialog showed in its
  button and total line, USD: the listed prices' upper total rounded up to
  the cent; required with
  `confirmedPlaceholders` whenever Nebula can price the run) or gets 409
  `placeholder_confirm_required` before anything is priced or changes.
  Nebula holds the run to its own estimate: at the keys in Settings, with
  every price read from an input file measured first (an inline `data:`
  image too, as `POST /api/pricing/input-sizes` measures it for the
  canvas), a shot as one shot times its variations, multiplied and then
  rounded to 6 places (an amount above zero never reads as 0: under half a
  millionth it reads 0.000001, so `confirmedCost: 0` can't pass a run that
  costs something; the canvas shows and sends $0.01 for it); anything above
  `confirmedCost` (no slack) gets the same 409. A run that carries `confirmedCost` is held to it even when
  no placeholder is left (their agents finished them while the dialog was
  open); `confirmedPlaceholders` then doesn't matter. A paid node with no
  list price counts nothing on either side, as the dialog says. The 409
  carries `placeholders` (empty when none is left), `agents` (each one's
  owner), `estimate` (`low`, `high`, `nodes` {id: {low, high}}, `unpriced`,
  `plan`, `plus`, `unavailable`, `awaitingInput`) and the message "Nothing
  ran. This run includes 1 paid node Codex is still setting up, and Nebula
  asks before running those. Click “Run” again to review it." (a shot's
  ends "Generate again to review it."; with no placeholder left, "Nothing
  ran. This run changed since you last reviewed it. Click “Run” again to
  review it."). The canvas never shows that message: it takes the start
  back (no Run history record, nothing Queued, no Stop), asks again at
  once in its dialog, priced at `estimate`, and starts the same run again
  with `estimate.high` rounded up to the cent after a yes; the message is
  for a tab too old to do that. Free placeholders need no confirmation. Agents' runs are
  unchanged: your own placeholders run when you run them, and a Cinema
  shot you start skips another agent's.
- **Saved with the graph:** the flag lives on the node with its owner
  (`{agent: {id, name, color, verified}, at}`), in the persisted graph, the
  export (`data.pending`) and the project, so it survives a reload and a
  project switch. Saves take it from the live graph, never from a tab.
  `look_at_canvas` shows `pending: {agent, agentId}` on such a node. The
  person's undo and redo (`POST /api/graph/restore`) put it back as the
  step had it (`pending` on a node item: the flag, or null). Your own undo
  (`undo_canvas_edit`, `nebula undo`) does the same from what the server
  kept: a placeholder you removed comes back as one, and undoing your
  `pending: false` makes those nodes placeholders again (the reply's
  `placeholders`; not a node someone else ran since, nor one changed since
  by anyone: params, name, a move of 8 px or more, a connection to or from
  it, which is `skipped` with reason "changed since"). An agent's restore
  never sets or clears one otherwise.
- **The run mark:** while a run an agent started is on a node, the canvas
  shows that agent's pill above it ("Running FLUX.2 [pro] · 0:41": the
  chosen Model option, or the model id a free-text model param names, such
  as "openai/gpt-4o-mini" or a fal endpoint; else the node name in quotes,
  "Running “Text Input” · 0:03"; the person's paid-placeholder dialog names
  a row's model the same way), once the run has
  gone 1 s; `model` carries the quotes), from
  `agentRun` socket events (`change`: started or ended, with `agent`,
  `runId`, `nodeId`, `model`, `projectId`, `secondsAgo`). A status line on
  a node (`set_status(text, node_id)`) shows the same pill.
- **Done cards:** when a run an agent started ends (finished, partly
  failed or failed; not stopped), Nebula posts one Update for it under that
  agent's name (`source: "nebula"`, `about: "run"`): "Codex finished
  “Hero shots”.", "Codex finished 2 of 3 nodes. “Upscale” failed.",
  "Codex's run of 3 nodes failed." Its `run` is `{id, nodeIds, lastNodeId,
  outcome, thumbnail?}`; `refs` is the last node, which **Show on canvas**
  flies to. The thumbnail links an output Nebula already keeps
  (`/api/outputs/...`, never a provider URL or a copy): the last node's
  first output for a success, the last output that succeeded for a
  partial run, none for a failure or a text or audio output. A failed run
  also gets an Agent log line. A newer card for the same node and agent
  replaces the older one. The agent reads its own with `list_notes`. Runs
  the person starts get no card.

### Proposals outside the canvas

Some of the person's calls live on a project or a board, not on the graph
(audit U16; Justin's Q60 a, 2026-10-20). An agent proposes those with
`propose_asset_change(kind, id, change, note)` (`POST /api/asset-proposals`
with the same four fields), and the person decides where they work on that
thing:

| `kind` | `change` | Decided | Applied through |
|---|---|---|---|
| `project` (a project id) | `{"cover": url}` (one of `list_project_covers`' images) or `{"cover": ""}` (automatic) | on the project's card on the Projects screen: the cover now and the one proposed, side by side, with **Keep mine** and **Use this cover** | `PUT /api/projects/{id}/cover`, as the person |
| `moodboard` (a board's id or name) | `{"sendNotes": true}` | in Moodboard Studio, under the board's Send notes switch, with **Keep them here** and **Send them** | `PUT /api/moodboards/{id}`, as the person |
| `commons` (a reference's id; the body may add `brand`) | one edit, or `{"edits": [...]}` (up to 8): see [Commons curation](#commons-curation) | in the Commons, on the reference's detail (each edit as it is now and as proposed; a line above the grid names the references waiting, and their tiles say "proposal"), with **Don't** and **Apply** (**Apply all** for several edits) | each edit's Commons route (`POST .../corrections`, `POST .../regions`, `PATCH /api/commons/regions/{id}`, `PATCH /api/commons/memberships/{id}`, `POST .../accept`), as the person |

Characters and Styles have nothing only the person may change yet, so their
kinds are refused by name (422).

**Project covers.** The person may pin a project's cover, or reset it to the
automatic one (its newest image), at any time. Anyone else (an agent, a
script) may too while the person hasn't pinned one: `set_project_cover`
(`PUT /api/projects/{id}/cover`) saves who set it as `coverBy` (`{kind,
name}`, on the card and as `pinnedBy` in the covers listing; a pin saved
before 2026-10-20 has none and is the person's) and returns `previous`
(`{"cover": url or null}`), which put back through the same call undoes it.
A cover the person pinned is refused for anyone else (403, `agent_refused`
or `person_required`) with a sentence naming `propose_asset_change`. An
accepted proposal pins the cover as the person's, so the next agent change
asks again. The Projects screen shows "Cover: set by <agent> (agent)" on a
cover an agent set.

A pin whose image is no longer in the project (its node deleted, or its
output gone from the project's snapshot; the same test as the cover
picker's list) no longer counts (Justin's Q90 a, 2026-10-21): the card shows
the automatic cover, the covers listing has `pinned: null`, `pinnedBy: null`
and `lostPin: {url, by}`, the card has `coverLostPin` and no `coverBy`, and
anyone may set the cover (`previous` is then `{"cover": null}`, what the card
showed). The stored pin isn't deleted: if the image comes back (Cmd+Z on the
canvas, saved by autosave) the pin counts again. An agent's reset to
automatic leaves a lost pin as it is (the cover is automatic already); the
person's reset drops it. The person's next pin counts as before. A proposal
made against a pin that has since lost its image stays open: its
`change.cover` reads `from: null`, `fromBy: null` and `lostPin`, so the strip
shows it against the automatic cover (never "You pinned" over a missing
image), and Accept applies it as before. The exception is a proposal back to
automatic (`{"cover": ""}`): once the pin's image is gone it would change
nothing, so it closes as `invalidated` ("No longer fits"), the same way a new
one is refused with 409, and the stored pin stays for an undo. The open
project's cover proposals follow its live canvas: a node deleted, undone or
removed by an agent re-checks them at once, so the person's screen updates
(or the proposal closes) without waiting for the autosave.

A board's own cover, the image a board opens on, is the board's setting
rather than a pin of the person's, so it has no proposal: agents set it with
the board's other fields. Taking that image off the board clears the cover
(the board opens on #1), so a board cover never outlives its image.

**Life cycle.** The same as canvas proposals: `open`, then `accepted`,
`rejected` (with the person's reason), `withdrawn`, `expired` (15 minutes)
or `invalidated`. Ids start with `pa_`; `GET /api/canvas/proposals/{id}`
(with `?wait=`) and `DELETE /api/canvas/proposals/{id}` answer for them, so
`get_proposal`, `withdraw_proposal` and `nebula proposal` work unchanged, and
the journal uses the same `proposal.*` kinds with `kind` and `targetId` in
`data`. `GET /api/asset-proposals?kind=&id=` lists the open ones. The view
is `{id, status, agent, note, kind, target: {kind, id, name}, change:
{<key>: {from, to}}, summary, decideIn, createdAt, expiresAt, reason,
applied, update}` (`change.cover` also has `fromBy`, `auto` (the image the
automatic cover shows now, the newest one, or null when the project has no
image; the strip shows it on the automatic side), and `lostPin` while the
pin it was proposed against has lost its image; `applied` is what Accept set;
a commons proposal's `change` is `{"edits": [...]}`, the agent's own edits;
`update` is `{id, projectId}` of its Update, below, or null). `start_here`'s
`proposals` part lists open asset proposals too, with `kind`, `targetId` and
`update` (the Update's id).
Caps: 3 open per agent and 12 in all (429 beyond), counted apart from canvas
proposals; a 160-character note.

**Checks.** A proposal is refused when its target is missing (404), the
image isn't one of the project's (400, the open project read from the live
canvas), or the change is already so (409: that cover, or notes already
sent). `{"sendNotes": false}` needs no proposal (422: set it directly).
Each proposal records its target as proposed (the pin and who set it,
notes off). If that no longer holds before the person decides (they pinned
another cover, an agent changed it, the image or the project or the board
is gone, notes were turned on), it closes as `invalidated` with the reason:
on any read or decision, after every cover change, and when the screen that
shows it hears its project or board changed. Accept checks once more and
answers 409 then.

**Who decides.** Only the person, through the canvas proposals' two layers:
`POST /api/asset-proposals/{id}/accept` and `/reject` need the person token
and no agent marker, and the proposal's key in `X-Nebula-Proposal-Key`. The
key goes only to `/ws` sockets that said hello with the person token
(`assetProposalOpened` on creation, `assetProposalSync` after hello, on any
screen), never to REST, the journal or MCP results. `assetProposalClosed`
`{proposalId, status, reason, kind, targetId}` goes to every socket. The
Agent log names the proposal ("Asks to make another image the cover of
project "Dusk" (decide on the Projects screen)"), since no cursor can go
there. Memory only: lost on restart.

**The Update.** Each asset proposal also posts an Update in the Updates
corner (Justin's Q92 a, 2026-10-21), on the open project's list, written by
Nebula in the strip's words and attributed to the agent (`author` is the
agent, `source: "nebula"`, `about: "proposal"`): "Claude Code asks to change
the cover of Dusk", "Claude Code asks to send Dusk board's notes to
generators", "Claude Code asks to change a reference in the Commons" (or
"asks to make 3 changes to a reference in the Commons", "asks to take a
reference out of the inbox"). Names only: never the agent's note, a board's
notes, a private note or Commons text. It carries `proposal: {id, kind,
targetId}` and one **Review** action (`proposal.review`), which takes the
person to the Projects screen with that card's strip in view, to Moodboard
Studio on that board, or to the Commons on that reference, from whichever
screen they are on. One per agent and
target: a new proposal on the same target replaces the agent's earlier
Update (the socket's `removed`), and while the agent still has another
proposal open there, closing one leaves the Update asking about the other.
When the last one closes the Update gets `resolvedAt`, `resolvedBy` (`person`,
the agent, or `system`), `readAt` and a short `outcome` ("Accepted: the cover
changed", "You kept your cover", "You kept the notes here", "Applied",
"Withdrawn by Claude Code", "Expired", "No longer fits", "Closed: Nebula
restarted"), and shows that in place of Review. Expiry lands on time, even
when nobody reads proposals: Nebula checks each proposal when it is due, and
`list_notes` never lists an expired one as waiting. Proposals are memory
only, so after a restart an Update whose proposal was still open resolves
as "Closed: Nebula restarted" (Justin's Q108 a, 2026-10-21) the next time
its list is read (`list_notes`, the person's tab reconnecting, a project
switch); "Expired" stays for a proposal that really waited 15 minutes. The
agent can ask again: propose it once more if you still want it (a
`get_proposal` on the old id is a 404 that says so). The socket sends `agentNotes` op `resolved` (op `changed`
when it moved to the other proposal) for the open project. With no project
open there is no Update (`update: null`); the Agent log line still is.
Agents read it with `list_notes` / `nebula notes` and through the view's
`update`.

### Commons curation

Curating the Commons is the person's (Justin's Q63 b, 2026-10-20; audit U13):
correcting a reference's reading, drawing, renaming, confirming or deleting a
region, and a reference's role, why or inbox place in a collection. Those
routes stay person-only (403 for agents). An agent asks with
`propose_asset_change(kind="commons", id=<reference>, change, note, brand)`
(`POST /api/asset-proposals`, or `nebula commons propose <id> --edit <json>
--note <why>`), a [proposal outside the canvas](#proposals-outside-the-canvas)
like a cover's. `change` is one edit or `{"edits": [...]}`, up to 8, all on
that reference, accepted or rejected together:

| Edit | Takes | Applied through |
|---|---|---|
| `{"correction": {...}}` | `field_path` (`summary`, `subject`, `composition_notes`, `type_style`, `spacing_density`, `layout`, `medium`, `axes.<quiet_loud, warm_cold, geometric_humanist, dense_airy or polished_raw>`, with or without `.value`) and `value` (text up to 2,000 characters, one of the enum's values, a number from -1 to 1), op `set`; or `keywords` with op `add` or `remove` and one keyword; `reason` optional (300 characters) | `POST /api/commons/assets/{id}/corrections` |
| `{"region": {"box": [x, y, w, h], "label": ...}}` | a new region, the box in fractions of the image | `POST /api/commons/assets/{id}/regions` |
| `{"region": {"id": ..., ...}}` | one of the reference's regions: `label`, `note`, `status` (`confirmed`, or `deleted`, which the person can undo), `box` | `PATCH /api/commons/regions/{id}` |
| `{"membership": {"id": ..., ...}}` | one of the reference's memberships in the agent's scope: `role` (`attract`, `avoid`, `evidence`, `neutral`), `why`, `accept: true` (out of the inbox, which queues it for analysis) | `PATCH /api/commons/memberships/{id}`, `POST .../accept` |

**Checks.** The agent must see the reference in its brand scope, as
`commons_get` does (404 otherwise, and for a region or membership that isn't
the reference's or out of scope, or a region the person deleted). One edit
per field, keyword, region or membership (422 for two). Parts of an edit
that are already so are dropped from it; an edit with nothing left is
refused (409). Each edit
records its target as it was: the field's value or whether the keyword is
there, the region, the membership. That is Commons text, so it goes only to
the person's screen (`before` in `assetProposalOpened` / `assetProposalSync`);
the view agents read holds only their own edits. Reading a commons proposal
(`GET /api/canvas/proposals/{id}`, `GET /api/asset-proposals`) and
withdrawing it are for the person, the session that proposed it, and
callers who see the reference in the brand it was proposed for: a
brand-bound agent session gets 404 for another brand's, as `commons_get`
answers. Its `proposal.*` journal events and `assetProposalClosed` carry
ids, not its note or the person's reason (`reason` is null there), since
every agent on the canvas reads them. If it changes before the
person decides (they corrected that field, the region or membership changed
or went, the reference was deleted, the Commons was turned off), the
proposal closes as `invalidated`; the person's own edits check the
proposals on that reference at once.

**Accept** makes each edit in order through its Commons route, as the person,
so a correction is the person's and outranks the model's reading. The
journal gets one `commons.*` event per edit by the person, ending "(accepted
from <agent>)", then `proposal.accepted` with `applied: {"edits":
[{"correction": <id>}, {"region": <id>}, {"membership": <id>}]}`. Should an
edit fail midway (its target went in the instant between the check and the
write), the ones before it stay made and the proposal closes as invalidated
with the reason.

Blind labeling (`/api/commons/evaluation...`) and the agent review
(`/api/commons/review...`) stay the person's alone, with no proposal and no
tool, exactly as before; Justin's answer changed only when agents get the
Commons, not who decides. The GM Commons trial is on hold: nothing here calls
a hosted Commons service.

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
which has no list price; Jev mode is priced per request) and a node whose priced setting arrives by connection (Krea Kling 3.0's
`multi_prompt` port), or is set to something the price list doesn't cover
(multi-shot Kling). Free nodes always pass. The person's own runs from the
canvas are never limited.

Some prices depend on the input file (SeedVR2 Upscale and Video Upscale,
FLUX Video Upscale and Edit [fast]: `sizing` in
[MODEL-PRICING](MODEL-PRICING.md#what-counts)). The check measures the file
the run will send: an Image Input or Video Input's file, `nebula quick`'s
file, or (in a proposal) an upstream output that already exists. The limit
checks the top of the computed price.

Only inputs nothing can change after the check are measured, because the
node reads its file later than the check (other nodes may run first): an
inline `data:` image, and a file in Nebula's output folder. The file's path
as given must be inside that folder with no `..`, and its resolved path
too, so a link there can't point somewhere that changes; a served
`/api/outputs/...` ref or a loopback URL to one counts. A file Nebula is
still writing (a run's folder until the run ends, a dot-named partial file)
isn't measured yet. No agent that reaches Nebula through its API can write
into that folder: in-app Claude has no file-writing tool, in-app Codex's
sandbox lists the folder read-only (its base allows writes to /tmp and
$TMPDIR, so the folder gets its own read-only entry), and every route that
writes there writes a new name. `nebula save` won't write over a file that
isn't a saved graph. A local file anywhere else, a chat's workspace
included, is refused as outside: add it first with `upload_file` (`nebula
upload <file>`), which copies it into the folder and puts an Image Input or
Video Input holding the copy on the canvas, then connect that to the node. (`nebula
quick` copies a local image into Nebula first, so `--input image=<file>`
works; a clip passed to it stays outside.) Every run route makes that same
copy of an outside image, so an image still outside is one it refused: over
20 MB, or not an image Nebula recognises. The upload refuses those too, and
a clip over 500 MB, so such a run is proposed instead; the refusal says so
and doesn't send you back to `nebula quick`.

A clip is measured as an upper bound of what a provider decoding it would
process: every video stream is looked at (exactly one that isn't cover art
is measured; two or more leave it unmeasured), and its frames and seconds
come from its demuxed packets as well as its header, so a header that
understates the length (a fragmented MP4, a falsified MKV duration) doesn't
lower the price. A packet that signals new parameters leaves it unmeasured.
Known limit: a size change inside the coded bitstream (an in-band H.264 or
HEVC SPS, a VP9 resize) shows only when decoding, so such a clip is priced
at its header size. An image with more than one frame or size (GIF, APNG,
animated WebP, multi-page TIFF, ICO) isn't measured. Measuring runs in a
worker thread, never on Nebula's event loop, and gives up after 60 seconds
or past 2,000,000 packets (the clip is then unmeasured). The packet listing
is read as it comes, so the backend's memory doesn't grow with the clip.

When the size can't be measured, the node is unpriced and the run is
refused, and the refusal says which case it is and what to do (the same
words on MCP, the CLI and HTTP):

- The input is made by another node in the same run, that node hasn't run,
  or Nebula is still writing it: connect an Image Input (or Video Input)
  holding the file to the node and run that (`upload_file` / `nebula
  upload` makes one), run an image through
  `nebula quick <node type> --input image=<file>`, or propose it (a
  proposal made after the upstream node has run is priced from its output).
- The input is a local file outside Nebula's output folder: it could change
  after the check, so add it with `upload_file` / `nebula upload <file>`
  first, or propose it. An image over 20 MB (or one Nebula can't recognise)
  and a clip over 500 MB can't be added, so those runs are proposed.
- The input is a file on another host (an outside URL, including one passed
  to `nebula quick`): it is never downloaded to price it. Download it and
  add the local copy with `upload_file` / `nebula upload`, or propose it.
- The file can't be measured (missing, not an image or clip Nebula opens,
  more than one frame, size or video stream, or outside the folders Nebula
  may read), or the port has nothing connected or more than one input: fix the input, or
  propose it.

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
  - runs that take nodes in the request: `/api/execute`, `/api/execute-node`,
    `/api/cinema/generate-shot` and `/api/quick`. A node there may bill only
    the way the canvas node with its id and definition does (`_kreaAuth`, and
    a multi-provider node's `_provider` too; a Moodboard node can't open
    `send_notes` further), judged on its params after retired ones are
    renamed; any other node starts on Auto and the API token. A
    run's params are written back to the canvas only onto a node of the same
    definition, and for a run that isn't the person's only what the run
    itself changed, never `_kreaAuth`.

  Proposals carry `_kreaAuth`, and the person's Accept applies it. Nodes that
  offer only the plan (Krea Files, Moodboards) have nothing to switch.
- A refusal is a 403 whose message names the cost, the limit and the exact
  `nebula propose ... --run <node>` to send instead. Accepting a proposal is
  the person's approval, so the canvas runs it without checking a limit.
- Which refusals carry a `code`: every 403 that refuses a request only
  because it isn't the person's (a billing change on any route above, a
  run the person approved started by someone else, a run or a Moodboard read
  over the spending limits, an edit that would leave the open project over
  the save limit) answers a request with no agent marker (a canvas
  tab not connected as the person, the CLI without `NEBULA_AGENT_NAME`, curl)
  with `code: "person_required"` beside the same `detail`, as the person-only
  routes do. The canvas reads the code and asks the person to reconnect; a tab
  whose person token is from an earlier launch can then send the same request
  again. An agent's refusal is unchanged: the same `detail` and no `code`.
  `detail` is word for word the same either way, so scripts and the CLI, which
  read it, see no difference.
- Only the person can change the limits: `PUT /api/settings` refuses every
  change from anyone without the person token.

`nebula spend` (or `GET /api/agent/spend`) shows an agent its limits and what
its session has used. `budget` is `chat`, `shared` or `app`; outside callers
also get `outsideSpent`, the shared 24-hour total.

### Personal agents' session tokens

A personal agent (your own Claude Code, Codex, Gemini CLI, Antigravity or custom ACP agent in the
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

Formats checked against each app's docs on 2026-10-13 (Antigravity CLI on
2026-10-20).

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
- **Antigravity CLI (`agy`)** (`agy mcp add --help` in agy 1.4.3, checked
  2026-10-20). In Settings > Connect your agent pick **Other MCP client**,
  then run:

  ```bash
  agy mcp add --env NEBULA_URL=http://127.0.0.1:8000 \
    --env NEBULA_APP_TOKEN_FILE=/Users/you/.nebula/app-tokens/<app id>.token \
    nebula -- <repo>/backend/.venv/bin/python <repo>/backend/mcp_server.py
  ```

  Every flag goes before the name (agy rejects one after it), and `--` keeps
  agy from reading the command's arguments as its own. It writes your
  user-level `~/.gemini/config/mcp_config.json`. For one project only, put the
  Other MCP client snippet, unchanged, in `<project>/.agents/mcp_config.json`
  instead: agy loads `.agents/` from the folder it runs in, once you've trusted
  that folder. `agy mcp list` shows only the user-level servers.

  agy asks before each Nebula tool call. A headless run (`agy -p`) can't ask,
  so it denies the call and prints the rule it needs. To allow them, add
  `"mcp(nebula/*)"` to `permissions.allow` in
  `~/.gemini/antigravity-cli/settings.json`; that allows every Nebula tool,
  including the ones that run nodes, which still spend only inside the app's
  daily limit.

  To read a board, ask in plain words: "Use the nebula tools: call
  look_at_canvas, then view_output on the image node, and tell me what it
  shows", or for a moodboard, "call moodboard_list, then moodboard_get on my
  board 'Autumn campaign' and summarise its brief". agy passes the images
  `view_output` returns to its model: on 2026-10-20 agy 1.4.3 with
  `gemini-3.8-flash-low`, set up from a project's `.agents/mcp_config.json`,
  read three random capital letters from an image node that way (the
  per-client image check the moodboard plan's PR10c asks for).
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

### Recently deleted

Deleting a moodboard, a character, a Style or a project doesn't remove it. It
moves to Recently deleted with who deleted it (you, an agent by name, or an
unnamed client) and when. Agents may delete boards, characters and Styles
(`DELETE /api/moodboards/{id}`, `DELETE /api/characters/{id}`,
`DELETE /api/presets/{id}`), because anyone can undo it:

- `GET /api/trash` lists it, newest first. `kind` (`moodboard`, `character`,
  `style`, `project`) narrows it; `scope` (`global`, or `project` with
  `projectId`) narrows boards, characters and Styles the way their lists do.
- `POST /api/trash/{kind}/{id}/restore` brings one back with the same id and
  contents, so a Moodboard or Character node that points at it runs again. A
  project comes back closed. Agents may restore. Restoring one that is already
  back is a no-op (200, `alreadyRestored: true`). MCP: `list_trash` (with
  `kind`, `scope` and `project_id`), `restore_from_trash`. CLI: `nebula trash list`
  (`--kind`, `--scope`, `--project`: list_trash's three; `--json` prints its
  result), `nebula trash restore [kind] <id>`.
- Deleting for good is person-only (see the list above). The person does it
  from Moodboard Studio, Character Studio, the Assets panel's Styles tab or
  Projects. Emptying sends what the
  person's list showed (`{"items": [{kind, id}]}` to `/api/trash/empty`,
  `{"ids": [...]}` to `/api/projects/trash/empty`) and only those go, so an
  agent's delete that lands after the list loaded stays restorable.
- "Deleted by" is attribution, never permission. `deletedBy.kind` says who:
  `person`, `agent`, `system` or `anonymous`. An agent names itself, so its
  `name` proves nothing; the canvas and CLI label every agent from `kind`
  ("Claude (agent)") and only `kind: "person"` reads as "you". Names are
  stored NFKC-normalized, without control, format (zero-width, bidi),
  private-use or surrogate characters.

A board, character or Style in Recently deleted answers `GET` and `PUT` with
404 and `code: "in_trash"` plus its trash record. Its node card and the Inspector say
it's in Recently deleted and offer Restore. Running the node fails with a
message that says how to restore it, and `edit_canvas` refuses to point a node
at it.

No saved graph points at a Style (applying one copies its prompt and settings
into Create), so deleting one breaks nothing: it only leaves the Styles lists.

Boards, characters and Styles stay until the person deletes them for good:
there is no timer. Projects keep their 30-day expiry. Files live in
`<store>/.trash/<id>.json` with a `<id>.trash.json` record beside them
(`backend/services/asset_trash.py`).

### Building and running over MCP

`edit_canvas` (without `steps`) and `remove_from_canvas` send one body to `POST /api/graph/apply`
(`backend/main.py`, parsed by `services/canvas_edits.py`). It takes the
proposal shape (`nodes` with `+refs`, `edges`, `params`) plus `rename`,
`move`, `remove` and `unwire`, stages all of it on a copy of the graph in that
order (unwire, remove, add and change, rename, move) with the validators the
single-edit routes use, and commits it at once. A bad connection or a missing node
leaves the canvas exactly as it was. There is no limit on how much one edit
does: the only bound is the most a project can save
(10,000 nodes and 50,000 connections, the same limits as import). An edit that
would pass them is refused with 413 and changes nothing. Proposals keep their
limits because the person reviews them item by item. Nodes with unresolved World Labs paid
state can't be removed. Krea nodes may name `_kreaAuth` only to keep the mode
they have: a change is refused with 403 and must be proposed (see Spending
limits). Other `_` params are refused. The route never runs anything and
is for agents only (the canvas edits through its own routes). `nebula apply`
is the CLI twin (see below). `edit_canvas(steps=[...])` sends a plan of steps
one step at a time, exactly as `nebula apply` does (both use
`backend/apply_steps.py`): it returns `{status: "applied", steps, idMap,
undo}`, or `{status: "stopped", failedStep, steps, error, applied, idMap,
undo}` when a step is refused, and refuses a plan whose refs don't add up
before anything is sent.

A write lands only on the canvas that was open when it was asked. Node ids
start again in each project and after Clear or a loaded graph, and some
writes wait on something first (the model catalog for a universal node's
model, a run's spend check, an upload's file). If the person opens another
project meanwhile (even if they come back to this one), the write is
refused with 409 and nothing changes: "The open project changed since this
started, so nothing was changed. Read the canvas again and send the change
again if it still fits." After a Clear or a loaded graph
on the same project the detail starts "The canvas was cleared or replaced
since". Nebula filing an unfiled canvas as "Recovered canvas" (the same
graph and ids, when the project list files it) isn't a switch: your change
and your run carry on.
This covers `edit_canvas` and `remove_from_canvas` (`nebula
apply`), `propose_change`, `upload_file` with a node, `load_graph_file`,
`run_nodes` (`nebula run`), and the routes under them (`PUT
/api/graph/node/{id}`, `POST /api/graph/node`, the canvas's own Run and a
Cinema shot). Read the canvas again (`look_at_canvas`) before you retry.
A run started before such a change writes nothing back either: its outputs,
params and node errors go only to the canvas it started on, and `get_run`
still reports them. While a run is going, Clear, a loaded graph, a project
switch and deleting the open project wait for it. Each refuses with 409 and
its own `detail`:

| Action | Route | 409 `detail` while a run is going |
|---|---|---|
| Clear (`nebula clear --force`) | `DELETE /api/graph` | "Cannot clear the canvas while a run is active. Wait for the run to finish or stop it first." |
| Load a graph (`load_graph_file`, `nebula load`) | `POST /api/graph/import` | "Cannot replace the graph while a run is active. Stop the run and wait for its terminal state first." |
| Open or make a project (`open_project`, `new_project`, `nebula project open` / `new`) | `POST /api/projects/{id}/open`, `POST /api/projects` | "Cannot switch projects while a run is active. Wait for the run to finish or stop it first." |
| Delete the open project (the Projects screen) | `DELETE /api/projects/{id}` | "Cannot delete the open project while a run is active. Wait for the run to finish or stop it first." |

A quick run (`nebula quick`, `POST /api/quick`) doesn't count: its nodes
are temporary and never on the canvas, so nothing waits for it.

While the person's tab can't reach Nebula, their canvas is read-only: its
banner says "Nebula is offline. Editing is paused until it reconnects.", and
their edits are blocked, not queued, because a restarted backend refuses
replayed writes. That covers everything their tab could change: canvas
edits, Run (every run entry, so no paid run starts from a tab that only
thinks Nebula is gone), Create's Generate, proposal Accept and Reject,
Forget ID and the unlock, chat sends and a chat permission's "Allow once",
settings, the Commons, and project create, switch, rename and delete. The
tab sends no write that starts work or changes anything; it saves the
project once Nebula answers again. Since round 16 a few requests that only
stop or reduce work still go, so a tab that only thinks Nebula is gone can
still stop a run that's spending: Stop (`DELETE /api/executions/{runId}`),
a render's cancel (`DELETE /api/render-jobs/{jobId}`), the Commons worker's
Stop (`POST /api/commons/worker/stop`), and over the chat socket Deny and
the chat's Stop (its `cancel` message). The canvas's selection and view
reports (what `get_selected_nodes` and `look_at_canvas` read) aren't sent while
offline; the tab sends the current ones once Nebula answers again. You meet the same outage as a connect Nebula never took
("Nebula isn't running at <url>. Start Nebula, then retry."), and the tool's
error then adds: "While Nebula is offline the person's canvas is read-only:
nothing you or they edit is saved or queued. Once it's back, call start_here
to re-read the canvas before assuming your plan landed." `edit_canvas(steps=...)`
puts the same sentence in the stopped plan's `error`. The CLI (and `nebula
apply`'s stop) says it with "run `nebula graph`" in place of "call
start_here". A request Nebula took and then dropped (a restart mid-request),
a timeout or a real refusal doesn't add it: Nebula was there.

#### Universal nodes: ports from the model

The OpenRouter, Nous Portal and Replicate nodes have no fixed ports: a
vision model takes `images`, an image model outputs `image`, a Replicate
model's file inputs are its ports. One backend module has the rules
(`services/universal_ports.py`), and every path uses it:

- An edit (`edit_canvas`, `nebula apply`, a proposal when the person
  accepts it, and `nebula create` / `set` with an agent name) that creates
  one of these nodes with a model, or sets its `model` (`model_id` on
  Replicate), configures it as the canvas's model picker does. Nebula reads
  the model's catalog row or schema through `/api/openrouter/models`,
  `/api/nous/models` or `/api/replicate/schema/{owner}/{name}` (cached 5
  minutes, a Replicate schema an hour; reading costs nothing) and writes the
  node's canvas-owned params: `_output_image`, or `_version_id`,
  `_schema_fetched` and the schema's defaults, plus `_model_ports` (the ports,
  stamped with the model). The agent's own values in the same edit win over
  the schema's defaults; setting the model a node already has keeps its
  current values. Agents still can't send `_` params themselves.
- The reply has `modelPorts` ({node id: {model, inputs, outputs}}) for each
  node it configured. When the model's data can't be read (the key isn't
  set, the model doesn't exist, the provider is down) the node keeps its
  definition's ports (OpenRouter: `messages` in, `text` out; Nous Portal adds
  `images`; Replicate none), the reply says why in `modelPortNotes`, and a
  connection to any other port of it is refused with that reason, for example
  "Nebula can't read OpenRouter's model list because OPENROUTER_API_KEY isn't
  set, and only the person can add it (Settings in Nebula)".
- A model change that leaves connections on ports the node no longer has is
  refused and names them; `unwire` them in the same edit. That covers a new
  model without those ports, and clearing the model or naming one Nebula
  can't read, which leaves the definition's ports. (The person's picker drops
  them instead, as it always did.)
- Replicate: a port per file input (`x-uploadable`, or a `uri` string),
  named as the schema names it, and one output. A file output's schema is a
  plain `uri` string whatever the file is, so its type comes from the
  model's own data: a content hint in the output schema (`contentMediaType`,
  an `x-` MIME hint, a MIME type or extension in its description), else the
  file its `default_example` run returned (the schema route keeps it as
  `default_example_output` from the model read it already makes; no extra
  call). That gives `video` (Video), `audio` (Audio), `image` (Image), `svg`
  or `mesh`; when nothing says, `image` with `typeUnconfirmed: true`, and
  the reply's `modelPortNotes` (and `model_schema`'s `note`, `look_at_canvas`'s
  `ports.unconfirmed` and `ports.note`) say so. Any other output is `text`
  (`typeUnconfirmed` too when the model has no output schema and no example
  file). A run fills that declared port; a returned file whose type
  contradicts a confirmed port fails the run naming both. On an unconfirmed
  port the file's own type wins: it goes out under `video`/`audio`/...,
  shown and saved, but a connection on the guessed port gets nothing. A node
  configured on 2026-10-20 (no `rev` in its `_model_ports`) shows its file
  output as unconfirmed with a note: set its `model_id` again to re-read. Other inputs are params of the same name; a connection to one is
  refused ("... are params of the same name: set them with params instead
  of a connection").
- `describe_node` on these nodes has `modelPorts`, a sentence with the rules;
  `look_at_canvas` lists a configured node's `ports` ({inputs, outputs}).
  Before an edit, `model_schema` (and `model_catalog`'s rows, as ids) give a
  model's ports from the same function.
- `POST /api/universal/ports {definitionId, model, params?}` returns a
  model's ports without a node (and, for Replicate, its params and version).
- The canvas export, the connection checks (`port_contracts.node_ports`) and the
  run check read `_model_ports`, so the canvas draws the ports and connections an
  agent made without a reload. A node saved before 2026-10-20 has no
  `_model_ports` and keeps exactly the ports it had (its definition's) until
  its model is set again. A Replicate node configured on 2026-10-20, before
  file outputs were typed (its stamp has no `rev`, every file output
  `image`), keeps that port and runs as it did; sending its `model_id` again
  (an edit or `PUT /api/graph/node/{id}`) reads the model again and types it.

The canvas's pickers call `POST /api/graph/node/{id}/model {model}`, which
configures the node with the same function, drops connections the model has no
port for, and returns the params, ports, Inspector controls
(`dynamicParams`, Replicate) and `providerMeta`. It is the canvas's (403 for
an agent).

#### Undoing your own edit

Every apply that changes something replies with `undo: {token, editId,
expiresInSeconds, summary}`. `undo_canvas_edit(token)` (`nebula undo
TOKEN`, `POST /api/graph/apply/undo {token}`) takes the edit back:

- A node it added is removed with its connections, unless it changed since (its
  params or name), or the person connected it to something else since.
- A param, name or position it changed goes back to the earlier value,
  each param on its own: if the person changed the prompt since, the prompt
  stays and the seed the agent changed goes back.
- A node it removed comes back under its own id with its params (an
  uploaded image's preview, a painted mask and a Paper source included),
  outputs, name, position and connections. A connection whose other end is gone, or
  whose input has taken another connection since, stays out. The person's pins
  that were on it go back on it (`reattached`; one the person deleted
  since stays gone, in `pinsLeft`), and the proposals the delete closed
  reopen when they still pass Accept's checks (`reopened`); one that
  expired, no longer fits, or that Nebula no longer has after a restart is
  in `notReopened` with the reason.
- A connection it added is disconnected; one it took away is connected back.

A run counts as a change. A node the edit touched that someone ran after
the edit (the person, another agent, or a client that didn't name itself)
stays whole: it isn't removed, its params, name and position aren't put
back, and no connection into it is taken away or put back, because those inputs
made its result. It is one `skipped` item with reason `ran since`,
`ranBy` (`[{kind, name}]`), `left` (the parts it kept: `node`, `params`,
`name`, `position`, `wires in`) and a message such as "n3 ran since (run
by the person), so it stays". Connections out of it follow the rules above. Only
runs the undoing agent started itself don't count, so an agent can still
undo its own experiments. A run counts if it was asked for after the edit
landed, including one still going when the undo comes (all the nodes it
set out to run count); a run asked for before the edit doesn't, even if it
reached the node after. The person's own Cmd+Z is unchanged.

Each part someone changed since is left as it is and listed in `skipped`
(`{nodeId, part, keys?, wire?, reason, message}`, plus `ranBy` and `left`
for `ran since`), as a moodboard restore does. A param only the person may change back (opening a Moodboard node's
"send notes" again) is skipped too. The rest is one restore through the
same staging as the canvas's Cmd+Z, so it lands whole or not at all, and
the person can undo the undo. `status` is `undone`; `skipped` when nothing
could go back (the token keeps working, for when the person puts a changed
part back; a node someone ran since stays for good, since a run can't be
taken back, and the message says so); or `already-undone`, with `undoneBy` (you, or the person with Cmd+Z,
which the backend learns from the canvas's restore). `message` says what
went back and each part left, and why. Calling it twice changes nothing
the second time.

The backend keeps each inverse in memory (`services/canvas_undo.py`): for
60 minutes, the last 100 edits, at most 16 MB each and 64 MB in all. A
token works only for the agent that made the edit (403 otherwise), only
while the project it was made in is open (409), and not after it expired,
was pushed out, or the canvas was cleared or a graph loaded into the
project (410: their node ids start again). A restart forgets them (404).
Because the server wrote the inverse, the undo may put back `_` params and
the person's billing choice on a node it brings back; agents still can't
send `_` params themselves, through `restore` or anywhere else.

#### Arrange: let the canvas lay out new nodes

An agent can't know how tall a node will be on screen (an image card sizes
to its image), so an edit can leave the layout to the canvas. Add `arrange`
to the edit:

- `"arrange": true` lays the new nodes out left to right, following their
  connections: each step of connecting the nodes is a column, 120 px apart, and
  nodes in the same column stack 40 px apart.
- `"arrange": {"direction": "down", "gap": 80}` flows top to bottom instead:
  each step is a row, and nodes in the same row sit side by side.
  `direction` is `right` (default) or `down`; `gap` is 0 to 2000 px.

Only that edit's new nodes move. The block starts at the top-left of where
they were placed, and shifts right or down only if it would cover another
node. The person's nodes never move. An edit with `arrange` must add nodes.
When the block fits in what the person can see (clear of the top bar, the
rail, the chat panel, the bottom toolbar and an open proposal bar:
`computeCanvasFitPadding`), it
lands inside that area, moved in from where it was placed and clear of other
nodes when there is room. When it can't (too big at this zoom, or no free
room), the canvas pans, or zooms out just enough, on the agent cursor's
spring to show it whole, unless the person is dragging. Fit view (Shift+1,
the toolbar button, the command palette) frames open proposals' ghosts along
with the nodes, above the proposal bar.

How it works (`services/canvas_arrange.py`, `components/canvas/ArrangeController.tsx`):
the backend keeps the request and sends open requests with every graphSync
(`arrange: [{id, nodeIds, direction, gap}]`), and in `GET /api/graph/export`
for a tab that loads a project. An open canvas waits until those nodes have
their real size (it draws every node meanwhile, even off screen, and loads
their images), lays them out with the
same size-aware layout as Auto-layout, and saves the positions with
`PUT /api/graph/layout` and `arrangeId`. The first write for an id wins; a
second open tab gets `already-arranged` and changes nothing, and every tab
takes the winning positions from the next graphSync. The arrange is part of
the agent's edit, not an edit of its own: that graphSync carries `arranged:
{id, nodeIds}` and no `edit`, and each canvas puts the positions into the
undo step that added those nodes. So Undo removes the nodes, and Redo puts
them back arranged. The activity log credits the agent. Only the person's
canvas finishes an arrange this way; a write with an `arrangeId` from
anyone else (an agent or script can read it off a graphSync) is a normal
move, its own undo step, credited to whoever wrote it.

The edit's reply has `arrange: {id, nodeIds, direction, gap, status,
message}`. `status` is `waiting` when a canvas is open, or
`waiting-for-canvas` when none is: the nodes stay where they were placed and
the first canvas that opens lays them out. If someone moves one of the nodes
first (a drag, or an agent's `move`), that position wins and the arrange
leaves it alone. Opening another project, Clear canvas or a backend restart
drops open requests; the nodes keep the positions they were placed at.
#### The person can undo any agent edit

Every graph edit an agent makes (`edit_canvas`, `remove_from_canvas`,
`nebula apply`, `set`, `create`, `delete`, `connect`, `disconnect`, `move`,
`nebula graph load`, the layout route) is one undo step on each open canvas (a canvas
finishing an agent's `arrange` joins that agent's step instead; see above). The canvas shows "Claude changed the
canvas" with an Undo button, and Cmd-Z works too. Undo puts back exactly
what that edit changed: deleted nodes come back with their params, outputs,
name and connections, and new nodes go away with their connections. Redo (Cmd-Shift-Z)
applies the edit again. A run's results are never undo steps, so undoing a
param change keeps the outputs a run made since.

An open canvas draws exactly the backend's connections between backend nodes: a
connection an agent took away (an unwire, `disconnect`, an undo, a node re-typed
to other ports) leaves it at once, with no reload, and its next save doesn't
put it back. Only the person's own connection still on its way (drawn, not yet
answered) or one they just deleted stays as they have it until the backend
answers.

How it works: a graphSync caused by an edit request carries `edit` =
`{actor, tab?, id?, undoes?}`. `id` names an agent's apply or undo (its
`undo.editId`), and `undoes` says the sync is an agent undoing that edit
(the notice then reads "Claude undid its edit"). `actor` is the request's journal actor (a named agent, the
person, or anonymous). `tab` is the canvas tab that sent it (`X-Nebula-Tab`,
set by the canvas on every write), so that tab skips the echo of its own
edit. Only the person's canvas (this launch's person token) gets a `tab`:
an agent, or a script without the token, never does, even if it sends the
header. Run
results and status syncs carry no `edit`, and opening, creating or switching
a project is never an undo step. Loading a graph into the open project
(`nebula graph load`) is: undo puts the whole canvas back, and since a load
hands out ids from n1 again, the restore swaps any id that now holds a
different model. Undo and redo then send what
changed to `POST /api/graph/restore`, so the backend graph, the saved
project and every other canvas match. A step that came with an `id` sends
it as `edit`, and the person's restore is then linked to that edit (see the
journal above): the agent's `wait_for_canvas_change` learns its edit was
undone, and its undo token answers `already-undone` until the person redoes
it. The restore is journaled as whoever
the canvas is (`Person` when the tab is connected as you), with "(undo)" or
"(redo)" on each line. Agents never need to call it; they undo their own
edits with `undo_canvas_edit`.

Undo puts back everything a delete removed (GM - Design, 2026-10-23). Every
node delete (`DELETE /api/graph/node/{id}`, an apply's `remove`, a restore
that removes nodes) detaches the pins on the node and closes the proposals
that read it, under a removal record `{id: "rm_…", nodeId, pins,
proposals}`: the delete's answer has it (`removal`; an apply's and a
restore's `removals`), and so does the edit's graphSync (`edit.removals`),
for a canvas that didn't send it. The canvas keeps the records in its undo
step and names them in the restore that brings the nodes back
(`removals`). The backend checks each one again rather than trusting the
list: a pin goes back on the node only if that very removal detached it
(the pin keeps the removal id with the project, so this survives a
restart), and a proposal reopens only if that removal closed it and it still
passes Accept's checks (the params it sets unchanged, the proposal staged on
the live graph, what its runs would start unchanged), hasn't expired, and
the open caps allow it. The restore's answer says what happened:
`reattached`, `pinsLeft` (`{id, reason, code}`: `deleted since`
(`deleted`), `changed since` (`changed`), `its node came back as another
model` (`another-model`) or `another project is open now`
(`another-project`); the canvas counts by `code`, and its notice names only
`another-model` pins: "Restored the node. 1 pin couldn't be re-attached."),
`reopened` and `notReopened` (`{id, reason}`). Proposals live in
memory, so after a restart the ones the delete closed can't reopen and are
counted in `notReopened`. A proposal that also needs another deleted node
waits, closed and uncounted, until that delete is undone too. Redo deletes
again, with new records.

A record's `proposals` also names the project cover proposals the delete
closed (an asset proposal whose image was on the node), so after a restart
those are counted in `notReopened` too; without a restart a cover proposal
reopens when Accept's check passes against the restored live canvas. A node
has one live removal, its latest delete's: when the person redoes your
delete, or undoes your undo, the nodes are deleted again under new records,
and your `undo_canvas_edit` token names those from then on, so it still
puts the pins back and reopens the proposals.

A record undoes exactly one delete of exactly one node, never "whatever is
n1 now": node ids are not unique over time (a clear or an import starts them
again at n1, and every project has its own n1). So each record is
`{id: "rm_…", nodeId, projectId, definitionId, replaces?, pins, proposals}`.
`projectId` and `definitionId` are the project and model the node was
deleted from; a restore uses a record only in that project and only for a
node that comes back as that model, and the backend also checks them against
what it minted the id for. `replaces` is set when the deleted node is one an
undo had brought back: it names the removal that undo used, and only
records with exactly that id (the canvas's older steps, your undo token) are
renewed to the new one. A node that a clear, an import or a plain add put
under the id replaces nothing. A pin goes back only onto the model it was
on (`pinsLeft` reason `its node came back as another model` otherwise). A
proposal is tagged only by deletes in its own project, as a (removal, node)
pair, and a clear, an import or a project switch drops the earlier deletes'
tags: undoing a delete from before one of those can't reopen the proposal,
and `notReopened` says so ("the canvas was cleared since", "the canvas was
replaced since"). Pins never show the removal ids or anchors undo keeps
(`detachedBy` and the rest stay in Nebula's own copy); agents undo their own
edits by token and never need them. Only the person's restore carries
records: an edit's graphSync shows every socket its `edit.removals`, so a
restore from anyone else that names `removals` restores its nodes and connections
but ignores the records (its answer's `reattached`, `pinsLeft`, `reopened`
and `notReopened` stay empty). Your `undo_canvas_edit` puts back what your
deletes removed from the records the backend kept for that edit.

A run from `run_nodes` is a CLI run (`POST /api/graph/run` with `wait`), so
it gets the same spending check and the same long-run handling. It also gets
the canvas Run button's pre-call check (`validate_graph`: missing keys,
required inputs with nothing connected, a cycle), before the spending check. A node that
fails it refuses the whole run: nothing is called or spent, the reply is
`{status: "failed", error: "Nothing ran, so nothing was spent. …", errors:
{nodeId: message}, results: {}}`, and the canvas marks the node exactly as a
refused click on Run does. Every node's state from an agent's run reaches
open canvases as it happens (queued, executing, done, failed), the same
events a canvas run sends, so a failure shows on the card with its message.
A run in which any node failed reports `status: "failed"` with `error`
naming the node, `errors` with each message and `results` with what
finished; `get_run` and `nebula result` say the same. The backend keeps each
node's last error (`services/node_errors.py`) for `look_at_canvas`,
`view_output`, `nebula look` and `nebula path` until the node runs again,
whoever ran it (the canvas Run button too). It is kept per project, in
`node-errors.json` in the state dir, so it survives a page reload, a switch to
another project and back, and a backend restart; every graph the canvas loads
(graphSync, `GET /api/projects/{id}`) gives such a node `state: "error"` with
the card's `error`, `errorFriendly`, `errorCategory`, `errorPerson`, `errorProviderText` and `errorProvider` (round 3f). Loading a graph over
the project or clearing it forgets its errors, as does deleting the project
for good. Deleting a node keeps its error, so undoing the delete
(`POST /api/graph/restore`) puts the node back failed, as the canvas's undo
shows it; an undo that swaps another node in under the id forgets it. It waits 45
seconds by default because Codex gives each tool call 60 seconds unless
configured otherwise (in-app Codex gets 150); `get_run` waits again (up to 300). Finished image and
video outputs come back as small previews from
`GET /api/graph/node/{id}/preview`, which reads only files in Nebula's output
folder (external URLs are never fetched), downscales images to 512, 1024 or
1568 px and keeps each preview under 350 KB, since Claude Code caps a tool
result at 25,000 tokens.

`GET /api/agent/nodes` and `GET /api/agent/nodes/{id}` back `find_nodes` and
`describe_node`; `nebula nodes` reads the first too, with `limit` up to
`AGENT_NODES_MAX` (2,000, above the whole catalog) so `--all` gets every node
type in one call. Both use `services/node_readiness.py`, the same rule
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

#### Runs the canvas started

`get_run` reads `GET /api/graph/runs/{runId}`. A run an agent or the CLI
started answers as it always has. Any other run (the person's Run, an
accepted proposal's run) used to be a 404; now it answers from the execution
registry and the run's own events (`services/run_reports.py`, fed by
`_emit_and_sync`, memory only, the last 256 runs), in the same shape with
`source: "canvas"`, `startedBy` (`{kind, name}`), `results`, `errors`,
`skipped`, `nodesExecuted` and `nodes`: per node its `state` (queued,
executing, complete, error, skipped), latest `progress` (0 to 1), the text it
has streamed so far (`partialText`, up to 4,000 characters, with
`partialTextLength` past that) and its `error`. A run that failed before any
node reported an error has `error` saying so (the exception itself stays in
Nebula's log). `wait` waits for it to end,
as for a CLI run. A CLI run that is still going also carries `nodes` and
`startedBy`; once it ends it answers exactly as its start did. The run id
comes from the `run.started` journal events (`wait_for_canvas_change`).

### Universal nodes over MCP

`model_catalog` and `model_schema` (above) say which models the OpenRouter,
Nous Portal, Quiver and Replicate nodes can run, and for the three universal
nodes which ports each model gives the node. Those ports come from
`services/universal_ports.py`, the same function `edit_canvas` configures a
node with, the canvas draws from and `look_at_canvas` reads (see
[Universal nodes: ports from the model](#universal-nodes-ports-from-the-model)),
so the three always agree:

1. `model_schema("openrouter", "google/gemini-3-pro-image")` returns
   `ports: {inputs: [messages, images], outputs: [text, image]}` (each port
   with its `dataType`).
2. One `edit_canvas` call creates the node with `params: {model: ...}` (or
   `model_id` on Replicate) and connects those ports: `images` in, `image` out,
   or a Replicate model's file inputs by name. The reply's `modelPorts` lists
   the same ids, `look_at_canvas` shows them as the node's `ports`, and the
   canvas draws them without a reload.

- **OpenRouter / Nous Portal:** `messages` always; `images` (Image, several
  connections) for a model that takes images; `text` and/or `image` out for what
  it makes, as the model list says.
- **Replicate:** a port per file input (`x-uploadable`, or a `uri` string),
  named as the schema names it; one output, for a file URL or a list of them
  typed from the model's data (schema content hint, else its
  `default_example` run's file) as `video`, `audio`, `image`, `svg` or
  `mesh`, else `text`. With nothing to tell, it is `image` with
  `typeUnconfirmed: true` and a `note`. The run fills that port, so
  `model_schema("replicate", "<a video model>")` gives `outputs: [video]`
  and one `edit_canvas` can set the model and connect `video` to a Video
  input. `model_schema`'s `params` are the other inputs: set them as params
  of the same name; a connection to one is refused.
- **Quiver** nodes have fixed ports (`describe_node`); their catalog rows
  carry no `ports`.

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
# Applied: added 3, connected 2, renamed 1, moved 1, removed 1, disconnected 1.
#   +p → n8  Text Input
#   +wide → n9  Wide
#   +tight → n10  Nano Banana
#   Undo: nebula undo 3f9c…  (for 60 minutes; parts changed or run since stay)
nebula undo 3f9c…                   # take it back (see Undoing your own edit)
nebula apply --file plan.json       # or --file - to read standard input
nebula apply --file plan.json --arrange        # or --arrange down
```

The plan is the one `nebula propose` takes (`nodes` with `+refs`, `edges`,
`params`) plus `rename`, `move`, `remove` and `unwire`, so a file of nodes,
edges and params can be proposed or applied as it is. `nebula apply` never
runs anything: a plan with `run` is refused before it's sent (propose it, or
apply it and then `nebula run`). Like proposals, it needs your agent name
(`$NEBULA_AGENT_NAME` or `--as`). `--json` prints the backend's result,
including `idMap`. There's no limit on how much one plan adds. `--arrange`
(or `"arrange"` in the file) has the canvas lay out the new nodes by their
real size; see Arrange above.

A plan file can also hold steps, for a build where later parts connect to
nodes earlier parts made:

```json
{"note": "Moodboard, then takes",
 "steps": [
   {"nodes": [{"ref": "+mood", "definitionId": "image-input"}]},
   {"nodes": [{"ref": "+p", "definitionId": "text-input"},
              {"ref": "+img", "definitionId": "nano-banana"}],
    "edges": [{"source": "+p", "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"},
              {"source": "+mood", "sourceHandle": "image", "target": "+img", "targetHandle": "images"}],
    "arrange": true}
 ]}
```

`nebula apply` sends the steps in order. Each is its own edit that lands
whole or not at all. A step can use the `+refs` earlier steps made: the CLI
swaps in the node ids each step's reply gave in `idMap`, so the backend
keeps no plan state. A ref names one node across all steps, and the CLI
checks every step's refs before it sends step 1. If a step is refused, the
command stops there (exit 1), names the step and the reason, and lists what
the earlier steps applied, with the ids their `+refs` became. Those steps
stay on the canvas: fix the refused step and apply it and the rest on their
own, using those ids in place of the refs. `--json` prints `{status, steps, idMap, undo}`, or `{status: "stopped",
failedStep, error, applied, idMap, undo}`; `undo.tokens` are the applied
steps' undo tokens, newest first, and a plan that landed ends with the line
`Undo these N steps: nebula undo <newest> … <oldest>`. `nebula undo` takes
them in that order and stops at the first one refused. `nebula propose`
doesn't take steps. The checks and the stop-and-report rule are
`backend/apply_steps.py`, which MCP's `edit_canvas(steps=...)` uses too.

Other graph commands:

```bash
nebula delete n3 n4                 # nodes and their connections
nebula disconnect n1:text n2:prompt
nebula rename n2 "Hero shot"        # an empty name restores the model's
nebula move n2=400,120 n3=400,320   # canvas coordinates
nebula projects                     # saved projects; * is open (--json: list_projects)
nebula project open <id>            # switch the canvas (not while a run is going)
nebula project new "Logo ideas"     # start a new, empty project and open it
nebula project rename current "Logo ideas, round 2"   # prints the command that renames it back
nebula project show <id>            # a saved project unopened: nodes, connections, cover, runs (get_project)
nebula project size                 # its size against the 16 MB save limit, largest parts first (project_size)
nebula load "Big campaign.nebula.zip"  # a .nebula, .json or bundle, as Load graph opens it (load_graph_file)
nebula clear                        # refused when the canvas has nodes
nebula clear --force                # clears it anyway; the person can undo it
nebula trash list                   # Recently deleted boards, characters, Styles, projects
nebula trash list --scope global    # boards, characters and Styles in no project
nebula trash list --project current # the open project's (--scope project with it)
nebula keys                         # which provider keys are set, never a key's ending
nebula providers                    # whether each key works, and the Krea account (--refresh)
nebula trash restore [kind] <id>    # bring one back with the same id
```

Opening or starting a project keeps the one that was open as it is. When an
agent (or any script that isn't the person's own canvas) does it, the
person's canvas follows, says who switched it, and offers a button back.
The project's history names the agent.

`nebula load` opens a file as `load_graph_file` does, through the same
module (`backend/graph_file_client.py`): a bundle's files are restored, a
file under the save limit replaces the open project's canvas, and one over
it opens as a new project named after the file, the open one left as it
was; it prints what happened and how to go back (`nebula project open
<id>`).

`rename`, `show`, `size`, `trash list`, `keys` and `providers` are the CLI
twins of `rename_project`, `get_project`, `project_size`, `list_trash`,
`get_settings` and `provider_status`. Each goes through the same route and the same shaping
(`backend/project_client.py`), so its `--json` prints the tool's result, with
hints worded as `nebula` commands. A rename is journaled as `project.renamed`
under `$NEBULA_AGENT_NAME` (unnamed without it). The CLI is an agent surface
and never has the person token, so `keys` and `providers` print set or not
set and each provider's health, never any part of a key (Justin, Q55 a).

`nebula clear` refuses when the open project has nodes and points to
`nebula project new` instead, which keeps this project's work. `--force`
clears anyway, for agents and the person alike. The backend enforces this
for every caller: `DELETE /api/graph` on a project with nodes returns 409
unless it has `?force=true` (the canvas's Clear button and chat `/clear`
send it after the person confirms). It's a check of intent, not of who is
asking. A clear also waits while any run is going, as a project switch does
(409; the exact `detail` of each refused action is in the table under "Building and running over MCP"):
node ids start again after a clear, and a run writes its outputs back by
node id. With the canvas open, a clear is one undo step: Undo (or Cmd-Z)
brings back every node, connection, name and output. With no canvas open there is
nothing to undo it from, so prefer `nebula project new`.

### Styles from the CLI and MCP

A Style (a preset; `/api/presets`, `backend/services/preset_store.py`) is what
the person saves from Create with "Save current" and finds again in Create's
Styles and the Assets panel's Styles tab: a `prompt` fragment Create adds to
the prompt, and optionally a `modelId` with that model's `params`. Applying it
copies those into Create; no saved graph points at one.

- **CLI:** `nebula style list [--project ID|current] [--global] [--json]`,
  `show <style>`, `new <name> [--prompt] [--category] [--model NODE]
  [--params JSON] [--ref URL] [--project ID|current]`, `set <style> [--name]
  [--prompt] [--category] [--model NODE|""] [--params JSON] [--ref URL]
  [--base-version N] [--restore FILE]`, `delete <style>`. A Style is named by
  id or exact name (any case).
- **MCP:** `style_list(project_id)`, `style_get(style)`,
  `style_create(name, prompt, category, params, model_id, ref_images,
  project_id, thumbnail)`, `style_update(style, ..., base_version)`,
  `style_delete(style)`. They share `backend/style_client.py` with the CLI and
  go through the routes the app uses.
- **New Styles** are Global unless a project is given; `current` is the
  project open on the canvas. `nebula style new` and `style_create` send
  `paramsVersion` (the version of the code they run), so their params are
  never read as older ones. A `POST /api/presets` without it is still read as
  a pre-marker bundle's, version 0.
- **Updates are checked writes.** `PUT /api/presets/{id}` takes `baseVersion`
  (the `version` read) and answers 409 `code: "version_conflict"` with the
  Style as it is now when someone saved it since. `style_update` and
  `nebula style set` always send it. `params` replaces the settings whole;
  `modelId: ""` makes a Style style-only. They return `previous` (the fields
  the call changed, as they were, with `base_version` the version it made):
  `style_update(style, **previous)` or `nebula style set <style> --restore
  <file>` undoes exactly that change, and is refused if someone changed the
  Style again since.
- **Who bills is the person's call.** Applying a Style puts its settings on
  Create's draft, billing included, so Style writes follow the node routes'
  rules: nobody but the person may save a Style whose `_provider` or
  `_kreaAuth` differs from the model's default (or, for an update, from what
  the Style had), 403 with a node edit's sentence, except that a Style
  change can't be proposed, so it says to leave the key out or ask the person
  to pick it in Create; an agent may not write an internal (`_`) param it
  didn't read back unchanged (422), and leaving one out of `params` keeps
  the Style's own, so `previous` still undoes the change; an agent's
  `modelId` must be a node in the catalog (400).
- **Delete** moves a Style to Recently deleted (kind `style`, with
  `deletedBy`); `restore_from_trash(kind="style", id)` or
  `nebula trash restore style <id>` brings it back with the same id. On a
  Nebula without Recently deleted for Styles both refuse rather than delete
  for good.
- **Everyone sees it.** Every write journals one `style.*` event with its
  actor (see [Watching for changes](#watching-for-changes)), broadcasts
  `storedAssetChanged` with `kind: "style"` (the Assets panel and Create's
  Styles list again), and an agent's write is a line in the Agent log
  ("Changed the prompt of Style Dusk"). Starter Styles are seeded once
  (`<preset root>/.seeded` marks it), so starters the person deleted, even
  for good, don't come back on the next start.

### Moodboards from the CLI and MCP

`nebula moodboard` and the `moodboard_*` MCP tools edit the boards Moodboard
Studio shows. Both use `backend/moodboard_client.py`.

```bash
nebula moodboard new "Nature + tech" ./refs https://example.com/ref.jpg --project current
nebula moodboard show "Nature + tech"      # settings, the brief generators get, images, analysis
nebula moodboard add <board> more.png
nebula moodboard set <board> --weight 2=0.5 --image-note 3="the orange accent" --set-aside 5 --strength 0.6
nebula moodboard set <board> --private-note 2="PAINTERLY (liked)"   # a label, never sent anywhere
nebula moodboard set <board> --direction "quiet coastal mornings" --avoid "neon signage" --pin-color "#E8593C"
nebula moodboard set <board> --unavoid "neon signage" --keep-out-color "#0000FF" --unpin-color "#E8593C"
nebula moodboard set <board> --brief "My own brief..."   # or --clear-brief, --keep-brief
nebula moodboard set <board> --keep-anyway "#a6392d"     # or --leave-out, --leave-out-flagged, --reset-color
nebula moodboard set <board> --clash-mode flag           # leave-out (default), flag, no-measured, keep-all
nebula moodboard set <board> --restore set-output.json  # undo: the `set --json` output
nebula moodboard edit <board> --place 12=200,40 --resize 3=0.6 --in 5=Dither --link 5=Glass
nebula moodboard edit <board> --ops ops.json --say "Moved the warm ones together"
nebula moodboard edit <board> --undo edit-output.json   # undo: the `edit --json` output
nebula moodboard analyze <board>
nebula moodboard analyze <board> --dry-run --merge-delta-e 8   # preview; saves nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --estimate           # the price; reads nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --dry-run --only 3,5   # paid read; moves nothing
nebula moodboard list                      # boards for every project, plus the open project's
nebula moodboard move <board> --to global  # or current, or a project's id or exact name
nebula character move <character> --to "Shoot B"
nebula moodboard delete <board>
```

- "Project" is a canvas project, the same one the app's Project tabs show:
  `--project current` (`project_id="current"`) is the one open on the canvas,
  otherwise an id from `nebula projects` / `list_projects`. An id that isn't a
  canvas project, or one in Recently deleted, is refused (422). Without it a
  board is Global, for every project. A node that names a board from another
  project still shows, runs and opens it there; the board stays in its own
  project. Boards filed under an old-style id (the backend's folder name, from
  older builds) are moved at startup (contract 07, section 1.9).
- Moving: `nebula moodboard move <board> --to ...` / `moodboard_move(board,
  to)`, and `nebula character move` / `character_move` for a Character,
  file it under Global or another canvas project (contract 07, section
  1.10). `to` is `global`, `current` (refused with no project open), a
  project's id, or its exact name (refused when two projects share it, or
  it's in Recently deleted). Only its listing changes: id, contents,
  `version` and `updatedAt` stay, and nodes in every project keep using it.
  Anyone may move, agents included; the result's `from` says where to move
  it back, and `movedBy` who moved it. Already there is a no-op
  (`status: "unchanged"`); one in Recently deleted is refused until it's
  restored. A Studio draft kept for it follows the move, also one made while
  the tab's socket was closed (contract 07, section 1.12).
- Editing a Character: `PUT /api/characters/{id}` with only the fields you
  change and `baseVersion` (the `version` you read); a 409
  `version_conflict` carries the Character as it is now. An open Character
  Studio shows the change live, keeps the person's unsaved edits, and names
  you when you both changed one field (contract 07, section 2.1). No MCP
  tool edits a Character's fields.
- Images on a Character (`referenceViews`) or a Style (`refImages`,
  `thumbnail`; `POST`/`PUT /api/presets`) must be Nebula's own files: an
  output or an upload as `/api/outputs/<path>` (upload a file with
  `POST /api/uploads` and use the `url` it returns; the file's path inside
  the output folder works too) or a shipped Style thumbnail
  `/api/presets/thumbnails/<name>`. An `http(s)` link to another site, a
  `data:` URI or a file outside the output folder is refused with a 422 that
  names the field, and nothing is saved: the app would otherwise fetch that
  site whenever it shows the image. To use an image from the web, download it
  and upload it first (moodboard_create and moodboard_add do that for a
  board). Links a Character or Style already holds are kept, but the app
  shows a placeholder for them, and a run of a Character node leaves such a
  view out and says so in the run's notes (it stops when every view is one)
  (contract 07, section 2.2).
- Images on a board must be Nebula's own files too (the same rule, without
  the shipped Style thumbnails): `POST /api/moodboards`, a `PUT` that adds or
  replaces an image, and the `add` board edit refuse an `http(s)` link, a
  `data:` URI or a file outside the output folder with a 422 that names the
  image (`images[1].url is an image link from outside Nebula ...`), and
  nothing is saved. `nebula moodboard new`/`add` and moodboard_create /
  moodboard_add download a link and upload it first, so use them for web
  images. A board saved before the check keeps its links: the board read
  lists them in `outsideImages`, `show --json` and moodboard_get mark each
  one `outside: true` (with an `outsideNote`), `show` prints "[Image link from
  outside Nebula (not loaded)]" before it, the app shows a placeholder, and
  a run and the analysis leave it out and don't count it (contract 07,
  section 1.19). Anyone who could reach the routes could have saved such a
  link, so don't fetch it on your own: ask the person first, and only with
  their OK re-add it with `add` (which fetches it), then remove the old one.
- A board is named by its id or exact name; an image by its number or id
  from `show`. `--json` prints the board as JSON (the MCP tools return the
  same shape).
- `show --json` and `moodboard_get` add the board's layout: each image's
  `placements` (its cards: `x`, `y`, `w`, `h` in board pixels, `weight`,
  `frameId` for the frame it is in or null, `placedBy`, `placedAt`) and the
  board's `frames` (contract 07, section 1.1). Lists and the results of
  edits leave it out. A card's area is its weight (full weight is a 480x270
  card). The layout never steers, so it isn't in the analysis, the brief or
  the node's outputs. Images you add land after the last card, in its row
  if there is room, else in a new row; a weight you set resizes the
  image's cards. The layout view also has the board's `version`, its write
  counter.
- Moving cards: `nebula moodboard edit <board>` and `moodboard_edit(board,
  ops, base_version?, say?)` send checked edits through
  `POST /api/moodboards/{id}/edits`, the route Moodboard Studio's Board view
  uses when the person drags a card (`place`, `resize`, `link`, `unlink`,
  `setAside`, `weight`, `note`, `add`, `remove`, `frame.create`,
  `frame.update`, `frame.delete`, `frame.merge`; contract 07 section 1.12).
  The CLI's flags are those ops: `--place CARD=X,Y` (the card's top-left in
  board pixels), `--resize CARD=WEIGHT` or `CARD=WxH` (it keeps its aspect),
  `--in CARD=LOOK` (a loose card joins the look; a card in another look
  moves there), `--link IMAGE=LOOK` (a copy in another look),
  `--set-aside`, `--use`, `--note`, `--private-note`, and `--ops FILE` (or
  `-`) for any other ops as JSON. A CARD is an image's number or id when it
  has one card, a card id from `placements`, or `12@Dither`. The ops land
  together or not at all, an open Studio shows them at once and keeps what
  the person was doing, and the edit is journaled under your name with your
  `say` (`--say`, up to 140 characters) in the Agent log. A `base_version`
  (`--base-version`) that is no longer the board's changes nothing and says
  the board's version: read it again. Each edit answers with `undo`
  (`edit --json` prints it, the plain output prints the command): sent back
  (`moodboard_edit(board, undo["ops"])`, `edit --undo FILE` or `-`), it
  puts back only what is still as the edit left it and names the rest ("#12
  changed since, left as is"). A `PUT` keeps what it leaves out (images
  merge by id), keeps the saved cards of images already on the board, and
  takes `baseVersion` too.
- Two writers never overwrite each other: an add from the CLI or MCP is one
  `add` op, applied to the board as it is saved, and an open Moodboard
  Studio shows it without a reload and keeps its own unsaved edits (it
  sends image changes as ops and only the board fields it changed). Each
  write is journaled as a `board.*` event in the writer's name, and a change
  to the board's own fields as `board.fields` (the field names, never their
  values), so `wait_for_canvas_change(kinds=["board"])` returns on the
  person's Direction edit at once.
- `moodboard_add` (and `add --json`) returns `addedIds` and `undo` (the
  batch that takes them off again); the CLI prints the `nebula moodboard
  set <id> --remove ...` line that does it. A URL already on the board is
  skipped and counted in `duplicatesSkipped`.
- Set aside (contract 07, sections 1.1 and 1.3a): `--set-aside N` /
  `--use N` (old names `--exclude` / `--include`), or `{"image": 5,
  "excluded": true}` in `moodboard_update` (`setAside` is the same key). A
  set-aside image stays on the board with its weight and cards and is still
  read for its colours: the analysis lists it with `setAside: true`. It never
  steers: it isn't in the palette, accents, colour sources, cues, summary,
  brief or representative images, and the Moodboard node's outputs (and so
  Krea 2's style references) leave it out. Weight 0 shows as set aside too;
  each image in `show --json` and `moodboard_get` has `setAside` (`excluded`
  or weight 0), while the analysis marks only switched images with
  `setAside` (a weight-0 image keeps its ordinary entry, measured and in no
  colour's sources). Using a weight-0 image again sets the weight its card shows,
  unless the same change gives a weight. Set-aside images still count in a
  board's image count, named beside it: `nebula moodboard list` reads
  "(5 images, 1 set aside, look, ...)", and the Moodboard node card, the
  Studio's board list and the Assets panel read "5 images · 1 set aside · look"
  (the card on one line, the whole of it on hover). An open Studio, the card and the
  lists also catch up on a change made while their tab's socket was closed
  (a backend restart), once it opens again. A Preview of the run
  counts only the images that steer ("4 images"), weight 0 left out like
  the switch, and so does the analysis's summary ("4 reference image(s)
  analyzed"). The Moodboard node's bundle leaves weight-0 images out of
  `images`, `analysis.images` and `representativeImages` as it does switched ones. When nothing
  steers, the analysis warns "Every reference is set aside, so none of them
  shapes the board." and its summary says "No reference image steers this
  board: every one is set aside."
- Each image has `notes`, which steer (the analysis reads them), and
  `privateNote`, the person's own label (`--private-note`, or
  `{"image": 2, "privateNote": "..."}` in `moodboard_update`). The private
  note is shown to whoever inspects the board (`show`, `moodboard_get`,
  Moodboard Studio) and nowhere else: not the analysis or its source hash,
  not `brief`, not the negative prompt, not the Moodboard node's outputs.
  Changing it keeps the analysis, and `previous` puts it back like any other
  image setting.
- `cover` in `moodboard_update` (a number, `#n` or an id; `""` for none)
  picks the image the board opens on: its canvas card, its thumbnail in the
  lists and Studio, `cover` ({number, id}) in `moodboard_get` and
  `moodboard_list` when one is chosen (`nebula moodboard set --cover` /
  `--clear-cover`). Without one it is #1. It moves no image, so #n stays the
  same image, and generators get exactly what they got before: same images,
  weights, brief and analysis. A set-aside image can be the cover; taking
  the cover image off the board opens it on #1 again, and `previous` puts
  the cover back like any other change.
- Images can be files, folders (the images directly inside, in name order,
  so `2.png` comes before `10.png`), http(s) links or Nebula outputs
  (`/api/outputs/...`, used as they are).
- Links are downloaded by the CLI or the MCP server process, never by the
  backend, with the guarded fetcher Commons uses for links
  (`backend/commons/net.py`): public web addresses only, so never this
  computer, its local network or a cloud metadata address (checked on every
  redirect, 3 at most, and the connection goes to the address that was
  checked); ports 80 and 443; no user name or password in the link. Then a
  PNG, JPEG, GIF or WebP content type whose bytes match, 20 MB at most, 60
  seconds in all. For an image anywhere else, save it and add the file. The
  bytes go through `POST /api/uploads`, like Moodboard Studio's Add Images.
  Everything is read and downloaded before the first upload, so one bad
  source changes nothing.
- An in-app chat's turn reads local files only from its own workspace (as
  with Commons); a relative path means that workspace. Every image found in
  a folder is checked the same way, and the check runs again when the file
  is read (which follows no links), so a link can't lead outside it.
- Each board comes with its brief fields (`direction`, `avoid`,
  `pinnedColors`, `briefOverride` with `by` and `stale`) and `brief`, the
  backend's computed brief (`styleBrief` is what generators get,
  `negativePrompt` their negatives). On a Nebula too old to send `brief` it
  is `null`; the client never offers `analysis.styleBrief` in its place,
  since that leaves out Direction, pinned colours and a hand-written brief.
- `set` and `moodboard_update` change the brief fields: `--direction` /
  `direction` (`""` clears), `--avoid` / `--unavoid` / `--clear-avoid`
  (`avoid_add`, `avoid_remove`, `avoid` to replace), `--pin-color`,
  `--keep-out-color`, `--unpin-color` (`pin_colors`, `keep_out_colors`,
  `unpin_colors`, `pinned_colors` to replace), `--brief` / `--clear-brief`
  (`brief_override`, `""` for the generated brief) and `--keep-brief`
  (`keep_brief`). Values are checked against the backend's limits before
  anything is sent, and never cut short. Only the person may change or Keep
  the person's own hand-written brief; the refusal says so in a sentence,
  and nothing in that call is saved.
- Clashes (contract 07, section 1.11): Nebula checks the measured colours
  against the words in Direction and Avoid. `brief.leftOut` lists the
  colours generators don't get, each with `reason`, `reasons`, `level`
  (conflict or warning), `why` (check, choice or mode) and `foundBy` (the
  check that found it: `words` today; a check that looks at the images can
  add findings later). `brief.mayClash` still goes, `brief.kept` holds the
  person's Keep anyway, and `brief.pinnedClashes` lists pinned colours that
  clash (they always go). `show` prints each list with the command that
  changes it. `--keep-anyway` / `keep_anyway` puts a colour back without
  pinning it, `--leave-out` / `leave_out` takes one out,
  `--leave-out-flagged` / `leave_out_flagged` takes out every flagged one,
  `--reset-color` / `reset_colors` drops either choice, and `--clash-mode`
  / `clash_mode` picks `leave-out` (default), `flag`, `no-measured` or
  `keep-all`. `colorCheck` is the saved check and its findings.
- Notes: a board's notes and its images' notes are for the person, their
  team and agents. Generators get them only when the person turns on "Send
  these notes to generators" (`sendNotes`; `brief.notesSent` says whether
  they went), or a Moodboard node's `send_notes` is `yes`. `--no-send-notes`
  / `send_notes=False` turns it off; turning it on is the person's call, so
  an agent's `--send-notes` / `send_notes=True` is refused and nothing in
  that call is saved. `previous` has `clash_mode` and `color_choices`, and
  `send_notes` when the change touched it.
- Each colour in `analysis.colors` lists `sources`: the images it comes
  from, by `number` (as `show` numbers them, excluded images counted) and
  `id`, with `share` (the colour's share of that image) and `contribution`
  (its part of the board share), largest first. `show` prints them as
  `#4 0.35%, #5 0.26%`. An analysis from before sources existed has none;
  `analyze` again to see them.
- `analyze --dry-run` (`moodboard_analyze` with `dry_run`) calls
  `POST /api/moodboards/{id}/analyze/dry-run`: the analysis and the brief
  generators would get, plus `changes` against what's saved (palette and
  accents added, removed, nudged or reordered; the brief and negatives
  before and after). It saves nothing, so agents may run it without the
  person. `--accent-min-chroma` / `accent_min_chroma` (0-150, default 40),
  `--accent-separation` / `accent_separation` (0-100, default 10) and
  `--merge-delta-e` / `merge_delta_e` (0-50, default 5) try other colour
  thresholds for that run only; without the dry run they are refused.
  On a Nebula without the dry run it says so and analyzes nothing.
- `analyze --read-with gemini-4-argon --dry-run` (`moodboard_analyze` with
  `read_with` and `dry_run`) reads the references with a vision model
  (`POST /api/moodboards/{id}/read?dryRun=1`, contract 07, section 1.13):
  batches of 6, two at a time, each image sent as a 1024 px JPEG. It prints
  every line as it arrives, the readings first (`#21  clouds under a
  halftone screen → Dither (0.82)`), then how Analyze would sort them
  (`#6 Unsorted: no look fits (0.41)`, a suggestion such as "Make a
  Painterly × Dither look for #3, #9, #14?"), a done line ("Dry run: would
  sort 14 into 4 looks (1 new) · 2 Unsorted · nothing moved") and what it
  spent. It is paid, and only the dry run exists: it saves nothing and moves
  nothing, and the board's `version` stays. Without `--dry-run` it is
  refused.
  - `--estimate` / `estimate_only` (`POST .../read/estimate`) prices it and
    sends nothing: "$0.37 to $1.02" for 14 images at medium, from Google's
    list price on the day (Gemini 4 Argon is $2.00 input and $10.00 output
    per million tokens through 2026-11-30, then $4.00 and $20.00; thinking
    counts as output). The high end assumes one retry per batch.
  - The spent line is a minimum: a request that stopped without a token
    count (a 5xx, a time bound) isn't in it, and the CLI says how many
    there were (`spent.requestsWithoutUsage` in the MCP answer).
  - `--only 3,5` / `only=[3, 5]` reads some images (numbers or ids);
    `--thinking-level low|medium|high` / `thinking_level` (default medium);
    `--quiet` prints only the done and spent lines; `--json` prints each
    trace line and then the result as JSON lines. `include_thoughts` adds
    the reader's thought lines to the MCP answer (Argon's thought summaries
    are unconfirmed, so it asks for none yet).
  - Agents go through the spending limits: a read counts as one run of the
    Gemini chat node, priced at its high estimate, so one above the per-run
    limit (default $1) is refused with the price and how to ask. The person
    can raise Gemini chat's limit in Settings > Agent spending. A request
    that never started is given back. A read with no list price is refused
    under any dollar limit.
  - The reader sees the images as A to F, never board numbers; reasons that
    name another image are cleaned before they are shown. A new look's name
    must be 1 to 60 characters and at most 4 words, of letters, digits,
    spaces and `&-'`, with no `#n`, image label, link or `@`; when the
    reader names a look any other way, its images show as Unsorted ("its
    look's name was refused") instead. Each reading in `--json` carries
    `reader` and `readerName` ("Gemini 4 Argon"), and the answer's `reader`
    says who read (`source: "model"`). Board and image
    notes go only when the board's `sendNotes` is on; private notes never.
    A reference that isn't a file on this computer is skipped and listed.
  - It needs `GOOGLE_API_KEY` (400 without it, and nothing is charged).

- Strength 0 turns the board off for every node it's connected to: no brief,
  Avoid, negatives or images, and each such node's run notes "Board
  strength is 0: board not sent". Any other board connected to the same node
  still goes. The Moodboard node's own outputs (Brief, Negative, Palette,
  Images) are unchanged, since connecting one is the person's choice. `show`
  says the brief is not sent while strength is 0. Images off with text on
  is the node's "Send board images" switch, not strength 0; that switch
  isn't in this version yet, and until it is, GPT Image, Nano Banana, FLUX
  and the other content-slot nodes get the text only anyway.
- Like Moodboard Studio, changing images, notes, mode or strength clears the
  board's analysis, so run `analyze` again; a rename and the brief fields
  keep it. `--remove` takes an image off the board; its file stays, and the
  command prints the URL to add it back.
- `moodboard_update` (and `set --json`) returns `previous`: what the change
  changed, as it was before (only those settings and brief fields, and only
  the image settings it changed), so undoing it keeps what others changed
  since in anything else. Passing it back undoes it:
  to `moodboard_update` as they are (`undo` included), or `nebula moodboard
  set <board> --restore <file>` with the saved `set --json` output (or just
  `previous`). Its `undo` goes as one checked write: a setting someone
  changed again since is left as they set it, and the result's `skipped`
  says so ("Direction changed since, left as is", "#2's weight changed
  since, left as is"; the CLI prints each line). Images the change took off
  come back with it. Its board-field part is the `undo` the server's `PUT`
  answered with: a direct `PUT /api/moodboards/{id}` answers with the board
  plus `undo`, and sending its `ops` to `POST /api/moodboards/{id}/edits`
  is the same checked undo. The person's Cmd+Z in Moodboard Studio never
  takes back your edit, so take back your own this way. The other keys are what an older Nebula puts back
  instead; a `previous` without `undo` is put back as arguments, and the
  images it took off come back from `removed` (`moodboard_add` / `nebula
  moodboard add`).
  It has the hand-written brief only when the change touched it, so undoing
  anything else leaves a brief the person wrote since alone; if the person
  replaced your brief since, the undo leaves theirs and says so (a
  `previous` without `undo` is refused with nothing saved: send it again
  without `brief_override`). If Keep fails after the other changes were
  saved (the person wrote or removed the brief while the call ran), the error
  says so and carries the `previous` that puts them back (in the MCP error
  text; on stderr from the CLI).
- Deleting: where Nebula keeps deleted boards in Recently deleted, anyone
  may delete one, agents included, because it can be restored. Where a
  delete is for good (a Nebula without Recently deleted), `nebula moodboard
  delete` and `moodboard_delete` refuse for everyone; the person deletes the
  board in Moodboard Studio. The client never decides who is the person:
  that would be a check any client could skip.
- `moodboard_create` and `moodboard_add` are marked open-world because they
  fetch links; `moodboard_delete` is marked destructive.

### The nebula skill

`skills/nebula/SKILL.md` teaches Claude Code and Codex the `nebula` CLI. It
is for agents outside Nebula, so it lives apart from `.agents/skills/`, the
provider knowledge Nebula's own chats read (they get their own primers).
Install it once per machine:

```bash
backend/.venv/bin/python -m nebula skill install          # link it (git pull keeps it current)
backend/.venv/bin/python -m nebula skill install --copy   # or copy it
backend/.venv/bin/python -m nebula skill install --for codex
```

It goes to `~/.claude/skills/nebula` (Claude Code) and
`~/.agents/skills/nebula` (Codex's user skill folder), for each app set up on
the machine. Anything already there is moved, not deleted, to
`skill-backups/nebula.backup-YYYYMMDD-HHMMSS` next to the skills folder
(`~/.claude/skill-backups/`, `~/.agents/skill-backups/`). The backups sit
outside the skills folder so they don't load as a second `nebula` skill.
A copy records its checkout in `.installed-from`.

`nebula context` lists the definition ids that can run here: with your keys,
free, on the signed-in Krea account (marked `*`), or with a Nous sign-in.
`nebula nodes` lists the same node types with how each runs and its price
(words and `--category` narrow it), and `nebula nodes --all` adds the ones
that can't run here, each with what it needs. Before 2026-10-21 `nebula
nodes` listed every node type with no sign of which could run, and an agent
in the Q104 rerun proposed FLUX.2 with no BFL or fal key set from it.
