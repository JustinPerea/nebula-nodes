---
name: nebula
description: Drive Nebula Nodes, the node-graph studio for AI images, video, audio and 3D, from the `nebula` CLI. Use when the person asks to build or run a pipeline on their Nebula canvas, generate media through Nebula, make or change a moodboard in Nebula, or mentions Nebula or Nebula Nodes. Covers finding nodes, building a graph in one step with `nebula apply`, running it, proposals for paid or big changes, moodboards, and projects.
---

# Nebula Nodes CLI

Nebula Nodes is a node-graph studio. The person has a canvas open in Nebula
and sees every change you make, live. You work on that canvas with the
`nebula` CLI.

## Running the CLI

Every command below is written as `nebula <command>`. Run it from the Nebula
Nodes checkout with the backend's Python:

```bash
cd <checkout> && backend/.venv/bin/python -m nebula <command>
```

Finding `<checkout>`:

- If this skill was installed with `nebula skill install`, the skill folder
  is a link into the checkout: `realpath ~/.claude/skills/nebula` (Codex:
  `realpath ~/.agents/skills/nebula`) prints `<checkout>/skills/nebula`.
- If it was installed with `--copy`, the file `.installed-from` in the skill
  folder holds the checkout path.
- If you are already working inside the repo, it's the repo root.

Nebula must be running. The CLI uses `$NEBULA_URL`, else the address the
desktop app writes to `$NEBULA_URL_FILE`, else `http://localhost:8000`. If it
can't connect, ask the person to start Nebula; don't start a second backend
yourself.

Set `NEBULA_AGENT_NAME` (for example `export NEBULA_AGENT_NAME="Claude Code"`)
so your cursor and edits show under your name (the person's Agent log lists
each of your edits, runs and moodboard changes under it too). `nebula apply` and
`nebula propose` need it (or `--as NAME`).

## Start here

