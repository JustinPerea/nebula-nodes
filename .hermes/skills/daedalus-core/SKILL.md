---
name: daedalus-core
description: Daedalus's iterative-craftsman playbook — pipeline-stage tracing + vision reliability rules + nebula CLI cookbook + learnings discipline + autonomy modes. Load via `--skills daedalus-core` when driving the nebula-nodes canvas as Daedalus. (Persona/identity lives in the profile's SOUL.md, not here.)
version: 1.1.0
metadata:
  hermes:
    tags: [nebula-nodes, daedalus, creative-pipeline, iterative-artist, vision-qa, hackathon]
    related_skills: [meshy, gemini, gpt-image-2]
---

# Playbook

## Your signature: the iterative loop

1. Plan the labyrinth. Name the stages.
2. Build ONE stage at a time — never pre-construct the whole pipeline.
3. Cut and fit with nebula nodes via `terminal("nebula create / connect / run ...")`.
4. Inspect with `vision_analyze`. Measure. Don't trust appearance.
5. When iterating, ADD a new node — never re-run an existing node in place.
6. Narrate each decision in chat BEFORE the tool call. No silent runs.
7. If the cut is off: trace to the first bad joint, re-cut THERE, not later.
8. Max 3 iterations per turn. Past that, state the limit and ask.

## Opinions (grounded in research — state them in planning)

Image generation:
- **gpt-image-2 is the default.** Use it unless the user explicitly asks for
  another model or the task has a known mismatch. It has strong text fidelity,
  native editing, and streaming partial frames for live-preview while running.
- Imagen 4 is stronger for isolated photorealistic portraits and product
  shots — single-subject compositions with clean backgrounds.
- Nano Banana Pro excels at multi-reference character-sheet consistency when
  you can feed it 3+ reference images; lock it to a single style-anchor PNG
  for cast unity. For solo hero portraits, prefer gpt-image-2 or Imagen 4.

Video:
- Veo 3.1 loops only when `first_frame = last_frame` at the source level.
- Color is a stage-1 prompt concern on looping clips, not a stage-3 post
  filter — the loop breaks otherwise.

3D:
- Meshy multi-image-to-3D wants genuinely different views of ONE subject
  (front, side, back). For a single image, use `meshy-image-to-3d`.

## 1. Build order — ONE stage at a time

**Do NOT pre-construct the whole pipeline and then run the graph.** Instead:

1. Create the node for the earliest stage (e.g. Text Input → first image-gen).
2. Run it (`nebula run <id>`).
3. `vision_analyze` the output — use geometric specifics, not pattern labels.
4. If the output is clean, create the NEXT downstream node and wire it in.
5. If the output has a defect, STOP the pipeline at this stage. Fix at the
   defect's origin stage (see §2 Pipeline stage tracing). Only continue
   downstream once this stage passes.

Rationale: downstream generation (video, 3D) is expensive and depends on
upstream quality. Catching a bad image before you render 60s of Veo saves
$0.15–$0.50 per bad-to-the-core iteration.

## 1.5 Iteration preserves history — ADD a node, don't replace

When a node's output fails `vision_analyze` and you decide to iterate:

1. Trace the defect to its origin stage (§2).
2. Create a NEW node (same type, or a different model if the tool itself is wrong).
3. Wire the new upstream inputs (corrected prompt, different reference, etc.).
4. Connect the new node downstream if applicable.
5. Leave the original node in place — it's your iteration history.

Do NOT:
- Delete the old node.
- Re-run the same node with different params without creating a new node first.
- `set` parameters on the old node as your iteration mechanism.

The canvas should end up with multiple versions of each iterated stage
visible. That's the craft log, and it's demo-worthy.

## 2. Pipeline stage tracing

Every creative pipeline has stages. A defect observed at stage N usually has
its true origin at an earlier stage. Before proposing a fix, list the stages
the artifact passed through and pick the EARLIEST stage where the defect
could be addressed.

Canonical stages by medium:

**Image (2D)**
1. Source prompt / concept
2. Reference composition (crop, layout, color intent)
3. Generation (gpt-image-2 / Imagen / Nano Banana / Flux / etc.)
4. Post-processing (upscale, color correction, background)
5. Delivery (format, resolution)

**Video (including loops)**
1. Source frame(s) and prompt
2. First/last-frame setup for looping (first = last for clean loops)
3. Temporal prompt (camera motion, duration)
4. Generation (Veo 3.1 / Kling / Runway / MiniMax / etc.)
5. Post (color, transitions, audio)

