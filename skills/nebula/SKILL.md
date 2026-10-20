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
canvas (nodes, wires, the selection, other agents' cursors), the pins the
person left for you, open proposals, every moodboard (this project's,
Global, and other projects'), the node types that run here with their
prices, and your spending limits. Only use nodes it lists. `--json` prints
the same as JSON. On a big canvas it shows the first nodes in full and says
so; `nebula look` then gives every node.

Projects: `nebula projects` lists them; `*` is the one open on the canvas.
Start new work in a new project (`nebula project new "<name>"`) or open the
right one (`nebula project open <id>`). The person's canvas follows (from
their Projects screen too), names you, and offers them a button back.
**Never run `nebula clear` to make room**: a new project keeps their work.
`nebula clear` refuses on a canvas with nodes, and `--force` clears it
anyway. With their canvas open that is one undo step for them; with none
open it can't be undone yet. `nebula selection` is what they have selected.

A mistyped command or option gets "Did you mean ...?" with that command's
usage. MCP's names work too: `nebula find` is `nebula nodes`, `nebula
describe` is `nebula info`.

## Find nodes

| Command | What it does |
|---|---|
| `nebula nodes upscale` | Node types whose id or name has every word (`--category image` and so on) |
| `nebula info <node-id>` | Ports, params, options, defaults and prices; on a node with a Moodboard port, what a wired board does there (`MOODBOARD:`) |
| `nebula keys` | Which provider keys are set |
| `nebula spend` | The spending limits you work under, and what you used |

Node ids and params change as models are added. Check `nebula info` instead
of guessing.

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

It also prints `Undo: nebula undo <token>`. Run that to take your edit back
(for 60 minutes, while that project is open): what you added goes, what you
changed or removed comes back, and anything the person changed since stays
as it is (the output lists it). A plan of steps prints one line with every
step's token, newest first. Only your own `nebula apply` edits have tokens.

Single edits also exist: `nebula create`, `connect`, `set`, `rename`, `move`,
`delete`, `disconnect`.

Prompts go into input ports, not params: wire a `text-input` node's `text`
output into the model's `prompt` (or a chat model's `messages`).

Lay out branches as a grid: columns are stages (sources, prompts, models,
outputs) about 400 px apart, rows are branches about 250 px apart. Use
`--at +ref=x,y` when adding.

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

`nebula cancel` stops runs an agent or the CLI started. A run the person
started from the canvas is theirs to stop: the CLI refuses it, so tell them
to press Stop in Nebula.

A run where any node failed exits 1 and prints each node's error (a missing
key refuses the whole run before anything is called or spent). The card on
the canvas shows the same error. `nebula look` prints a failed node's error
under it, and `nebula path` says why there is no file. The error stays on the
node, through reloads, project switches and restarts, until it runs again.
Tell the person what to set up, or pick a node `nebula context` lists.

## Propose instead of doing

Use `nebula propose` for paid runs over the limits and for reworking the
person's own graph. Its flags: `--note` (required), `--add`, `--param`,
`--set`, `--wire`, `--at`, `--rename` for its own new nodes (`+ref=name`;
the ghost shows the name and accepting applies it), `--run`, `--file`,
`--wait` and `--json`. It doesn't take `apply`'s `--move`, `--remove`,
`--unwire` or `--arrange`, or a rename of a node already on the canvas
(use `nebula rename`). The person accepts or rejects it on the canvas; you
can't accept it.

```bash
nebula propose --note "Upscale the wide take" \
  --add +up=seedvr2-upscale --wire n9:image +up:image --rename +up="Wide, upscaled" --run +up --wait
```

If a node the run needs can't run here, `nebula propose` prints a
`warning:` line naming it and why (`--json` gives it as `warning`, with
`--wait` too); Accept would fail at that node. Say so to
the person, or propose a node that runs here instead (`nebula context` lists
them).

`nebula proposals` lists open ones; `nebula proposal withdraw <id>` takes one
back.

## Moodboards

Moodboards are the boards in Moodboard Studio: reference images with weights
and notes, analyzed into a palette and accent colours, plus the brief fields:
Direction (what the board is for), Avoid (things to keep out), pinned colours
(must appear / keep out) and an optional hand-written brief. A
`nebula-moodboard` node puts a board on the canvas (param `moodboard` = the
board id), with outputs `moodboard`, `style_brief`, `negative_prompt`,
`representative_images` and `palette`.

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
nebula moodboard analyze <board>
nebula moodboard analyze <board> --dry-run --merge-delta-e 8   # preview; saves nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --estimate          # the price; reads nothing
nebula moodboard analyze <board> --read-with gemini-4-argon --dry-run --only 3,5  # paid read; moves nothing
nebula moodboard list
nebula moodboard move <board> --to global      # or --to current, or a project's id or exact name
nebula character move <character> --to current
nebula moodboard delete <board>
```

- Before wiring a board into a generator's `moodboard` port, `nebula info
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
  after the last one, and `--weight` resizes the image's card. The CLI can't
  move cards yet.
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
  goes at the full strength), and your own wired references keep theirs on
  top. The run note lists what went. Strength 0 turns the board off for
  every node it's wired into, text included: no brief, Avoid, negatives or
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
  agent. A Moodboard node's `send_notes` param (`board`, `yes`, `no`) can
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
- `set --json` returns `previous`: what your change changed, as it was
  before (only those settings, Direction, Avoid, pinned colours, your own
  hand-written brief, and only the image settings you changed), so undoing
  it keeps what others changed since in anything else. To undo it, save that output and run
  `nebula moodboard set <board> --restore <file>` (`-` reads stdin), or
  pass `previous` to the MCP tool `moodboard_update` as it is (`undo`
  included). Its `undo` is one checked write: anything someone changed
  again since is left as they set it, and the result says so in `skipped`
  ("Direction changed since, left as is"). Images you took off with
  `--remove` come back with it (an older Nebula's `previous` has no `undo`:
  add them back from `removed` with `nebula moodboard add <board> <url>`). If a `--keep-brief` fails after
  the other changes were saved, the error prints the `previous` that puts
  them back.
- `delete` moves a board to Recently deleted, and
  `nebula trash restore moodboard <id>` brings it back. If this Nebula has no
  Recently deleted, a delete would be for good, so it's refused: ask the
  person, or take images off the board instead.
- `--json` on any of them prints the board as JSON.

## Watch and answer the person

```bash
nebula watch --once            # wait for the next change on the canvas
nebula pins                    # notes the person pinned for agents
nebula pin resolve <pin-id> --say "Warmed the grade on n7"
nebula point n4 --say "Trying a tighter crop here"
nebula note "n4 and n7 use different seeds; I'll match them" --node n4 --node n7
nebula notes --unread          # your updates the person hasn't opened
```

`--say` (on `point`, `pin resolve`) and `--note` (on `apply`, `propose`) are
for your own action. What you noticed, a report or a suggestion goes in
`nebula note`: the person reads it under Updates in the top right, saved with
the project (`--board <name>` for a moodboard's, where `#12` names image 12).
One plain line, 240 characters, at most 6 a minute; never quote a private
note; `--since-last-turn` for what they changed since your last turn.

## Save and load

```bash
nebula save graph.json
nebula load graph.json         # replaces the canvas: open a new project first
```

## Port types

Wires must match types; `Any` connects to anything.

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
3. Check ports with `nebula info` before wiring.
4. Spending is the person's own money with their providers. Stay inside
   their limits and propose anything bigger.
5. Canvas edits can be undone, so when the person gives you room, use it.
   Ask before anything that can't be undone.