Run `nebula context` first. One call gives you the open project and its
canvas (nodes, connections, the selection, other agents' cursors), the pins the
person left for you, open proposals, every moodboard (this project's,
Global, and other projects'), the node types that run here with their
prices, and your spending limits. Only use nodes it lists. `--json` prints
the same as JSON. On a big canvas it shows the first nodes in full and says
so; `nebula look` then gives every node.

Its NEXT lines and the line under BOARDS are the exact commands for a first
build: `nebula apply` with its flags, how to show a board in a Preview, and
`nebula propose` for the paid run. Copy those instead of reading
`nebula apply --help` or `nebula info nebula-moodboard`; use `nebula info`
for a generator's own params and ports.

Projects: `nebula projects` lists them; `*` is the one open on the canvas.
Start new work in a new project (`nebula project new "<name>"`) or open the
right one (`nebula project open <id>`). The person's canvas follows (from
their Projects screen too), names you, and offers them a button back.
**Never run `nebula clear` to make room**: a new project keeps their work.
`nebula clear` refuses on a canvas with nodes, and `--force` clears it
anyway. With their canvas open that is one undo step for them; with none
open it can't be undone yet. `nebula selection` is what they have selected.
`nebula project rename <id> "<name>"` (or `current`) renames one, prints the
old name and the command that puts it back. `nebula project show <id>` reads
a saved project without opening it: nodes as `nebula look` shows them, connections,
cover and the newest 20 runs (what each ran and made, never the values).
`nebula project size` (or `<id>`) says how big a project is against the 16
MB save limit and what takes the space, largest first, with node ids. Over
the limit the person's canvas pauses saving it until it is smaller, and an
edit of yours that would make it over, or larger while over, is refused: trim
with `nebula apply` (shorter params, removals), asking the person before
deleting their work. Run history is theirs to clear.
Recently deleted: `nebula trash list` (`--kind`; `nebula trash list --scope
global` or `--project current` narrows boards, characters and Styles) and
`nebula trash restore [kind] <id>`.

A mistyped command or option gets "Did you mean ...?" with that command's
usage. MCP's names work too: `nebula find` is `nebula nodes`, `nebula
describe` is `nebula info`.

## Find nodes

| Command | What it does |
|---|---|
| `nebula nodes upscale` | Node types that run here whose id, name or description has every word (`--category image` and so on), best matches first, each with how it runs (key, free, krea, nous) and its price per run at default settings. The last line says how many more need a key; `nebula nodes --all` lists those too, each with what it needs. `--json` prints MCP find_nodes' answer |
| `nebula info <node-id>` | Ports, params, options, defaults and prices (`PRICE:`: at default settings, or the rate a node priced from its input file is checked at); on a node with a Moodboard port, what a connected board does there (`MOODBOARD:`). Takes a node's exact name too (`nebula info moodboard`), when one node has it, and says the id it used |
| `nebula keys` | Which provider keys are set: set or not set, never any part of a key (only the app, with the person token, sees an ending; the CLI never has it) |
| `nebula providers` | Whether each key works (free, read-only checks, cached 5 minutes; `--refresh`) and the Krea account connection |
| `nebula spend` | The spending limits you work under, and what you used |

Build only with node types `nebula nodes` lists without `--all`: one that
`--all` marks `needs BFL_API_KEY or FAL_KEY ...` can't run here, so a run
of it, or a proposal that runs it, fails. Node ids and params change
as models are added. Check `nebula info` instead of guessing. `nebula info` (and `describe`) also takes a node's exact name,
any case: `nebula info moodboard` answers for `nebula-moodboard` and says so
on its first line. An id always wins, and a name two nodes share is refused
with both ids. `apply`, `propose`, `create`, `quick` and `style new/set
--model` take ids only; given
a name, they refuse and name the id ("did you mean nebula-moodboard
(Moodboard)?").

## Build: `nebula apply`

`nebula apply` makes several edits in one step, all or nothing. New nodes get
refs like `+img`; existing nodes use their ids (`n4`).

```bash
nebula apply --note "Lighthouse, two takes" \
  --add +p=text-input --param +p.value="a lighthouse at dusk, film grain" \
  --add +wide=nano-banana --param +wide.aspect_ratio=16:9 \
  --add +tight=nano-banana --param +tight.aspect_ratio=4:5 \
  --wire +p:text +wide:prompt --wire +p:text +tight:prompt \
  --rename +wide=Wide --rename +tight=Tight
```

It prints each new node's id. It never runs anything. Other edits:
`--set n4.prompt=...`, `--move n4=400,120`, `--remove n7`,
`--unwire n1:text n2:prompt`, or a whole plan with `--file plan.json`.
A `--wire` end without a port (`--wire +mb +pv:input`) is refused with the
ports that node has.

It also prints `Undo: nebula undo <token>`. Run that to take your edit back
(for 60 minutes, while that project is open): what you added goes, what you
changed or removed comes back, and anything the person changed since stays
as it is (the output lists it). A run counts as a change: a node the person
(or another agent) ran since your edit stays with its params, name and
input connections ("n3 ran since (run by the person), so it stays"). Nodes only
you ran still go, so you can undo your own experiments. A node you deleted
comes back with the person's pins on it ("Back on its node: pin_…"; one the
person deleted since prints "Couldn't re-attach …" with why) and the
proposals the delete closed reopen when they still fit ("Reopened: p_…";
one that expired or no longer fits prints "Couldn't reopen …" with why).
The person's Cmd+Z of your delete does the same, and so does your undo
after the person redid your delete or undid your undo. A plan of steps prints one line with every
step's token, newest first. Only your own `nebula apply` edits have tokens.

Single edits also exist: `nebula create`, `connect`, `set`, `rename`, `move`,
`delete`, `disconnect`.

### Placeholders while you set nodes up

```bash
nebula apply --add +hero=flux-2-pro --add +p=text-input --wire +p:text +hero:prompt --pending
nebula apply --ready n4 --ready n5      # they're ready: normal again
```

`--pending` makes that apply's new nodes your placeholders: the person sees
a dashed outline in your colour and "<you> is setting this up.", and every
run (theirs, yours, another agent's) skips them and what needs their output,
listing them as `skipped` with the reason. Nothing is spent on them. They
turn normal with `--ready`, when you run them yourself (a run refused
before it starts leaves them pending), after 10 minutes without a request
from you, or when the person edits or runs one (when the person's run
would run a paid placeholder of yours, Nebula asks them first, so leave
the model and params as they should be; if you finish or change them while
they are deciding, Nebula shows them your changes and runs nothing that
costs more than they agreed to, nor a node, model, price or extra cost
they didn't see (a model or price that changed asks them again, even a
cheaper one, and a switch on a free-text model such as OpenRouter's counts,
as does a Meshy node's mesh type, or a Krea node's Variant, Engine, Model,
Training Model, Version, Enhancement model or Frame interpolation model (the
Topaz video upscalers), or grain model while Grain is on);
if you delete or disconnect one, it tells them it's no longer in the run,
and a replay of a saved run then runs its saved copy, as it does when you
changed one after the run was saved: the dialog names the nodes you changed
(up to three; a count from four) and tells them the replay uses the saved settings). Only new
nodes can be placeholders, and only you make yours ready. `nebula undo` of
your `--ready` (or of a delete) makes them placeholders again, unless someone
ran or changed one since. A proposal whose run needs your placeholder runs
nothing until you finish it, and once one turns normal the proposal no longer
fits (Accept refuses it): propose again when they're ready. In a steps file,
put `"pending": true` on the step that adds them and `{"pending": false,
"nodeIds": ["+hero"]}` in a later step. MCP: `edit_canvas(pending=True)`,
then `edit_canvas(pending=False, node_ids=[...])`.

Prompts go into input ports, not params: connect a `text-input` node's `text`
output to the model's `prompt` (or a chat model's `messages`).

Lay out branches as a grid: columns are stages (sources, prompts, models,
outputs) about 400 px apart, rows are branches about 250 px apart. Use
`--at +ref=x,y` when adding.

### OpenRouter, Nous Portal and Replicate: ports come from the model

These three nodes take their ports from their model. Set the model in the
same `nebula apply` (`--param +eye.model=openai/gpt-4o`, or `model_id=owner/name`
on Replicate) and Nebula reads the model's data (free, with the person's key)
and gives the node its ports; the output prints `Ports of n5 (model): in ...;
out ...`.

- OpenRouter / Nous Portal: `messages` always; `images` (Image, several
  connections) for a model that takes images; `text` and/or `image` out for what it
  makes. An image model's `image` connects onward like any Image output.
- Replicate: one port per file input, named as the model names it
  (`input_image`, `image`, `audio`), and one output. A file output is typed
  from the model's own data (a content hint in its schema, else the file its
  `default_example` run returned): `video`, `audio`, `image`, `svg` or
  `mesh`; a text model's is `text`. When nothing says, it is `image` with
  `typeUnconfirmed`, and the apply prints a note (a run then keeps another
  kind of file under that file's own port, not the guessed one; a node
  saved before outputs were typed gets the same note: set its model again
  with `--param model_id=...`). The run fills that port,
  so connect a video model's `video` to a Video input. The model's other
  inputs are params of the same name: set them with `--param`, don't connect
  them.

To see a model's ports before the apply, an agent on Nebula's MCP server
calls `model_schema(provider, model_id)` (its `ports`, with types) or
`model_catalog(provider, query)` (each row's `ports`, as ids). They come from
the same function the apply configures the node with, so connecting exactly those
ports in the apply that sets the model is accepted. There is no `nebula`
command for the catalogs yet.

Changing the model of a node with connections on ports the new model lacks (or
clearing it, or naming one Nebula can't read, which leaves the basic ports)
is refused: `--unwire` them in the same apply. Without the provider's key the
node keeps its basic ports, and a connection to any other port is refused with the
reason (only the person can add a key).

## Run

```bash
nebula run n5          # a node and what feeds it; waits up to 100 s
nebula run-all         # the whole canvas
nebula result <run-id> --wait 100   # a run still going (exit 2 = still running)
nebula cancel <run-id>
nebula path n5         # the local file of a node's image
nebula status
```

Runs spend the person's own provider credits. A run over their limits, or
with a node that has no list price, is refused: send it as a proposal.
Some nodes are priced from their input file's size (SeedVR2 Upscale: $0.001
per megapixel of the larger of input and output, rounded up; `nebula info`
says so on its PRICE line). Nebula measures the file the run will send, but
only a file in Nebula's own output folder (or an inline image): a file
anywhere else could change between the check and the run, so a run from it
is refused. Add your file first:

```bash
nebula upload clip.mp4     # copies it into Nebula; prints the Video Input it made (MCP: upload_file)
nebula upload voice.wav --at 820,140   # an Audio Input, placed at 820,140 (MCP: position={"x": 820, "y": 140})
nebula upload notes.pdf --at -200,140  # a negative x works too
nebula connect n7:video n8:video
nebula run n8              # checked against the limits at the clip's real size
```

`nebula upload` takes images (PNG, JPEG, GIF, WebP), clips (MP4, MOV,
WebM), audio (WAV, MP3, M4A, AAC, FLAC, Ogg: an Audio Input, port `audio`)
and documents (PDF or text: a Document Input, port `text`), checked by their
bytes. Without `--at` the node goes right of the other nodes. The node
keeps the file's own name (its stored copy has a hashed name): the card
shows it, and `nebula look` prints it as `file:` (`fileName` in
look_at_canvas).

`nebula quick seedvr2-upscale --input image=photo.png` works too for an
image (quick copies a local image into Nebula first, not a clip). An image
over 20 MB, one Nebula can't recognise, or a clip over 500 MB can't be
added at all: propose that run. An input
another node makes in the same run isn't known yet, so that run is refused:
connect an Image Input or Video Input holding the file, or propose it. A file
on another host (a URL) is never downloaded to price it either: download it,
`nebula upload` the local copy, or propose it. A clip with more than one
video stream, or an image with more than one frame or size, isn't measured
(propose it). The refusal says which case it is.

`nebula cancel` stops runs an agent or the CLI started. A run the person
started from the canvas is theirs to stop: the CLI refuses it, so tell them
to press Stop in Nebula.

A run where any node failed exits 1 and prints each node's error (a missing
key refuses the whole run before anything is called or spent, as does a
Topaz Standard with no Model chosen, or a Krea node app with no Version:
"Choose a model for “Clean plate” first."; set it with `nebula set` first,
or leave the choice to the person). The card on
the canvas shows the same error. `nebula look` prints a failed node's error
under it, and `nebula path` says why there is no file. The error stays on the
node, through reloads, project switches and restarts, until it runs again.
Tell the person what to set up, or pick a node `nebula nodes` lists.

## Propose instead of doing

Use `nebula propose` for paid runs over the limits and for reworking the
person's own graph. Its flags: `--note` (required), `--add`, `--param`,
`--set`, `--wire`, `--at`, `--rename` for its own new nodes (`+ref=name`;
the ghost shows the name and accepting applies it), `--run`, `--file`,
`--wait` and `--json`. It doesn't take `apply`'s `--move`, `--remove`,
`--unwire` or `--arrange`, or a rename of a node already on the canvas
(use `nebula rename`). The person accepts or rejects it on the canvas; you
can't accept it. Each proposal also posts an Update the person sees on
every screen ("Codex proposes 3 changes on the canvas", with Review, which
takes them to the canvas and its bar), so don't also post a `nebula note`
about it. `nebula notes` shows how it ended: `[Accepted]`, `[Rejected]`,
`[Withdrawn by <you>]`, `[Expired]`, `[No longer fits]` or
`[Closed: Nebula restarted]` (ask again then). Proposing again after you
withdraw one replaces the withdrawn one's Update.

```bash
nebula propose --note "Upscale the wide take" \
  --add +up=seedvr2-upscale --wire n9:image +up:image --rename +up="Wide, upscaled" --run +up --wait
```

If a node the run needs can't run here, `nebula propose` prints a
`warning:` line naming it and why (`--json` gives it as `warning`, with
`--wait` too); Accept would fail at that node. Say so to
the person, or propose a node that runs here instead (`nebula nodes` lists
them). The proposal is kept, with the warning: if you then propose
something else instead, withdraw the first with the call the warning ends
with (`nebula proposal withdraw <id>`; `--json` gives it as `withdrawWith`,
which `--wait` drops once the person has decided), so the person has one
proposal to answer. While one of yours that can't run
is still open, your next `nebula propose` prints a `reminder:` line naming
it (`stillOpen` in `--json`); nothing is withdrawn for you. `nebula context`
marks such a proposal "N node(s) can't run here".

`nebula proposals` lists open ones; `nebula proposal withdraw <id>` takes one
back. A proposal invalidated because a node it needs was deleted opens again,
with the same id and expiry, if the delete is undone and it still fits
(`nebula watch` prints `proposal.reopened`; `pin.reattached` when a pin goes
back on its node). That holds only for the very node that was deleted: after
a clear, an import or a project switch, undoing an earlier delete prints
"Couldn't reopen …" (the canvas was cleared or replaced since), and a pin goes
back only onto the model it was on.

Curating the Commons (when it is on) is the person's too: correcting a
reference's reading, its regions, or its role, why or inbox place in a
collection. Ask with `nebula commons propose <id> --edit '{"correction":
{"field_path": "summary", "value": "..."}}' --note "..."` (repeat `--edit`,
up to 8; `--brand` for the brand you work on); the person decides in the
Commons and `nebula proposal <proposal id> --wait` follows it.
`nebula commons collections`, `status`, `borrowings`, `fidelity <id>` and
`concentration` read the rest. Blind labeling and the agent review stay the
person's alone.
A reference whose analysis failed carries `last_error` (the reader's text)
and `last_error_kind` (`unavailable`, `unreadable` or `other`) in
`nebula commons get <id>`.

Refusals give you the specific text (an id, the field, the command to run);
the person's canvas gets a written line instead. Read `detail`, not the
person's wording. That includes the World Labs holds: a run start, "Checked
Marble — unlock" and "Checked Marble — forget" refused while a job is still
waiting keep their exact text for you. A node's run error works the same way:
`error` (in `nebula result`, `nebula look` and the run record) is the specific
text, ids and parameter names included; the card shows a written line (the
graph's `errorPerson`, when the node's handler wrote one, or a line for the
provider's answer such as "Meshy is busy. ..." with `errorProviderText`) that
you shouldn't parse. A failed Cinema shot's `output` works the same: read its
`error`; its `errorCategory`, `errorFriendly`, `errorPerson`,
`errorProviderText`, `errorProvider` and `errorRaw` are for the Cinema panel.
Round 3f rewrote the card lines to GM's rules; nothing you read changed (a
proposal's `cost.notReady` rows add a `person` line beside `missing`: read
`missing`). A job the
provider ran and then reported failed is never `category: "auth"`, even when
its text says "unauthorized" (the job's input, not the key): check the job at
the provider rather than the key. A run the pre-run check refuses (a missing
key, an unconnected input, a Batch over its cap) prints the same specific text
as before ("Missing API key: OPENAI_API_KEY"); the card's line ("Add your
OpenAI API key in Settings, then run the node again.") rides only on the
canvas's own answer, so nothing you read changed.

## Moodboards

Moodboards are the boards in Moodboard Studio: reference images with weights
and notes, analyzed into a palette and accent colours, plus the brief fields:
Direction (what the board is for), Avoid (things to keep out), pinned colours
(must appear / keep out) and an optional hand-written brief. A
`nebula-moodboard` node puts a board on the canvas (param `moodboard` = the
board id), with outputs `moodboard`, `style_brief`, `negative_prompt`,
`representative_images` and `palette`. To show one in a Preview:
`nebula apply --add +mb=nebula-moodboard --param +mb.moodboard=<board> --add +pv=preview --wire +mb:moodboard +pv:input`;
connect `+mb:moodboard` to a generator's `moodboard` input to style it.

```bash
nebula moodboard new "Nature + tech" ./refs https://example.com/ref.jpg --project current
nebula moodboard show "Nature + tech"          # settings, the brief generators get, images, analysis
nebula moodboard add <board> more.png ./more-refs
nebula moodboard set <board> --weight 2=0.5 --image-note 3="the orange accent" --set-aside 5
nebula moodboard set <board> --private-note 2="PAINTERLY (liked)"   # a label, never sent anywhere
nebula moodboard set <board> --mode world --strength 0.6 --notes "warm, quiet"
nebula moodboard set <board> --direction "quiet coastal mornings" --avoid "neon signage" \
  --pin-color "#E8593C" --keep-out-color "#0000FF"
nebula moodboard set <board> --unavoid "neon signage" --unpin-color "#0000FF"
nebula moodboard set <board> --brief "My own brief..."   # or --clear-brief, --keep-brief
nebula moodboard set <board> --cover 3                  # the image the board opens on; --clear-cover: #1 again
nebula moodboard set <board> --keep-anyway "#a6392d"     # put a left-out colour back (not pinned)
nebula moodboard set <board> --leave-out "#1c70f2"       # or --leave-out-flagged, --reset-color HEX
nebula moodboard set <board> --clash-mode flag           # leave-out (default), flag, no-measured, keep-all
nebula moodboard set <board> --restore set-output.json  # undo: the `set --json` output
nebula moodboard edit <board> --place 12=200,40 --resize 3=0.6   # move and resize cards
nebula moodboard edit <board> --in 5=Dither --link 5=Glass --say "Grouped the warm ones"
nebula moodboard edit <board> --undo edit-output.json   # undo: the `edit --json` output
nebula moodboard analyze <board>
nebula moodboard analyze <board> --dry-run --merge-delta-e 8   # preview; saves nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --estimate          # the price; reads nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --dry-run --only 3,5  # paid read; moves nothing
nebula moodboard list
nebula moodboard move <board> --to global      # or --to current, or a project's id or exact name
nebula character move <character> --to current
nebula moodboard delete <board>
```

- Before connecting a board to a generator's `moodboard` port, `nebula info
  <node-id>` says what that node takes from it: the `MOODBOARD:` line is the
  card's ("Board images: on · up to 10 to Image Style Refs", or the brief as
  text only), with `(on <route>)` after it on a node with more than one
  route, then the channel, weights, ports the board never fills, and the
  models or routes that change it.

- `show` lists each palette and accent colour with its share of the board
  and the images it comes from (`#4 0.35%, #5 0.26%`: image number from
  `show`, and the colour's share of that image); `--json` has the full
  `sources` (number, id, share, contribution). An older analysis has none
  until you `analyze` again.
- `analyze --dry-run` shows what analyzing would give and what would change
  (palette and accents added, removed or reordered; the brief generators get;
  the negatives), and saves nothing, so you can run it without asking. With
  it, `--accent-min-chroma` (0-150, default 40), `--accent-separation`
  (0-100, default 10) and `--merge-delta-e` (0-50, default 5) try other
  colour thresholds for that run only. Nothing saves custom thresholds.
- `analyze --read-with gemini-4-argon --dry-run` reads the references with
  a vision model and prints each reading as it streams (`#21  clouds under
  a halftone screen → Dither (0.82)`), then how Analyze would sort them into
  looks (`#6 Unsorted: no look fits (0.41)`, "Make a Painterly × Dither look
  for #3, #9, #14?") and what it spent. It is paid but moves and saves
  nothing; only the dry run exists yet. Run `--estimate` first and tell the
  person the price: a read counts as one Gemini chat run against the
  spending limits, so one over the per-run limit is refused (the person can
  raise the Gemini chat limit in Settings > Agent spending). `--only 3,5`
  reads some images, `--thinking-level low|medium|high` (default medium),
  `--quiet` prints only the done and spent lines, `--json` one JSON line
  per trace line. The spent line is a minimum: a request that stopped
  without a token count isn't in it, and the CLI says so. The reader never
  sees board numbers, and its reasons never name another image; a look
  name it makes up that isn't plain words (at most 4, letters, digits and
  `&-'`) is refused and those images show as Unsorted;
  board and image notes go to Google only when the board's `sendNotes` is on,
  private notes never. A reference that isn't a file on this computer isn't
  read.
- Images can be files, folders (their images in name order), http(s) image
  links, or Nebula outputs (`/api/outputs/...`). Links are downloaded on your
  machine (PNG, JPEG, GIF or WebP, up to 20 MB), then uploaded to Nebula.
  Only public web links work: not this computer, its local network, or ports
  other than 80 and 443. For those, save the image and add the file.
- Name a board by its id or exact name, and an image by its number or id
  from `show`.
- `--cover` picks the image a board opens on: its card on the canvas, its
  thumbnail in lists and Studio, `show` ("Cover: #3"). Without one it is #1,
  as before. It is a pick, not a reorder: #n stays the same image, and the
  cover never changes what generators get (images, weights, brief or
  analysis). A set-aside image can be the cover. Taking the cover image off
  the board opens it on #1 again, and undoing that brings both back.
  `--clear-cover` goes back to #1. MCP: `moodboard_update(cover=3)`, or
  `cover=""` to clear; `moodboard_get` lists `cover` (number, id) when one
  is chosen.
- `show --json` (and MCP `moodboard_get`) also lists where each image's
  card sits on the board: `placements` (x, y, w, h in board pixels, its
  weight, and `frameId`, the frame it is in or null) and the board's
  `frames`. A card's size is its weight (full weight is 480x270). The layout
  never steers: it isn't in the analysis or the brief. New images land
  after the last one, and `--weight` resizes the image's card.
- `edit` moves cards, the same checked edits the person's drags in the
  Studio's Board view send: `--place CARD=X,Y` (top-left, board pixels),
  `--resize CARD=0.6` or `CARD=480x270` (it keeps its aspect), `--in
  CARD=LOOK`, `--link IMAGE=LOOK`, `--set-aside`, `--use`, `--note`,
  `--private-note`, and `--ops FILE` for any other ops as JSON (contract 07
  section 1.12; MCP `moodboard_edit(board, ops)`). A CARD is the image's
  number when it has one card, else `12@Dither` or a card id from `show
  --json`. Say what you did with `--say` (the person reads it in the Agent
  log). It all lands or none of it, and an open Studio shows it at once. It
  prints how to undo it; `--undo` with its `--json` output puts back only
  what is still as you left it and says what changed since.
- Your changes never overwrite the person's: `add` lands on the board as it
  is saved, and an open Moodboard Studio shows it at once and keeps what the
  person was typing. If a write says the board changed since you read it,
  read it again (`show`) and redo your change. `set` resends its own fields
  when the person saved something else meanwhile, but if they changed a
  field `set` is setting (say Direction), it stops, writes nothing more and
  names the field: read their value before you run it again. `add` prints how to take the
  images off again; `add --json` (and MCP `moodboard_add`) gives
  `addedIds` and `undo`.
- Weights and strength run from 0 to 1. On Krea 2 the board's images
  share out its strength: each goes at strength x its weight / the weights
  of the images sent, so they add up to the board's strength (one image
  goes at the full strength), and your own connected references keep theirs on
  top. The run note lists what went. Strength 0 turns the board off for
  every node it's connected to, text included: no brief, Avoid, negatives or
  images, and the run note "Board strength is 0: board not sent". For
  text without images, use the node's "Send board images" switch instead
  (not in this version yet; until then GPT Image, Nano Banana, FLUX and
  the other content-slot nodes get only the text anyway). `--set-aside N` keeps an image on
  the board with its weight, still read for its colours, but it never steers
  (no palette, brief, cues or representative image, and no generator gets
  it); `--use N` uses it again (`--exclude`/`--include` are the old names).
  Weight 0 shows as set aside too, and `--use` on a weight-0 image gives it
  the weight its card shows unless you pass `--weight`. `show` marks them
  "set aside" and `list` counts them ("5 images, 1 set aside"; a Preview
  of the run counts only the 4 that steer); `--json`
  has `setAside` on each image. The analysis lists an
  image switched aside with `setAside: true` and its colours; a weight-0
  image keeps its ordinary entry there, but the summary counts neither, and
  the Moodboard node's bundle (what an LLM node on an Any port reads) has
  neither in `images`, `analysis.images` or `representativeImages`. `--remove` takes
  an image off the board (its file stays).
- `--image-note` steers (the analysis reads it). `--private-note` is a label
  for whoever looks at the board, like "PAINTERLY (liked)": no analysis,
  brief, generator or node output gets it, and changing it keeps the
  analysis. `show` prints it marked private; `show --json` has it as each
  image's `privateNote`. Read it, but never put it in a prompt.
- The brief generators get is `brief.styleBrief` in `show --json` (and
  `brief.negativePrompt` their negatives); `show` prints it with who wrote
  it. Don't use `analysis.styleBrief`: it leaves out Direction, pinned
  colours and any hand-written brief.
- Nebula checks the measured colours against the words in Direction and
  Avoid. By default a colour that clashes (Avoid "red, orange or pink
  flowers" and a brick-red accent) leaves the brief: `show` lists it under
  "Left out of the brief" with the reason and the `--keep-anyway` command,
  and `--json` has it in `brief.leftOut` (each with `reason`, `level`,
  `why` and `foundBy`). `brief.mayClash` still goes; `brief.pinnedClashes`
  are pinned colours, which always go. Tell the person what was left out
  rather than putting it back yourself. `--keep-anyway` doesn't pin the
  colour; `--reset-color` hands it back to Nebula's check. `--clash-mode`:
  `flag` leaves nothing out and lists clashes, `no-measured` sends no
  measured colour once there is a Direction, `keep-all` turns the check's
  effect off. Today the check reads words only; a later check (one that
  looks at the images) adds its findings to `colorCheck` the same way.
- The board's notes (and each image's notes) are for the person, their team
  and you: generators don't get them unless the person turns on "Send these
  notes to generators" (`sendNotes`, `brief.notesSent`). `--no-send-notes`
  turns it off; `--send-notes` is the person's call and refused for an
  agent: ask with `POST /api/asset-proposals` (`{"kind": "moodboard", "id":
  "<board id>", "change": {"sendNotes": true}, "note": "..."}`, or
  `propose_asset_change` over MCP), which the person decides in Moodboard
  Studio; `nebula proposal <id> --wait --timeout 60` follows it. Every such
  proposal (a cover, Send notes, Commons curation) also posts an Update in
  the person's Updates corner ("<you> asks to ...", with Review); a new one
  on the same target replaces it, and `nebula notes` shows how it ended
  (an expired one says "Expired" on time; one that was open when Nebula
  restarted says "Closed: Nebula restarted", since proposals don't survive a
  restart; either way, ask again if you still want it). A Moodboard
  node's `send_notes` param (`board`, `yes`, `no`) can
  override it per node; moving it toward sending is also the person's, so
  propose it. That includes pointing a node on `yes` at another board: set
  `send_notes` to `board` or `no` in the same edit, or propose it.
- `--avoid`, `--pin-color` and `--keep-out-color` add (repeatable);
  `--unavoid` and `--unpin-color` take off; `--clear-avoid` empties the list
  first; `--direction ""` clears Direction. Limits: 40 Avoid items of 200
  characters, 12 colours per list.
- `--brief` writes the brief by hand; `--clear-brief` goes back to the
  generated one. When the board changes after, `show` says so:
  `--keep-brief` keeps yours. If the person wrote the brief, it's theirs:
  changing or keeping it is refused and nothing in that command is saved, so
  leave those flags out or ask them.
- Changing images, notes, mode or strength clears the analysis: run
  `analyze` again before you use the board. A rename and the brief fields
  keep it.
- Every board write is journaled in its writer's name, so `nebula watch
  --kinds board` sees the person's edits too: an image, card or frame
  change is `board.added`, `board.moved`, ...; a change to the board's own
  fields (Direction, Avoid, pinned colours, its notes, Send notes, strength,
  a rename...) is `board.fields`, whose `fields` lists the names that
  changed. It never carries their values: read the board (`show`) for them.
- Without `--project` a board is Global: it belongs to no project, so every
  project can use it. `--project current` keeps it in the project open on the
  canvas (the `*` in `nebula projects`), which is the project the person's
  Project tab shows; `--project <id>` takes an id from `nebula projects`. An
  id that isn't a project, or one in Recently deleted, is refused.
- A Moodboard (or Character) node names its board by id, so it works in any
  project: copied into another project it still shows the board, runs, and
  opens it, and the board stays in the project it lives in.
- `nebula moodboard move <board> --to global|current|<project id or exact
  name>` changes which project a board is listed in (Global: every
  project's Global tab). `nebula character move` does the same for a
  Character, by id or exact name. Only where it's listed changes; nodes that
  use it keep working everywhere, so anyone may move one, and the output
  prints the command that moves it back. A board or Character in Recently
  deleted is refused: restore it first. MCP: `moodboard_move`,
  `character_move`.
- An open Character Studio follows a Character you change with
  `PUT /api/characters/{id}` (there is no MCP tool for its fields): send
  only the fields you change, with `baseVersion` (the `version` you read)
  so you never write over the person's edit; a 409 `version_conflict`
  carries the Character as it is now. The person's unsaved edits stay, and
  if you both changed one field the Studio tells them, naming you.
- A Character's `referenceViews` and a Style's `refImages` and `thumbnail`
  take only Nebula's own files: `/api/outputs/...` (upload a file with
  `POST /api/uploads` and use its `url`) or a shipped Style thumbnail
  `/api/presets/thumbnails/<name>`. A web link, a `data:` URI or a file
  outside Nebula's output folder is refused (422, nothing saved); download
  and upload the image first. A Character saved earlier with a web link
  keeps it, but a run leaves that view out and its notes say so.
- A board's images are Nebula's own files the same way: `POST`/`PUT
  /api/moodboards` and the `add` board edit refuse a web link or a `data:`
  URI (422, nothing saved). `nebula moodboard new`/`add` (and moodboard_create
  / moodboard_add) download a link and upload it, so pass web images to them.
  A board saved earlier with a web link keeps it: `show` marks it "[Image
  link from outside Nebula (not loaded)]", `--json` gives `outside: true`,
  and a run and the analysis leave it out. Don't fetch it on your own: ask
  the person before re-adding its link with `add` (that fetches it), then
  remove the old one; or they replace it with an upload in Moodboard Studio.
- `set --json` returns `previous`: what your change changed, as it was
  before (only those settings, Direction, Avoid, pinned colours, your own
  hand-written brief, and only the image settings you changed), so undoing
  it keeps what others changed since in anything else. To undo it, save that output and run
  `nebula moodboard set <board> --restore <file>` (`-` reads stdin), or
  pass `previous` to the MCP tool `moodboard_update` as it is (`undo`
  included). Its `undo` is one checked write: anything someone changed
  again since is left as they set it, and the result says so in `skipped`
  ("Direction changed since, left as is"). The person's own Cmd+Z in
  Moodboard Studio never undoes your edits, so this is how you take back
  yours (over HTTP, a `PUT /api/moodboards/{id}` answers with the same
  `undo`; send its `ops` to `/edits`). Images you took off with
  `--remove` come back with it (an older Nebula's `previous` has no `undo`:
  add them back from `removed` with `nebula moodboard add <board> <url>`). If a `--keep-brief` fails after
  the other changes were saved, the error prints the `previous` that puts
  them back.
- `delete` moves a board to Recently deleted, and
  `nebula trash restore moodboard <id>` brings it back. If this Nebula has no
  Recently deleted, a delete would be for good, so it's refused: ask the
  person, or take images off the board instead.
- `--json` on any of them prints the board as JSON.

## Styles

A Style is a saved look the person applies in Create (and sees in the Assets
panel's Styles tab): a prompt fragment, optionally with a model and its
settings. Name one by id or exact name.

```bash
nebula style list                       # Global Styles plus the open project's
nebula style show "Neon noir"
nebula style new "Neon noir" --prompt "neon noir, wet streets" \
  --model nano-banana --params '{"aspect_ratio": "3:4"}'
nebula style set "Neon noir" --prompt "neon noir, rain" --json   # save this reply as undo.json
nebula style set "Neon noir" --restore undo.json   # undo that change
nebula style delete "Neon noir"         # to Recently deleted
nebula trash restore style <id>         # bring it back, same id
```

- New Styles are Global unless `--project current` (or an id) keeps one in
  a canvas project.
- `set` is a checked write: if someone saved the Style since you read it,
  nothing is written; read it again. `--params` replaces the settings whole.
  `--restore` undoes your change and is refused once someone changed it again.
- Who bills a Style's model (`_provider`, `_kreaAuth`) is the person's call:
  leave those out. Internal `_` params are refused.
- Deleting for good is the person's, in the app.

## Ask the person

When you reach a decision only the person can make (which of two
directions, a name that is theirs, a detail you can't find on the canvas),
ask, then wait for the answers. Don't ask to announce work (that is
`nebula note`), and send a concrete change to approve as `nebula propose`.

```bash
nebula ask --question "Which crop for the hero?" --option Square --option Wide --option Tall \
  --question "Anything to avoid?" --note "Picking the hero crop" --node n4 --wait 300
nebula answers qs_9a1c3e02 --wait 300     # read (or keep waiting for) the answers
nebula questions withdraw qs_9a1c3e02     # take them back
```

1-5 questions; `--option` (2-6), `--multiple` (any number of its choices)
and `--no-text` (choices only) belong to the `--question` before them, and
`--file` takes `{questions, note, nodeIds}`. The person sees an Update from
you ("Codex has 2 questions.", with Answer; "Codex asked 2 questions."
once closed), may skip any question or dismiss them all; you don't post a
`nebula note` about it. With --wait (`nebula answers <id> --wait 300`) it
exits 0 answered, 2 no answer yet, 3 dismissed, 4 withdrawn (without --wait
it always exits 0, so read the status it prints); a skipped
question shows "No answer.". Only you read your answers, and the person's
typed text is their message to you. Three sets can be open at once; at the
cap the error lists yours with the `nebula questions withdraw` call for
each. There is no time limit, and sets survive a Nebula restart (they are
kept with the project): `nebula answers <id>` under the same agent name
still reads them, and a `--wait` rides through the restart (it retries
until Nebula is back, within the wait). MCP: `ask_person`, `get_answers`,
`withdraw_questions`.

## Say what you're working on

```bash
nebula status "Rendering three hero crops" --node n4   # your line in the person's Agents panel
nebula status --clear                                  # when you finish
nebula agents                                          # who else is working, on what
nebula status                                          # with nothing: the nodes' run state, as before
```

Set a status when you start a piece of work and replace it when the work
changes. The person sees it under your name in the Agents panel (the top
of Updates), and other agents in `nebula agents`. It lasts until you change
or clear it, or until you make no call to Nebula for 10 minutes; clear it
when you finish. One line, 140 characters at most (a longer one is cut
after its last whole word if that keeps at least 100 characters, otherwise
cut hard without splitting a character, and ends in "…"); `--node` puts it on a
node on the open canvas (deleting that node, or switching projects, drops
the node and keeps the line). A status is what you are working on and
lasts; `nebula point --say "..."` is a passing remark at your cursor; what you
noticed goes in `nebula note`. You set only your own, it belongs to the
open project, and a Nebula restart clears it.

`nebula agents` (`--json` for the raw read) lists the agents around in the
open project: Needs you first (an agent whose questions or proposals wait
for the person, longest wait first, with counts such as "1 question, 1
proposal"), then Working (most recent first), each with its status or its
cursor's last action ("Added “Text Input” · 2 min ago"). Counts only: you
never see another agent's questions, the person's answers or another
agent's proposal notes. MCP: `set_status`, `list_agents`.

While your run is on a node, the person sees your mark above it ("Running
FLUX.2 [pro] · 0:41"); `nebula agents` lists each agent's running nodes and
placeholders too. When a run you started ends, Nebula posts your done card
in Updates ("Codex finished “Hero shots”.", "Codex finished 2 of 3 nodes.
“Upscale” failed.") with a thumbnail and Show on canvas; read it with
`nebula notes` (MCP `list_notes`, `about: "run"`). You don't post it
yourself, and a newer card for the same node replaces yours.

## Watch and answer the person

```bash
nebula watch --once            # wait for the next change on the canvas
nebula pins                    # notes the person pinned for agents
nebula pin resolve <pin-id> --say "Warmed the grade on n7"
nebula point n4 --say "Trying a tighter crop here"
nebula point --say "Reading your board"   # no target: said where your cursor is, it doesn't move
nebula note "n4 and n7 use different seeds; I'll match them" --node n4 --node n7
nebula notes --unread          # your updates the person hasn't opened
```

`--say` (on `point`, `pin resolve`) and `--note` (on `apply`, `propose`) are
for your own action. What you noticed, a report or a suggestion goes in
`nebula note`: the person reads it under Updates in the top right of
every screen (the canvas, Projects, the studios, the Commons), saved with
the project. `--board <name>` keeps it with a moodboard instead (there `#12`
names image 12; read it back with `nebula notes --board <name>`): the person
sees it in Moodboard Studio's corner under "This board" while that board is
open, and on no other screen, so leave out `--board` to reach them anywhere.
One plain line, 240 characters, at most 6 a minute; never quote a private
note; `--since-last-turn` for what they changed since your last turn. Your
proposals, on the canvas and outside it, post their own Update (you don't
post one, and it doesn't count toward the 6): `nebula notes` lists it with
`[outcome]` once it closed.

A project's cover: agents set it (MCP `set_project_cover`) while the person
hasn't pinned one, and propose a change to the person's pin
(`propose_asset_change`). A pin whose image is gone (its node deleted) no
longer counts: `list_project_covers` says `lostPin`, and you may set it.
A cover proposal's `change.cover.auto` is the image the automatic cover
shows now (null when the project has none).

## Save and load

```bash
nebula save graph.json
nebula load graph.json         # replaces the canvas: open a new project first
nebula load "Big campaign.nebula.zip"   # a bundle: its files are restored too
```

`nebula save` replaces only an earlier saved graph; it won't write over any
other file (an image or clip, say). `nebula load` (MCP `load_graph_file`)
opens a file as Load graph on the canvas does: a plain `.nebula` or `.json`,
or a `.nebula.zip` bundle (a graph plus its files), whose files it restores
into Nebula's output folder with the graph's links pointing at them. Under
the 16 MB save limit it replaces the open project's canvas. A file over the
limit opens as a new project named after the file, and the open project is
left as it was; the new project's saving is paused until it's trimmed under
16 MB (`nebula project size` shows what's large), and `nebula load` prints
the `nebula project open <id>` that goes back.

## Port types

Connections must match types; `Any` connects to anything.

| Type | Carries |
|---|---|
| Text | Prompts, chat messages |
| Image | .png, .jpg, .webp files |
| Video | .mp4, .mov files |
| Audio | .mp3, .wav files |
| Mesh | .glb, .obj, .fbx files |
| SVG | .svg files or SVG text |
| Array | Lists of the above |
| Moodboard | A saved moodboard |
| Any | Anything |

## Utility nodes (free, no provider)

| Node id | Use |
|---|---|
| `text-input` | Prompt text (param `value`), output `text` |
| `image-input`, `video-input`, `audio-input` | A local file (param `filePath`) |
| `combine-text` | Merge `text1`-`text3`; `template` like `"A {text1} painting of {text2}"` |
| `router` | One input out to `out1`-`out3` |
| `array-builder` / `array-selector` | Collect items into an array / pick one |
| `iterator-image`, `iterator-text` | Run once per array item |
| `frame-extractor` | A frame from a video (needs ffmpeg) |
| `svg-rasterize` | SVG to PNG |
| `preview`, `image-compare` | Show results on the canvas |
| `sticky-note` | A note on the canvas |

## Rules

1. Run `nebula context` first, and only use nodes it lists.
2. Start a new project rather than clearing a canvas you didn't make.
3. Check ports with `nebula info` before connecting.
4. Spending is the person's own money with their providers. Stay inside
   their limits and propose anything bigger.
5. Canvas edits can be undone, so when the person gives you room, use it.
   Ask before anything that can't be undone.