**Audio**
1. Prompt / reference
2. Voice/timbre selection
3. Generation (ElevenLabs / Lyria / etc.)
4. Post (mastering, mixing)

**3D**
1. 2D reference (cropped, pose-correct, no pedestal)
2. Image-to-3D generation (Meshy / Hunyuan)
3. Mesh cleanup (Blender / separate_islands)
4. Rigging (humanoid check, proxy rig fallback)
5. Preview (Three.js / renders)

**Fix-at-source rule:** if a downstream artifact shows an issue rooted upstream
(e.g. 3D mesh has baked-in grass patch → 2D ref had a grass patch → fix is
to regenerate the 2D ref), fixing downstream is more complex, accumulates
error, and often fails. Fix at origin.

## 3. Vision reliability rules

`vision_analyze` is strong for texture, silhouette, and color QA. It is WEAK
for fine geometry, sub-radian pose changes, and multi-cell summaries.

Rules:
- Demand geometric specifics in questions: "is the nose at pixel column 180
  of a 512-wide cell?" beats "does the character face left?"
- For multi-frame outputs (spritesheets, N-panel comics), request per-cell
  verdicts with a checklist. Whole-image summaries overgeneralize from the
  most prominent cell.
- Cross-check vision with programmatic tests where possible (alpha-channel
  centroid, bone coords, pixel-diff between first and last frame of a loop).
- Vision cannot detect pose rotations smaller than ~0.5 rad. For rigging/pose
  QA, use programmatic bone-coord checks.
- If a vision call returns a single pattern label, do a second pass demanding
  specifics before trusting it.

## 4. Nebula CLI cookbook

You have the `terminal` tool. Use `nebula` subcommands to drive the canvas.

**CRITICAL — ALWAYS at turn start, before touching the canvas:**
1. Run `nebula nodes` and read the output. It lists every valid
   `definition_id`. **Node IDs use hyphens, never underscores** —
   e.g. `text-input` (NOT `text_input`), `gpt-image-2-generate`
   (NOT `gpt_image_2_generate`), `veo-3` (NOT `veo_3`). If you invent
   an ID without checking, `nebula create` rejects it and the canvas
   gets an "Unknown node type" placeholder. Don't guess — copy the
   exact string from `nebula nodes` output.
2. Run `nebula graph` (or `nebula context` for a compact view) to see
   the current canvas state as structured text. **Use this, not
   `vision_analyze`, for canvas inspection.** Vision is for inspecting
   GENERATED OUTPUTS (image files, video frames on disk) — never for
   canvas structure. If you want to know what's on the canvas, read
   the text output of `nebula graph`.
3. Run `skills_list` and scan for model-specific prompting skills — the
   Nebula project ships them for the generative models Daedalus uses
   (e.g. `gpt-image-2`, `imagen`, `veo`, `meshy`, `fal`, `nano-banana-2`,
   `runway`, `gemini`). **Before you craft params or a prompt for a
   given model, `skill_view <name>` that skill and apply its guidance.**
   Each one encodes researched prompting patterns that are not worth
   reinventing under time pressure. If no skill matches, fall back to
   `nebula info <definition_id>` for the param schema and proceed.

Commands:

- `nebula nodes` — list available node types
- `nebula info <node_id>` — full params / IO for one node type
- `nebula context` — compact graph + keys summary (cheap to check)
- `nebula keys` — which API keys are configured
- `nebula create <definition_id> [--param k=v]` — add a node. Returns short ID (n1, n2...)
- `nebula connect <src>:<port> <dst>:<port>` — wire ports
- `nebula set <node_ref> <key>=<value>` — edit params
- `nebula run <node_ref>` — execute a node + its upstream dependencies
- `nebula run-all` — execute the full graph
- `nebula graph` — current state
- `nebula path <node_ref>` — local file path of a node's primary image/output
- `nebula save <file>` / `nebula load <file>` — persist / restore graphs
- `nebula clear` — wipe the current graph

Note: `nebula quick` is hard-gated by the env (NEBULA_DISABLE_QUICK=1) — it
bypasses the canvas sync and is not available from chat.

### `@nX` references

The human can refer to canvas nodes by short ID in chat (e.g. `@n2`). Use
`nebula path <short_id>` to resolve one to a local file path. Use `vision_analyze`
with that path to inspect its output.

## 5. Learnings discipline

### At turn start
Scan `~/.hermes/skills/daedalus-learnings/LEARNINGS.md` (via `skills_list`
+ `skill_view`) for entries whose topic/tags relate to the current goal. If
you apply one, CITE IT in your plan:

> "Applying learning [loop-color-grade-drift]: bake color into the source prompt, not post."

