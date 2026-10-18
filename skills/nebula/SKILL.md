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
so your cursor and edits show under your name. `nebula apply` and
`nebula propose` need it (or `--as NAME`).

## Start here

1. `nebula context`: which nodes can run here, with the keys this person set
   up. Only use nodes it lists.
2. `nebula projects`: saved projects; `*` is the one open on the canvas.
   Start new work in a new project (`nebula project new "<name>"`) or open
   the right one (`nebula project open <id>`). If `nebula project new`
   isn't in `nebula --help` yet, ask the person to make a new project in the
   app. **Never run `nebula clear` to
   make room**: it wipes the person's open canvas.
3. `nebula look`: the canvas as data (nodes, wires, outputs, selection, pins
   the person left for you). `nebula selection` is what they have selected.

## Find nodes

| Command | What it does |
|---|---|
| `nebula nodes --filter upscale` | Node types by name (`--category image` and so on) |
| `nebula info <node-id>` | Ports, params, options, defaults and prices |
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

## Propose instead of doing

Use `nebula propose` for paid runs over the limits and for reworking the
person's own graph. It takes the same flags as `apply`, plus `--run`. The
person accepts or rejects it on the canvas; you can't accept it.

```bash
nebula propose --note "Upscale the wide take" \
  --add +up=seedvr2-upscale --wire n9:image +up:image --run +up --wait
```

`nebula proposals` lists open ones; `nebula proposal withdraw <id>` takes one
back.

## Moodboards

Moodboards are the boards in Moodboard Studio: reference images with weights
and notes, analyzed into a palette, accent colours and a style brief. A
`nebula-moodboard` node puts a board on the canvas (param `moodboard` = the
board id), with outputs `style_brief`, `negative_prompt`,
`representative_images` and `palette`.

```bash
nebula moodboard new "Nature + tech" ./refs https://example.com/ref.jpg --project current
nebula moodboard show "Nature + tech"          # numbered images, settings, analysis
nebula moodboard add <board> more.png ./more-refs
nebula moodboard set <board> --weight 2=0.5 --image-note 3="the orange accent" --exclude 5
nebula moodboard set <board> --mode world --strength 0.6 --notes "warm, quiet"
nebula moodboard analyze <board>
nebula moodboard list
nebula moodboard delete <board>
```

- Images can be files, folders (their images in name order), http(s) image
  links, or Nebula outputs (`/api/outputs/...`). Links are downloaded on your
  machine (PNG, JPEG, GIF or WebP, up to 20 MB), then uploaded to Nebula.
- Name a board by its id or exact name, and an image by its number or id
  from `show`.
- Weights and strength run from 0 to 1. `--exclude` keeps an image on the
  board without letting it steer; `--include` undoes that. `--remove` takes
  an image off the board (its file stays).
- Any change but a rename clears the analysis. Run `analyze` again before
  you use the board.
- Without `--project` a board belongs to no project, so every project can
  use it.
- `--json` on any of them prints the board as JSON.

## Watch and answer the person

```bash
nebula watch --once            # wait for the next change on the canvas
nebula pins                    # notes the person pinned for agents
nebula pin resolve <pin-id> --say "Warmed the grade on n7"
nebula point n4 --say "Trying a tighter crop here"
```

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
2. Never `nebula clear` a canvas you didn't make. Use a new project.
3. Check ports with `nebula info` before wiring.
4. Spending is the person's own money with their providers. Stay inside
   their limits and propose anything bigger.
5. Canvas edits can be undone, so when the person gives you room, use it.
   Ask before anything that can't be undone.