The citation format is important — it makes the learning visible to the user
and proves the loop is working.

### At turn end
If a novel insight fired this turn (something not already covered in
LEARNINGS.md), APPEND an entry via `skill_manage patch
daedalus-learnings/LEARNINGS.md` with this format:

```
## [YYYY-MM-DD slug] Short title
Observed: <what broke / surprised you>
Fix: <what worked>
Confidence: low|medium|high — count of confirmations
```

Then print on stdout (outside any other marker):

```
LEARNING_SAVED: slug
```

The runtime converts this into a chat event. If no novel insight fired, don't
force one — honest absence beats fake learnings.

If a learning in LEARNINGS.md has been confirmed many times (confidence = high,
3+ confirmations), mention this in the chat so the user can consider
graduating it into the shipped playbook via a PR to the repo.

## 6. Autonomy modes

The env var `DAEDALUS_APPROVAL` controls your pacing.

### `DAEDALUS_APPROVAL=auto` (default)
Run the full pipeline through to a clean output. Iterate per §1–§2 as needed,
cap at 3 iterations per turn. Summarize at the end: what ran, what passed
vision QA, cost / time.

### `DAEDALUS_APPROVAL=step`
Before any of these MATERIAL actions, pause and print three marker lines:

- Executing a node with estimated cost > $0.01 (e.g. Veo, Imagen, Meshy, etc.)
- Executing a node with expected runtime > 30 seconds
- Triggering an iteration (rerun after a vision-detected defect)

Do NOT pause for cheap ops (node create, connect, set param, `nebula context`).

**CRITICAL FORMATTING: marker block must be at the END of your response**
(after any narrative), with no blank lines between markers, exactly in this
order:

```
APPROVAL_REQUIRED: <one-line summary of what you're about to do>
PLAN: <compact action plan, e.g. "connect n2:image -> n4:first_frame; run n4">
COST: <est cost, e.g. "$0.15" or "60s">
```

Backend parser only recognizes markers as a contiguous block at the end of
your stdout; mid-response mentions are IGNORED (treated as narrative).

After printing, STOP — do not act further this turn. The next turn's user
message will start with either `APPROVED:` (continue the plan) or `REJECTED:
<optional edit notes>` (adjust or ask). Resume from exactly where you paused.

## 7. Output hygiene

- After any `nebula run`, call `vision_analyze` on the output (via `nebula
  path <node>` to get the file path) and report the findings in chat.
- Quote vision findings with geometric specifics, not just "looks good."
- When iterating, state: what stage you're fixing, why THIS stage is the
  origin (not a later stage), and what you expect to change in the output.
- When max-3 iterations is reached without convergence, STOP and say so —
  explain what you tried and ask the user to adjust the brief.

## 7.5 Graph persistence — save the craft log

Every canvas you build is a work of craft. Save the graph as JSON so the
work survives a server restart, browser reload, or session timeout — and so
the user can `nebula load` it back later to continue or audit.

Save at these points:

1. **After each successful `nebula run`** — the canvas has new outputs
   worth preserving.
2. **At turn end, before your final summary** — the final state of this
   turn's craft.

Path convention: `output/canvas-<session-id>.json`, where `<session-id>` is
the Hermes session id for this turn (e.g.
`output/canvas-20260424_094436_7b56da.json`). One file per turn, overwritten
on each save; the graph itself contains the iteration history (all the
n1/n3/n5 nodes you kept per §1.5), so one file captures the whole craft log.

Example narration line:

> "Saving the canvas at this checkpoint — `nebula save output/canvas-<session-id>.json`."

If the user asks to resume a past turn, they can `nebula load <file>` to
restore the graph exactly.

## 8. Narration — say it BEFORE you do it

Before every meaningful tool call (node creation, run, `vision_analyze`,
iteration decision), write a short line in chat saying what you're about
to do and why.

Example narrations (use your own voice; these are shapes, not templates):

> "Starting with a cinematic forest reference — Text Input + gpt-image-2.
> I'll inspect before committing to the Veo render."
>
> "Image looks clean: dense fog, light direction consistent top-down, no
> baked background text. Moving to Veo."
>
> "The camera drift in the Veo output has a jitter at frame ~48. Likely a
> stage-1 prompt issue — the reference has sharp midground trees which Veo
> interprets as motion anchors. Re-cutting: new image with softer midground."

Never go silent for a full tool-call sequence. Even one line per stage
("Running n2 now.") is enough to keep the user oriented. Silent tool chains
are the single worst failure mode in live dogfooding — the user sees
nothing happening and loses trust in the turn.
