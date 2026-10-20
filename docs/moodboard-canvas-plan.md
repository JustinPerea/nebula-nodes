# Moodboard canvas (item 6), looks and moodboard adapters: build plan

Version 2, 2026-10-19. Version 1 (the canvas plan, `docs/moodboard-canvas-plan.md` on `feat/moodboard-canvas`) was merged from two independent plans against main `12257250`. Version 2 adds Justin's nine answers on "Moodboards into every node" (A1-A5, B1-B4, all "a)", relayed by GM - Design: "Go with your recs"). A4 settles per-look briefs: yes. Section 10 lists what was not verified.

Checked read only against:

- main `12257250` (line numbers are from it unless marked);
- PR1 (`8e14de37` golden file, `67702064` board model v2, `ea2f04d2` docs, `4af99c84` review fixes), merged into main as #87 (`e5072eb2`) on 2026-10-19 with Justin's OK;
- `fix/moodboard-brief-precedence` (#18): implemented in `e457b51d` (2026-10-19 16:29, "Moodboard brief conflicts: colour-word check, clash modes, notes on opt-in"), not merged yet. This plan is rebased on that commit. Its names are checked in its code: board fields `clashMode` (`CLASH_MODES` = leave-out, flag, no-measured, keep-all), `colorChoices` (`{keep, leaveOut}`), `sendNotes`, `colorCheck` (saved when its basis moves); the node param `send_notes` on `nebula-moodboard` with `NODE_NOTES_CHOICES` = board / yes / no; functions `colour_check_basis`, `refresh_colour_check`, `current_colour_check`, `generator_analysis`. It takes contract 07 §1.11;
- the research note `Research/topics/moodboard-image-adapters-2026-10.md` (vendor pages fetched 2026-10-19). In this plan, **(r)** means "from the research note only", and **(u)** means "unverified: not in the code or the note".

What changed from version 1:

- One brief per look is in scope (§4.11, PR7b to PR7d). Frames are no longer organize-only, and `placement.weight` now steers a look.
- A new shared layer, moodboard adapters (§5.7), decides how each node takes a board. Twelve new PRs (PR13 to PR24) build it.
- Q4 and Q12 are reworded. Q18 to Q28 are new; Q22 and Q23 turned out to be already answered (§7.2).
- Version 2.1 (same day) fixes what a critic found in version 2: §10.3 lists each point and what changed.
- Version 2.2 (2026-10-20) adds Analyze as an overseer (GM's mockup v5): the reader's trace (§5.6.1), Q29 (§7.3), the new PR10b, and a checker's corrections (§10.4).
- Version 2.3 (same day) records Justin's Q29 answer, c): the readings plus a dimmer "thinking (summary)" stream, optional per model, which falls back to b) when a model gives no summaries.

---

## 1. Summary

Moodboard Studio's image grid becomes a second React Flow canvas (C1), with a List view that keeps today's grid (C6). Each reference is a card whose size is its weight (C2). One "Set aside" switch dims a card: it is still read for colours but never steers (C3). Looks are frames that you draw and name (C4). One image can sit in several frames as linked copies, each with its own weight (C13). Numbers stay in add order (C7). New references land in free space (C8). Agents see and edit the board the way they see and edit the main canvas: a view report, a picture, checked edits with a cursor, and your recent edits before each turn (C9). An Analyze button reads references with a vision model you pick, shows the price first, and sorts them into frames as a first draft you then edit (C10 to C13).

Two things join the plan:

- **One brief per look (A4).** Each look gets its own analysis and brief, measured from its own cards at their own sizes. A Moodboard node sends one look: its images and its brief. "Whole board" stays an option, and it is exactly today's output. A look can use the board's Direction and Avoid or have its own.
- **Moodboard adapters (A1 to A5, B1 to B4).** One table says, for every node, how it takes a board: which input gets images, how many, in what order, what the prompt says about them, and what never gets them (a first frame, an image being edited, 3D views). Style slots (Krea 2, Ideogram style references, Runway gen4 untagged images, and the Krea `style_images` fields a source shows are style-only: Seedream 4, Ideogram 3, Runway gen-4) get board images by default. Content slots (GPT Image, Gemini, FLUX, Seedream, Krea 3, and every Krea field whose meaning is unverified) get the text brief by default, with a "Send board images" switch that warns about copying. Video reference slots get images; first frames never do, though you can pick a board image as one. Lyria gets images and a short music direction (and no visual brief). Text-only music and text-to-video nodes get text. 3D gets text, and Meshy gets one texture image. Then palette as data, Avoid into negative-prompt fields, and an aspect from the references. A contract test refuses a Moodboard port without an entry.

The plan does this in 27 PRs, in three lanes:

- **Canvas (PR1 to PR12).** The first four retire the riskiest unknowns before any canvas UI exists:
  - **Old boards and lost writes (PR1, PR3).** Today every save replaces the whole `images` list, last write wins. PR1 makes writes lossless and gives old boards a layout without rewriting them. PR3 adds checked, atomic board edits, so a person's drag and an agent's add can't overwrite each other.
  - **What set aside does to the analysis (PR2).** It's small and pinned by tests, so it goes early.
  - **Model quality and price (PR4).** This is a dry run Justin can try on his real board from the CLI before any Analyze UI is built.
- **Looks (PR7b, PR7c, PR7d)**, after frames exist (PR7) and #18 has merged.
- **Adapters (PR13 to PR24)**, after #18 merges, beside the canvas lane. PR13 and PR14 build all the shared machinery; PR15 to PR21 then mostly add table entries and ports. Adapters read `bundle.images` and never need to know about looks, so they don't wait for PR7d. Once PR7d lands, every adapter gets one look's images with no change of its own.

A usable canvas arrives with PR6. Board images reach GPT Image edits and Nano Banana (behind the switch) with PR14, and style slots by default with PR15. Main stays releasable after every PR: each one either changes nothing you can see, or ships a complete feature.

Out of scope: Avoid as an area on the canvas (C5), the reading feeding the visual brief (analysis option 1; B1's music direction is the one exception), collage as a default anywhere (the comparison favoured separate references), a trained style (LoRA) per look, the reader-based clash check for #18, and GM's later ideas. See §8.

---

## 2. Decisions, mapped to code

### 2.1 Canvas (C1 to C13)

| Call | Justin's answer | What it means in code |
|---|---|---|
| C1 | React Flow, a second canvas in the Studio | `BoardCanvas` gets its **own** `<ReactFlowProvider>`. App's single provider (`App.tsx:272`) wraps every view, so without its own provider the board would share the main canvas's store. The board never touches `graphStore`, `uiStore.canvasZoomedOut`, `uiStore.canvasViewport` or `publishCanvasSelection`. |
| C2 | Size sets weight; full weight is a fixed area | A placement's weight is `area / FULL_AREA`, capped at 1. Each card's weight depends only on its own area. The roll-up already divides by total weight (`_roll_up`, `moodboard_analysis.py:524`), so resizing one card changes only shares, never another card's weight. |
| C3 | One "Set aside" switch: dims, keeps size and place, still read, never steers | The stored key stays `excluded`, and its meaning changes from "not read" to "read, never steers". Weight-0 images also show as set aside. Analysis version 5 measures set-aside images. The steering outputs stay byte-identical. Set aside is one switch per image, so it applies in every look. See §4.4. |
| C4 | Only frames you draw and name are looks | Membership is explicit: a placement's `frameId`, written when a card is dropped into a frame or by an op. It is never inferred from position on read. |
| C5 | Later | Nothing is built. See §8. |
| C6 | Badges on the card; side panel for the selected reference; List view for bulk edits | Badges: `#n · w`, a dot per note, and a set-aside dim. The side panel holds the steering note, the private note, `ImageColors` and, from PR10, the reading. Today's grid (`MoodboardStudioView.tsx:554-610`) moves unchanged into `MoodboardListView`. |
| C7 | Numbered in add order; moving never renumbers | `#n` stays `index + 1` in `images[]`. **No canvas operation ever reorders `images[]`**: drag, frames, arrange, Analyze and undo all leave it alone. Removing a reference still renumbers the ones after it; the decision page's C7 "why" says so ("as today. Ids work everywhere for anything that has to be exact"). So there is no number field and no counter. Undoing a removal puts the image back at its old index, which restores its number. A look keeps the board's numbers (§4.11). |
| C8 | Free space next to the view, else after the last; `--at`, `--in`, `--size`; `arrange --by look\|colour\|weight` | `moodboard_layout.place()` runs on the server only, so the CLI, MCP and Studio drops all land the same way. The view report (PR8) says what's in view. Arrange is a server-computed layout applied as one op batch (PR12). |
| C9 | The canvas agent model on the board | `GET /api/moodboards/{id}/look`, `GET …/picture`, `POST …/edits` (checked, atomic, with a cursor), `board.*` journal kinds, and a "Since your last turn" block in each runner. |
| C10 | Analyze sorts the selection, or the whole board; the result is an editable draft; your edits are signals; the price shows first | A new reader, `services/moodboard_reader.py`, works in two phases: per-image reading, then one sort call. Its result is applied as one edit batch from the reader (actor kind `reader`, with the model's name and colour, and `requestedBy`; §5.6.1). Gating: the person confirms above `runCostConfirmUsd`, and agents go through `agent_spend.decide`. |
| C11 | Nothing selected: keep what you placed or renamed, and sort only new and Unsorted. A selection: read those again | Decided by `placedBy` on each placement, `namedBy` on each frame, and `readings[imageId].url`. |
| C12 | b) A re-analyze may move a reference you placed, if you selected it; one Undo puts it back | When an image is selected, the sort may move its placement even if `placedBy` is `"person"`. The whole run is one undo step. |
| C13 | Linked copies, shared reading and notes, weight per frame, suggest a second look and never add one silently, hybrid frames | Several placements per image, at most one per frame. Second looks and hybrids are stored as `suggestions[]` and become memberships only when you accept them. **Per-frame weight is read by the look's analysis and the look's bundle** (§4.11), so Krea strengths and every adapter's order follow the card's size in that look. |

### 2.2 Moodboards into every node (A1 to A5, B1 to B4)

Answered 2026-10-19, all a).

| Call | Justin's answer | What it means in code |
|---|---|---|
| A1 | Style-slot models get board images by default. Content-slot models get the text brief by default, with a per-node "Send board images" switch that warns about copying. | Each adapter entry has `default: "images" \| "text" \| "never"`. A hidden param `_boardImages` (`on` / `off`; absent = the entry's default) overrides it per node (§5.7.8). **Style slots, images by default:** Krea 2 (and its Krea catalog variants), Ideogram v3 `style_reference_images`, Runway gen4 image (untagged = style (r)), and the Krea catalog style fields a source shows are style-only: Seedream 4 `style_images` (native strength (r)), Ideogram 3 `style_images`, Runway gen-4 `reference_images`. **Content slots, text by default:** GPT Image, Gemini (Nano Banana), FLUX 3, Seedream, Krea 3, the Krea copies of these, and every other Krea `style_images` field (Seedream 5, Flux dev, Kontext dev, Qwen, Z Image, UNI-1, Muse, Grok Imagine 2). Krea calling a field `style_images` doesn't show the model treats it as style, and A1 names FLUX and Seedream as content. An entry moves to images by default only when a source, or a mocked run followed by one paid run Justin approves, shows the field is style-only. Recraft has no image slot in Nebula today (Q24). |
| A2 | On models without a weight: the heaviest images fill the cap after any image you wired in; they go in weight order; the prompt names each image's role and strength. | One planner, `plan_board_fill` (§5.7.4): wired values first, then the scope's steering images that its analysis could read, heaviest first (board number on ties), up to the slot's limit for the active route and model, minus wired. One legend line in the model's own syntax ("Image 3: style reference, strong"). An entry with no legend must say why (`syntaxReason`): Runway gen4, where naming an image means tagging it, which makes it a subject; Krea 2 and Krea Seedream 4, whose weights are native. Image notes never go in the legend unless notes are opted in (#18). |
| A3 | "Combine into one image" is an adapter option only where the single input is a reference: top 6 to 9 images, tile area by weight, a minimum tile size, neutral gutters, one look per collage, a "don't copy the layout" line. Not a default until the paid comparison. | `collage: true` is allowed only on an entry whose slot has `max: 1` and is a reference (never in `never`, never an edit target or frame). The contract test enforces it. Candidates: `flux-1-1-ultra` `image`, Krea Z Image and Flux Kontext dev `style_images` (limit 1), the future Meshy texture image. PR23 builds it as a per-node option. No entry sets it as the default. GM's paid comparison (2026-10-19, Justin approved, about $1.01) found separate references better than a collage (§8). |
| A4 | One look per node, picked on the node, defaulting to the heaviest look; images and its own brief come from that look only; "Whole board" stays an option. | Per-look analysis and brief (§4.11, PR7b). The Moodboard node gets a `look` param (Q18, Q19; PR7d). The bundle for a look carries only that look's images, at their card weights, and that look's brief. Adapters read the bundle and stay unaware of looks. |
| A5 | A node can't have a Moodboard port without an adapter entry; a contract test enforces it; "text only" is a valid explicit entry. | `backend/data/moodboard_adapters.json` (hand-written) plus `moodboard_adapters_krea.json` (written by `scripts/sync-krea-catalog.py`). `scripts/check-node-contracts.mjs` and `backend/tests/test_moodboard_adapters.py` check both ways (§5.7.10), including that every image input of a node with an entry is classified. PR13 declares every existing Moodboard-port node. |
| B1 | Lyria gets the look's top images, plus a short music direction the reader writes from the look, shown on the node and editable. | `lyria-3` gets a Moodboard port and a `music` entry. Its text is the music direction only: no visual brief, Avoid or negatives (a hex palette means nothing to a music model). The music direction is stored once per scope (`lookFields[F].musicDirection`, or the board's `musicDirection` for Whole board), shown and editable on the Lyria node. A plain legend says which image sets the main mood. The reader drafts it on request (Q25, PR19), from the scope's images, readings and Direction, with notes only when notes are opted in. It is the one reader output that reaches a generator. Text-only music nodes (`elevenlabs-music`, `stable-audio-25`, `ace-step`, the Krea ElevenLabs Music and Seed Audio nodes) get a port and the music direction as text. |
| B2 | Video reference slots get the look's top images; a first frame is never filled from the board automatically. | Every Image or Any input of a video node is classified in its entry as a slot, `never` or `needsWired`; the contract test fails if one is left out. Reference slots (`reference_images`, `style_references`, Kling O3 `images`, Seedance R2V `images`, Krea Veo 3.1 `reference_images`) get images by default, as decided, including Veo's "asset" references with the 8 s rule and a face warning. "Use #n as the first frame" on the node's Moodboard row is the "pick one" half: it adds a wired Image Input, an undoable graph edit, never an automatic fill. Text-to-video nodes get the brief and negatives. |
| B3 | 3D never takes board images as geometry views; only Meshy's texture input gets a style image; palette and materials go in as text. | Multi-view inputs get `channel: "views"` with no fill. Meshy gets a new `texture_image` port (no node has one today). The palette and materials sentence goes to `texture_prompt` where the route has one (`textSlot`). |
| B4 | After images: palette as data for models with a colour control, and Avoid into negative-prompt fields; then an aspect default from the references. A trained style (LoRA) per look is a later, separate project. | PR14 builds the hooks: the negative field resolved from the active route's params (`has_negative_field` reads `definition["params"]` only today) and a palette-param step. PR21 declares them on real nodes: Avoid into `negative_prompt` wherever a route has one, and the scope's palette into Recraft's `colors` / `background_color`. PR22: an aspect from the references, written into the node's aspect param as a graph edit when a board is wired or its look changes, never at run time (Q27). LoRA per look is out of scope (§8). |

---

## 3. Facts in the code that shape the plan

These were checked in the code. Some of them correct the subsystem maps, the readers' notes or one of the two original plans.

### 3.1 Board store and canvas (version 1, still true)

- **`_normalize_images` drops unknown keys** (`moodboard_store.py:119-143`), and `MoodboardImageModel` is `extra="forbid"` (`main.py:10547`). Every new image field needs both changed. (PR1 has done this on the branch for `placements`.)
- **A PUT turns a missing key into its default.** The route calls `img.model_dump()` (`main.py:10890-10891`), so a client that leaves out `privateNote` erases it today. Merging by id needs `model_dump(exclude_unset=True)`.
- **The CLI and MCP send back what they read.** `update_board` and `add_to_board` re-PUT the images they got from GET (`moodboard_client.py:538-552`, `:700-740`). Once GET returns `placements`, the image model must accept them, or every `nebula moodboard set` returns a 422.
- **The CLI's "did this steer?" check would clear the analysis on any layout change.** `moodboard_client._steering` (`:833`) compares every key except `privateNote`, and the Studio's `updateImage` does the same (`MoodboardStudioView.tsx:272-280`). Both need an explicit list of steering keys: `url, weight, notes, excluded`.
- **New fields would leak into node outputs.** `handlers/moodboard.py:61-64` copies every image key into `bundle.images`. That list needs a whitelist.
- **The Studio doesn't follow outside edits.** It only relists the rail on `storedAssetChanged` (`MoodboardStudioView.tsx:708`). Its autosave sends the whole draft 600 ms after a change (`:233-236`), so a CLI add made while the board is open is overwritten.
- **`version` is a write counter that nothing compares** (`moodboard_store.py:387`). It becomes the compare-and-set token.
- **`excluded` and weight 0 differ today.** Excluded images are skipped before measuring (`moodboard_analysis.py:145, 155-157`). Weight-0 images are measured but don't steer (`:122-129, 197`). `rank_representative_images` already skips both (`:359-385`), ranks heaviest first with board order on ties, and dedupes by URL.
- **`source_hash` already includes `excluded`** (`:448-472`). If `excluded` becomes the set-aside switch, the hash payload doesn't change, so every saved analysis and every hand-written brief's basis (`brief_basis`, `moodboard_brief.py:186`) stays current. Layout fields stay out of the hash.
- **The defaults pin covers per-image colours.** `pinned_view` includes `imageColors` for every entry in `analysis.images` (`test_moodboard_defaults_pin.py:~110`), and the pinned "brand" board has an excluded image. Under C3 that image gains a colour entry. See §4.4 and Q7.
- **The summary counts only non-excluded images** (`_summary(mode, len(images), …)`, `:220`). It keeps counting only references that aren't set aside.
- **Pricing keys must be node definitions.** `validate_pricing` refuses an entry with no node definition (`model_pricing.py:196-198`), and `test_model_pricing.py:39` checks the real table. A `moodboard-read` pricing entry would fail that check, so the reader prices itself (§5.6).
- **There is a precedent for token-priced vision requests.** `qc-camera-geometry` (`model_pricing.json:12128`) prices one request as a `[low, high]` range, with a live token probe written into its notes.
- **The journal accepts a group name.** `kinds` filtering accepts the part before the dot (`EVENT_GROUPS`, `canvas_events.py:80`), so `board.*` kinds get `kinds=board` for free. The ring holds 500 events (`:41`), shared with the graph, so board batches must journal one event per batch.
- **The MCP instructions test** (`test_mcp_tools.py:~280`) fails if `INSTRUCTIONS` names a `snake_case` word that isn't a tool. That rules out a journal kind named `board.set_aside`; it is `board.setAside`.
- **React Flow 12.10.2** ships `NodeResizer`/`NodeResizeControl` and `onlyRenderVisibleElements`, and its viewport moves take an `ease` function (`@xyflow/system` `types/general.d.ts:140, 182`).
- **Uploads already get thumbnails.** Studio and CLI uploads land at `/api/outputs/chat-uploads/…` (`main.py:2432`), and `serve_output(rel, thumb)` serves 512 px thumbnails (`main.py:11565`, `output_thumbnail.py:26`).
- **The tab echo rule can be reused as is.** `_graph_edit_origin` (`main.py:6304`) gives `{actor, tab}` and trusts the tab only with the person token. The Studio's `apiFetch` already sends `X-Nebula-Tab` on every write (`lib/backend.ts:321`).
- **`FORjustin.md` is gitignored** (`.gitignore:60`) and lives in the main checkout, where the coordinating session appends to it after each PR. Builders never create it in the repo. `implementation-notes.md` exists at the root. Contract 07 (`docs/contracts/07-studios-and-resources.md`) uses sections 1.1 to 1.10 on main, and #18 adds §1.11 ("When the words and the measured colours disagree, and board notes"). This plan's new sections start at §1.12, one per subject: §1.12 board edits (PR3), §1.13 reading references (PR4, PR10), §1.14 the canvas: size, weight, frames (PR6, PR7), §1.15 looks (PR7b to PR7d), §1.16 moodboard adapters (PR13 to PR24).

### 3.2 Looks (new)

- **Images are numbered by their place in the list.** `analyze_moodboard` numbers each image by its position among all images (`moodboard_analysis.py:140-143`), reads `img.weight` (`:162`) and hashes the whole `images[]` list (`source_hash`, `:448-472`). A look's analysis must keep the board's numbers, use `placement.weight`, and must not change the whole-board hash payload, or the golden file breaks.
- **Krea 2 reads three places in the bundle.** It takes `analysis.providerHints.krea.representativeImages` first, then `representativeImages`, then ranks `images` itself (`handlers/krea.py:381-386`). It looks each URL's weight up in `images` and uses **1.0 for a URL it can't find** (`:387-391`). Strength = `board.strength × weight`, clamped to 0..1, filling `10 − wired`. So a look bundle makes Krea's strengths follow the look with no Krea handler change **only if all three places hold the look's images**: a whole-board `providerHints` left in a look bundle would send the whole board's top 10, mostly at full strength (§4.11.8).
- **The Moodboard node has two settings after #18.** `nebula-moodboard` has `moodboard`, picked through `StoredAssetPicker` (`Inspector.tsx:631`, which handles only `moodboard` and `character`), and #18's `send_notes` (board / yes / no, `NODE_NOTES_CHOICES`). Its plain outputs (`style_brief`, `palette`, `representative_images`) can each describe only one scope.
- **#18's bundle carries a generator view of the analysis.** `handlers/moodboard.py` (on `e457b51d`) sets `analysis = generator_analysis(board, analysis, brief)`: keywords and summary without notes unless sent, colour sentences without left-out colours. It counts every non-excluded board image for the summary. The bundle then carries `analysis: {**analysis, providerHints}` and `providerHints` at the top level.
- **#18's colour check keeps itself current by basis.** `colour_check_basis` hashes Direction, Avoid, the "must appear" pins, the measured colours and the lexicon version. `refresh_colour_check` runs on every store create and update and saves a new check when the basis moved; `current_colour_check` checks in memory when the saved one is stale. The check does not wait for Measure.
- **Its output is never cached.** `nebula-moodboard` is in `_READS_SAVED_RECORD` (`engine.py:273`), so every run reads the board again and can refresh a stale analysis in memory (`handlers/moodboard.py:50-60`).
- **Measurement is cached per file, 256 entries** (`_measure_file`, `functools.lru_cache(maxsize=256)`). Measuring the whole board and then each look one after the other would thrash it on a large board.
- **`with_brief` composes the brief for every board in `list()`.** Composing every look's brief there would multiply the cost of the board rail.
- **The hand-written brief has a person gate.** `_guard_override` (`moodboard_store.py:197`) refuses an agent's replace or remove of text the person wrote, because "the board keeps no history".

### 3.3 Generators and the board (new)

- **One choke point.** `engine.py:1201-1204` calls `apply_board_to_generator` (= `moodboard_brief.apply_to_generator`, `:355`) for every node. Today it only folds text: the brief into `prompt`, Avoid into the prompt for instruction-following models (`follows_instructions`, a prefix list at `:67-74`), and negatives into `negative_prompt`. The Moodboard port is then dropped, except for `_HANDLER_READS_BOARD = {"krea-2-generate"}` (`:82`).
- **It does nothing without a wired prompt.** `if not bundles or not isinstance(prompt, str) or not prompt.strip(): return passed_on, params` (`:368` on main, unchanged in #18), where `prompt` is the `prompt` **input**. A node with no prompt port (Meshy Image to 3D: only `image`; `texture_prompt` is a param) or a prompt typed into a param instead of wired (Krea catalog nodes have `prompt` both as an optional port and a param) gets no brief and no negatives today.
- **The analysis ranks only images it could read.** `rank_representative_images(images, only=analyzed_urls)` (`moodboard_analysis.py:207`), so Krea 2 never sends an external https URL or a file that failed to read. The golden boards include such images (`test_moodboard_golden.py` docstring: `prebrief_v2_edited`, `v3_current`, `v4_current_private`).
- **Step order in the engine.** `_local_media_inputs` (`engine.py:1194`, `:279-302`) turns `/api/outputs/...` refs into file paths **before** `apply_to_generator` runs. An image the adapter adds is still an `/api/outputs/...` ref unless the adapter passes it through `services/output.local_media_ref` (`output.py:448`, which also runs `require_allowed_path`). The cache key is built after (`engine.py:1205+`), so board images count toward it, which is right.
- **`has_board_port` needs `id == "moodboard"` and `dataType == "Moodboard"`** (`moodboard_brief.py:337-341`). Krea 2's `moodboard` port is `dataType: "Any"`, so the check skips it; it works only because of `_HANDLER_READS_BOARD`.
- **15 nodes have a Moodboard port** (counted in `node_definitions.json`): `gpt-image-1-generate`, `gpt-image-1-edit`, `gpt-image-1-5`, `gpt-image-1-5-edit`, `gpt-image-2-generate`, `gpt-image-2-edit`, `gpt-image-2-5-generate`, `gpt-image-2-5-edit`, `gpt-image-2-fal-generate`, `gpt-image-2-fal-edit`, `nano-banana`, `nano-banana-fal`, `nano-banana-fal-edit`, `fast-sdxl`, `flux-2-pro`. Seven take images (the edits and Nano Banana) but get only the text brief.
- **`has_negative_field` reads `definition["params"]` only** (`:331-334`). It misses `negative_prompt` in `falParams` (`veo-3`, `ideogram-remix`), `sharedParams` (`ideogram-character`) and route params (`krea-3`'s fal route).
- **Port `role` is a UI badge and is wrong for adapters.** `runway-video.image` says `style` but is sent as `promptImage`, the first frame (`runway.py:318`). `veo-3.image` says `subject` and is the first frame. Roles are advisory (`frontend/src/types/index.ts:86-90`, `lib/referenceRoles.ts`, badge at `ModelNode.tsx:512`). Adapter entries must name slots explicitly.
- **Cinema already has reference helpers.** `cinema/art_direction.py` has `append_reference_guidance` (`:108`, an "image N: role" legend after existing refs), `reference_cap_for` (`:138`, per-model caps) and `check_reference_cap` (`:177`). The adapter layer absorbs these rather than copying them.
- **Every estimate reads edges.** `model_pricing.wired_counts` (`:580`), `estimate_node` (`:417`), `estimate_run` (`:636`), `(references)` from `_REFERENCE_PORTS = ("images",)` (`:100`, `:375`). The frontend mirrors this in `lib/pricing.ts` and `lib/runScope.ts` (`wiredPorts`), held in step by `tests/fixtures/pricing_cases.json`. Route rules read the same counts (`node_route.py` `ports` rules, `with_wired_blockers`). A board fill adds no edge, so without a change a Krea 3 run with board images prices as `references = none`.
- **There is no shared upload helper.** Each handler turns a local path into what its provider takes: fal always a data URI with no size check (`fal_universal.py:52-70`), Runway a data URI up to 5 MB else an upload (`runway.py:155, 232-245`), Krea an asset upload (`krea.py:187-244`), Gemini and Lyria inline data (`google_gemini.py:431-447`), Meshy a data URI (`meshy.py:101, 341`), Replicate its files API (`replicate_model.py:106-121`), route-table clients a data URI (`route_clients.py:134-139`).
- **A face check exists.** `services/qc_metrics.detect_faces` (`:156`) runs OpenCV's frontal-face cascade; `opencv-python-headless` is already a dependency. It can't tell a photo from a painting and knows nothing about public figures.
- **The billing params.** `node_route.BILLING_PARAMS = ("_provider", "_kreaAuth")` (`:141`). `agent_params.internal_keys` (`agent_params.py:40-43`) refuses every other `_` param from agents ("is internal (the canvas keeps it)"), so any new hidden param an agent should set needs an explicit exception.
- **Unpriced nodes.** `model_pricing.json` has no row for `krea-2-generate`, `krea-image-krea-krea-2-medium`, `-large`, `-medium-turbo`, `krea-image-z-image-z-image`, `krea-image-alibaba-qwen-image-3`, `krea-image-luma-uni-1`, `ideogram-remix`, `-reframe`, `-replace-background`, `-edit`, `-character`, `krea-video-kling-kling-o1`, `krea-video-minimax-h3-max`, `gemini-omni-flash`, `krea-video-google-gemini-omni-flash` (1.0; 1.1 is priced), `kling-o3-ref`, `lyria-3`, the Meshy 3D nodes, `recraft-v4-raster`, `-svg` and `flux-1-1-ultra`. Agents with any USD limit are refused on unpriced nodes (`agent_spend.py:659-661`); the `plus` field shows a cost note but doesn't refuse.
- **Two more maker routes refuse frames plus references.** MiniMax H3 (`handlers/minimax_v2.py:99-101`: "takes either a start/end image or references ..., not both in one run"; `MAX_REFERENCE_IMAGES = 9` at `:42`), the source-direct route of `krea-video-minimax-hailuo-3` (`directRoute.translation: "krea-minimax-h3"`). Gemini Omni on Google (`execution/maker_routes_google.py:369-373`: "can't take a start image and references together"), the direct route of `krea-video-google-gemini-omni-flash-1-1`. On main, `krea-video-minimax-h3-max` and the 1.0 Omni node have no direct route; they run on Krea only. MiniMax's own page charges "First 5 images free; $0.04 per additional image" for H3 (quoted in `sync-krea-catalog.py:583`).
- **Node definitions drift.** The TS file and the JSON mirror are compared by id only (`check-node-contracts.mjs:556-565`); four nodes carry JSON-only fixes (AGENTS.md), two of them video targets (`veo-3`, `gemini-omni-flash`). Krea catalog nodes are generated by `scripts/sync-krea-catalog.py`, which also writes their pricing entries.
- **Two board readers already exist outside generators.** `lyria-3` sends images as inline parts with no count check (`google_gemini.py:414-447`). Seedance on BytePlus treats first frame, first+last frame and references as mutually exclusive (`maker_routes_byteplus_seedance.py:33-36`).

---

## 4. The board data model

### 4.1 Board fields (new)

| Field | Default | Limits | Meaning |
|---|---|---|---|
| `layoutVersion` | absent | `1` | Absent: an old board, laid out on read (§4.8). Stamped `1` by the first write that saves a layout. |
| `frames[]` | `[]` | ≤ 100; at most one `kind: "unsorted"`; names 1 to 60 characters, unique on the board ignoring case | `{id (12 hex), name, kind: "look"\|"unsorted", x, y, w, h, createdBy, namedBy: "person"\|"agent"\|"analyze", createdAt}`. Coordinates are absolute flow pixels, rounded to 1 px. `w, h` ≥ 160. Frames stay layout only; a look's words and analysis live in the maps below. |
| `suggestions[]` | `[]` | ≤ 200 | `{id, kind: "alsoIn"\|"hybrid", imageIds[], frameIds[], name?, reason (≤ 200), by: "analyze"\|"agent", runId, model? (the reader id, set when `by` is `analyze`; §5.6.1), status: "open"\|"dismissed", createdAt}`. Dismissed suggestions are kept so a re-analyze doesn't repeat them. The key is the kind plus the sorted ids. |
| `readings{}` | `{}` | one per image id, ≤ 2 KB each | `{model, at, url, readerVersion, medium, style, light, motifs[], looks: [{name, fit}], reason}`. `reason` is at most 120 characters, never names another image, and is the line the trace shows (§5.6.1). Written by Analyze only. Never in `source_hash`, `brief_basis`, `compose` or node outputs (analysis option 1 is unpicked). `url` makes a reading stale when the image's file changes. |
| `lastRead` | `null` | — | `{runId, model, at, imageIds, estimate: {low, high}, spent?, requestedBy?: {kind, name}, summary?: {sorted, looks, unsorted, couldntRead, newLooks, suggestions}}` |
| `lookFields{}` (PR7b) | absent | keyed by a frame id of kind `look`; ≤ 100 | The person's words for one look: `{direction?, avoid?, pins?: {mustAppear?, keepOut?}, briefOverride?, colorChoices?, musicDirection?}`. A missing field means "use the board's" (§4.11.5). Edited only through `look.set` / `look.inherit` ops. |
| `lookAnalyses{}` (PR7b) | absent | keyed by frame id | Derived, ignored if a client sends it: `{analysis, colorCheck}` (§4.11.2). `analysis` is written by Measure and Analyze; `colorCheck` also by any write that moves its basis (§4.11.3). |
| `lookAliases{}` (PR7b) | absent | ≤ 200 | `{oldFrameId: newFrameId}`, written by a merge so nodes saved on the old look follow it. Chains resolve, at most 8 steps. |
| `musicDirection` (PR18) | absent | text ≤ 600 | The Whole board's music direction: `{text, by: "person"\|"reader", model?, at, basis}`. Looks have their own in `lookFields`. Never in `source_hash`, `brief_basis` or `compose`. |

The look keys and `musicDirection` are written only when used. A board with no looks and no music direction never gets them, and nothing is written on read.

### 4.2 Image fields

Unchanged: `id, url, weight, notes, privateNote, excluded`. New: `placements[]` (PR1), and `realPerson` (PR17, if Q26 a).

```
placements: [{id, frameId: str|null, x, y, w, h, weight, placedBy: "person"|"agent"|"analyze", placedAt}]
realPerson: bool   # "This shows a real person"; default false; not steering; outside source_hash
```

Placement rules:

- 1 to 8 placements per image, and at most one per frame.
- `frameId: null` (loose) is allowed only when it is the image's only placement. "Loose" means in no look.
- Each placement is one card, and its `id` is the React Flow node id.
- Coordinates are absolute flow pixels. |x| and |y| are at most 1e6.
- `weight` is the per-frame weight (C13). `w × h = weight × FULL_AREA`, to within 1 px rounding. The server writes `w, h` from `weight` and the card's aspect ratio, and never recomputes them on read.
- Linked copies are several placements on one image record. Notes, the private note, the reading, the colours and `realPerson` live once, on the image.

### 4.3 Weight and size (C2)

- `FULL_AREA = 129_600` px², the area of a 480×270 card (Q1, answered). New drops in GM's mockup are 480×270.
- `MIN_WEIGHT = 0.05`, today's slider step (Q3, answered). A 16:9 card at that weight is about 107×60. Weight 0 can't be reached by size; Set aside covers it.
- Resizing is capped at full weight (Q2). A drag resize snaps to steps of 0.05 and keeps the aspect ratio. A weight set by the CLI or MCP is stored exactly (0.33 stays 0.33).
- **`image.weight` stays the Whole-board weight.** The whole-board analysis, `source_hash`, Krea strength on Whole board (`handlers/krea.py:387-397`), CLI `--weight` and the List view all keep reading it.
  - For a steering image, `image.weight` is the largest placement weight (Q4), so a double membership never counts twice in the whole-board roll-up.
  - A resize recomputes it.
  - A `weight` edit that doesn't come from a resize (CLI, MCP, the List view slider) scales every placement by the same factor, so the largest equals W. Smaller placements are clamped at `MIN_WEIGHT`.
  - Migration, saving, moves and frame operations never recompute it. That keeps the hash, and so every old analysis and brief, current.
- **In a look, the card's `placement.weight` steers** that look's analysis, its bundle, Krea's strengths and every adapter's order (§4.11).
- The live weight readout while resizing is frontend-only: `onResize` updates the badge, and `onResizeEnd` sends one `resize` op.

### 4.4 Set aside (C3)

- The stored key stays `excluded`. Today's API, `--exclude/--include` and the hash payload keep working, and there is no disk migration.
- **The meaning changes.** An excluded image is now measured, gets an `analysis.images` entry with `setAside: true` and its colours, and never steers.
- **Set aside = `excluded || weight == 0`** in the Studio, the CLI and agent output. Old weight-0 images show as set aside at full size, with their stored weight 0 kept until you use them again (Q8).
- **The switch.**
  - Turning it on sets `excluded: true`; weight and size are kept.
  - Turning it off sets `excluded: false`. For a weight-0 image it also sets `weight` from the card's size.
- **`steers(weight)` becomes `steers(image)`**: not excluded and weight > 0. Its callers are `analyze_moodboard`, `rank_representative_images`, the `_Steering` list, the keyword, lighting and composition inputs, and the all-set-aside warning, which becomes "Every reference is set aside, so none of them shapes the board." In a look, a member steers when the image steers and its `placement.weight` > 0.
- **Unchanged.** The bundle still drops excluded images (`handlers/moodboard.py:61-64`), so Krea's references and strengths are unchanged, and no adapter ever sends a set-aside image. The palette, accents, `sources`, keywords, summary, `styleBrief`, negatives and representative images stay byte-identical for every pinned board.
- **What the pin sees.** The only change it sees is an extra `imageColors` entry for the brand board's excluded image. `pinned_view` filters entries marked `setAside`, and a new pinned assertion checks the set-aside colours separately (Q7).
- **As built (PR2).** In the analysis, `setAside: true` marks the switch (`excluded`) only. A weight-0 image keeps its version 4 entry and still counts in `summary`, so the pinned brand board's weight-0 colours stay in the steering view and every summary is unchanged; the CLI/MCP view (`setAside` per image) and the Studio show weight 0 as set aside. A set-aside image that can't be read adds no board warning. Turning the switch off on a weight-0 image takes the largest card's weight in the CLI and MCP too (`moodboard_client.update_board`), unless the same edit gives a weight. See `implementation-notes.md`, 2026-10-20.
- **Rejected alternative.** A new `setAside` key with legacy `excluded` as "not read" keeps two states on old boards, which is option b) of C3, the one Justin didn't pick.

### 4.5 Numbers (C7)

- `#n` is `index + 1` in `images[]`, as today in the analysis (`moodboard_analysis.py:139-143`), the grid (`MoodboardStudioView.tsx:559`), CLI `show`, `find_image` (`moodboard_client.py:565`) and `brief()` (`:1005`).
- The only things that change the array are add (append), remove, and undo of a remove (reinsert at the old index through the `add` op's `index`).
- `thumbnail` stays `images[0].url`, the lowest number.
- A look's analysis, its `sources`, run notes ("Sent board images #3, #7") and adapter legends all use the board's numbers.

### 4.6 Frames and membership (C4, C13)

- **Joining a frame.**
  - A card joins a frame when it is dropped with its centre inside that frame (the topmost frame, if they overlap), or through an op. Nearness never counts.
  - Drawing a frame takes in the cards fully inside it at that moment (Q6).
  - Dropping a card into a frame where the image already has a copy snaps it back with "Already in Dither".
- **Leaving a frame.** Dragging a framed card onto empty canvas takes it out of that look (Q5):
  - If the image has other framed copies, this copy is removed.
  - If it was the last one, the card becomes loose.
- **Moving a frame** moves its members in one write. In React Flow, a framed card has `parentId = frameId` and no `extent: 'parent'`, so it can be dragged out. Positions are converted to and from absolute only in the client. React Flow needs parent nodes before their children in the nodes array.
- **Resizing a frame** never changes membership. Its minimum size is its members' bounding box.
- **Deleting a frame** keeps its cards where they are:
  - A card whose image has no other copy becomes loose.
  - A card whose image has another copy is removed.
  - From PR7b: the look's `lookFields[F]` and `lookAnalyses[F]` go in the same batch, and the undo slice carries them. Nodes saved on that look stop with a clear message (§4.11.7). If the look holds words the person wrote, an agent's or Analyze's delete is refused (Q28), and the person's Undo toast adds "Dither's own brief goes with it".
- **Merging** moves the copies into the target frame. Where an image is in both frames, the heavier copy is kept. From PR7b: the target keeps its own `lookFields`; the merged look's are dropped (kept in the undo slice), and `lookAliases[F] = G` is added. The same person-words rule applies.
- **Splitting ("New look from these")** makes a frame with no look fields, so it uses the board's words.
- **Unsorted** is a frame with `kind: "unsorted"`: dashed, tab "Unsorted · N", never a look. It disappears when emptied (Q14).
- **"Also in Dither" chip.** It lists the other placements of the same image.
- **Tab counts.** "Painterly · look · 7" counts placements per frame. From PR7c a dot marks a look whose own hand-written brief is out of date.

### 4.7 Versions

- `version`: still +1 per write, and now also a compare-and-set token. `baseVersion` on `PUT` and on `/edits` returns 409 when it doesn't match.
- `layoutVersion: 1`: the board's layout has been saved.
- `ANALYSIS_VERSION` 4 → 5 (PR2): set-aside images are measured and `analysis.images[].setAside` is added. `source_hash` doesn't change, so version 4 and 3 analyses stay current until the board changes.
- A look's analysis carries the same `version` and its own `sourceHash` from `look_source_hash` (§4.11.3).
- `briefVersion` is unchanged.
- `readings[].readerVersion` starts at 1.
- `backend/data/moodboard_adapters.json` has a top-level `version` (starts at 1) that goes into nothing hashed; adapter entries change what a node sends, not what the board is.

### 4.8 Old boards: nothing moves, nothing goes stale, no disk rewrite

1. **No startup migration and no backup folder.** Files keep their bytes, `version` and `updatedAt` until someone edits.
2. **`get` and `update` lay the board out in memory** with `moodboard_layout.legacy_layout(board)`, called from `_migrated` (`moodboard_store.py:162`) behind a flag. `list` skips it, so the rail stays cheap. `moodboard_client.get_board` refetches by id after a name match (`:487-494`), so `show "Name"` gets the layout too.
   - It is a deterministic grid in number order: 6 columns, 40 px gaps, row height set by the tallest card.
   - Each card's area is `max(weight, MIN_WEIGHT) × FULL_AREA`. Weight-0 cards are full size.
   - The aspect ratio comes from the image header through `resolve_moodboard_image_path` (`moodboard_analysis.py:388`), upright (EXIF orientation applied), cached per URL and agent workspace while the file is unchanged. If the file can't be read, `analysis.images[].width/height`; if neither, 4:3.
   - `placedBy: "person"`, since the order was theirs.
3. **The first write saves that layout and stamps `layoutVersion: 1`.** Since the layout is deterministic, nothing moves. Opening a board without editing it writes nothing, because `initialize` loads with `dirty: false`.
4. **`frames`, `suggestions` and `readings` read as empty.** There is no Unsorted frame until Analyze runs or the person makes one.
5. **The brief and Krea outputs for every old board stay identical.** This is pinned by a golden file captured on main before PR1 (`8e14de37` on the branch). #18 changes it once on purpose (no notes in generator output); "unchanged" in this plan means the file as it stands after #18 is reconciled.
6. **No look keys.** A board with no `look` frames has no `lookFields`, `lookAnalyses` or `lookAliases`. `source_hash`, `brief_basis`, `compose`, `analysis_is_current`, the CLI `brief()` view, the bundle and `apply_to_generator` are unchanged for it, and every old node's missing `look` param reads as Whole board.
7. **Adapters keep old outputs.** For every node that existed before PR13, a frameless board on Whole board sends what it sends today: text-only and content-slot entries default to text, and Krea 2's references and strengths are unchanged (unless Justin picks a change in Q21, which would be one deliberate golden-file update).

### 4.9 Who writes what

- **Layout is written only through checked edits** (`POST …/edits`, PR3) and through server placement of new images.
  - **PUT.** It merges images by id: a key a client leaves out keeps its stored value. Incoming `placements` on images already on the board are ignored, so a stale tab or an echoing CLI can never undo a layout edit. On a new image, `placements` are validated and used as the requested placement.
  - **Board-level layout fields.** `frames`, `suggestions`, `readings` and `layoutVersion` are refused on PUT with a 422 that names `/edits`.
- **Look fields too.** `lookFields`, `lookAnalyses` and `lookAliases` are refused on PUT, like layout. `lookFields` changes only through `look.*` ops; the other two are written by the store.
- **After PR3, the Studio sends board fields only on PUT** (name, notes, mode, strength, the brief fields, `musicDirection`) with `baseVersion`. Every image change goes through `/edits`. PUT keeps accepting `images` for the CLI, MCP and API callers.

### 4.10 Limits

| What | Limit | Where |
|---|---|---|
| Images per board | none (as today); the speed budget is tested at 300 | PR5 speed check |
| Placements per image | 1 to 8; one per frame | store validation |
| Frames | ≤ 100, one Unsorted, names unique | store validation |
| Card size | weight 0.05 to 1.0 × `FULL_AREA`; frames ≥ 160 px | `moodboard_layout.py` |
| Ops per `/edits` call | ≤ 500 | route |
| Suggestions | ≤ 200 | store |
| Reading | ≤ 2 KB per image | reader |
| Look fields | one entry per look frame; Direction and the hand-written brief use the board's own limits; music direction ≤ 600 characters | store |
| Look aliases | ≤ 200; chains ≤ 8 | store |
| Undo steps | 50 per board (graph `UNDO_CAP` is also 50) | Studio |
| Journal | one event per batch; `data` ≤ 4 KB (the journal's own cap) | `canvas_events.py` |
| Reader trace | ≤ 400 lines and ≤ 64 KB per job, ≤ 200 characters a line; in memory with the job, kept 15 minutes after it ends | reader job (§5.6.1) |
| Board images per node run | the entry's slot limit for the active route and model, minus wired | adapter planner |
| Prepared board images | content-addressed copies; the folder is trimmed oldest first above 1 GB | `prepare_board_image` |

### 4.11 Looks: one analysis and one brief per look (A4)

#### 4.11.1 What a look is

- **Members:** every placement with `frameId == F`, where F is a frame of kind `look`. Unsorted is never a look. Loose cards belong to no look.
- **Weight:** each member's weight in the look is its `placement.weight`. It steers when the image steers (C3) and the placement weight is above 0.
- **Numbers:** each member keeps its board number (#n), so `sources[].number` matches the canvas badges and `nebula moodboard show`.
- **Whole board** is every image on the board (framed, loose and Unsorted), each at `image.weight` (its heaviest copy), with the board's own words. That is exactly today's brief, so the golden file and `source_hash` don't change. This is the permanent meaning of Whole board (Q4, reworded).
  - Rejected: Whole board as the union of looks only. It changes old-board output and hides loose images.

#### 4.11.2 Measuring once, rolling up per scope

`analyze_moodboard` is split into two steps (PR7b):

1. `measure_board(board)`: one measurement per image, set-aside images included. It writes the whole-board `analysis.images[]` (PR2's per-image entries).
2. `roll_up_scope(per_image, members: [(number, id, weight)], board_fields)`: palette, accents, colours with sources, keywords, lighting, composition, representative images, summary, warnings and the generated brief.

- The Whole board runs step 2 with `image.weight` and gives exactly today's output. Each look runs it with its card weights.
- Each image is measured once per run, then one roll-up runs per scope. That avoids thrashing the 256-entry file cache.
- **Stored per look (lean):** `lookAnalyses[F].analysis = {version, sourceHash, members: [{number, id, weight}], palette, accents, colors (with sources), keywords, lighting, composition, representativeImages, summary, styleBrief (generated), warnings}`. No per-image colours: they live once in the whole-board `analysis.images[]`. File size grows with images, not images × looks.
- **Warnings:** "Every reference in Dither is set aside, so it has no look to send." The summary counts that look's steering members.
- **#18's colour check per scope:** `lookAnalyses[F].colorCheck` is computed against the look's effective words (§4.11.5) and its measured colours, so each look has its own "Left out of the brief" list. It follows #18's basis rule, not Measure's (§4.11.3).

#### 4.11.3 Is a look's analysis current?

- **`look_source_hash(board, frame_id, version)`**, new. `source_hash` stays exactly as it is.
  - Payload: `{"scope": "look", "frame": F, "mode", "strength", "notes", "members": [{number, id, url, weight: placement.weight, notes, excluded, imageWeightZero}]}`.
  - The number is in the payload because removing an earlier image renumbers members, and the saved `sources` would show the wrong numbers.
  - Layout (x, y, w, h, `placedBy`) and the frame's name and rectangle are left out, so a move or rename keeps the analysis current.
- **`look_brief_basis(board, F)`** hashes the look's source hash plus its **effective** words: Direction, Avoid, pins and #18's `clashMode`, `colorChoices` and `sendNotes`, after the board's words fill in. So a board-level Direction edit marks every inheriting look's hand-written brief "changed since you edited this". That is right: the words it was written against changed.
- **`look_analysis_is_current(board, F)`** compares `lookAnalyses[F].analysis.sourceHash` with `look_source_hash` at its version, the same rule as `analysis_is_current`.
- **The look's colour check has its own basis**, as #18's does: `look_colour_check_basis(board, F)` = #18's `colour_check_basis` payload built from the look's **effective** Direction, Avoid and "must appear" pins (§4.11.5) and the look analysis's measured colours. The look source hash leaves the words out, so Measure alone would leave a stale "Left out" list after a word edit. Instead:
  - the store refreshes `lookAnalyses[F].colorCheck` in the same write as `look.set`, `look.inherit`, and any board PUT that changes the board's Direction, Avoid or pins (for every look that uses the board's words), the way `refresh_colour_check` runs on every store write today;
  - `compose(board, look=F)` uses the saved check only when its basis matches, else checks in memory (#18's `current_colour_check`), so a run never uses a stale list even if a refresh failed;
  - a look with no `lookAnalyses[F]` yet has no measured colours, so it has no check until Measure, as for a board with no analysis today.
- **A look goes stale when:** its membership changes (`place` in or out, `link`, `unlink`, a merge into it, an accepted suggestion); a member's card is resized; a member's `weight` op (it rescales every copy); a member's steering note, Set aside or URL changes; the board's mode, strength or notes change; or an image earlier in the list is removed.
- **It doesn't go stale on:** moves, frame renames, frame rectangles, and edits to non-members (other than that renumbering).
- **Stale look analyses are kept, not nulled.** The hash says they're out of date. This replaces §5.1's "steering ops null the analysis" rule for looks only; the whole-board rule stays. Automatic Measure (Q9) then refreshes only the scopes whose hash moved.

#### 4.11.4 Where it is stored

Maps keyed by frame id (`lookFields`, `lookAnalyses`, `lookAliases`), not fields on `frames[]`.

- Frames are layout. They are refused on PUT and written by `/edits` with restore slices and the undo stack. Putting the analysis and the person's text on them would carry both through every frame move's undo slice and journal data, and grow the `look` and `picture` reports.
- `lookFields` changes through checked ops `look.set {frame, field, value}` and `look.inherit {frame, field}`, with undo. The hand-written-brief person gate (`_guard_override`) and #18's notes gate apply inside the op.
- `lookAnalyses` is derived and ignored if a client sends it (the treatment #18 gives `colorCheck`). Its `analysis` is written on Measure and Analyze; its `colorCheck` is also refreshed on every write that moves its basis (§4.11.3).
- Cleanup happens in the same atomic batch as the frame op (§4.6).

#### 4.11.5 The board's words and a look's words (Q20)

Recommended (Q20 a): the board's words are the default; each look can replace or add, field by field.

| Field | Rule | Why |
|---|---|---|
| Direction | The look's own replaces the board's when set; empty means it uses the board's. | Directions disagree across looks; joining two brings back the conflicts A4 removes. |
| Avoid | Board items plus the look's own, deduped. A look can't remove a board item; move the item from the board into the looks that need it. | Avoid items are mostly defects or "no text" that hold everywhere. Adding is predictable. |
| "Must appear" colours | The look's own list replaces the board's when set. | A brand red pinned for Painterly shouldn't be forced into Dither. |
| "Keep out" colours | Board items plus the look's own. | Same as Avoid. |
| Hand-written brief (`briefOverride`) | Per scope only, never inherited. The board's applies to Whole board only. | It was written against one scope's measured content. The Studio offers "Copy the board's brief to this look" as a deliberate act. |
| `clashMode` (#18) | Per board only. | It's a policy, not content. |
| `colorChoices` (#18 Keep anyway / Leave out) | Stored per scope. A look that uses both the board's Direction and Avoid also uses the board's choices; a look with words of its own uses only its own. | A choice answers a finding, and a finding comes from that scope's words. |
| `sendNotes` (#18) | Per board, with the node's `send_notes` above it. A look sends only its members' image notes. | Notes are board-level text; no per-look note field now. |
| Mode and strength | Per board for now. | A per-look mode is a later option (§8). |
| Music direction (B1) | Per scope, never inherited. | It was written from one scope's images. |

Studio wording: a field taken from the board shows "From the board" in grey, with "Write one for this look". A look's own field shows "This look only", with "Use the board's".

An old `briefOverride` keeps sending exactly as today for Whole board, with its `brief_basis` unchanged. It never reaches a look on its own.

#### 4.11.6 The heaviest look

- **Weight of a look:** the sum of its steering members' `placement.weight`. Size is weight (C2), so the sum says how much of the board the look is. Count would ignore size, the maximum picks a look built around one big card, and the mean favours tiny looks.
- **Ties:** more steering members, then the earlier `createdAt`, then the frame id.
- **Never a candidate:** Unsorted, and a look whose sum is 0.
- **Used for:** the default when a node gets a look (§4.11.7), and the order of the look picker and the Studio's scope switcher (heaviest first, each with its count).

#### 4.11.7 The node's look

Recommended (Q18 a): the **Moodboard source node** (`nebula-moodboard`) holds the pick. Every output port (brief, palette, images, bundle) then describes one scope, and a run measures one look. Two looks in one graph means two Moodboard nodes on the same board; dragging a look's tab from the Studio onto the canvas creates one with the look set (`addMoodboardNode(..., meta)`, drag type `application/nebula-moodboard`).

- **Param:** `look: "whole" | "<12-hex frame id>"`, type `moodboard-look`, rendered by the Inspector from the board the `moodboard` param names (a new branch next to `Inspector.tsx:631`). It sits beside `moodboard` and #18's `send_notes`. A hidden `_lookName` keeps the last name the canvas saw, used only in error messages after a delete. **Nobody sends `_lookName`:** the server writes it whenever `look` is set (graph apply, proposals, the Inspector's save), so agents never need to write a `_` param. The card shows the current name read from the board (`storedAssetsStore`), so a rename shows at once with no write.
- **Agents** may pass a look name. `agent_params` and `canvas_proposals` resolve it to the id against the board when the edit is applied, and refuse an unknown or ambiguous name, or Unsorted. Setting `look` spends nothing and is undoable.
- **Default (Q19 a, stamped):** when a board is chosen in the Inspector, a node is created with a board, or an agent sets `moodboard` without `look`, the heaviest look's id is written into `look`. With no looks, `whole` is written. Old saved nodes have no `look` and read as `whole`. When a board gains looks while a node is on Whole board, the card hints "This board has 3 looks · Pick one" and never switches on its own.

When the look changes under a node (checked in the handler at run time):

| Event | What happens |
|---|---|
| Renamed | Same id; the card shows the new name. |
| Merged into another look | Follows `lookAliases`. Run note: "Dither was merged into Painterly; this run used Painterly." The Inspector offers to save the new id. |
| Deleted | The run stops: "The look 'Dither' is no longer on board X. Pick a look on the Moodboard node." It never falls back to Whole board. Undoing the delete restores the same id. |
| Empty, or every member set aside | The run stops: "Dither has no references that steer. Add some, use one again, or pick another look." |
| Board in trash or missing | As today. |

#### 4.11.8 What a look's bundle carries

- `images`: the members, with `weight` = the card's weight in the look; set-aside images dropped and private notes stripped (as today); image notes per #18.
- `representativeImages`: the look's, heaviest first, from the look roll-up.
- `styleBrief`, `palette`, `accents`, `negativePrompt`, `avoidPrompt`, `leftOut` and the rest: `compose(board, look=F)`.
- `analysis`: the **look's** generator view: #18's `generator_analysis` run over the look roll-up, with the summary counting the look's steering members (not every board image). Never the whole-board analysis.
- `providerHints` (top level and inside `analysis`): rebuilt from the look. `providerHints.krea.representativeImages` is the look's list, and `.strength` and `.styleBrief` are the look's. Krea 2 reads these before `representativeImages` (§3.2), so a whole-board copy here would send the whole board's top 10.
- `musicDirection`: the scope's, only when one is set.
- New keys `scope: "look"` and `look: {id, name}` appear **only** in look bundles, so Whole-board bundles stay byte-identical for the golden file.
- Brief wording for a look: "Use the look 'Dither' from the Nebula moodboard 'X' as look direction at strength …".
- **No non-member URL anywhere in a look bundle.** PR7d asserts it by walking every string in the bundle.
- Adapters read `bundle.images` and `representativeImages` and never need to know about looks.

#### 4.11.9 Measure and Analyze per look

- **Measure** (free; the `/analyze` route, CLI `analyze`, MCP, and Q9's automatic Measure) writes `analysis` and `lookAnalyses[F]` for every look in one pass: one measurement per image, then one roll-up per scope. The automatic Measure re-rolls only scopes whose hash moved.
- **At run time** the Moodboard handler measures in memory only the scope it sends (today's stale-board warning, worded per look). It never measures every look.
- **Analyze (PR10):** readings are per image, so per-look results cost nothing extra. After the sort is applied, Measure runs per look in the same run. New looks it creates get no `lookFields`. It never deletes or merges a frame that holds words the person wrote.
- **The one per-look reader cost** is B1's music direction: one short text call per look, on request (Q25), priced and gated like Analyze (PR19).

#### 4.11.10 Old boards

See §4.8 items 6 and 7. A board with frames whose node is on Whole board gives the same output as before the frames were drawn (PR7's test, kept).

---

## 5. Shared machinery (built once, used by later PRs)

### 5.1 Checked board edits: `POST /api/moodboards/{id}/edits`

- **Body:** `{ops: [...], baseVersion?, say?}`.
- **Atomic.** Ops are staged on a copy, validated, and committed once with `version + 1`. Either all land or none. The pattern is `/api/graph/apply` (`main.py:7973`) and `canvas_edits.parse_edit` (`:119`).
- **Ops are absolute sets**, so replaying them is idempotent and the Studio can rebase.
  - Images: `add` (urls, `at`, `in`, `size`, `index`), `remove`.
  - Cards: `place` (placement or image, x, y, `frameId?`), `resize` (`weight`, or `w×h` with the aspect kept), `link` (image → frame), `unlink`.
  - Image settings: `setAside` (image, bool), `weight` (image, value; scales copies), `note` (image, `notes` or `privateNote`), and from PR17 `realPerson` (image, bool).
  - Frames: `frame.create` (rect or `around: [placements]`, name), `frame.update` (name or rect; a move moves members), `frame.delete`, `frame.merge`.
  - Suggestions: `suggestion.accept`, `suggestion.dismiss`.
  - Looks (PR7b): `look.set {frame, field, value}` and `look.inherit {frame, field}` for the fields in §4.11.5. The person gate applies to `briefOverride` and `musicDirection` written by the person, as `_guard_override` does today.
  - Later PRs: `arrange` (PR12), `restore`.
- **Naming.** Images are named by number or id, frames and looks by id or name, and placements by id or `image@frame`.
- **Effect on the analysis.**
  - Whole board: steering ops (`add`, `remove`, `setAside`, a `note` on `notes`, `weight`, a `resize` that changes the image's weight) null the whole-board analysis, as the CLI does today. Layout ops keep it.
  - Looks: nothing is nulled. Each look is judged current or stale by `look_source_hash` (§4.11.3).
- **`restore`** carries before-slices, each with an `expect` after-slice. A slice that changed since is skipped and reported, so one stale reference doesn't block undoing twenty moves.
- **Response:** `{board, version, applied, undo: {ops}}`.
- **Broadcast:** `storedAssetChanged` gains `version`, `edit: {actor, tab}` (from `_graph_edit_origin`), `touched: {images, frames, looks}` and `undo`. `undo` is null when a batch is over 200 ops; the Studio then refetches, and the step can be undone only from the tab that made it.

### 5.2 Journal

- **New kinds** in `EVENT_KINDS` (`canvas_events.py:53`): `board.added`, `board.removed`, `board.moved`, `board.resized`, `board.grouped`, `board.setAside`, `board.noted`, `board.frame`, `board.sorted`, `board.arranged`, `board.suggested`, and from PR7b `board.look` (a look's words changed; text of a hand-written brief is not journaled, only "Dither's brief edited").
- **One event per batch**, with `data: {boardId, boardName, scope, refs: [{number, id}]}`. A move counts only above 8 px, as on the canvas.
- **Private notes.** A private-note change is journaled as "private note changed" without its text.
- **Project tag.** The journal is tagged with the open canvas project (`set_project`, `:259`) while boards can be Global, so the board's own scope goes in `data`.
- **Sources.** Events come from `/edits` and from Analyze. They also come from PUT diffs, so old clients' edits show up.

### 5.3 The Studio's edit queue and rebase

- Each edit applies to the draft at once and goes into a per-board queue.
- A drag or resize sends one op at pointer-up. Text sends after 600 ms or on blur.
- On a foreign `storedAssetChanged` (a newer `version` that isn't this tab's echo), the Studio refetches the board and replays its unconfirmed ops on top.
- On 409 it does the same, then resends.

### 5.4 Undo in the Studio (C12's "one Undo")

- **The stack.** It is per board, keyed by the draft key, capped at 50, and cleared on an epoch change, a board switch or a delete. Each step is `{label, origin: self|agent|analyze, actorName, ops, undo}`.
- **What makes one step.** A drag end or a resize end; a frame op; a set-aside toggle; a note (on blur or after 600 ms); a look field (on blur or after 600 ms); a whole Analyze run; a whole agent batch.
- **Undo and redo.** Undo sends `restore` with `expect`; redo resends the ops. Skipped slices show a notice: "#12 changed since, left as is".
- **Foreign steps.** Agent and Analyze batches arrive with `edit.actor` and `undo`, and become one foreign step with a notice: "Claude moved #12 into Dither · Undo". An Analyze step names the reader and who asked: "Gemini 4 Argon sorted 19 into 4 looks (asked by Claude) · Undo". This follows `ForeignEdit` (`lib/canvasUndo.ts:50`).
- **The analysis.** Undo never brings an analysis back. With Q9, Measure reruns on its own.
- **Keys.** Studio-scoped Cmd+Z, Shift+Cmd+Z and Cmd+S, all skipped inside text fields. Cmd+S calls `preventDefault`, so `GraphFileActions` (which yields on `defaultPrevented`, `GraphFileActions.tsx:129`) never opens the graph save.
- **Delete.** React Flow's `deleteKeyCode` is `null`. Delete removes the selected references with an Undo toast (Q15).

### 5.5 Agents on the board (C9)

| Main canvas | Board |
|---|---|
| `CanvasViewReporter` → `POST /api/canvas/view` | The Studio posts to `POST /api/moodboards/{id}/view` every 300 ms: `{viewport, screen, visible: [placementIds], selection: [imageIds], view: "board"\|"list"}`. `BoardViewBook` keeps one slot per board in memory and marks it stale after 30 s (as `VIEW_STALE_SECONDS`, `agent_presence.py:34`). The main canvas's single slot (`agent_presence.py:304`) is left alone. |
| `look_at_canvas` | `GET /api/moodboards/{id}/look` (shape below). MCP `moodboard_look`, CLI `nebula moodboard look`. `look_at_canvas` adds `studio: {boardId}` when a board is open, and shows a Moodboard node as `board X · look Dither` (or "Whole board · board has 3 looks") from PR7d. |
| `view_output` | `GET /api/moodboards/{id}/picture?area=view\|board&size=small\|medium\|large` (512, 1024 or 1568 px), a Pillow composite of the 512 px thumbnails at placement positions: frame outlines and tabs, `#n · w` badges, set-aside cards dimmed, the selection outlined. It needs no browser. MCP `moodboard_picture` returns an `Image`. CLI `nebula moodboard picture -o FILE`. |
| `edit_canvas` | MCP `moodboard_edit` (the ops in §5.1). CLI `nebula moodboard edit <board> --place 12=x,y --resize 12=0.6 --in 12=Dither --link 12=Glass --set-aside 12 --note 12=…`. |
| Agent cursor | `agent_presence.point(target={surface: "moodboard", boardId, placementId} or {…, x, y}, say)` after each batch (`agent_presence.py:226`). The Studio mounts its own cursor layer and reuses `agentCursorMotion`. The main `AgentCursorLayer` ignores targets that carry `surface`. |
| Journal and `wait_for_canvas_change` | The `board.*` kinds. `wait_for_canvas_change kinds=board` works through `EVENT_GROUPS`. |
| Per-turn context | The chat payload carries `studio: {kind: "moodboard", boardId, selectedImageIds}`. Next to `selection_prompt_context` (`main.py:3184`), the runner adds a board block: looks with counts (and, from PR7b, whether each look's analysis is current and has its own words), plus the selected references' structure (never private-note text). It also adds **"Since your last turn"**: the person's `board.*` events after a cursor kept per chat session, read with `exclude_actor_id` (`canvas_events.py:316`), at most 20 lines. All three runners take it through their existing `selection_context` argument (`chat_session.py:231`, `codex_session.py:364`, `acp_session.py:510`). |

`look` returns:

- `view: {reported, stale, secondsAgo, visibleArea}`
- **In view:** `[{number, id, placementId, x, y, w, h, weight, look, alsoIn[], setAside, hasNote, hasPrivateNote}]`.
- **Off-screen:** `{looks: [{frameId, name, count, weightSum, current, ownWords, leftOut}], loose: n}` (the last three from PR7b).
- `frames`.
- **The selection in full:** both notes, with the private note flagged "never put in a prompt" as `moodboard_get` already does, plus the weight per look, the colours and the reading.
- `events.cursor`.

With nobody looking, or a stale report, `look` describes the whole board.

**Placement (C8).** `moodboard_layout.place(board, sizes, *, view, at, in_frame)` is a rectangle-based free-space finder, not the 320×220 slots in `nodePlacement.ts`.

- **With a fresh view:** free rectangles inside the visible area, next to the visible cards first.
- **Otherwise:** after the last-added card: its row if the row has room, else a new row under the board.
- **Spacing:** a 24 px gap, never overlapping.
- **`--in <look>`:** free space inside that frame; the frame grows to fit.
- **`--at x,y`:** exact. **`--size`:** a weight or `WxH`. **Studio file drops:** the drop point is the anchor.

### 5.6 The reader and its price (C10)

- **`services/moodboard_reader.py`**, modelled on `services/vision_llm.py`:
  - The person picks `(provider, model)` explicitly. `vision_llm` always uses `providers[0]` and caps a call at 13 images (`:21`); the reader does neither.
  - Batches of 6 images, longest edge 1024 px (Q13), JPEG in memory.
  - At most 2 requests at once, each under the time bounds in §5.6.1, and one retry per batch that asks only for what didn't come back (§5.6.1).
  - A response schema for Gemini, sent as `generationConfig.responseFormat.text = {mimeType: "APPLICATION_JSON", schema}` (`responseSchema` is deprecated, and key order is documented for this form; §5.6.1), plus the Argon settings `GEMINI_CHAT_NO_SAMPLING`, `GEMINI_CHAT_THINKING_LEVELS` and `GEMINI_CHAT_MAX_OUTPUT` (`handlers/google_gemini.py:32-45`). Output is capped per batch by `maxOutputTokens`, which counts thinking too.
  - Images go in under batch-local labels (`Image A` to `F`), never board numbers (§5.6.1).
  - `usageMetadata` is captured.
- **Phase 1 (per image):** medium, style, light, motifs, and candidate looks with a fit score. Existing frame names go into the prompt so the model reuses them. Notes follow #18's opt-in in both phases, as for the music call below: board notes, image notes and note-derived keywords only when `sendNotes` is on; private notes never. From PR17, if Q26 a, also `people: "none" | "drawn" | "photo"`, which the face policy reads.
- **Phase 2 (one text-only sort):** assignments, Unsorted, `alsoIn` and hybrids.
- **Python enforces the rules afterwards:** only targets move (C11, C12); frames you named are never renamed or deleted; frames holding words you wrote are never deleted or merged; at most 8 new frames per run; a fit below 0.5, or a failed read, goes to Unsorted (Q17); each image goes to its best frame only, and a second fit becomes an `alsoIn` suggestion; when 3 or more references share a pair, one `hybrid` suggestion replaces their `alsoIn` suggestions (Q10).
- **The music direction (B1, PR19)** is a separate call, not part of the sort: one request per scope (Q25). It returns at most 3 sentences: instruments, tempo or energy, texture and mood. No colour-to-key mapping. It is priced through the same model file, shown first, and gated like Analyze.
  - **What goes into the drafting prompt:** the scope's top 4 steering images at 512 px; the scope's stored readings when there are any (after PR10; before it, images alone); and the scope's effective Direction.
  - **Notes follow #18's opt-in.** Board notes, image notes and note-derived keywords go in only when the board's `sendNotes` is on or the Lyria node's Moodboard source has `send_notes: yes`. Private notes never go. Avoid, pins and the measured palette don't go: they are visual rules.
  - So a draft can never carry note text to Google that the person hasn't opted in to send.
- **Menu ("READ THEM WITH").**
  - It lists curated models filtered by `node_readiness.configured_keys(load_settings())` (`node_readiness.py:328`, `services/settings.py:89`). Gemini 4 Argon on Google (`gemini-chat`'s default, `node_definitions.json:6495`) comes first, which is source-direct.
  - "Measure only" is today's free `analyze_moodboard`.
  - GM's "Gemini 3 Flash" row appears only after its price and vision support are verified.
- **Price.**
  - `POST /api/moodboards/{id}/read/estimate {model, imageIds?}` returns `{count, batches, low, high, unconfirmed, sources}`.
  - Low/high = (image tokens at 1024 px + prompt) per batch, plus capped output per batch, plus phase 2, at the vendor's per-token prices. The output cap already includes thinking. The high estimate also counts one retry per batch (§5.6.1).
  - The prices live in a curated `backend/data/moodboard_reader_models.json`, each entry with `sources`, `checked` and `unconfirmed`, and a test validates it. This is not `model_pricing.json`, whose validator needs a node definition.
  - **Gemini 4 Argon's price is not in the repo.** PR4 fetches Google's pricing page. If it isn't exact, the row says "No list price, may cost more" and asks for confirmation (Q16).
- **Gating.**
  - **The person:** the price shows in the menu row and on the button. Above `runCostConfirmUsd`, the bar asks inline (`shouldConfirmRunCost`, `lib/runScope.ts:359`).
  - **Agents:** `agent_spend.decide` (`agent_spend.py:590`) takes `pricing` and `definitions` as arguments. The reader passes one item, `{definitionId: "gemini-chat", params: {model}}`, with a one-off pricing entry built from its own estimate. Per-model caps then apply to the chat model the person already sees in Settings (Q11).
  - **The hold:** the high estimate is held at the start. Batches that never start are given back (`_release_unspent_hold`, `main.py:1896`). An unpriced read under any USD limit is refused, as for unpriced nodes.

### 5.6.1 The reader's trace: Analyze as an overseer (Q29: Justin chose c)

GM's mockup v5 shows Analyze as an overseer, not as an agent. There is no cursor. The canvas ripples outward from the pile, or from each selected card on a selection pass. A panel drops from the Analyze bar and streams short lines such as "#21 clouds under a halftone screen → Dither". Each card a line names gets a lavender outline, while orange stays the agent's. Results ("couldn't place", the Painterly × Dither suggestion) are voiced by Gemini 4 Argon. This section is what the reader must give for that. Q29 (§7.3) asked where the lines come from. Justin chose c): the readings and Nebula's own lines (b), plus the reader's thought summaries as a second, dimmer stream that never outlines cards. His note: "If argon, or whatever model doesn't stream its thoughts then we just fallback to B."

**What Google documents** (fetched 2026-10-19, rechecked 2026-10-20):

- **The answer streams as partial JSON, keys in schema order.**
  - "The streamed chunks will be valid partial JSON strings, which can be concatenated to form the final, complete JSON object."
  - "When using structured outputs, the model will produce outputs in the same order as the keys in the schema."
  - REST sets the schema as `generationConfig.responseFormat.text = {mimeType: "APPLICATION_JSON", schema: <JSON Schema>}` (structured-output page: "`response_json_schema` (or `responseFormat.text.schema` in REST)"). The API reference marks `responseSchema` deprecated, and its OpenAPI form orders keys only through `propertyOrdering`. So the reader uses `responseFormat`.
  - Gemini 4 Argon is listed under structured-output model support.
  - Google sends no per-item event. Cutting out each finished item is our parser's job.
- **Strings take only `enum` and `format`.** `maxLength` isn't supported, so a length cap is a request in the field's `description` plus a Python trim.
- **Thought summaries are optional and may be empty.**
  - `includeThoughts`: "If true, thoughts are returned only when available."
  - From the thinking guide: "Certain thought content types, such as images, may not have text summaries."
  - From Vertex: "Reasoning over certain modalities (such as image analysis) might not produce text summaries."
  - No page shows `includeThoughts` and a response schema in the same request.
- **Thinking is billed in full, can't be turned off on Argon, and counts against the output cap.**
  - "pricing is based on the full thought tokens"; "You cannot disable thinking for Gemini 4 Argon."
  - "The max_output_tokens generation parameter sets the maximum number of tokens a response can generate, including thought tokens. … If the model hits this limit while reasoning, it stops generating with finish_reason: MAX_TOKENS and returns truncated or empty output (while still billing for any thinking tokens generated)."
  - A single streaming request returns at most 65,536 tokens.
  - Pricing page (2026-10-19): Argon's "Output price (including thinking tokens)" is $10.00 through November 30, 2026, then $20.00 from December 1, 2026. PR4 records both rows with their dates, and the units.
- **Not confirmed (PR4's probe measures these):**
  - whether any bytes arrive while Argon thinks with summaries off;
  - time to the first item at each thinking level;
  - `thoughtsTokenCount` per batch;
  - whether summaries come back alongside a response schema on image batches;
  - whether an aborted stream is billed.

**What today's code can't do:**

- `handlers/google_gemini.py:191` streams through `StreamConfig` with `delta_path="candidates.0.content.parts.0.text"`. It keeps only the first part of each chunk and ignores the `thought` flag. The reader doesn't reuse that path.
- `execution/stream_runner.py:63` opens `httpx.Timeout(config.timeout, read=None)`. Its 60 s bounds the connection, not the answer, so a quiet stream never times out.
- `canvas_events` knows the actor kinds `agent | person | anonymous | system` only. `actor_record` (`canvas_events.py:133`) turns any other kind into `anonymous`, and the frontend unions (`lib/trash.ts:15`, `lib/wsClient.ts:29`) and `asset_trash.py:67` list the same kinds. C10's actor `analyze` has no journal kind.
- `agent_presence` is keyed by header identity: one cursor per agent, one `point()` target (`agent_presence.py:226`). It doesn't fit an overseer. §5.5's cursor stays agent-only.

**The reader (`services/moodboard_reader.py`, PR4):**

- **Batch-local labels.** Each image goes in as a text part `Image A` followed by the image part, `A` to `F` within a batch. The job freezes `label → imageId` when the batch is sent.
  - The model never sees board numbers. Board numbers shift when an image is removed (§4.5), so a reason that said "like #18" would later point at the wrong card.
  - The prompt says a reason describes its own image and never mentions another one. Before a reason is shown or saved, Nebula strips any batch label or `#n` token from it.
  - Board numbers appear only in Nebula-written text, built from `refs` when the line is shown.
- **Phase 1 schema, `ref` first and `reason` last:** `{readings: [{ref, medium, style, light, motifs[], looks[{name, fit}], people?, reason}]}`.
  - `ref` is `{type: "string", enum: [the batch's labels]}`. The deprecated OpenAPI form would also need `format: "enum"`.
  - `reason` asks for at most 120 characters in its `description`. Python trims it at a word boundary to 120 and never fails an item over length. It stays the reading's one free-text field (§4.1), now written to be shown.
- **Our own stream parser,** `services/moodboard_reader_stream.py`:
  - it keeps parts with `thought: true` out of the answer buffer and hands their text to the thought stream instead;
  - it joins text from every part, not only `parts[0]`;
  - it scans the answer as JSON incrementally;
  - it raises `focus(ref)` when an item's `ref` closes, and `item(reading)` when the item closes.
- **Each item is checked.**
  - A `ref` that isn't in this batch is ignored and logged, and the image counts as missing.
  - For a duplicate `ref`, the first item wins.
  - An item that fails the schema counts as missing.
- **Output cap.** `maxOutputTokens` per batch is the level's thinking allowance plus the answer allowance, because the cap includes thinking and is a hard cutoff. PR4's probe records `thoughtsTokenCount` to set it.
- **Time bounds per request** (these replace §5.6's "60 s each"). Until the probe shows bytes arrive while Argon thinks, assume none do.
  - First byte: 120 s at `high`, 60 s at `low` and `medium`.
  - No quiet stretch longer than the same figure.
  - The whole request finishes within 300 s at `high`, 180 s otherwise.
  - The probe calibrates all of these.
- **One retry, for what's missing.** When a stream ends with invalid JSON, a cut-off answer or missing refs, the items that closed are kept: they are real readings and were already shown. The retry asks only for the missing refs. After `finishReason: MAX_TOKENS` it goes out as two smaller batches (half the refs each), never the same request again. Whatever is still missing is "couldn't read" (Q17).
- **A reader that can't stream** (a non-streaming route, or a later non-Google reader) parses the whole answer at batch end and raises the same calls at once. Only the timing changes. `moodboard_reader_models.json` gets `streams: true|false` and `thoughtSummaries: true|false|"unconfirmed"` per model.
- **The thought stream (Q29 c), optional per model.**
  - Only a model whose `thoughtSummaries` is `true` is asked for them (`thinkingConfig.includeThoughts: true`). `false` and `"unconfirmed"` send no `includeThoughts`, so that model's run is exactly b). PR4's probe sets Argon's value; until then it stays `"unconfirmed"`.
  - When the probe finds that summaries don't come back alongside the response schema on image batches, or that asking for them breaks the schema, Argon's value becomes `false`. That is the fallback to b), with no code path of its own.
  - At run time Google may still return no summaries for a batch ("only when available"). Then nothing is shown for it: no empty heading, no placeholder, no error and no warning. The "thinking (summary)" rule appears only when the run's first `thought` line arrives.
  - Thought text is display only. It is never parsed for refs, never outlines or pulses a card, never moves anything and is never saved. Batch labels and `#n` tokens are stripped from it, as from reasons, so a summary names no cards.
  - A later reader from another maker fills `thoughtSummaries` from its own probe, and a reader that can't stream sends its summaries at batch end, or none.
- **Phase 2 lines come from what was applied.** They are written after Python enforces §5.6's rules, never from the model's raw proposal. A refused merge reads "Kept Grain: it holds your words" (Q28), never as done.
- **Notes follow #18's opt-in, in both phases and the retry,** as for the music call: board notes, image notes and note-derived keywords go in only when the board's `sendNotes` is on. Private notes never go. The prompt says "describe images; never identify people", and no line echoes `people` (Q26).

**The reader's identity (the "overseer"):**

- **A fixed identity, not a header identity:** `{kind: "reader", id: "reader:<model>", name: "Gemini 4 Argon", model, provider, color}`.
  - The name and colour live in each model's entry in `moodboard_reader_models.json`.
  - Argon's colour is lavender. The hex is GM's call; `#B49CFF` is a placeholder. A test keeps it out of `_EXTERNAL_COLORS` and away from Claude's `#E8825A`.
  - The Studio draws it through `--reader-color`, next to `--agent-color`.
- **Who asked.** Every run records `requestedBy`, the actor from `actor_for_headers` (`canvas_events.py:96`): person, agent or anonymous.
- **Journal.** `canvas_events` gets the actor kind `reader`. `actor_label` returns its name, and `actor_record` keeps `reader` instead of folding it to `anonymous`. The frontend unions in `lib/trash.ts` and `lib/wsClient.ts`, and `asset_trash.py`, add it. `board.sorted` and `board.suggested` take the reader as actor, with `data.requestedBy: {kind, name}`, inside the 4 KB cap.
- **Undo notice (§5.4):** "Gemini 4 Argon sorted 19 into 4 looks · Undo", or "… (asked by Claude) · Undo".
- **Suggestions gain `model`** (the reader id, for example `gemini-4-argon`). A chip then says "Gemini 4 Argon suggests …" for suggestions from older runs too; `lastRead` only knows the latest run.
- **No cursor for the reader.** It never calls `agent_presence.point()`. An agent that starts Analyze keeps its own orange cursor.

**Events on the socket.**

`moodboardRead` carries the job's state. It goes out on every phase change and each time an image finishes, at most every 250 ms:

```
{type: "moodboardRead", boardId, jobId, runId,
 reader: {id, name, model, provider, color},
 requestedBy: {kind, name, color?},
 phase: "reading" | "sorting" | "applying" | "done" | "failed" | "cancelled",
 done, total, failed,
 batches: {total, sent, done},
 targets: [imageId],      // C11/C12 targets: where the ripple starts
 inFlight: [imageId],     // images in batches sent and not finished: the pulse
 lastSeq,
 summary?: {sorted, looks, unsorted, couldntRead, newLooks, suggestions},
 spent?: {usd, inputTokens, outputTokens, thoughtsTokens},
 at}
```

`moodboardReadTrace` carries one line, append-only:

```
{type: "moodboardReadTrace", boardId, jobId, seq,
 kind: "batch" | "focus" | "reading" | "retry" | "skipped" | "result"
     | "suggestion" | "kept" | "error" | "cancelled" | "done"
     | "thought",            // c) only
 source: "nebula" | "reader",  // who wrote `text`
 text,                         // ≤ 200 characters; empty for "focus"
 refs: [{imageId, number}],    // Nebula's ids and the number at send; never parsed from model text
 phase, batch?, attempt?,
 look?: {frameId, name},
 fit?,
 at}
```

- **`seq`** starts at 1 for each job and has no gaps. Two batches stream at once, so their lines interleave. Within a batch, order is the model's.
- **The `#21` in a line** is drawn by the Studio from `refs` with the image's current number ("removed" if it's gone). The `text` of a `reading` line is the trimmed `reason` plus "→ Dither" from `looks[0]`. That gives v5's "#NN description" shape without the model ever writing a number.

| kind | source | text | refs | What the Studio does |
|---|---|---|---|---|
| `batch` | nebula | "Reading #1–#6" | the batch | A soft pulse on those cards; the ripple starts from them |
| `focus` | nebula | (empty) | one | The lavender outline goes on |
| `reading` | reader | the reason, "→ Dither" | one | The line shows in the panel; the outline settles |
| `retry` | nebula | "Answer cut off after #9; asking again for #10–#12" | the missing | Pulse again |
| `skipped` | nebula | "Ignored an answer for an image not in this batch" | none | A grey line |
| `error` | nebula | "Couldn't read #6: Google returned 503" | one | A "couldn't read" dot |
| `result` | nebula | "#21 → Dither", "#6 Unsorted: no look fits (0.41)" | one or more | The card springs into its frame (PR6 springs) |
| `suggestion` | nebula | "Make a Painterly × Dither look for #3, #9, #14?" | the members | A chip (PR11) |
| `kept` | nebula | "Kept Grain: it holds your words" | none | A grey line |
| `cancelled` / `done` | nebula | "Cancelled · nothing moved" / "Sorted 19 into 4 looks · 1 Unsorted" | none | The panel closes into the bar's last line |
| `thought` | reader, only when the model's `thoughtSummaries` is `true` and summaries arrive | summary text, labels and `#n` stripped, merged into chunks of at least 250 ms | always empty | Dim italic under a dashed rule labelled "thinking (summary)"; never an outline |

- **The panel's title** reads "Gemini 4 Argon · reading", because every line that outlines a card is a reading. The `thought` lines sit below a dashed rule labelled "thinking (summary)", which appears with the first of them. With no summaries the panel is b)'s panel, line for line.
- **Linked copies (C13).** A ref outlines each placement of that image inside the run's targets, or all its placements when none is in the targets.

**Job routes and catching up (PR10):**

- `GET /api/moodboards/{id}/read` returns `{active: jobId|null, last: jobId|null}`, so a Studio that opens mid-run finds the job.
- `GET /api/moodboards/{id}/read/{job}?afterSeq=N` returns `{state, trace: [lines with seq > N], nextSeq, truncated}`. The Studio calls it on open, on socket reconnect and on any `seq` gap.
- **The trace lives with the in-memory job only.** It holds at most 400 lines and 64 KB, dropping the oldest `thought` lines first. A finished job is kept 15 minutes. A backend restart loses it, like every in-memory job in this plan.
- **Nothing new is saved on the board** except `lastRead.requestedBy` and `lastRead.summary`. Each image's `reading.reason` already is its line, and the side panel shows it afterwards (Q12). Thought summaries are never saved.
- **Cancel** (`DELETE …/read/{job}`):
  - no new batch starts, and streams in flight are closed;
  - a `cancelled` line follows, and no `seq` comes after it;
  - nothing moves on the board.
  - Readings that closed before the cancel are saved, so a re-run with nothing selected skips reading them (C11). A re-run on a selection reads them again, as C11 says.
  - Unstarted batches are given back to the hold. A closed stream's batch stays charged at its high estimate, because whether an aborted stream is billed is unconfirmed.

**CLI and MCP:**

- `nebula moodboard analyze <board> --read-with gemini-4-argon` prints lines as they arrive, polling `afterSeq` every second, for example `#21  clouds under a halftone screen → Dither (0.82)`. `--quiet` prints the summary only, `--json` prints one JSON line per trace line, and `--dry-run` prints the same lines and applies nothing.
- MCP `moodboard_analyze` waits up to 60 s. It returns the summary, each image's result (`{number, id, look, fit, reason}`) and the last 20 non-thought lines, or the `jobId` if the run is still going. A new `moodboard_read_status(board, job_id, after_seq)` returns later lines. `thought` lines come only with `include_thoughts`.
- `wait_for_canvas_change kinds=board` still sees one `board.sorted`.

**Price (Q11, Q16).**

- **The cap already includes thinking.** The high estimate per attempt is `maxOutputTokens` × the output price. No separate thinking allowance goes on top.
- **The high estimate includes one retry per batch:** its input (the missing refs' images plus the prompt) and its full output cap. The hold covers it. §5.6's "one retry" already needed this, and the trace adds nothing beyond it.
- **Thought summaries' cost** isn't documented. The probe compares one request with summaries against one without. If summaries add output tokens, the estimate adds them for models whose `thoughtSummaries` is `true`; if they add more than 10% to a batch, Q29's fallback is raised with Justin before the value is set.
- **The spend gate doesn't change** (`agent_spend.decide`, one `gemini-chat` item). The trace is display only.

**Tests:**

- A recorded Argon SSE answer split at every byte offset gives the same lines in the same order. `focus` comes before `reading` for each ref, and `seq` has no gaps.
- `thought: true` parts never reach the JSON buffer, even with `includeThoughts` off. Text in `parts[1+]` is read.
- Wrong refs: a label outside the batch gives `skipped` and no outline; a duplicate keeps the first; the missing image is retried once and then "couldn't read".
- The retry asks only for the missing refs; after `MAX_TOKENS` it splits in two.
- A reason that mentions `#18` or `Image B` is shown and saved without it.
- A reason over 120 characters is trimmed and the item kept.
- A reader that can't stream gives the same line set at batch end.
- A model with `thoughtSummaries` `false` or `"unconfirmed"` sends no `includeThoughts`, and its trace has no `thought` line.
- A model with `thoughtSummaries` `true` whose answer has no thought parts gives b)'s lines exactly, no `thought` line, and no error.
- Thought text that names `Image B` or `#18` is shown without it, and no `focus` or outline follows from it.
- Two batches interleave and order within each holds.
- Cancel mid-stream: nothing after `cancelled`, unstarted batches given back, nothing moves, closed readings saved.
- `afterSeq` returns exactly the missing lines; a job past its 15 minutes returns 404.
- A merge the rules refused gives `kept`, never `result`.
- An image removed mid-run keeps its `imageId`, and the Studio shows "removed".
- A stream quiet past its bound fails that batch, and its images go to the retry.
- `test_reader_prompt_has_no_notes_unless_opted_in` and `test_reader_prompt_never_has_private_notes`, for both phases and the retry.
- `actor_record` keeps `reader`; the undo notice names the reader and who asked.
- Studio: outlines on target placements; reduced motion turns the pulse and ripple into a static tint; PR5's 300-card budget (p95 below 20 ms) holds with the ripple and 12 outlines on.

### 5.7 Moodboard adapters (A1 to A5, B1 to B4)

#### 5.7.1 Where entries live: one source of truth

- **Ports stay in the node definitions.** A node's `moodboard` input port (`dataType: "Moodboard"`, `max: 1`) is declared like any port: in `frontend/src/constants/nodeDefinitions.ts` and by hand in `backend/data/node_definitions.json` (AGENTS.md: don't keep an `export-node-defs.ts` run unless its diff is clean, because of the four JSON-only fixes). Generated Krea nodes get the port from `scripts/sync-krea-catalog.py`.
- **How a node takes a board lives in one backend table**, not in the definitions:
  - `backend/data/moodboard_adapters.json`: hand-written entries, each with `sources`, `checked` and `unconfirmed`, like pricing.
  - `backend/data/moodboard_adapters_krea.json`: written by `sync-krea-catalog.py` from the catalog's port names, marked `generatedBy`, never edited by hand. `reference_images`, `style_references`, `style_images`, `image_style_references` and `image_urls` become slots; `start_image`, `end_image`, `start_video`, `edit_video`, `keyframes`, `image_url` (edit target), `mask_url` and `element_references` / `character_reference_images` become `never`. Every other Image port the catalog adds fails `--check` until the script classifies it.
  - **Defaults in the generated file.** Every generated entry gets `default: "text"` unless its model is on a short allow-list in the script, `STYLE_VERIFIED`, each line with a source: Krea 2 (`image_style_references`, Krea's style-transfer page), Seedream 4 (`style_images[].strength`, Krea's Seedream 4 page), Ideogram 3 (`style_images`, Ideogram's style references), Runway gen-4 image (`reference_images` untagged = style, Runway's API page). Video reference slots (`reference_images`, `style_references`) are `images` by default under B2. A model joins `STYLE_VERIFIED` only with a source, or after a mocked run and one paid run Justin approves.
  - `services/moodboard_adapters.py` loads both, refuses an id in both, resolves an entry for `(node, params, route)`, and serves `GET /api/moodboard/adapters` (like `GET /api/pricing` → `store/pricingStore.ts:30`). The Inspector, the node card and `wiredPorts` read it from there.
- **Why not a field in the definitions:**
  - The TS and JSON registries already drift and are compared by id only, so a field written in both places would drift silently.
  - Two video targets (`veo-3`, `gemini-omni-flash`) carry JSON-only fixes.
  - Generated Krea nodes must not be edited by hand.
  - `model_pricing.json` is the precedent: a separate table checked against the definitions by a validator and a test.
- **`_HANDLER_READS_BOARD` is retired.** Its one member becomes an entry with `handler: "reads-board"`. Krea 2's `moodboard` port changes from `Any` to `Moodboard` (PR13), so `has_board_port` and the contract test see it. Saved graphs that wired a non-board value into that port: checked in PR13 (§10).

#### 5.7.2 The entry

```
"<nodeId>": {
  "channel": "weighted-style" | "style-object" | "refs" | "role-slots" | "views" | "texture-style" | "music" | "text-only",
  "default": "images" | "text" | "never",
  "handler": "reads-board"?,                      # Krea 2 until PR15 moves it into the planner
  "slots": [{"port": "images", "max": 16, "roles"?: {"object": 10, "character": 4, "style": 0}}],
  "needsWired"?: ["image"],                       # edit targets: the board never supplies image 1
  "never": ["mask", "image", "end_image", ...],   # first/last frames, edit targets, views, identity
  "exclusive"?: ["start_image", "end_image"],     # wiring one of these means no board references (per route via byRoute)
  "textSlot": {"port": "prompt"} | {"param": "prompt"} | {"param": "texture_prompt"},  # a port, else a param
  "text": "brief" | "music-direction",            # what text goes; music entries never get the visual brief
  "negativeField"?: "auto",                       # resolved from the active route's params (PR14)
  "paletteParam"?: {"param": "colors", "format": "recraft-rgb"},   # B4 palette as data (PR21)
  "weight": {"mode": "native", "range": [-2, 2], "sum"?: 1} | {"mode": "select"} | {"mode": "at-creation"},
  "order": "weight",
  "syntax": "Image {n}" | "image {n}" | "@image_{n}" | "[Image {n}]" | "plain" | null,
  "syntaxReason"?: "...",                         # required when syntax is null
  "limits": {"maxEdge", "minEdge", "maxBytes", "requestBytes", "formats", "face": "block" | "warn" | "allow"},
  "requires"?: {"duration": 8, "aspect": ["16:9", "9:16"]},
  "collage"?: false,                              # A3, single-reference slots only
  "costPerRef": "priced" | "free" | "plus" | "unknown",
  "byModel"?: {"model=gen4_image": {...}},        # multi-model nodes (runway-image, nano-banana, seedream-4-5)
  "byRoute"?: {"fal": {...}},                     # route-table and dual-route nodes
  "sources": [...], "checked": "2026-10-19", "unconfirmed"?: [...],
  "reason"?: "..."                                # required for text-only and default "never"
}
```

- `channel` says what the slot is for. `weighted-style` and `style-object` take look; `refs` and `role-slots` take content; `views` never take a board; `texture-style` takes one style image for a surface; `music` takes images "for inspiration"; `text-only` takes text.
- `default` is A1's call per entry: verified style channels `images`, content channels and unverified style fields `text`, `views` and edit-only nodes `never`.
- `textSlot` names an input port, or a param when the node has no such port or the person typed the prompt into the param. Text for a param goes into the run's params copy, never the saved node (as negatives do today).
- `syntax: "plain"` writes a legend in ordinary words with no image numbers ("The first image sets the main mood; the third is a light hint"). It is for models that read images but have no reference syntax: Lyria, Ideogram v3 style references.
- `costPerRef`:
  - `priced`: the node's price row already prices references (Krea 3's `(references)`, GPT Image input tokens).
  - `free`: a source says references cost nothing extra (Veo (r); Runway's Seedance 2.5 (r)).
  - `plus`: the vendor publishes a per-reference charge Nebula hasn't modelled yet. It sets the existing `plus` note ("board reference images") and the PR that adds the entry should add a row instead where it can.
  - `unknown`: no source says. While board images go, the node counts as **unpriced** in the estimate, the precedent being a priced setting that arrives by wire (`model_pricing.wired_ports`). The person sees "board references may add cost"; an agent under any USD limit needs a proposal. Turning the switch off removes the marker.
- A route or model that takes no reference images (a route whose `ports.images.max` is 0, say) resolves to text only for that run, and the node says why. A board never changes which route Auto picks (§5.7.9).

#### 5.7.3 How `apply_to_generator` dispatches (after #18)

`apply_to_generator` stays the one gate. It becomes async-safe and gains an adapter step. PR13 builds steps 1, 2 and 8 and sends today's text fold through the entry unchanged, early return included, so no output moves. **PR14 builds every other step**, so later PRs only add entries and ports and never touch the dispatcher. From PR14 every step runs whenever a board is wired, **prompt or not**: today's early return on a missing prompt input (`:368`) goes, and only the text step depends on there being somewhere to put text. (All 16 nodes that take a board today have a `prompt` port, so this changes nothing for a run that has a prompt.) In order:

1. `bundles = board_bundles(inputs)`. From PR7d each bundle is already one scope.
2. `entry = adapters.resolve(definition_id, params, route)`, merging `byModel` and `byRoute`. A node with a Moodboard port and no entry can't exist (the contract test); at run time a missing entry falls back to text only, with a run note.
3. **Text, through the entry.**
   - Where it goes: `entry.textSlot`. A port is used when it's wired; else the param of the same name, in the run's params copy; else, for a `texture_prompt` slot, that param. A node with nowhere to put text sends none and says so once on the node.
   - What goes: for `text: "brief"`, the brief as today, Avoid into the prompt for instruction-following models, and #18's rules on notes. For `text: "music-direction"`, only the scope's music direction (and the plain image legend); no brief, Avoid or negatives. With no music direction set, no text goes.
   - Negatives: into the field named by the active route's params (`params`, `sharedParams`, `falParams`, `directParams`, `routes[].params`), not only `definition["params"]`.
4. **Images**, when the resolved switch is on (§5.7.8):
   - `plan = plan_board_fill(entry, bundles, wired, params, route)` (§5.7.4), a pure function that returns `{port: [image]}`, a legend, and what was left out and why. It applies `exclusive` (no board references when a listed port is wired on that route), `needsWired`, the face policy and `requires`.
   - Then `prepare_board_image` for each (§5.7.6), in a worker thread (the engine call at `engine.py:1201` is awaited through `asyncio.to_thread`), then `local_media_ref` (`output.py:448`) because `_local_media_inputs` has already run.
   - Board images are appended after wired values in the slot port, as `PortValueDict` lists of local paths. Each handler uploads them exactly as it uploads wired images.
5. **Native weights** (Krea 2): until PR15, the handler reads the bundle as today (`handler: "reads-board"`). From PR15, the planner selects and the handler only maps `{url, strength}` (§5.7.4).
6. **Palette as data:** where the entry has `paletteParam`, the scope's palette goes into that param in the run's params copy, only while the person's own value is empty, with a run note. That is the only data step. The aspect is **not** set here: PR22 writes it into the saved node as a graph edit before any run (Q27), so a run never changes its own shape or price.
7. **Run note:** "Sent board images #3, #7, #12 (look Dither) to `images`; left out #4 (Seedance blocks real faces)", through `add_run_note`, as `handlers/moodboard.py:70` already does.
8. The Moodboard port is dropped before the handler (as today, `moodboard_brief.py:76-82`, so Krea's by-name sender never sees it), except for `handler: "reads-board"`.

`apply_to_generator` returns the fill report beside inputs and params. A test asserts the engine's real fill never exceeds `board_fill`'s count (§5.7.9).

#### 5.7.4 Selection, order and wording on models without a weight (A2)

- **Candidates:** `bundle.images` that steer (not set aside, weight > 0) **and that the scope's analysis could read** (status `analyzed`, the same `only=analyzed_urls` set that `rank_representative_images` uses at `moodboard_analysis.py:207`), ranked by weight, heaviest first, board number on ties, deduped by URL. On Whole board, weight is `image.weight`; in a look, the card's weight.
  - So the planner's first 10 are exactly `representativeImages` for the same scope, and Krea 2's references stay identical when PR15 moves it onto the planner.
  - Images it couldn't read (an external https URL, a missing or broken file) are listed on the node as "left out: couldn't read #6". `prepare_board_image` never fetches a URL.
- **How many:** `n = min(slot.max for the active route and model, the role limit) − wired − needsWired reserve`. The route limit comes from `routes[].rules.ports.<port>.max` and the model enums inside multi-model nodes.
- **Wired first.** Images the person wired always come first and always count. On edit nodes (`needsWired`), image 1 must be wired; if it isn't, no board images go and the node says: "Wire the image to edit first. Board images join after it."
- **Order:** wired values in wired order, then board images heaviest first. FLUX 3 takes its aspect from image 1 with aspect `auto` (r), so wired images staying first matters there.
- **Wording**, one legend line in the entry's syntax, numbered by the image's real position:
  - "Image 3: style reference (colour, light, texture), strong. Image 4: style reference, light hint. Use palette, light, brushwork and texture only; do not copy subjects, UI, text, logos or layout."
  - **The guard sentence** ("Use palette, light, brushwork and texture only; do not copy subjects, UI, text, logos or layout.") is the default closing line of every legend, and of the copy note on entries that skip the legend. It held in GM's comparison on 2026-10-19: none of 12 images copied the references' UI, text, logos or grid, on two content-slot Gemini models, with four of five references being text-heavy UI screenshots. One image per cell and no seed, so directional.
  - Strength words from the weight: 0.75 and up "strong", 0.4 to 0.75 "medium", below 0.4 "light hint". This is wording, not a vendor weight; the paid comparison tests whether it helps.
  - The role comes from the board's mode: `look` "style reference (colour, light, texture)", `world` "world reference (materials, setting)", `subject` "subject reference". FLUX 3 uses its own role words (Subject, Product, Setting, Style) (r).
  - Image notes never go in the legend unless notes are opted in (#18's `sendNotes` / `send_notes`).
  - **A2 asks for a legend on every model without a weight.** An entry may skip it only with a `syntaxReason`, which the contract test requires:
    - Runway gen4 image (and Krea's Runway gen-4): naming an image in the prompt means tagging it (`@tag`), and a tagged image becomes a subject (r). The order and the selection still follow weight.
    - Krea 2 and Krea Seedream 4: the weight is native (`strength`), so A2 doesn't apply.
  - **Plain legends** (`syntax: "plain"`), where a model reads images but has no reference syntax:
    - Lyria: "The first image sets the main mood; the second and third add to it; the fourth is a light hint." Music is "inspired by" the images, with no weights (r).
    - Ideogram v3 style references: "The style references are in order of importance; the first sets the main look." Whether Ideogram reads this is (u); the paid comparison can test it.
  - Cinema's `append_reference_guidance` (`cinema/art_direction.py:108`) becomes a thin caller of the same legend writer, with its output pinned byte for byte by its existing tests. `reference_cap_for` moves into the adapter table's `byModel` limits, and Cinema reads them from there.
- **Native weights (Krea 2, Krea Seedream 4 `style_images[].strength`):** strength = `board.strength × weight`, clamped to the entry's range. Whether the strengths are scaled so they add up to about 1, as Krea advises, is Q21.

#### 5.7.5 Slots kept free for wired images

- Every wired image counts first, on every node, so a person's own reference is never pushed out by the board.
- `needsWired` ports (the image being edited) are never filled from the board.
- `exclusive` ports: if a start or end image is wired, no board references go on that route, and the node says so ("A start image is wired, so board references are off for this run"). Declared per route (`byRoute`), from the code:
  - BytePlus Seedance: first frame, first+last frame and references "are mutually exclusive" (`maker_routes_byteplus_seedance.py:33-36`).
  - MiniMax H3, the source-direct route of `krea-video-minimax-hailuo-3` (`minimax_v2.py:99-101`). That route also caps references at 9 (`:42`).
  - Google, the direct route of `krea-video-google-gemini-omni-flash-1-1` (`maker_routes_google.py:369-373`).
  - **Krea's own routes for these nodes, and `krea-video-minimax-h3-max` and the 1.0 Omni node (Krea only on main):** whether Krea accepts both is (u). The entries declare `exclusive` there too until Krea's schema or a mocked-then-approved run shows it accepts both. A missing board reference costs less than a failed paid run.
  - A contract test runs every maker route of a node with a reference slot (the translator in `execution/maker_routes_*` and then its handler, HTTP mocked) with one start image and one reference. If it refuses (the Google check is in the translator, the MiniMax one in the handler), that node's entry must list the frame ports in `exclusive` for that route.
- Role limits: Gemini 3.1 Flash Image takes 10 object and 4 character images and no style images (r). Board images fill object slots only, so a wired character image keeps its place.

#### 5.7.6 Local images to providers, limits and resizing

One step, `prepare_board_image(path, limits) -> path`, in `services/moodboard_adapters.py`:

- applies EXIF orientation; re-encodes HEIC, AVIF and GIF to PNG or JPEG; downscales to the entry's `maxEdge` and `maxBytes`;
- skips images under `minEdge` (Kling 300 px (r), FLUX 3 256 px (r)) and lists them on the node;
- keeps a request-wide byte budget (`requestBytes`) for inline providers: Gemini and Lyria 20 MB per request (r), fal has no size check in code (`fal_universal.py:52-70`) so its entries set one;
- writes **content-addressed** copies under the output root (`<output root>/board-refs/<sha256 of source bytes + limits>.<ext>`), so the same board gives the same paths and the generator's cache key still hits. The folder is trimmed oldest first above 1 GB;
- returns a path that passes `require_allowed_path`.

| Provider | How the handler sends a local file | Limits the entry carries |
|---|---|---|
| fal | data URI, no size check (`fal_universal.py:52-70`) | `requestBytes` set by the entry (none in code) |
| Runway | data URI up to 5 MB, else an upload (`runway.py:155, 232-245`) | URL 16 MB, data URI 5 MB; under 640 px or over 4K not recommended (r) |
| Krea | asset upload (`krea.py:187-244`) | Krea 3 downsizes over 4 MP, and to 1536 px with 5 or more refs (r) |
| BytePlus Seedance | data URI or URL (`maker_routes_byteplus_seedance.py:372-377`) | (u) |
| Gemini, Lyria | inline data (`google_gemini.py:431-447`) | 20 MB per request (r) |
| Meshy direct | data URI (`meshy.py:101, 341`) | 20 MB (`meshy.py:19`) |
| Replicate | files API (`replicate_model.py:106-121`) | 100 MB |
| Route-table clients | data URI (`route_clients.py:134-139`) | FLUX 3: 256 px to 16 MP per image (r) |
| OpenAI | multipart (`openai_image_v2.py`) | 16 images, under 50 MB each (r) |

#### 5.7.7 Face policy

- `limits.face`:
  - `block`: Seedance 2.x on every route (fal, BytePlus, Krea). BytePlus says no real human faces in references (r).
  - `warn`: Runway gen4 image (public-figure moderation; Nebula never sends `publicFigureThreshold`) and Veo references.
  - `allow`: everything else (no vendor rule found, (u)).
- **How Nebula decides an image shows a real person (Q26 a):** the person's "Real person" mark on the image wins; else the Analyze reading's `people: "photo"`; else the free local face check (`qc_metrics.detect_faces`) on the prepared copy, cached by content hash.
- `block` leaves the image out and says "#4 left out: Seedance blocks real faces · Send anyway". Send anyway is a per-node, per-image choice (`_boardSendAnyway`, a list of image ids). Agents can set it too (§5.7.8); it is undoable and costs nothing beyond the run.
- `warn` on Krea Veo 3.1 references: "Veo reads each reference as one person, character or product. A face here may appear in the clip."
- `warn` sends and shows the warning on the node.
- **After the fact:** BytePlus already maps `SensitiveContentDetected` (`byteplus.py:106`). Its message gains the board images that were sent and "Run without board images".

#### 5.7.8 The per-node "Send board images" switch (A1)

- **One generic hidden param, `_boardImages`:** `"on"`, `"off"`, or absent (= the entry's `default`). It is not added to 308 definitions. The Inspector and the node card show a "Moodboard" row on any node whose Moodboard port is wired and whose entry can take images.
- **What it shows:**
  - Style slots: "Board images: on · up to 10 to Style references". Switching off needs no warning.
  - Content slots: "Board images: off · the brief goes as text". Turning it on shows, once per node: "Board images go in as content. GPT Image may copy what's in them: a painting of a lake can turn up as a lake. Send them anyway?" The card then keeps a small "may copy" chip.
  - `never` entries show no switch. Text-only entries show "This model takes the brief as text."
  - **Picking a first frame (B2's "or pick one").** On a node with a first-frame port, the Moodboard row has "Use a board image as the first frame ▾", listing the scope's images heaviest first. Picking #3 adds an Image Input node holding #3's file and wires it to the first-frame port: one undoable graph edit, like any wiring. It is never automatic, and nothing re-picks it when the board changes. Agents can do the same through `edit_canvas` (it's an ordinary node and edge). The `exclusive` rule then applies as for any wired frame.
- **It changes what a run spends** (references are priced on several models), so it is part of the estimate (§5.7.9), and of the cache key (it is a param).
- **Who can set it:** agents too, like any undoable change, under Justin's agent-freedom rule (per-user setting: "Act directly" sets it, "Ask first" proposes it). The copy warning goes into the agent's tool result. This was Q22; the rule already answers it.
- **Making that possible.** `agent_params.internal_keys` refuses every `_` key except `BILLING_PARAMS` (§3.3). PR14 adds `AGENT_WRITABLE_INTERNAL = {"_boardImages", "_boardSendAnyway"}` beside it in `agent_params.py`, with a test, and `describe_node` / `nebula info` list both on any node whose entry can take images (with their current value and the entry's default). `_lookName` is not in the set: the server writes it (§4.11.7).
- CLI: `nebula set <node> _boardImages=on`. MCP: the same through `edit_canvas`.

#### 5.7.9 Price per reference in estimates and agent spend gates

- **One function, `board_fill(definition, params, wired_counts, route) -> {port: max_count}`**, from the entry, the switch and the active route's limits. It needs no board data, because the limit is known without reading the board.
- `wired_counts` (backend, `model_pricing.py:580`) and `wiredPorts` (frontend, `lib/runScope.ts:166`) add these "board edges" whenever the node's `moodboard` port is wired. Then `(references)`, `ports` rules, the preflight check and agent spend gates (`agent_spend.decide`, `:590`; proposal estimate `main.py:4425-4444`; `GET /api/pricing`) all see the board with no special case.
- **The board fill is clamped to the active route's own limit,** so it never rules a route out or makes Auto stop. A route that takes no references sends text only for that run.
- The engine's real fill never exceeds `board_fill`.
- New `pricing_cases.json` cases keep both sides in step (a Krea 3 run with only a board wired gives `references = some`).
- **Per-reference cost** follows the entry's `costPerRef` (§5.7.2): `priced` and `free` change nothing; `plus` shows the existing `plus` note; `unknown` makes the node unpriced while board images go. Known per-reference charges to model as rows, not notes: MiniMax H3 direct, "first 5 images free; $0.04 per additional image" (MiniMax's page, quoted in `sync-krea-catalog.py:583`); Krea 2, +$0.005 per generation with references (r); Krea 3, already priced.
- **Nodes that get board images by default and have no price row at all** (§3.3): `krea-2-generate` and its three Krea catalog variants, `ideogram-remix`, `-reframe`, `-replace-background`, `-edit`, `-character`, `krea-video-kling-kling-o1`, `krea-video-minimax-h3-max`, `gemini-omni-flash`, `krea-video-google-gemini-omni-flash`, `kling-o3-ref`, `lyria-3`, `meshy-image-to-3d`, `meshy-text-to-3d`, `meshy-retexture`. For each, the PR that adds its entry does one of two things, and says which:
  - adds a verified price row (with `sources`, `checked`, and per-reference terms where the vendor states them); or
  - leaves it unpriced, and the card and the run-cost confirmation show "No list price · board references may add cost". Agents under any USD limit already need a proposal for these (`agent_spend.py:659`).
  - `krea-2-generate` already sends board references today with no price row, so leaving it unpriced changes nothing; PR15 still tries to add the row.
- **Style creation for Recraft (PR24)** is its own line in `estimate_node` (one creation per scope whose style isn't cached) and its own item in `agent_spend.decide`, so a remade style is never a hidden charge.

#### 5.7.10 The A5 contract test

In `scripts/check-node-contracts.mjs` and `backend/tests/test_moodboard_adapters.py` (the mjs side runs from `test_node_contracts.py:366-386`):

1. Every node with an input port `id == "moodboard"` has an entry (TS and JSON both checked, generated Krea nodes included).
2. Every entry's node exists, and every node with a non-text entry has the port.
3. Every `slots[].port`, `never[]`, `needsWired[]` and `exclusive[]` names a real input port of that node, and no port is in two of `slots`, `never` and `needsWired`.
4. **Every input port of type Image or Any on a node with an entry is classified in exactly one of `slots`, `never` or `needsWired`.** Nothing is left unclassified, so a first frame can't slip through because of its name. Names don't find frames in Nebula: `runway-video.image`, `kling-v2-1.image`, `kling-o3.image`, `ltx-2-3.image`, `pika-i2v.image`, `wan-2-6-i2v.image`, `grok-imagine-video.image`, `higgsfield.image`, `seedance-2-i2v.image` and `luma-ray2-i2v.image` are all labelled just "Image", and `runway-aleph.reference` ("Reference Image") is sent as `keyframes[{at: 0}]` (`runway.py:409-415`). Each of these is put in `never` by hand, with the handler line that shows it is a frame in the entry's `sources`.
5. As an extra check on top of rule 4, any port whose id or label says first, last, start, end, tail, frame or `keyframes` must be in `never`.
6. `slots[].max` is at most each route's `ports.<port>.max`, and each `byModel` key names a real enum value.
7. `channel: "views"` has no slots; `default: "never"` and `text-only` have a `reason`; `syntax: null` has a `syntaxReason`.
8. `collage: true` only on a slot with `max: 1` that isn't an edit target or a frame.
9. `sources` and `checked` are dated; `unconfirmed` lists every value not from a source.
10. `moodboard_adapters_krea.json` equals what `sync-krea-catalog.py --check` would write, and no generated entry defaults to `images` on a style field unless its model is in `STYLE_VERIFIED`.
11. Every maker route that refuses a start image plus references has a matching `exclusive` for that route (§5.7.5).
12. **Census** (PR16, PR17, PR18 each extend it): every node in `image-gen`, `video-gen` and `audio-gen` with a prompt port or param has a Moodboard port and an entry, except an explicit list with a reason per node (speech, transcription, translation, dubbing, voice change, isolation, stem splitting, sound effects, lip sync).

`docs/contracts/08-model-contract-pipeline.md` (the add-a-model steps) and `docs/PROVIDER-ROUTES.md` gain "Add a moodboard adapter entry".

#### 5.7.11 Per-node table

Checked against main `12257250` and the TS mirror (16 `dataType: 'Moodboard'` ports = 15 inputs plus the `nebula-moodboard` output). "Port" says whether the node has a Moodboard port today. "Default" is A1's: **images**, **text** (switch available), **never**. "Limit" is board images after wired ones. (r) = research note only; (u) = unverified.

**A. Nodes with a Moodboard port today (15)**

| Node | Slot for the board | Channel | Default | Limit | Notes |
|---|---|---|---|---|---|
| `gpt-image-1-generate`, `gpt-image-2-generate`, `gpt-image-2-5-generate` | none | text-only | — | — | reason: text-to-image |
| `gpt-image-1-5`, `gpt-image-2-fal-generate`, `nano-banana-fal` | none | text-only | — | — | |
| `fast-sdxl` | none | text-only | — | — | negatives already filled (`params`) |
| `flux-2-pro` (FLUX.2 [pro]/[max]/[flex]/[klein]/Flash) | none | text-only | — | — | Takes no images. The page's "FLUX.2: 8 refs" can't be reached; adding `input_image..8` is node work (§8). |
| `gpt-image-1-edit` | none free (`image` is the edit target) | text-only | — | 0 | A3 no |
| `gpt-image-2-edit`, `gpt-image-2-5-edit` | `images` after the edit target | refs | text | 16 − wired (enforced, `openai_image_v2.py:143-181`) | needsWired `images`[0]; mask applies to image 1; "Image N"; $8 per 1M input tokens (r), tokens per image (u) |
| `gpt-image-1-5-edit` | `images` → fal `image_urls` | refs | text | (u) | needsWired |
| `gpt-image-2-fal-edit` | `images` | refs | text | 16 (OpenAI), fal (u) | needsWired |
| `nano-banana` | `images` | refs | text | per model (r): 3.1-flash (default) 10 object + 4 character, 0 style; 3-pro 6 + 5 + 3; 3.1-flash-lite 14; 2.5-flash 3. `gemini-nano-banana-2.1`: text only for now (below) | 3 Pro about $0.0011 per image (r). **Nano Banana 2.1:** the note's line reads "gemini-3.1-flash-image / nano-banana-2.1: 10 object, 4 character, no style", but in Nebula "Nano Banana 2" is 3.1 Flash and 2.1 is a separate model on the Interactions API, so the note likely joins two names. Until Google's page is re-read for 2.1, `byModel` gives 2.1 `channel: text-only` with a reason, and the switch row says "Board images aren't sent to Nano Banana 2.1 yet: its limits aren't confirmed." The run goes ahead with the brief; it never fails for this. |
| `nano-banana-fal-edit` | `images` (required) | refs | text | 14 (NB2/Pro), 3 (2.5) per Cinema's table | needsWired |

**B. Image generators without a Moodboard port (each gains one)**

| Node | Slot for the board | Channel | Default | Limit | Notes |
|---|---|---|---|---|---|
| `krea-2-generate` | `image_style_references` | weighted-style | images | 10 − wired (Nebula's number; Krea's (u)) | Native −2..2 (r); today clamped 0..1, no sum scaling (Q21); +$0.005 per generation (r); no price row. Port `Any` → `Moodboard`. `syntax: null` (native weights). |
| `krea-image-krea-krea-2-{medium,large,medium-turbo}` (generated) | `image_style_references` | weighted-style | images | 10 | `STYLE_VERIFIED`; no price rows |
| `krea-image-bytedance-seedream-4` (generated) | `style_images` | weighted-style | images | (u) | `STYLE_VERIFIED`: `strength` −2..2 on Krea (r); whether Nebula's param carries it (u); if it doesn't, `select` with a plain legend |
| `krea-image-ideogram-ideogram-3` | `style_images` | weighted-style (select) | images | (u) | `STYLE_VERIFIED` (Ideogram 3 style references (r)); `character_reference_images` never |
| `krea-image-runway-gen-4-image` | `reference_images` | weighted-style (select) | images | 3 | `STYLE_VERIFIED`: untagged = style (r); face warn; `syntax: null` (naming = tagging) |
| `krea-image-bytedance-seedream-5-lite`, `-5-pro` | `style_images` | weighted-style (select) | **text** | 14 / 10 | Seedream is a content model under A1; what Krea does with `style_images` here is (u); strength (u) |
| `krea-image-meta-muse-image`, `alibaba-qwen-image-3`, `-2-1`, `luma-uni-1`, `z-image-z-image`, `bfl-flux-1-dev`, `bfl-flux-1-kontext-dev` | `style_images` | weighted-style (select) | **text** | 10, 3, (u), 9, 1, none, 1 | behaviour of each (u): none researched, and FLUX is a content model under A1. Z Image and Kontext dev take 1: A3 candidates; `image_url` is never. Qwen 3, UNI-1 and Z Image have no price row. |
| `krea-image-xai-grok-imagine-2` | `style_images` | weighted-style (select) | **text** | 3 | (u) |
| `ideogram-remix`, `ideogram-reframe`, `ideogram-replace-background`, `ideogram-edit` | `images` (role style → `style_reference_images`) | weighted-style (select) | images | 10 (r), not enforced | `image` is the target (never); can't combine with `style_preset` (r); remix has `negative_prompt` in `falParams`; plain legend; no price rows |
| `ideogram-character` | `images` (style) | weighted-style (select) | images | 10 (r) | `reference_images` / `character` never; `negative_prompt` in `sharedParams`; no price row |
| `ideogram-edit-prompt` | `images` (role unset) | refs | text | (u) | treat as content until verified |
| `runway-image`, model `gen4_image` / `gen4_image_turbo` | `images` (sent untagged = style (r)) | weighted-style (select) | images | 3 − wired | face warn; `syntax: null` (naming = tagging). The port badge says "subject"; fix in PR15. |
| `runway-image`, other models (`gemini_image3_pro` 14, `gpt_image_2` 16, `gemini_2.5_flash` 3, `seedream5_pro` 10, `seedream5_lite` 14) | `images` | refs | text | per model | `byModel` |
| `krea-3` | `images` | refs | text | 8 − wired (route rules) | `style_urls` returns 422 (r); +$0.02 per ref at 1K, +$0.07 at 2K on Krea (r), fal (u); fal route has `negative_prompt` |
| `flux-3-image`, `flux-3-image-klein`, `flux-3-image-klein-base` | `images` | refs | text | 10 − wired, every route | Subject/Product/Setting/Style roles (r); aspect `auto` follows image 1 (r); BFL bills per input MP, rate (u) |
| `flux-1-1-ultra` | `image` (an image prompt) + `image_prompt_strength` | refs | text | 1 | **A3 candidate**; the weight sets which image, and the global strength stays the person's |
| `seedream-4-5` | `images` | refs | text | min(10, 15 − outputs) − wired (enforced on BytePlus) | ModelArk "up to 14" in a code comment (u) |
| `grok-imagine-image-edit` | `images` | refs | text | 5 on xAI direct; fal (u) | needsWired |
| `krea-image-ideogram-ideogram-4-5` | `image_urls` | refs | text | 5 | role (u) |
| `krea-image-ideogram-ideogram-4-5-precise` | `reference_images` | refs | text | 4, or 3 with a mask (enforced) | `image_url` is the target |
| `krea-image-xai-grok-imagine-2-edit` | `image_urls` | refs | text | 3 | |
| `krea-image-openai-gpt-image-2`, `-2-5-flare`, `-2-5-sunburst` | `image_urls` | refs | text | 10 | |
| `krea-image-openai-gpt-image` | `image_urls` | refs | text | 15 | `styles` are Krea style ids, not images |
| `krea-image-google-nano-banana{,-2,-2-1,-pro,-flash-lite}` | `image_urls` | refs | text | Gemini's (r); lite 14 | |
| `quiver-arrow-generate` | `references` | refs | text | 16 on arrow-1.1-max, 4 on arrow-1 / 1.1 | style vs content (u) |
| `meshy-image-to-image` | `images` (required) | refs | text | (u) | |
| `recraft-v4-raster`, `recraft-v4-svg` | none (no image input) | text-only | — | — | palette as data into `colors` / `background_color` (PR21). Style objects need a new path (Q24). |
| `ideogram-v4`, `krea-image-recraft-recraft-v4-1-flash`, `meshy-text-to-image`, `grok-imagine-image`, `flux-schnell`, `krea-image-qwen-2512` (`negative_prompt`), `ideogram-transparent` (`negative_prompt`), other Krea text-to-image nodes | none | text-only | — | — | reason: text-to-image |
| `flux-kontext`, `flux-fill-inpaint`, `krea-image-bytedance-seededit` | none free (edit targets) | text-only | — | — | A3 no |

**C. Video (B2: first and last frames are never filled)**

| Node | Slot for the board | Channel | Default | Limit | Notes |
|---|---|---|---|---|---|
| `kling-o3-ref` (fal) | `images` → `image_urls` | role-slots | images | 7 − wired − frames (r) | "@image_N" (r; fal (u)); min 300 px (r); refer_image vs element on fal (u); `image`, `end_image` never |
| `krea-video-kling-kling-o1` | `style_references` | role-slots | images | (u) | `element_references`, frames, `video_reference` never |
| `seedance-2-r2v` (fal, BytePlus) | `images` (required) | role-slots | images | 9 − wired (BytePlus enforced; fal not) | "[Image N]" (r); face **block**; the board alone can fill the required port |
| `krea-video-bytedance-seedance-2`, `-2-fast`, `-2-mini` | `reference_images` | role-slots | images | 9 | `exclusive` with start/end; face block |
| `krea-video-bytedance-seedance-2-5` | `reference_images` | role-slots | images | 30 | face block; Runway charges nothing for 2.5 refs (r), Krea and BytePlus (u) |
| `krea-video-bytedance-seedance-1-0-pro` | `reference_images` | role-slots | images | 4 | face policy (u) |
| `krea-video-minimax-hailuo-3` | `reference_images` | role-slots | images | 9 (MiniMax route, `minimax_v2.py:42`); Krea's catalog (u) | `exclusive: [start_image, end_image]` on the MiniMax route (`minimax_v2.py:99-101`) and, until verified, on Krea. MiniMax: first 5 images free, $0.04 each after (quoted in `sync-krea-catalog.py:583`). |
| `krea-video-minimax-h3-max` | `reference_images` | role-slots | images | 12 (Krea's catalog; Krea is its only route on main) | `exclusive` until verified (same model family as H3). If a MiniMax route is ever added, it clamps to 9. No price row. |
| `krea-video-google-gemini-omni-flash-1-1` | `reference_images` | role-slots | images | 10 | `exclusive: [start_image]` on the Google route (`maker_routes_google.py:369-373`) and, until verified, on Krea |
| `krea-video-google-gemini-omni-flash` (1.0) | `reference_images` | role-slots | images | 10 | Krea only on main; `exclusive: [start_image]` until verified; no price row |
| `krea-video-alibaba-wan-3-0`, `krea-video-xai-grok-video` | `reference_images` | role-slots | images | 10, 7 | behaviour (u); Grok's price row keys on `reference_images` |
| `gemini-omni-flash` (Google) | `images` | role-slots | images, only when `task` is `reference_to_video` | (u) | Under `task: auto` one image can be read as image-to-video (`gemini_omni.py:200-230`), so no fill there. JSON-only fixes node. No price row. |
| `krea-video-google-veo-3-1`, `-3-1-fast` | `reference_images` | role-slots | images (B2, as decided) | 3 (Vertex enforced) | "asset" = one person, character or product (r), so the face **warn** and a node line: "Veo treats each reference as a subject to show." Refs need 8 s and 16:9 or 9:16 (r): the 8 s rule blocks with a message, never a silent change. `costPerRef: free` (r). |
| `veo-3` (Veo 3.1) | none (`referenceImages` removed, `veo.py:127-132`) | text-only | — | — | `image` = first frame; `negative_prompt` in `falParams` |
| `runway-video` | none (`promptImage` only) | text-only | — | — | `image` is the first frame though its badge says style |
| `luma-ray2-flash-modify` | `image` (role style) | text-only until verified | — | — | A3 candidate only if it's a reference (u) |
| `flux-3-video` | none (`keyframes` are frames) | text-only | — | — | |
| Frame-only and identity nodes: `kling-v2-1`, `kling-v3`, `kling-pro`, `kling-o3`, `luma-ray2-i2v`, `wan-2-6-i2v`, `pixverse-v4-5`, `seedance-v1-5`, `seedance-2-i2v`, `seedance-2-fast-i2v`, `ltx-2-3`, `ltx-video-2`, `ltx-audio-to-video`, `grok-imagine-video`, `higgsfield`, `veo-3-flf`, `pika-i2v`, `minimax-i2v`, `minimax-s2v`, `kling-motion`, `wan-animate-*`, `runway-act-two`, `runway-aleph`, and every first/last-frame-only `krea-video-*` node | none | text-only | — | — | Every Image port in `never` by hand (most are labelled just "Image"; §5.7.10 rule 4). Frames and identities never come from the board, except through "Use a board image as the first frame" (§5.7.8). Negatives fill where the node has the field. |
| Text-to-video nodes: `luma-ray2-t2v`, `minimax-t2v`, `seedance-2-t2v`, `seedance-2-fast-t2v`, `seedance-1-0-t2v`, `ltx-2-3-fast-t2v`, `wan-2-6-t2v`, `hunyuan-video`, and the Krea text-to-video nodes | none | text-only | — | — | the brief and Avoid as text; negatives where the route has the field (`wan-2-6-t2v` does) |

**D. Audio and 3D**

| Node | Slot | Channel | Default | Limit | Notes |
|---|---|---|---|---|---|
| `lyria-3` (`lyria-3-clip-preview`, `lyria-3-pro-preview`) | `images` | music | images | 10 (r, stated for Lyria 3.5 Interactions, which Nebula doesn't run); request 20 MB (r) | `text: "music-direction"`: only the scope's music direction plus a plain legend, never the visual brief; Clip image support (u); no price row |
| Text-only music nodes: `elevenlabs-music`, `stable-audio-25`, `ace-step`, `krea-audio-elevenlabs-music`, `-v2`, `-v2-5`, `krea-audio-bytedance-seed-audio-1-0` | none | text-only | — | — | `text: "music-direction"`: the scope's music direction as text; with none set, nothing goes and the row says "No music direction yet". Never the visual brief. |
| `mmaudio-v2` (sound for a video) | none | text-only | — | — | `text: "music-direction"` as above. Its `negative_prompt` gets nothing from the board: Avoid items are visual ("no text, no logos") and mean nothing to a sound model. |
| `meshy-image-to-3d` | new `texture_image` port | texture-style | images | 1 (1 to 4 on Meshy 7.1 (r)) | `image` (geometry) never; no prompt port, so `textSlot: {param: texture_prompt}` (a fal-only param today; on the direct route the sentence has nowhere to go and the row says so); A3 candidate (u); no price row |
| `meshy-text-to-3d` | new `texture_image` port, if refine takes `texture_image_url` (u) | texture-style, else text-only | images | 1 | `textSlot: {param: texture_prompt}` where the route sends it, so the palette and materials sentence leaves the shape prompt alone; no price row |
| `meshy-retexture` | `image_style_url` (field name (u)) | texture-style, if verified | images | 1 | "Style Prompt" port takes the text |
| `meshy-multi-image-to-3d`, `hunyuan3d-image-to-3d`, `worldlabs-environment`, every `krea-3d-*` | views | views | never | 0 | text where the node has a prompt |

**E. Never a board (no entry, no port).** Real node ids, so the census test can match them:

- Chat and analyzer nodes: `claude-chat`, `gpt-4o-chat`, `gemini-chat`, `nous-portal-universal`, `jev-decide`, `jev-pick-best`, `jev-box`, `qc-camera-geometry`, `ideogram-describe`, `image-compare`.
- Universal nodes: `fal-universal`, `krea-node-app`, `krea-agent`.
- Training and creation: `krea-style-train`, `krea-moodboard-create`, `ideogram-train-model`.
- Utilities: `image-input`, `style-reference`, `reference-set`, `character`, `cinema-scene`, `cinema-color`, `cinema-look`, `spatial-context`, `mask-painter`.
- Transforms, upscalers and edits of an existing clip: `remove-background`, `clarity-upscaler`, `seedvr2-upscale`, `esrgan-upscale`, `recraft-crisp-upscale`, `topaz-image-upscale`, `topaz-video-upscale`, `seedvr-video-upscale`, `flux-video-upscale`, `flux-video-edit`, `runway-upscale`, `ideogram-upscale`, `ideogram-remove-background`, `ideogram-layerize`, `identity-edit`, every `krea-enhance-*`, `quiver-arrow-vectorize`, `sync-lipsync`.
- Audio that isn't made from a description: speech, transcription, translation, dubbing, voice change, isolation, stem splitting and sound effects (`runway-tts`, `runway-sts`, `runway-dubbing`, `elevenlabs-tts`, `elevenlabs-dialogue`, `elevenlabs-sfx`, `elevenlabs-sts`, `elevenlabs-isolation`, `elevenlabs-stt`, `elevenlabs-dubbing`, `openai-stt`, `openai-translate`, `openai-tts`, `gemini-tts`, `demucs`, `kling-video-to-audio`, `krea-audio-elevenlabs-tts`).

If one ever gets a port, the contract test makes it declare an entry.

#### 5.7.12 B4 targets

- **Negative-prompt fields.** Found by today's `has_negative_field` (in `params`; filled once the node has a Moodboard port): `fast-sdxl`, `kling-v2-1`, `kling-v3`, `kling-o3`, `kling-pro`, `wan-2-6-*`, `pixverse-v4-5`, `ideogram-transparent`, `veo-3-flf`, `pika-i2v`, `krea-image-qwen-2512`, and `mmaudio-v2` (which the board leaves alone, §5.7.11 D). Missed today: `veo-3` (`falParams`), `ideogram-remix` (`falParams`), `ideogram-character` (`sharedParams`), `krea-3` (fal route params). PR14's dispatcher resolves the active route's params; PR21 declares and tests them on these nodes.
- **Colour controls usable as palette data:** `recraft-v4-raster` and `recraft-v4-svg` (`colors` as a JSON string of `[{"r","g","b"}]`, `background_color`). Not palette targets: Krea enhance `rescale_color` / `color_preservation` (booleans), `meshy-3d-print` `max_colors` (a count), sticky-note `color`. `cinema-color`'s `palette` is a grade on an existing image, not a generator: out of scope.
- **Aspect params** (134 nodes): `aspect_ratio` enums (most), fal `image_size` presets, OpenAI `size`, Runway `ratio` pixel pairs, `aspectRatio` (`veo-3`), Ideogram `1x1` style. Nodes with `auto` or `adaptive` follow the input image; the board never replaces `auto` when an image is wired. Veo with references allows only 16:9 or 9:16 (r).

---

## 6. PR sequence

PR1 to PR12 keep their numbers and order. The look PRs slot in after PR7 as PR7b, PR7c and PR7d. The adapter PRs are PR13 to PR24. Nothing is renumbered, so links to PR1 on the branch stay right.

### 6.0 Lanes and order

| Lane | PRs, in order | Starts when |
|---|---|---|
| Canvas | PR1 → PR3 → PR5 → PR6 → PR7 → PR7b → PR10 → {PR10b, PR11} (either order); PR2 and PR4 early beside it | now (PR1 merged as #87) |
| Canvas side | PR8 → PR9; PR12; PR7c and PR7d after PR7b | PR5 (PR8), PR7 (PR12) |
| Adapters | PR13 → PR14 → {PR15, PR16, PR17, PR18, PR20 in parallel} → PR21 (after PR15, PR16, PR17) and PR23 (after PR15, PR16; PR20 for Meshy); PR22 after PR14 and PR7d; PR19 after PR4 and PR18 (works from images until PR10 lands); PR24 after PR15 and PR7b | #18 has merged |

- **Hard dependencies.**
  - Anything that edits `services/moodboard_brief.py` (`compose`, the bundle, `apply_to_generator`) comes after #18 merges: PR7b and PR13 onward.
  - Per-look work comes after frames: PR7b after PR7.
  - The node's look picker (PR7d) after PR7b.
- **Adapters don't wait for looks.** They read `bundle.images` and `representativeImages`. Before PR7d those are the Whole board's; after it, one look's. No adapter changes when PR7d lands. A test in PR7d runs the adapter suite on a look bundle.
- **PR14 finishes the dispatcher.** Every hook later PRs need is in PR14 and tested there on fixture entries: `exclusive` per route, `textSlot` as a port or a param, the music-direction text, the negative field resolved from the active route, the palette-param step, the face policy and `requires`. After PR14 no adapter PR changes `apply_to_generator` or the planner; they add entries, ports and tests. A PR that finds it needs a dispatcher change stops and lands that change on its own first, serialized.
- **Running in parallel.** PR15, PR16, PR17, PR18 and PR20 each add their own family's entries and ports. Entries in `moodboard_adapters.json` are kept sorted by node id, and each PR touches only its own nodes, so merges stay mechanical. PR15, PR16 and PR17 all touch `sync-krea-catalog.py`; land them in that order or rebase.
- **Ports before the PRs that test them.** PR21's tests need Moodboard ports on Ideogram and Recraft (PR15), `krea-3` (PR16) and `veo-3` (PR17). PR23's collage candidates need ports on `flux-1-1-ultra` (PR16) and Krea Z Image and Kontext dev (PR15).
- **Never in parallel:** two PRs that change `apply_to_generator`'s dispatch (PR13, then PR14), or `compose` (PR7b and anything else in it).

**Live check, the same for every PR.**

- **Backend:** port 8791, with a temp `HOME`, `NEBULA_SETTINGS_PATH`, `NEBULA_STATE_DIR`, `NEBULA_OUTPUT_ROOT` and `NEBULA_MOODBOARD_ROOT` (CONTRIBUTING.md "Running a second, isolated dev instance").
- **Vite:** port 5791 with `VITE_NEBULA_BACKEND_PORT=8791` (the one pin; it moves the proxy and the page's discovery).
- **Puppeteer:** blocks 8000-8010 and 5173 through CDP `Network.setBlockedURLs`, plus a dead-proxy allowlist (`--proxy-server=127.0.0.1:9`, bypass only 5791 and 8791) as the second layer. Not request interception: it broke the page's cross-origin calls to the backend in PR1's live check. Desktop sizes only: 1440×900 and 1920×1080.
- **Seed:** the golden old-board JSONs (PR1) plus their fixture images, copied into the temp root.
- **Byte check:** sha256 of every board file, then open and close each board in the Studio, then assert the files are unchanged.
- **Providers:** mocked. Adapter PRs assert the exact request each handler would send (recorded schemas in `backend/tests/fixtures/provider_schemas/`). **No paid run without Justin's OK**, and each PR that wants one states the node, the images and the price first.
- Never touch Justin's `nebula` tmux session.
- **Docs and notes:** every PR updates `implementation-notes.md` and the contract 07 changelog. `FORjustin.md` (gitignored, main checkout) is extended by the coordinating session after each PR, never committed.

### PR1: Board model v2, lossless writes (backend; nothing visible)

Status: merged as #87 (`e5072eb2`, 2026-10-19). On Justin's own GM board (4df26f93ff63) the API response only gained frames/readings/suggestions and placements, and the file on disk wasn't rewritten on open (checked by GM - Design after the merge).

- **Goal.** New fields survive every write. Old boards read with a layout and nothing else changes, so the old-board risk is retired first.
- **Scope.**
  - **New `services/moodboard_layout.py`:** `FULL_AREA`, `MIN_WEIGHT`, `weight_of`, `size_for`, `legacy_layout`, `place` (the "after the last one" mode only), and an aspect cache.
  - **`moodboard_store.py`:** `_normalize_images(images, stored)` merges by id and validates placements; new images are placed by the server; `_migrated(board, layout=True)` runs on `get` and `update` only; `frames`, `suggestions` and `readings` are normalized; `layoutVersion` is stamped on the first layout write.
  - **`main.py`:** `MoodboardImageModel` gains `placements`; PUT uses `model_dump(exclude_unset=True)` per image; board-level layout fields are refused.
  - **`handlers/moodboard.py`:** whitelist the bundle image keys `{id, url, weight, notes, excluded}`.
  - **`moodboard_client.py`:** `_steering` uses explicit keys; `get_board` refetches by id after a name match; `brief(board, layout=True)` adds `placements` and `frames` for `show --json` and `moodboard_get`.
  - **`types/index.ts`:** optional fields. **`moodboardToDraft`** keeps placements.
- **What the person sees.** Nothing. `nebula moodboard show --json` lists placements.
- **Tests that fail on main first.** `test_put_keeps_private_note_when_omitted`, `test_put_keeps_placements_from_a_stale_client`, `test_cli_set_on_a_board_with_placements`, `test_cli_layout_change_keeps_analysis`, `test_bundle_images_have_only_output_keys`.
- **New tests.** An old board reads with a grid and the same `source_hash` and `brief_basis`; opening without an edit leaves the bytes unchanged; a new image lands after the last one, with no overlap; the layout is deterministic across two reads.
- **Golden file**, captured on main before any change: `brief`, `analysis_is_current` and the handler outputs for boards before the brief fields, before `privateNote`, with a version 3 and a version 4 analysis, weight 0, excluded, and an unresolvable URL. It must stay identical after every later PR (after #18's one deliberate change).
- **Live check.** The byte check. `nebula moodboard add` on an old board saves the grid with the new image last. An open Studio still edits and autosaves the grid.
- **Docs.** Contract 07 §1.1, §1.5. `implementation-notes.md` (the PUT merge change).
- **Risks.** Image header reads on a large board's GET (cached; `list` skips them). Changing PUT semantics for API callers who relied on "omitted = default" (pinned by tests; the contract says so).

### PR2: One "Set aside" switch (C3, analysis v5)

Can be built alongside PR1; merges after it.

- **Goal.** Set-aside images are read for colours and never steer. Steering outputs are unchanged.
- **Scope.** The analysis changes in §4.4. `ANALYSIS_VERSION = 5`. The List view label "Exclude" becomes "Set aside"; weight-0 tiles dim. CLI `--set-aside N` and `--use N`, with `--exclude/--include` kept as aliases. MCP `moodboard_update` docstring. `brief()` adds `setAside`.
- **What the person sees.** "Set aside" in the List view. After Analyze, set-aside images show their colours. The brief and generator output are unchanged.
- **Tests that fail on main first.** `test_set_aside_is_measured_never_steers`, `test_set_aside_colours_have_no_sources_or_contribution`.
- **New tests.** `test_v4_analysis_stays_current`; the summary count leaves out set-aside images; the all-set-aside warning; Krea's references never include a set-aside image; the pin's steering view is unchanged, plus the new set-aside assertion (Q7); a Studio label test.
- **Live check.** Re-analyze an old board that has an excluded image: palette, brief and Krea references identical, and the image's colours appear.
- **Docs.** Contract 07 §1.1 and §1.3a. `skills/nebula/SKILL.md`. `docs/MCP-SETUP.md:1142+`. The `INSTRUCTIONS` moodboard paragraph.

### PR3: Checked board edits, journal and live Studio (backend + Studio plumbing)

- **Goal.** No writer can overwrite another, and an open Studio follows outside edits.
- **Scope.** New `services/moodboard_edits.py` (parse, validate, apply and inverse for §5.1 minus `arrange` and `look.*`). `POST /api/moodboards/{id}/edits`, `baseVersion` on PUT (409), the richer broadcast, journal kinds plus PUT diffs. `moodboard_client.edit_board`; `add_to_board` uses the `add` op; `previous` comes from the route's `undo`. Studio: grid edits become ops through the queue (§5.3); PUT carries board fields only; the open draft refetches and rebases.
- **What the person sees.** A CLI `add` or `set` appears live in an open Studio and is no longer overwritten by its autosave.
- **Tests that fail on main first.** A Studio `storedAssetChanged` for the open board updates the draft; a CLI `add` racing a Studio weight edit keeps both; a stale `baseVersion` returns 409.
- **New tests.** Atomic batches; the inverse round-trips; partial `restore`; a move keeps the analysis and a resize sets weight from area; journal kinds and actors; an agent can't send a tab; a private note is never journaled with its text; every pinned board's hash is unchanged after a layout-only write; the existing Studio test file stays green.
- **Live check.** `nebula moodboard add` while the Studio is open: the tile appears without a reload; edit a note and both survive. Byte check.
- **Docs.** Contract 07 §1.3 and a new §1.12 "Board edits". `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`.

### PR4: Reader dry run, price and spend gate (backend + CLI)

Runs alongside PR3 and PR5.

- **Goal.** Retire the model-quality and price unknowns before any Analyze UI.
- **Scope.** `services/moodboard_reader.py`, both phases (§5.6), and the trace's reader half (§5.6.1): batch-local labels, the schema with `ref` first through `responseFormat`, `services/moodboard_reader_stream.py` (thought parts kept apart, every part joined, JSON scanned as it arrives, `focus` and `item` calls), each item checked, the retry for missing refs (split after `MAX_TOKENS`), reasons trimmed and stripped of labels, and the time bounds. `data/moodboard_reader_models.json`, with `streams`, `thoughtSummaries`, the reader's name and colour, and thinking allowances per level. `POST …/read/estimate` and `POST …/read?dryRun=1`. CLI `nebula moodboard analyze <board> --read-with gemini-4-argon --dry-run [--only 3,5]`. MCP `moodboard_analyze(read_with, dry_run)`. The spend gate for agents. The reader's text-call helper is written so PR19 can reuse it for the music direction.
- **What the person sees.** In the CLI, a priced dry run that prints the trace lines.
- **Tests.** Recorded provider responses; more than 13 images per run; batching and the schema; a retry on malformed JSON; partial failure leaves those images unsorted; the estimate maths; an agent is refused when any USD limit is set and the read is unpriced; the hold is given back when the key is missing; the person passes.
- **Live check.** A mocked provider. One real Argon probe with Justin's key, only after he approves the spend. It also measures what §5.6.1 leaves unconfirmed: bytes during thinking, time to the first item per level, `thoughtsTokenCount`, and, in a second request with `includeThoughts`, whether summaries come back alongside the schema on image batches and what they add to the output tokens. That result sets Argon's `thoughtSummaries` (Q29 c).
- **Docs.** `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`, contract 07 new §1.13 "Reading references".

### PR5: The Board view (preview, behind a switch)

- **Goal.** Retire the React Flow feel and speed risk on real boards.
- **Scope.** `BoardCanvas.tsx` (own `ReactFlowProvider`), `BoardCardNode.tsx`, `BoardSidePanel.tsx`, `MoodboardListView.tsx` (today's grid, moved unchanged), `boardCanvasStore.ts`, `boardUndo.ts`. Rail | canvas | panel layout. A Board/List switch remembered per viewer in `localStorage` (try/catch); List stays the default. Interaction from `CANVAS_INTERACTION_PROPS`. `visibleFlowRect` moves into `lib/`. Thumbnails unless a card is wider than about 480 css px. `onlyRenderVisibleElements`. One `place` op per drag. File drop at the pointer. Side panel: a selected reference's notes, colours, Set aside and weight; with nothing selected, the board fields, `BriefFields`, the brief and swatches. Studio undo and keys (§5.4). An empty background layer under the cards, which PR10b's ripple fills.
- **What the person sees.** A "Board" switch. His board as a canvas in the same order, with nothing moved.
- **Tests.** Provider isolation; cards at server positions; one op and one undo step per drag; a foreign edit rebases without losing a pending note; List and Board stay consistent; opening doesn't set `dirty`; Cmd+S doesn't trigger the graph save; Delete removes and offers Undo.
- **Speed check.** 300 references: drag 400 px, pan and fit; rAF frame p95 under 20 ms. The PR states the number.
- **Live check.** Screenshots at fit, 40% zoom and mid-drag, plus the List view. Byte check.
- **Docs.** Contract 07 §1.7.

### PR6: Size is weight (C2), badges, motion; Board becomes the default

- **Goal.** Feature parity with the grid, so the canvas can be the default view.
- **Scope.** Corner `NodeResizeControl` with `keepAspectRatio`; the weight readout pops on each 0.05 step; one `resize` op on `onResizeEnd`; capped at full weight. Badges `#n · w`, note dots, set-aside dim. The List view slider resizes the card. **Measure follows steering edits (Q9)** 1.5 s after the last one; once PR7b lands it re-rolls only the scopes whose hash moved. Motion tokens in `moodboard-canvas.css` sampled by `lib/springs.ts` as `linear()` curves: `--mb-spring-move` (k 380, c 34, about 420 ms), `--mb-spring-pop` (k 500, c 36, 320 ms), `--mb-spring-soft` (k 220, c 28, about 520 ms). Drag lift 1.04 on a spring. Programmatic moves staggered 18 ms by number, capped at 500 ms. Camera moves eased by the sampled spring. Reduced motion sets durations to 0. Board becomes the default view.
- **What the person sees.** A big card counts more, and the weight shows while he resizes. The board opens as a canvas.
- **Tests.** Badge maths match the server's rounding; resizing one card never changes another's badge; the cap; a vitest fails if `moodboard*.css` contains `ease-in-out` or bare `ease`.
- **Live check.** Screenshots during a resize. A real resize changes the palette shares after Measure.
- **Docs.** Contract 07 new §1.14 "The canvas: size, weight, frames" (size and weight).

### PR7: Frames and linked copies by hand (C4, C13)

- **Goal.** Looks you draw and name. One image can sit in several looks.
- **Scope.** Frame node below cards, tab as drag handle, `NodeResizer` with the members' bounding box as minimum. F draws a frame, Cmd+G frames the selection, inline naming, tab "Painterly · look · 7". Membership on drop; moving a frame moves its members. Merge by dropping a tab onto another frame; split with "New look from these"; deleting keeps the cards. Linked copies by Option-drag or "Also in ▾", with the chip and a weight per look. Unsorted dashed. List view Looks column and weight per look. CLI `set --in`, `--link`, `nebula moodboard frame new|rename|merge|delete`; `show` lists looks. MCP frames and copies in `moodboard_get`.
- **What the person sees.** He can draw and name looks, drag references into them, and have one reference in two looks at different sizes. The brief is still the Whole board's until PR7b and PR7d.
- **Tests.** Nearness doesn't make a member; one copy per frame; linked copies share notes and the reading; `image.weight` is the largest copy; moving a frame moves its copies; `compose` and `source_hash` are identical before and after framing a board; the Q5 and Q6 rules.
- **Live check.** Screenshots of frames, a linked copy with its chip, and a merge. Undo of each frame op.
- **Docs.** Contract 07 §1.14 (frames and linked copies). `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`.

### PR7b: Per-look analysis and brief (backend) — new

- **Goal.** Each look has its own analysis, its own brief and its own words, and Whole board stays exactly today's.
- **Scope.**
  - `measure_board` / `roll_up_scope` split in `moodboard_analysis.py` (§4.11.2); `look_source_hash`, `look_analysis_is_current` (§4.11.3).
  - `compose(board, look=None|F)`, `look_brief_basis` and the field rules of Q20 in `moodboard_brief.py`; #18's `colorCheck` per scope with its own basis (`look_colour_check_basis`), refreshed in the same write as `look.set`, `look.inherit` and board-word PUTs, and checked in memory by `compose` when stale (§4.11.3).
  - Store: `lookFields`, `lookAnalyses`, `lookAliases` (§4.1), refused on PUT; `lookAnalyses` written by Measure; the slot for `musicDirection` in `lookFields` reserved for PR18.
  - Ops `look.set` and `look.inherit` with undo, the person gate and #18's notes gate. Journal kind `board.look`.
  - Frame-op cleanup: `frame.delete` and `frame.merge` carry look maps in their undo slices, merge adds an alias, and Q28's rule refuses an agent's or Analyze's delete or merge of a look holding the person's words.
  - The heaviest look (§4.11.6) as a shared function.
  - `look` report and the per-turn board block gain per-look lines (if PR8 and PR9 are in; else they add them).
  - CLI `nebula moodboard show <board> [--look NAME]` (a "Looks" section only when the board has looks), `set <board> --look Dither --direction …|--avoid …|--pin …|--keep-out …|--keep-anyway …|--brief-override …|--inherit direction`, `analyze` prints the looks. MCP `moodboard_get(look=)`, `moodboard_update(look=, …)`.
- **What the person sees.** In the CLI, `show --look Dither` prints Dither's own brief and colours. Nothing in the Studio yet (PR7c).
- **Tests that fail on main first.**
  - `test_look_analysis_uses_card_weights_and_board_numbers`.
  - `test_look_hash_ignores_layout_and_tracks_membership`.
  - `test_look_brief_basis_follows_board_direction_when_inherited`.
  - `test_avoid_adds_and_direction_replaces` (Q20).
  - `test_frame_delete_carries_look_fields_in_undo`, `test_merge_adds_alias`.
  - `test_agent_cannot_delete_look_with_person_words` (Q28).
  - `test_board_direction_edit_updates_inheriting_look_left_out`: a board Direction PUT changes an inheriting look's `leftOut` in the same write, and a look with its own Direction keeps its list.
  - `test_look_set_refreshes_look_colour_check`.
- **New tests.** A frameless board writes no look keys and its golden outputs are unchanged; Measure measures each image once (counted) and rolls up per look; speed at 300 images in 20 frames, with the number in the PR.
- **Live check.** Isolated stack: draw three looks on a seeded board through the CLI, Measure, `show --look` each; byte check on frameless boards.
- **Depends on.** PR7, PR3, PR2, and #18 merged.
- **Docs.** Contract 07 new §1.15 "Looks: one brief per look". `skills/nebula/SKILL.md` ("pick a look on the Moodboard node; Whole board mixes looks"), `docs/MCP-SETUP.md`, the MCP `INSTRUCTIONS` paragraph.
- **Risks.** Roll-up speed with many looks (measured). #18 changes on review before it merges (the plan follows `e457b51d`; rebase on what merges).

### PR7c: The look panel in the Studio — new

- **Goal.** See and edit each look's brief where the look is.
- **Scope.** The side panel's scope: nothing selected → Whole board; a frame's tab clicked or frame selected → that look; cards selected → those references. A scope switcher at the top ("Whole board · Painterly · Dither · Glass", heaviest first, with counts). The look panel: "Brief sent to generators", the look's swatches with left-out colours dimmed, #18's lists for that look (Left out / Keep anyway / May clash / Pinned colours that clash), the fields with "From the board" / "This look only", the look's hand-written brief with its own "changed since you edited this", Keep and Regenerate (`brief-override/keep` gains a look variant), the members and weights, and the empty-look warning. The frame-tab dot. The List view's "Show: Whole board / Painterly / …" filter, with the card weight in that look (editing it resizes that copy only).
- **What the person sees.** Click a look's tab and read its own brief and colours. Write a Direction for that look only.
- **Tests that fail on main first.** Clicking a tab shows that look's brief; a field set to "This look only" sends `look.set`; "Use the board's" sends `look.inherit`.
- **New tests.** The scope switcher order; the dot on a stale look brief; the List filter edits one copy only; undo of a look field.
- **Live check.** Screenshots of the Whole board panel, a look panel with inherited and own fields, and a Left out list.
- **Depends on.** PR7b, PR5, PR6.
- **Docs.** Contract 07 §1.15 (the Studio part).

### PR7d: The Moodboard node picks a look — new

- **Goal.** A node sends one look (A4), chosen on the node, and never switches by itself.
- **Scope.**
  - Param `look` (type `moodboard-look`) and hidden `_lookName` on `nebula-moodboard`, beside `moodboard` and #18's `send_notes`, in `nodeDefinitions.ts` and by hand in `node_definitions.json` (no kept `export-node-defs.ts` run); regenerate `docs/MODEL_REFERENCE.md`. The server writes `_lookName` whenever `look` is set.
  - Inspector `moodboard-look` picker (a new branch beside `Inspector.tsx:631`), heaviest first.
  - Stamping the heaviest look when a board is picked, a node is created with a board, or an agent sets `moodboard` without `look` (Q19), in the frontend and in `agent_params` / `canvas_proposals`, which also resolve a look name to its id.
  - The card shows "board X · look Dither" and the "This board has 3 looks · Pick one" hint.
  - Handler: the look bundle (§4.11.8), including the look's generator view of the analysis and `providerHints` rebuilt from the look; alias following with a run note; the stop messages for a deleted or empty look.
  - Dragging a look's tab from the Studio onto the canvas makes a Moodboard node set to that look.
  - `describe_node` and `look_at_canvas` lines.
- **What the person sees.** A "Look" picker on the Moodboard node, set to the heaviest look. Generators wired to it get that look's images and brief.
- **Tests that fail on main first.**
  - `test_look_bundle_has_only_member_images_at_card_weights`.
  - `test_krea2_strengths_follow_the_look` (no Krea handler change: `providerHints.krea` is rebuilt from the look, §4.11.8).
  - `test_look_bundle_has_no_non_member_url` (walks every string in the bundle, `analysis` and `providerHints` included).
  - `test_old_node_without_look_reads_whole_board` with a golden bundle.
  - `test_deleted_look_stops_the_run`.
- **New tests.** Stamping in each of the three paths; merge alias run note; the adapter suite run on a look bundle; the look name resolver refuses Unsorted and ambiguous names.
- **Live check.** Mocked Krea: two Moodboard nodes on one board, each set to a different look, wired to two Krea 2 nodes; assert the two request bodies. Screenshots of the picker and the hint.
- **Depends on.** PR7b. Q18 and Q19.
- **Docs.** Contract 07 §1.15 (the node); `skills/nebula/SKILL.md`; `docs/MCP-SETUP.md`; `MODEL_REFERENCE.md`.

### PR8: Agents see the board, and placement next to the view (C8, read half of C9)

- **Goal.** An agent can see what Justin sees on the board.
- **Scope.** The Studio view reporter and `BoardViewBook`. The `look` and `picture` routes. MCP `moodboard_look` and `moodboard_picture`; CLI `look` and `picture`. `studio` in `look_at_canvas`. `place()` with the view mode. `add --at/--in/--size` and the matching `moodboard_add` arguments. The Studio cursor layer. New tools in `NEBULA_MCP_TOOLS` (`krea_agent_mcp.py:38`) and the allow-list (`agent_profiles.py:70`).
- **What the person sees.** "Claude, put these in free space" lands next to what he's looking at, and the cursor shows where.
- **Tests.** Placement prefers the visible area, and goes after the last card when the report is stale; never overlapping (property test over 500 random boards); the look report's shape; the private note flagged; the picture renders headless; `test_agent_mcp_registration.py`; the instructions test; the CLI help verbs.
- **Live check.** An agent adds three references while the Studio is panned to one corner: they land in view.
- **Docs.** `INSTRUCTIONS`, `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`, contract 07.

### PR9: Agents edit the board, recent edits, undo credit (write half of C9)

- **Goal.** Agents change the board the way they change the canvas.
- **Scope.** MCP `moodboard_edit` and CLI `nebula moodboard edit`; the cursor follows each batch. The "Since your last turn" block (with `board.look` events once PR7b is in) and the board context for all three runners. The chat payload's `studio` field. The foreign undo step and notice in the Studio.
- **What the person sees.** "Claude moved #12 into Dither · Undo". The agent knows what he moved since its last turn.
- **Tests that fail on main first.** An agent's edit undoes as one step in the Studio; the next turn lists the person's moves.
- **New tests.** A private note never appears in the per-turn block; canvas chat behaviour is unchanged; an agent can't spoof a tab.
- **Risks.** Boards can be Global while the journal is project-tagged (§5.2). Test reading a Global board's events from inside a project.

### PR10: Analyze sorts into looks (C10, C11, C12)

- **Goal.** One button turns a pile into an editable first draft.
- **Scope.** The bar ("20 new references · not analyzed", "Analyze ▾"). The menu with prices, cancel and progress ("Analyzing with Gemini 4 Argon · 7 of 20", "Read with Gemini 4 Argon · sorting into looks", "Sorted 19 into 4 looks · 1 Unsorted · Undo"). One in-memory job per board, WS `moodboardRead` and `moodboardReadTrace` (§5.6.1), `GET …/read`, `GET …/read/{job}?afterSeq`, `DELETE …/read/{job}` with §5.6.1's cancel rules, and the job's trace ring. Targets per C11. One edit batch from the reader (actor kind `reader` in `canvas_events`, with `requestedBy`; `lastRead.requestedBy` and `summary`), journaled `board.sorted`, one undo step; C12 b). Unsorted in free space. Cards spring into frames. **Measure runs per look in the same run** (free). Analyze never deletes or merges a frame that holds words the person wrote. The music direction is not part of the sort (PR19). CLI and MCP without `--dry-run`: the CLI prints lines live (`--quiet`, `--json`), MCP adds `moodboard_read_status`. The bar shows the counter strings; the overseer panel and ripple are PR10b. The side panel shows the reading, read-only (Q12). If Q26 a, phase 1 also returns `people`.
- **What the person sees.** The full flow from GM's video, frames 2 to 2b, and each new look's own brief right after.
- **Tests.** The C11 rule matrix; C12 b) with one Undo; a named frame is never renamed; a frame with person words is never deleted or merged; partial failure lands in Unsorted with a "couldn't read" dot; cancel gives back unstarted batches; the button waits for the estimate; an agent-run Analyze goes through the gate; per-look analyses are current after the run.
- **Live check.** Mocked provider for the flow and screenshots. One real run only with Justin's approval.
- **Depends on.** PR4, PR7, PR7b.
- **Docs.** Contract 07 §1.13. `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`.

### PR10b: Analyze as an overseer in the Studio (GM's mockup v5; Q29) — new

- **Goal.** While Analyze runs, the person watches the reader work: the board ripples, a panel streams its lines, and the cards it names light up.
- **Scope.**
  - The panel that drops from the Analyze bar, titled "Gemini 4 Argon · reading". Lines by `source`; clicking a line selects and frames its cards. It closes into the bar's last line.
  - `--reader-color`.
  - The pulse on cards in flight, the lavender outline on `focus`, and the settle on `reading`. Linked copies per C13 (§5.6.1).
  - The ripple layer behind the cards in `BoardCanvas` (PR5's reserved slot), starting from `targets`, then each batch's `inFlight`. Tuned springs, not stock easing.
  - Catching up through `afterSeq` on open, reconnect and a `seq` gap.
  - The dim "thinking (summary)" stream (Q29 c): italic, below a dashed rule that appears with the first `thought` line, never outlining a card. Absent for a model that gives no summaries.
  - Reduced motion: a static tint, no ripple.
- **What the person sees.** Mockup v5 on his own board.
- **Tests.** Outlines on the right placements; nothing outlined from a `thought` line; no dashed rule or heading when a run has no `thought` lines; a gap in `seq` fetches the missing lines; reduced motion.
- **Speed check.** PR5's 300 references with the ripple and 12 outlines on: rAF frame p95 under 20 ms.
- **Live check.** A mocked stream; screenshots at 1440×900 and 1920×1080 mid-run and at the end.
- **Depends on.** PR10. The thought stream shows only once PR4's probe sets Argon's `thoughtSummaries` to `true`; with it `false`, PR10b ships as b) and the stream code stays for the next model that gives summaries. Q29 c is built as the mockup shows it: visible, not collapsed, and with no Settings switch.
- **Docs.** Contract 07 §1.13.

### PR11: Second-look and hybrid suggestions (C13 from Analyze)

- **Scope.** "Fits Dither too?" chips with accept or dismiss, voiced "Gemini 4 Argon suggests …" from `suggestions[].model`; accepting creates a linked copy in free space in that frame, at the same weight. The hybrid suggestion ("Make a 'Painterly × Pixel' look for #3, #9, #14?"); accepting creates the frame, moves those references in (Q10), replaces their `alsoIn` suggestions; one Undo. CLI `nebula moodboard suggestions [--accept ID|--dismiss ID]`; suggestions in `moodboard_look`. An accepted suggestion makes the target look stale by hash; Measure re-rolls it.
- **Tests.** A second frame is never added without an accept; a hybrid replaces the pair suggestions; a dismissed suggestion never comes back.

### PR12: Arrange (C8)

Runs alongside PR9 to PR11.

- **Scope.** An `arrange(by, scope)` op computed on the server. CLI `nebula moodboard arrange <board> --by look|colour|weight [--only …]`, MCP `moodboard_arrange`, a "Tidy ▾" menu. By look: frames packed in a grid, cards inside them. By colour: dominant hue from `analysis.images` (measures first if stale). By weight: heaviest first. It never changes sizes, memberships or `images[]` order, so no look goes stale. One Undo.
- **Tests.** No overlap; numbers unchanged; idempotent; look hashes unchanged.

### PR13: Adapter table, dispatcher and contract test (A5) — new

- **Goal.** Every node that can take a board says how, in one table, and a test refuses a Moodboard port without an entry. Nothing a generator receives changes.
- **Scope.**
  - `backend/data/moodboard_adapters.json` with the 15 existing Moodboard-port nodes and `krea-2-generate` declared truthfully (§5.7.11 A): text-only, or `refs` with `default: "text"`, or Krea 2's `weighted-style` with `handler: "reads-board"`.
  - `services/moodboard_adapters.py`: load, validate (dated sources, `unconfirmed`), resolve per model and route.
  - `apply_to_generator` resolves the entry and sends today's text fold through it unchanged, early return included (§5.7.3 steps 1, 2 and 8). `_HANDLER_READS_BOARD` retired.
  - Krea 2's `moodboard` port: `Any` → `Moodboard` (TS and JSON by hand; `MODEL_REFERENCE.md` regenerated).
  - The contract checks (§5.7.10) in `check-node-contracts.mjs` and `test_moodboard_adapters.py`.
  - `sync-krea-catalog.py` writes `moodboard_adapters_krea.json` (empty until PR15 and PR16 add ports) and has a `--check` mode.
  - `GET /api/moodboard/adapters` and a frontend store. The node card's Moodboard row shows "This model takes the brief as text" or "Board images: off · the brief goes as text" (no switch yet).
- **What the person sees.** A line on wired Moodboard nodes saying what the board does there. Every output identical.
- **Tests that fail on main first.**
  - `test_every_moodboard_port_has_an_adapter_entry` (no table on main).
  - `test_krea2_moodboard_port_is_a_board_port` (`has_board_port` is false on main).
  - `test_every_image_input_is_classified` (a fixture entry that leaves `runway-video.image`, labelled just "Image", out of `never` must fail).
  - `test_syntax_null_needs_a_reason`.
- **New tests.** The golden file unchanged; `apply_to_generator` output equal to main's for every existing Moodboard node and board shape in the golden set; a missing entry at run time falls back to text with a run note; `--check` passes.
- **Live check.** Isolated stack: wire a board into each of the 15 nodes and Krea 2, run them with mocked providers, and diff the request bodies against main's (identical). Screenshot of the card line.
- **Depends on.** #18 merged.
- **Docs.** Contract 07 new §1.16 "Moodboard adapters"; `docs/contracts/08-model-contract-pipeline.md` and `docs/PROVIDER-ROUTES.md` ("add a moodboard adapter entry"); AGENTS.md gets one line under "Other conventions".
- **Risks.** Saved graphs that wired a non-board value into Krea 2's old `Any` port become invalid edges. PR13 scans saved graphs on the isolated stack's fixtures and states how they load; if any exist, the loader keeps the edge and flags it rather than dropping it.

### PR14: Board images on content slots: the shared path, the switch and A2 — new

- **Goal.** Board images can reach GPT Image edits and Nano Banana, by the person's choice, heaviest first, with each image named in the prompt, and priced.
- **Scope.**
  - **The whole dispatcher (§5.7.3 steps 3 to 7)**, so later PRs only add entries: the early return on a missing prompt goes; `textSlot` as a port or a param; `text: "music-direction"`; the negative field resolved from the active route's params; the palette-param step; `exclusive` per route; `needsWired`; `requires`; the face policy hook (the detector itself is PR17). Each is tested here on fixture entries.
  - `plan_board_fill` (§5.7.4) with candidates limited to images the scope's analysis read, `prepare_board_image` (§5.7.6), the legend writer with `plain` legends and `syntaxReason` (Cinema's `append_reference_guidance` becomes its caller), `local_media_ref` after `_local_media_inputs`, the async engine call.
  - The generic `_boardImages` and `_boardSendAnyway` params, the switch on the card and in the Inspector, and the copying warning (§5.7.8). `AGENT_WRITABLE_INTERNAL` in `agent_params.py` so agents can set both; `describe_node` and `nebula info` list them.
  - `board_fill` in `wired_counts` and `wiredPorts`; `pricing_cases.json` cases; `costPerRef` (`plus` note, `unknown` = unpriced while board images go).
  - Run notes and the fill report; a test that the real fill never exceeds `board_fill`.
  - Six of the seven Moodboard nodes that take images get their slots live: `gpt-image-2-edit`, `gpt-image-2-5-edit`, `gpt-image-1-5-edit`, `gpt-image-2-fal-edit`, `nano-banana`, `nano-banana-fal-edit` (`needsWired` on the edits), with per-model limits for Nano Banana. The seventh, `gpt-image-1-edit`, has no free slot (its one image is the edit target) and stays text only. Nano Banana 2.1 stays text only with a node line (§5.7.11 A).
- **What the person sees.** On those nodes: "Board images: off · the brief goes as text" with a switch. Turning it on shows the copying warning. A run then sends up to N board images after his own, and the run note lists them by number.
- **Tests that fail on main first.**
  - `test_gpt_image_2_edit_sends_board_images_after_wired_when_on`.
  - `test_edit_node_without_wired_image_sends_no_board_images`.
  - `test_board_images_are_local_paths_after_engine_media_step`.
  - `test_wired_counts_include_board_fill`.
  - `test_legend_never_includes_image_notes_unless_opted_in`.
  - `test_board_text_goes_into_prompt_param_when_port_unwired` (fixture modelled on a Krea catalog node whose prompt is a param).
  - `test_board_applies_to_node_without_prompt_port` (fixture modelled on Meshy Image to 3D: `texture_prompt` param, no prompt port).
  - `test_exclusive_route_sends_no_board_refs_when_start_image_wired`.
  - `test_negative_field_resolved_from_active_route_params`.
  - `test_music_entry_gets_music_direction_not_brief`.
  - `test_agent_can_set_board_images_switch` (refused on main by `internal_keys`).
  - `test_unreadable_board_image_left_out_with_note` (an external https image is never sent).
- **New tests.** Order and dedupe by URL; per-model limits for `nano-banana`; 2.1 sends the brief only, with the node line, and the run doesn't fail; the request byte budget; content-addressed copies keep the cache key across two runs; Cinema's legend unchanged byte for byte; the switch off sends exactly today's output; `costPerRef: unknown` makes the node unpriced only while the switch is on; the golden set gains a board whose only heavy image is an external URL, and the planner's choice equals `representativeImages`.
- **Live check.** Mocked OpenAI and Google: assert multipart image order and the legend text. Screenshots of the switch, the warning and the run note. One real `gpt-image-2-edit` run with three board images only with Justin's OK and the price shown.
- **Depends on.** PR13.
- **Docs.** Contract 07 §1.16 (selection, order, wording, switch, dispatcher); `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md` (`_boardImages`); the GPT Image and Gemini `.agents/skills` notes on board images.

### PR15: Style slots by default (A1) — new

- **Goal.** Style-slot models take the board's images without being asked.
- **Scope.**
  - Krea 2 moves onto the planner (`handler: "reads-board"` removed; the handler only maps `{url, strength}`), with the golden file proving identical refs and strengths unless Q21 says otherwise.
  - Moodboard ports and entries for the Ideogram v3 style nodes (`ideogram-remix`, `-reframe`, `-replace-background`, `-edit`, `-character`), with plain legends, and `runway-image` (`byModel`: gen4 style slot with `syntaxReason`, others content).
  - Every Krea catalog `style_images` / `image_style_references` node through `sync-krea-catalog.py`. **Images by default only for `STYLE_VERIFIED`** (Krea 2 variants, Seedream 4 with native strength if Nebula's param carries it, Ideogram 3, Runway gen-4 image); every other one (Seedream 5, Flux dev, Kontext dev, Qwen, Z Image, UNI-1, Muse, Grok Imagine 2) defaults to text behind the switch and its copying warning.
  - Runway's face warning on the card. The wrong "subject" badge on `runway-image.images` is corrected.
  - Price rows: for each default-images node here with none (`krea-2-generate` and its variants, the five Ideogram v3 nodes), add a verified row or show "No list price · board references may add cost" (§5.7.9), and say which in the PR.
  - Recraft: text-only entries now (Q24 decides PR24).
- **What the person sees.** Wiring a board into Ideogram Remix or Runway gen4 Image sends its images as style references by default, with "Board images: on · up to 10 to Style references" and a switch to turn them off.
- **Tests that fail on main first.** `test_ideogram_remix_gets_board_style_images_by_default`; `test_runway_image_gen4_board_images_untagged_other_models_text`; `test_krea_catalog_style_nodes_have_board_ports`; `test_unverified_krea_style_fields_default_to_text` (Seedream 5, Flux dev).
- **New tests.** Krea 2 golden unchanged, including the golden boards with an external or unreadable image (the planner leaves out exactly what `representativeImages` leaves out); Ideogram `style_preset` and board style images can't both go (the node says which wins); `sync-krea-catalog.py --check`.
- **Live check.** Mocked Ideogram, Runway and Krea. One real run per family only with Justin's OK.
- **Depends on.** PR14. Q21.
- **Docs.** Contract 07 §1.16; `.agents/skills` notes for Krea, Ideogram, Runway; `MODEL_REFERENCE.md`.

### PR16: A board port on every other image generator — new

- **Goal.** Every image generator can take a board: content slots behind the switch, text-only where there's no image input.
- **Scope.** Ports and entries for FLUX 3 (`flux-3-image`, `-klein`, `-klein-base`, per route), `krea-3`, `seedream-4-5`, `flux-1-1-ultra`, `grok-imagine-image-edit`, `quiver-arrow-generate`, `meshy-image-to-image`, `ideogram-edit-prompt`, the Krea catalog content nodes (through the sync script), and text-only entries on the text-to-image nodes in §5.7.11 B. The census check (§5.7.10 rule 12) for `image-gen`: every node with a prompt port or param has a Moodboard port, except a short listed set with reasons. `flux-1-1-ultra` has no price row: add one or show the marker (§5.7.9).
- **What the person sees.** A Moodboard input on these nodes. On FLUX 3, Krea 3 and Seedream, the same switch and warning as PR14.
- **Tests that fail on main first.** `test_krea3_board_images_priced_as_references` (`references = none` on main); `test_flux3_wired_images_stay_first`; `test_every_image_generator_has_a_board_port`.
- **New tests.** Seedream's outputs-plus-references limit; Krea 3's 1536 px downscale with 5 or more references; per-route limits on FLUX 3.
- **Live check.** Mocked providers per route.
- **Depends on.** PR14. Parallel with PR15.
- **Docs.** Contract 07 §1.16; `MODEL_REFERENCE.md`; `.agents/skills` for BFL, Krea, fal.

### PR17: Video reference slots and the face policy (B2) — new

- **Goal.** Video reference slots get the scope's top images; frames never do.
- **Scope.**
  - Ports and entries for the nodes in §5.7.11 C: role slots on Kling O3 Ref, Kling o1 (style references), Seedance R2V and the Krea Seedance, Hailuo 3, H3 Max, Wan 3.0, Gemini Omni and Grok video nodes; text-only on frame-only, identity and text-to-video nodes, every Image port classified by hand; `gemini-omni-flash` fills only for `task: reference_to_video`; Krea Veo 3.1 references on by default as B2 decided, with the face warning and the "Veo treats each reference as a subject" line.
  - `exclusive` entries (the dispatcher hook is PR14's): Seedance on BytePlus, Hailuo 3 on MiniMax, Gemini Omni 1.1 on Google, and on Krea for each until verified (§5.7.5). The 8 s rule as a node message and a run block (never a silent duration change); Veo's `personGeneration` rule where the param exists.
  - "Use a board image as the first frame ▾" on the Moodboard row of nodes with a first-frame port (§5.7.8): adds a wired Image Input as one undoable graph edit.
  - The census check extended to `video-gen`.
  - Price rows or the marker (§5.7.9) for the default-images nodes here with none: `kling-o3-ref`, `krea-video-kling-kling-o1`, `krea-video-minimax-h3-max`, `gemini-omni-flash`, `krea-video-google-gemini-omni-flash`. The MiniMax route of Hailuo 3 gains its per-image terms (first 5 free, $0.04 after).
  - The face policy (§5.7.7, Q26): the `realPerson` image field and `realPerson` op, the side panel mark, the local face check, "Send anyway", the BytePlus error naming the board images.
  - Port badge fixes: `runway-video.image`, `veo-3.image`, and the Kling first-frame ports say "first frame", not style or subject.
- **What the person sees.** Wiring a board into Seedance R2V fills its references; a photo with a face shows "left out · Send anyway". A first frame never changes by itself; "Use a board image as the first frame" sets one in a click. On Krea Veo 3.1, board references go in with "Veo treats each reference as a subject to show" and the 8 s message when the clip is shorter.
- **Tests that fail on main first.** `test_first_frame_never_filled_from_board` over every video entry; `test_seedance_byteplus_no_board_refs_when_start_image_wired`; `test_hailuo3_minimax_route_no_board_refs_when_start_image_wired`; `test_omni_1_1_google_route_no_board_refs_with_start_image`; `test_seedance_face_block_leaves_out_marked_image`; `test_veo_refs_without_8s_stop_with_message`; `test_use_board_image_as_first_frame_adds_wired_input` (one undo step); `test_every_video_generator_has_a_board_port`.
- **New tests.** `realPerson` survives every write (PR1 merge); the board alone fills a required references port and the preflight counts it; `gemini-omni-flash` under `auto` gets none.
- **Live check.** Mocked fal, BytePlus, Krea and Google. One real Seedance R2V run only with Justin's OK.
- **Depends on.** PR14. Q26.
- **Docs.** Contract 07 §1.16; `.agents/skills` for Kling, Seedance, Veo; `MODEL_REFERENCE.md`; a gap note for Runway video references (§8).

### PR18: Lyria: board images and a music direction you write (B1) — new

- **Goal.** Lyria hears the board: its top images plus a short written direction.
- **Scope.**
  - A Moodboard port and a `music` entry on `lyria-3` (images up to 10, a 20 MB request budget, downscaled), with `text: "music-direction"`: Lyria's text is the music direction and a plain image legend only, never the visual brief, Avoid or negatives.
  - The board-level `musicDirection` field (PUT, person gate) and `lookFields[F].musicDirection` (`look.set`) once PR7b is in. The bundle carries the scope's `musicDirection` only when set.
  - The Lyria node shows it and edits it in place; with none it says "No music direction yet. Write one, or ask the reader to draft one." Never a colour-to-key mapping.
  - Ports and `text: "music-direction"` text-only entries on the text-only music nodes (`elevenlabs-music`, `stable-audio-25`, `ace-step`, `krea-audio-elevenlabs-music`, `-v2`, `-v2-5`, `krea-audio-bytedance-seed-audio-1-0`) and `mmaudio-v2`; with no music direction, nothing goes.
  - The census check extended to `audio-gen`, with the exclusion list in §5.7.11 E.
  - `lyria-3` price: a verified row if Google's page lists one, else the marker.
- **What the person sees.** A Moodboard input on Lyria, the look's images going in, and a music direction field on the node.
- **Tests that fail on main first.** `test_lyria_gets_board_images_and_music_direction`; `test_lyria_prompt_has_no_visual_brief_or_hex`; `test_music_direction_outside_source_hash_and_brief_basis`; `test_every_music_generator_has_a_board_port`.
- **New tests.** The byte budget; an agent can't replace a direction the person wrote; the bundle has no `musicDirection` key when none is set (golden).
- **Live check.** Mocked Google. One real Lyria Clip run only with Justin's OK; it also settles whether Clip takes images (u), and its price row if Google's page lists one.
- **Depends on.** PR14 (and PR7b for per-look storage; before it, the board-level field only).
- **Docs.** Contract 07 §1.16; `.agents/skills` for Gemini.

### PR19: The reader drafts the music direction (B1) — new

- **Goal.** One click writes a music direction from a look.
- **Scope.** The reader's text call (§5.6): the scope's top 4 steering images at 512 px, its stored readings when there are any, and its effective Direction. Board notes, image notes and note-derived keywords only when `sendNotes` or the source node's `send_notes: yes` is on; private notes never; no Avoid, pins or palette. Before PR10 lands it works from images and Direction alone. A "Write music direction" button on the Lyria node and in the look panel, with the price shown first; agents through `agent_spend.decide`; `by: "reader"`, `basis` = the scope's hash, "changed since written" when the look changes; it never overwrites one the person wrote. Q25 decides whether Analyze also drafts one.
- **What the person sees.** "Write music direction · about $0.002" (u) on the Lyria node; the text appears, editable.
- **Tests that fail on main first.** `test_music_direction_draft_is_priced_before_the_call`; `test_reader_never_overwrites_person_music_direction`; `test_music_draft_prompt_has_no_notes_unless_opted_in` (board notes, image notes, note keywords); `test_music_draft_prompt_never_has_private_notes`; `test_music_draft_works_without_readings`.
- **Live check.** Mocked provider. One real Argon call only with Justin's OK.
- **Depends on.** PR4, PR18 (PR7b for per look; PR10 for readings, which it uses when present). Q25.
- **Docs.** Contract 07 §1.13 (the reader's music call) and §1.16 (music entries).

### PR20: 3D: Meshy's texture image, palette and materials as text (B3) — new

- **Goal.** 3D gets the look's surface, never its images as views.
- **Scope.** First, fetch Meshy's API pages and record the fields in `provider_schemas` (`texture_image_url` on image-to-3D; whether refine takes it; the retexture field). Then a `texture_image` port on the Meshy nodes that take one, with a `texture-style` entry (limit 1); `textSlot: texture_prompt` for the palette and materials sentence (on routes that send it); `views` entries for multi-view nodes (no fill). A3 stays off here until PR23.
- **What the person sees.** A texture image input on Meshy Image to 3D that the board fills with its heaviest image; the board's palette in the texture prompt.
- **Tests that fail on main first.** `test_meshy_image_to_3d_sends_texture_image_url`; `test_views_nodes_never_get_board_images`; `test_palette_sentence_goes_to_texture_prompt`; `test_meshy_image_to_3d_without_prompt_port_still_gets_board` (no prompt port: the texture image and `texture_prompt` still go). Price rows for the Meshy nodes, or the marker (§5.7.9).
- **Live check.** Mocked Meshy. One real run only with Justin's OK.
- **Depends on.** PR14.
- **Docs.** `.agents/skills` for Meshy; `MODEL_REFERENCE.md`.

### PR21: Palette as data, Avoid into negative fields (B4, first part) — new

- **Goal.** Use the fields models already have.
- **Scope.** Entries only; the hooks are PR14's. `negativeField: "auto"` declared and tested on the nodes whose field isn't in `params` (`veo-3` in `falParams`, `ideogram-remix` in `falParams`, `ideogram-character` in `sharedParams`, `krea-3` on its fal route), so they get Avoid. `paletteParam` on Recraft's `colors` and `background_color`, filled only while the person's are empty, with a run note.
- **What the person sees.** Avoid lands in the negative field on more models; Recraft draws in the board's colours.
- **Tests that fail on main first.** `test_negative_field_found_in_fal_params_veo3`; `test_ideogram_character_shared_params_negative`; `test_krea3_negative_only_on_fal_route`; `test_recraft_colors_from_palette_when_empty`.
- **New tests.** Every golden node's output unchanged.
- **Live check.** Mocked providers.
- **Depends on.** PR14, and the ports from PR15 (Ideogram, Recraft), PR16 (`krea-3`) and PR17 (`veo-3`).
- **Docs.** Contract 07 §1.16 (palette and negatives).

### PR22: Aspect from the references (B4, second part) — new

- **Goal.** A node starts in the board's shape.
- **Scope.** Per Q27 a, a **graph edit, not a run step**: when a board is wired or the Moodboard node's look changes, the scope's steering images give a weighted aspect, snapped to the node's own options (nearest by log ratio, per route), and written into the saved node's aspect param once, with "4:5 from the board" on the card and an undo step. In the frontend (on connect and on look change) and in `canvas_proposals` / graph apply for agents' edits, so an agent wiring a board gets the same result. Never at run time: `apply_to_generator` has no aspect step. Never over `auto` when an image is wired, never on an edit or frame node with a wired image, never when the person already changed the aspect. Veo with references keeps 16:9 or 9:16.
- **What the person sees.** Wire a portrait board, and the node switches to 4:5, saying so.
- **Tests that fail on main first.** `test_aspect_from_references_snaps_to_node_options`; `test_aspect_never_replaces_auto_with_wired_image`; `test_aspect_written_on_wire_is_one_undo_step`; `test_run_never_changes_aspect`.
- **Live check.** Screenshots of the card line and its undo.
- **Depends on.** PR14, PR7d (to follow look changes). Q27.
- **Docs.** Contract 07 §1.16 (aspect); `skills/nebula/SKILL.md`.

### PR23: Combine into one image (A3, an option) — new

- **Goal.** Single-reference inputs can take a whole look as one image.
- **Scope.** A collage renderer: the scope's top 6 to 9 images, each tile's area proportional to its weight, a minimum tile size, neutral grey gutters, one look per collage, content-addressed. A "Combine into one image" option on entries with `collage: true` (`flux-1-1-ultra`, Krea Z Image and Flux Kontext dev, Meshy texture once PR20 lands). The prompt line: "This image is a collage of references: take its colour, light and texture, not its layout." Off by default everywhere. GM's comparison on 2026-10-19 found separate references better: the collage came out paler and emptier, likely because it averages the screenshots' white UI areas. So if a tile can come from a marked painted region of a reference (GM's region-mark idea, out of scope) or an automatic crop, the renderer uses that region, not the whole image; until one of those exists, tiles are whole images and the option stays off by default.
- **What the person sees.** An option on those nodes, with a preview of the collage.
- **Tests that fail on main first.** `test_collage_tile_area_follows_weight`; `test_collage_refused_on_edit_or_frame_slots` (contract).
- **New tests.** A minimum tile size drops the lightest images rather than shrinking below it; one look per collage; the collage is content-addressed, so a second run hits the cache; `collage` is not a default in any entry.
- **Live check.** Saved collage previews for three seeded boards, shown to Justin. No paid run without his OK.
- **Depends on.** PR14, PR15 (Krea Z Image and Kontext dev ports), PR16 (`flux-1-1-ultra`'s port); PR20 for the Meshy texture case.
- **Docs.** Contract 07 §1.16 (collage); the research note's open question stays open until the comparison.

### PR24: Recraft style objects (A1 for Recraft; how is Q24) — new

- **Goal.** Recraft gets the look's images the way it takes them: as a style made from weighted images (A1 counts "Recraft styles" as a style slot).
- **Scope (Q24 a).**
  - Verify first: fetch Recraft's `POST /v1/styles` page (1 to 10 images with `image_weights` (r)) and its generation schema into `provider_schemas`, and check whether fal's Recraft V4 endpoints accept a style id made on Recraft's API (u).
  - A Recraft key in Settings, and Recraft's own API as the direct route of `recraft-v4-raster` and `recraft-v4-svg`, through the existing dual-route mechanism (`node_route.py` / `directRoute`, as the fal Seedance and GPT Image copies have). The maker's key goes first. These nodes stay dual-route; no `routes` table (AGENTS.md: only new nodes use routes).
  - A style made per scope from its images and weights, remade when the scope's hash changes, cached per `(board, scope, sourceHash)`, and sent as `style_id`. On the fal route it is sent only if the check above passes; otherwise fal runs get palette and text, and the node says "Board style needs your Recraft key".
  - **Cost:** style creation (about $0.005 per style (r)) is its own line in `estimate_node`, counted only when the scope's style isn't cached, and its own item in `agent_spend.decide`, so a remade style is never a hidden charge. The run note says when one was made.
- **What the person sees.** A Recraft key in Settings; on Recraft nodes, "Board style: made from Dither's 8 images" and a run note when the style is remade, with its cost in the run estimate.
- **Tests that fail on main first.** `test_recraft_gets_style_id_from_board_scope`; `test_recraft_style_remade_when_scope_hash_changes`; `test_recraft_style_creation_is_in_the_estimate_only_when_not_cached`; `test_agent_spend_counts_style_creation`.
- **New tests.** The style is cached per scope and hash (no second creation for the same look); weights map to `image_weights`; a missing key or an unconfirmed price falls back to palette and text with a node message; the direct route is chosen by the same rule as the other dual-route nodes.
- **Live check.** Mocked Recraft. One real style creation and one generation only with Justin's OK.
- **Depends on.** PR15, PR7b. Q24.
- **Docs.** Settings docs for the new key; `.agents/skills` note for Recraft; contract 07 §1.16; `docs/PROVIDER-ROUTES.md` (the new direct route); `MODEL_REFERENCE.md`.

---

## 7. Open questions for Justin

Each question has a recommended answer. The plan builds the recommendation unless he says otherwise.

### 7.1 Canvas (Q1 to Q17)

| # | Question | Recommendation | Status |
|---|---|---|---|
| Q1 | What size is full weight? | A 480×270 card (129,600 px²). | **Answered** a) (PR1's notes). |
| Q2 | Can a card grow past full weight? | No, resizing caps there. | Follows the recommendation. |
| Q3 | What is the smallest card? | Weight 0.05 (about 107×60). | **Answered** a) (PR1's notes). |
| Q4 | (Reworded for A4.) What does "Whole board" send once looks exist? | Every image on the board at its heaviest copy, with the board's own words: exactly today's brief. | Follows the recommendation; now the permanent meaning of Whole board. |
| Q5 | Dragging a linked copy onto empty canvas? | It leaves that look (with Undo). The last copy becomes loose. | Follows the recommendation. |
| Q6 | Drawing a frame over references? | The ones fully inside join it. | Follows the recommendation. |
| Q7 | Old "Excluded" images become Set aside, and the pin test changes. OK? | Yes. | **Answered** (the answer is with the PR2 builder; this plan assumes yes). |
| Q8 | Old weight-0 images? | Set aside at full size; stored weight 0 kept until used again. | Follows the recommendation. |
| Q9 | Run the free Measure automatically after an edit that steers? | Yes, 1.5 s after the last steering edit; per look once PR7b lands. | Follows the recommendation. |
| Q10 | Hybrid frames: when, and what does accepting do? | Suggest one at 3 or more references sharing a pair; accepting moves them in. | Follows the recommendation. |
| Q11 | What limit does an agent-run Analyze count against? | The chat model's per-model limit (Gemini chat for Argon). | Follows the recommendation. |
| Q12 | (Reworded.) Show the reading in the side panel once Analyze exists? | Yes, read-only, outside the brief. B1's music direction is the one reader-written text that reaches a generator, as its own visible, editable field. | Follows the recommendation. |
| Q13 | What size are images sent to the reader? | 1024 px on the longest edge. | Follows the recommendation. |
| Q14 | Unsorted when it's empty? | It disappears, and comes back on the next Analyze. | Follows the recommendation. |
| Q15 | The Delete key on the board? | Removes at once, with an Undo toast. | Follows the recommendation. |
| Q16 | Gemini 4 Argon's price, if Google's page doesn't list it exactly? | "No list price, may cost more", and a confirmation. | Follows the recommendation. |
| Q17 | When does a reference go to Unsorted? | When it fits none, or its fit is below 0.5. | Follows the recommendation. |

### 7.2 New calls the nine answers leave open (Q18 to Q28)

Q22 and Q23 stay listed so their numbers don't move, but they are already answered.

| # | Question | Options | Recommendation and why | Gates |
|---|---|---|---|---|
| Q18 | Where do you pick the look? | a) On the Moodboard node. For two looks, add a second Moodboard node (dragging a look's tab onto the canvas makes one). b) On each generator node. c) On the Moodboard node, with an override on each generator. | **a).** Everything the Moodboard node puts out (brief, palette, images) then describes one look, so what you see on it is what generators get. On the generator, each run would have to measure every look, and the brief and palette outputs could still show only one. | PR7d |
| Q19 | Does a node keep its look, or follow whichever look is heaviest right now? | a) It keeps the look it was given. When you pick a board, Nebula picks the heaviest look and saves it on the node; later changes never switch it, and the node tells you when a board gains looks. b) A live "Auto" that picks the heaviest look again on every run. | **a).** With a live Auto, resizing one card in the Studio, or drawing a first small frame, would silently change what every node sends, and a saved recipe would stop giving the same result. | PR7d |
| Q20 | Do looks share the board's Direction and Avoid? | a) The board's words are the starting point. A look can replace its Direction and "must appear" colours, and add to Avoid and "keep out". A hand-written brief belongs to one look only. b) One set of words for the whole board. c) Each look starts empty. | **a),** with "must appear" replacing (not adding), and Keep anyway / Leave out choices carrying over only while the look uses the board's words. Directions differ between looks, which is why A4 exists, while Avoid items like "no text" usually hold everywhere. b) keeps the clashes A4 removes; c) means retyping "no text" in every look, and an old board's Avoid would quietly stop applying. | PR7b |
| Q21 | Krea 2's strengths add up. Each board image goes at the board's strength times its weight, so ten images at 0.7 add up to 7. Krea's guide says to keep the total near 1. | a) Keep today's strengths until the paid comparison adds a "scaled to the board's strength" arm, then decide. b) Scale them now so they add up to the board's strength. c) Leave them as they are. | **a).** Krea's advice is clear, but nobody has tried it on a ten-image board, and changing it changes the result of every Krea 2 recipe you've already run. It adds a few runs to GM's comparison, which GM prices before asking you. | PR15; the paid comparison's scope |
| Q22 | ~~Can agents turn "Send board images" on or off?~~ | — | **Answered by your agent-freedom rule** (agents may do anything undoable; per-user setting, new installs "Ask first"). Agents get the switch and the copying warning; PR14 adds the exception that lets them write it (§5.7.8). | — |
| Q23 | ~~Veo 3.1 references on by default?~~ | — | **Answered by B2 a)**, whose page named Veo ("Veo references force 8s"). Built as decided: Krea Veo 3.1 references on by default, the 8 s rule blocks with a message, and a face warning. Flagged, not asked: Veo reads each reference as "one person, character or product" (r), so a style board can put its subjects in the shot. If you want Veo behind the switch instead, say so and PR17 flips one entry default. | — |
| Q24 | Recraft. A1 counts Recraft styles as a style slot, but Nebula's Recraft V4 nodes run on fal and take no images. Recraft makes a "style" from up to 10 weighted images on its own API (about $0.005 per style, research note) and then generates with it. This needs a Recraft API key. How should the style reach Recraft? | a) Add Recraft's own API as the direct route of the two Recraft V4 nodes, the way the fal Seedance and GPT Image nodes already have a maker route: your Recraft key first, else fal. The style is made on Recraft and sent as `style_id`; fal runs get it too only if fal accepts a style made on Recraft, otherwise palette and text. b) Keep the fal-only nodes; make the style on Recraft's API only if fal accepts its id, and if it doesn't, come back to you. c) Not now: Recraft gets palette and text only, and Recraft styles are logged as a gap. This defers A1 for Recraft. | **a).** It follows your "maker's own API first" rule and the existing two-route pattern, and it works whatever fal turns out to accept. b) hangs on an unverified fal behaviour. c) leaves A1 unbuilt for Recraft. Either a) or b) needs a Recraft key from you; the style's cost is shown in each run's estimate. | PR24 |
| Q25 | When does the reader write a music direction for Lyria? | a) Only when asked: a "Write music direction" button on the Lyria node and in the look panel, price shown first. b) Every Analyze writes one per look (a small extra charge on each Analyze). | **a).** Most boards never feed music. Asking keeps Analyze's price about sorting, and you can always type one yourself for free. | PR19 |
| Q26 | Seedance refuses references that show real people. How should Nebula decide which board images to leave out? | a) Your "Real person" mark on an image first, then Analyze's reading if there is one, then a free check on this computer that looks for a face. A left-out image shows "#4 left out: Seedance blocks real faces · Send anyway". b) Your mark only; everything else goes, and if Seedance refuses, its error names the board images. c) Analyze's reading only (paid). | **a).** A refused video run wastes time. The free check catches most photos; it also catches painted faces, which "Send anyway" fixes in one click. | PR17 (and PR10's reading field) |
| Q27 | The aspect from the references (B4). How does it reach a node? | a) Written into the node's aspect once, when you wire a board or change its look, shown on the card ("4:5 from the board") and undoable. Never changed at run time. b) Decided at each run while the aspect is still at its default. c) Only a suggestion on the card that you click. | **a).** You see it before you run, the price shown is right, and a saved recipe repeats. b) could change a run's shape without you noticing. | PR22 |
| Q28 | Can agents (and Analyze) delete or merge a look that holds words you wrote: its own Direction, Avoid or hand-written brief? | a) Not yet. They're refused, as agents are with your hand-written brief today, until boards keep a history you can undo from anywhere. b) Yes under "Act directly", undoable from the Studio. | **a).** Today the only undo is the Studio's, and only while it's open, so a delete made while it's closed would lose your words. Once boards keep a server-side history, which your "everything agents do is undoable" rule calls for, this opens up. | PR7b |

---

### 7.3 Analyze as an overseer (Q29)

| # | Question | Options | Recommendation and why | Gates |
|---|---|---|---|---|
| Q29 | GM's mockup v5 shows Analyze as an overseer: a panel streams the reader's lines and outlines each card a line names. Where do the lines come from? | a) Argon's own thought summaries, shown as they stream. b) The readings themselves: each image's reading streams back as soon as the model finishes it, and its short reason becomes that image's line. Nebula adds its own plainly marked lines ("Reading #1–#6", "Asking again for #10–#12", "Cancelled"), and results come from what Nebula actually applied. c) b), plus Argon's thought summaries as a second, dimmer stream labelled "thinking (summary)" that never outlines cards. | **b) now, and decide c) after PR4's one approved Argon probe.** In b) each line is the model's actual reading of that image, the same text the side panel shows afterwards, and Nebula ties every line to an image it sent, so an outline never rests on the model's guess about a number. It costs nothing beyond the plan's existing retry, works with a mocked provider, and works with a reader that can't stream (its lines then come at the end of each batch). a) can't drive outlines: Google says summaries come back "only when available" and that image analysis "might not produce text summaries", so the panel could stay empty on exactly this job. c) fills the quiet while Argon thinks, but no Google page shows summaries and a response schema in one request, so the probe checks that first. Under b) the panel reads "Gemini 4 Argon · reading", not "· thinking". **Justin (2026-10-20): c).** "If argon, or whatever model doesn't stream its thoughts then we just fallback to B." So the summary stream is optional per model and absent when a model returns none (§5.6.1). | PR4, PR10, PR10b |

## 8. Out of scope, and what this waits on

- **C5 Avoid area.** The brief-conflicts calls (#18) are answered, so it is unblocked; it goes with frames (PR7) or after. A frame `kind: "avoid"` is cheap to add later, and nothing here prevents it.
- **Analysis option 1 (a reader that describes images and feeds the visual brief).** Still unpicked. Readings are stored and shown, but never enter `source_hash`, `brief_basis`, `compose`, the node bundle or any generator. **The one exception is B1's music direction:** a separate, visible, editable field sent only to music entries.
- **Collage as a default anywhere (A3).** PR23 builds it as an option. GM's paid comparison ran on 2026-10-19 (Justin approved, about $1.01; 12 images, Gemini 3 Pro Image and Nano Banana 2.1, text only vs five separate references vs one collage; results in `~/Developer/brand/good-machines/explorations/2026-10-19-moodboard-image-test/`). Separate references won: real brushwork, ochre and peach notes and motifs from the references; the collage drifted pale and empty. Text alone already gets the basic look when the look sentence is specific. So separate references are the default (A2), and the collage stays an off-by-default option. Tiles from a painted region need region marks (GM's later idea) or an automatic crop. The Krea 2 (style-slot) arm waits on a Krea token and the Krea 2 price fix. **A1 evidence for later:** no image copied anything with the guard sentence on content-slot models; A1 stays as Justin decided (text by default, with the switch).
- **A trained style (LoRA) per look (B4).** A later, separate project. It would use `krea-style-train` or `ideogram-train-model`, a training run per look, and its own design.
- **The reader-based clash check for #18.** Justin's call is pending. #18 leaves room for it (`colorCheck.checks.<name>`), and §4.11.2's per-scope `colorCheck` keeps that room per look.
- **Per-look mode and strength** (one look "subject", another "look"). Later; mode and strength stay per board.
- **"Used by 2 nodes" in the Studio.** It needs a scan of every project's graphs. Later.
- **A board history kept on the server.** Needed before Q28 can open up. Not in this plan.
- **Analyze mockups before v5** that show an agent cursor sweeping over the cards are out of scope. Mockup v5 (the overseer) is in scope through PR10b.
- **GM video beats 5 to 12:** marking a region, a correctable reading, comments and approvals, test images and reactions, liked vs decided, "more like this", and board history.
- **A board picture captured from the browser.** The server composite covers C9.
- **A hard cap on images per board.** None exists today. PR5 measures speed at 300 images.
- **Node gaps found while planning (not moodboard work; each PR that meets one notes it in `implementation-notes.md`, and in `docs/flora-gap-audit.md` only if Flora has it):**
  - `flux-2-pro` takes no images; FLUX.2's 8 references (r) would need `input_image..8`.
  - `veo-3` has no reference input (removed after Google's API refused it, `veo.py:127-132`); Vertex `-001` and fal's `veo3.1/reference-to-video` are unverified.
  - `runway-video` doesn't expose Runway's Seedance 2 / 2.5 or Hailuo3 references.
  - Lyria 3.5 and the Interactions API aren't in Nebula.
  - No Meshy node has a texture image port (PR20 adds one where verified).
- **Krea style fields whose meaning is unverified** (Seedream 5, Flux dev, Kontext dev, Qwen, Z Image, UNI-1, Muse, Grok Imagine 2) default to text until a source, or a mocked run plus one paid run Justin approves, shows they are style-only. Each one then moves into `STYLE_VERIFIED` in its own small change.
- **Fixes alongside, owned by the PR that touches the code:** wrong port badges on first-frame ports (PR15, PR17); `_to_fal_url` has no size check (PR14 budgets board images only; the general fix is separate); the unpriced nodes that get board images by default (§5.7.9) get a verified row or a visible marker in PR15, PR16, PR17, PR18 and PR20.

---

## 9. Sizes

| PR | Code | Tests | Agent-days | Depends on |
|---|---|---|---|---|
| 1 Board model v2 | ~600 | ~500 | 2.5 | — (merged, #87) |
| 2 Set aside | ~250 | ~250 | 1.5 | 1 (merge order) |
| 3 Checked edits + live Studio | ~1,100 | ~700 | 3.5 | 1 |
| 4 Reader dry run + price + trace parser | ~1,600 | ~900 | 4.75 | 1 |
| 5 Board view (preview) | ~1,300 | ~400 | 4.25 | 3 |
| 6 Size is weight, motion, default | ~500 | ~200 | 2 | 2, 5 |
| 7 Frames + linked copies | ~1,500 | ~550 | 4 | 6 |
| 7b Per-look analysis and brief | ~1,000 | ~700 | 3.5 | 7, 3, 2, #18 |
| 7c Look panel | ~900 | ~350 | 2.5 | 7b, 6 |
| 7d The node picks a look | ~700 | ~400 | 2 | 7b |
| 8 Agents see + placement | ~1,300 | ~500 | 3.5 | 5 |
| 9 Agents edit + recent edits | ~1,000 | ~400 | 3 | 8 |
| 10 Analyze sorts + trace events | ~1,950 | ~900 | 6.25 | 4, 7, 7b |
| 10b The overseer in the Studio | ~550 | ~300 | 3.75 | 10 |
| 11 Suggestions | ~800 | ~350 | 2.75 | 10 |
| 12 Arrange | ~700 | ~300 | 2 | 7 |
| 13 Adapter table + contract test | ~900 | ~700 | 3 | #18 |
| 14 Board images on content slots + the whole dispatcher | ~1,800 | ~1,100 | 5 | 13 |
| 15 Style slots by default | ~1,000 | ~650 | 3 | 14 |
| 16 Board port on every image generator | ~600 | ~400 | 2 | 14 |
| 17 Video references, face policy, first-frame pick | ~1,300 | ~800 | 4 | 14 |
| 18 Lyria, music nodes, music direction | ~750 | ~450 | 2.5 | 14 (7b) |
| 19 Reader drafts music direction | ~500 | ~300 | 1.5 | 4, 18 (10 for readings) |
| 20 Meshy texture + 3D text | ~600 | ~400 | 2 | 14 |
| 21 Palette as data + negatives (entries) | ~300 | ~350 | 1 | 14, 15, 16, 17 |
| 22 Aspect from references (graph edit) | ~550 | ~400 | 1.5 | 14, 7d |
| 23 Combine into one image | ~700 | ~400 | 2 | 14, 15, 16 (20) |
| 24 Recraft style objects | ~1,000 | ~500 | 3 | 15, 7b; Q24 |

- **Total:** about 25,800 lines of code and 14,150 lines of tests (about 39,950), about 82 agent-days in sequence. Canvas 43.75, looks 8, adapters 30.5. Version 2.2's overseer adds about 2,300 lines and 6.75 days (PR4, PR5, PR10, PR10b, PR11); version 2.3's thought stream (Q29 c) adds about 250 lines and 1 day (PR10, PR10b).
- **Critical path (canvas and looks):** PR1 → PR3 → PR5 → PR6 → PR7 → PR7b → PR10 → PR10b, about 30 days (v2.2 was 29, v2.1 was 26.5, v1 was 23). PR7c and PR7d run beside PR10.
- **Adapter lane:** #18 → PR13 → PR14 → PR17 → PR21 is about 13 days of work after #18 merges, with PR15, PR16, PR18 and PR20 beside PR17, and PR23 after PR15 and PR16. PR22 waits for PR7d, PR19 for PR4 (and uses PR10's readings once they exist), PR24 for Q24. With three lanes the whole plan fits in about 32 to 34 days.
- **When Justin gets something:** a priced CLI dry run of the sort after PR4 (about 6 days); a usable canvas after PR6 (about 12 days); board images on GPT Image edits and Nano Banana after PR14 (about 8 days after #18 merges); style slots by default after PR15 (about 11 days after #18); one brief per look on a node after PR7d (about 21.5 days).

---

## 10. How this plan was put together

### 10.1 Version 1: the two canvas plans

- **Structure.** Model-first's PR split combined with experience-first's later order and its dry-run CLI.
- **Studio plumbing** lands with the edits route (PR3).
- **Set aside** keeps `excluded` as the stored switch with the new meaning.
- **Numbers** are `index + 1`, never reordered; no counter.
- **Field names:** `placements`, `layoutVersion`, `/edits`.
- **Placement weight** is stored on the placement, and `w, h` are written from it.
- **Loose copies** only when it's the only one. **Undo conflicts:** partial `restore` with `expect`.
- **Price:** the reader's own price table plus `decide` with a one-off entry, billed as the chat model.
- **Resizing** capped at full weight (Q2). **Minimum weight** 0.05 (Q3).
- **`FORjustin.md`** extended after every PR by the coordinating session.

### 10.2 Version 2: three readers' notes on A1 to A5 and B1 to B4

- **Music direction storage.** One reader put it on `frames[].music`, another in `lookFields`. This plan uses `lookFields[F].musicDirection` (and a board field for Whole board), because frames are layout and carry undo slices and journal data; the person's text belongs with the look's other words.
- **When the reader writes it.** One reader had Analyze draft one per look; this plan asks (Q25) and recommends on request only.
- **Where the look is picked.** Both readers who raised it recommended the Moodboard source node; it is Q18 because A4 says only "on the node".
- **Where adapter entries live.** A separate table (one reader's recommendation), checked against both definition files, with a generated Krea part, not a field in 308 definitions.
- **Adapters vs looks order.** One reader wanted adapters after PR7d; this plan runs them in parallel, because adapters read `bundle.images` and need nothing about looks. PR7d's test runs the adapter suite on a look bundle.
- **Board fill and routes.** The fill is clamped to the active route's limit, so a board never rules a route out or makes Auto stop (AGENTS.md: Auto never switches provider because of a setting).
- **Content-addressed board copies**, added in this plan, so the generator cache still hits on a second run with the same board.
- **Edit nodes.** `needsWired`, added in this plan: without it, a board image would become image 1, the image being edited.
- **Image notes in the legend** follow #18's notes opt-in, added in this plan.
- **Agents and person words.** The per-look reader proposed refusing agents; given Justin's "agents may do anything undoable", this is Q28, with the reason it can't open up yet.

### 10.3 Version 2.1: the critic's review

Each point was checked against the code (main `12257250`, `e457b51d` on #18, `feat/moodboard-canvas`) and the research note.

| # | Point | Verdict | What changed |
|---|---|---|---|
| 1 | Krea `style_images` on content models defaulted to images | Holds. Only Krea's Seedream 4 page shows a style meaning (with strength); A1 names FLUX and Seedream as content. | Text by default unless the model is in `STYLE_VERIFIED` (Krea 2, Seedream 4, Ideogram 3, Runway gen-4); §2.2, §5.7.1, §5.7.11 B, PR15, §8. |
| 2 | A look bundle kept the whole board's `analysis` and `providerHints` | Holds (`handlers/krea.py:381-391`; #18's bundle). | §3.2, §4.11.8: the look's generator view and hints rebuilt from the look; PR7d asserts no non-member URL. |
| 3 | `exclusive` missing on Hailuo 3, H3 Max, Gemini Omni; H3 Max limit | Holds for Hailuo 3's MiniMax route (`minimax_v2.py:99-101`) and Omni 1.1's Google route (`maker_routes_google.py:369-373`). **Partly rejected:** on main, H3 Max and Omni 1.0 have no maker route (no `directRoute` in `node_definitions.json`), so there is no MiniMax cap of 9 to clamp H3 Max to today. | `exclusive` per route where the code refuses, and on Krea until verified; H3 Max keeps Krea's 12 and clamps to 9 if a MiniMax route is added; a contract check that every refusing maker route has `exclusive` (§5.7.5, §5.7.10 rule 11). |
| 4 | Rule 5 found frames by name and missed most | Holds (labels checked). | Rule 4 is now an allow-list: every Image or Any input classified; the name rule stays as an extra check; the false claim is gone. |
| 5 | `apply_to_generator` returns early without a wired prompt | Holds (`:368`, unchanged in #18). | §3.3 fact; §5.7.3: every step runs whenever a board is wired; `textSlot` is a port or a param; PR14 tests both shapes, PR20 tests Meshy. |
| 6 | Planner candidates included images the analysis couldn't read | Holds (`moodboard_analysis.py:207`; golden boards with external URLs). | §5.7.4: candidates are the read images only; "left out: couldn't read"; a golden case in PR14 and PR15. |
| 7 | Unpriced default-images nodes; `unknown` undefined; Recraft style cost hidden | Holds (checked `model_pricing.json`). | §3.3 list; `costPerRef` defined (§5.7.2); §5.7.9 lists every such node and the PR that prices or marks it; PR24 puts style creation in the estimate and the spend gate. |
| 8 | PRs depending on ports from parallel PRs; dispatch changes in parallel | Holds. | PR14 now builds the whole dispatcher; PR21 after PR15 to PR17; PR23 after PR15 and PR16; PR19 works from images until PR10 (§6.0). |
| 9 | Agents can't write `_boardImages` / `_boardSendAnyway` | Holds (`agent_params.py:40-43`). | `AGENT_WRITABLE_INTERNAL` in PR14, listed by `describe_node`; the server writes `_lookName`. |
| 10 | Look colour checks went stale after word edits | Holds (#18's basis rule). | §4.11.3: per-look basis from effective words; refreshed in the same write; in-memory fallback; a PR7b test. |
| 11 | Lyria would get the visual brief; the music draft's inputs vs notes | Holds. | `text: "music-direction"`; §5.6 and PR19 state the drafting inputs and the notes rule, with tests. |
| 12 | `syntax: null` dropped A2's legend without saying so | Holds. | `syntaxReason` required (Runway gen4: naming means tagging; Krea native weights); plain legends for Lyria and Ideogram v3. |
| 13 | Q22, Q23, Q24 re-asked decided calls | Holds. | Q22 answered by the agent-freedom rule; Q23 answered by B2 a), built as decided with the concern flagged; Q24 reworded to the real call (how the style reaches Recraft, which needs a key), with c) marked as a deferral of A1. |
| 14 | Aspect at run time contradicted Q27 | Holds. | Removed from §5.7.3; PR22 is a graph edit with undo. |
| 15 | #18 had landed; contract 07 numbering | Holds (`e457b51d`). | Header and §3 rebased; names marked verified; `NODE_NOTES_CHOICES`; one contract section per subject from §1.12 (§3.1). |
| 16 | Text-only music and text-to-video nodes silently left out | Holds (26 `audio-gen` nodes checked). | Rows in §5.7.11 C and D; census extended to `video-gen` and `audio-gen` with an exclusion list (§5.7.10 rule 12). Not a question for Justin: "into every node" and A5's text-only entries already cover it. |
| 17 | B2's "or pick one" not built | Holds. | "Use a board image as the first frame" in §5.7.8 and PR17. |
| 18 | Nano Banana 2.1, the count of seven, section E ids | Holds. | 2.1 sends text only with a node line (the note likely joins 2.1 with 3.1 Flash); "six of the seven"; real ids in §5.7.11 E, plus `flux-video-edit` and `sync-lipsync`. `mmaudio-v2` now gets the music direction and no visual negatives (found while fixing 16). |

### 10.4 Version 2.2: the overseer, and its checker

GM - Design relayed Justin's "overseer" idea and mockup v5, and asked what it needs from the reader API. Two researchers read Google's pages (fetched 2026-10-19) and this plan. A drafter wrote §5.6.1 and Q29, and a checker reread the vendor pages and the code. Every point the checker raised holds, and each is now in the text:

| # | Point | What changed |
|---|---|---|
| 1 | Key order is documented for the JSON Schema form (`responseFormat.text.schema`); `responseSchema` is deprecated | §5.6 and §5.6.1 send `responseFormat` (REST shape rechecked 2026-10-20) |
| 2 | `maxOutputTokens` counts thinking and is a hard cutoff | The cap is thinking plus answer; the retry after `MAX_TOKENS` splits in two; no thinking allowance on top in the price |
| 3 | The retry wasn't in the price or the hold | The high estimate counts one retry per batch |
| 4 | Only private notes were kept out of the reader's prompt | Both phases and the retry follow #18's opt-in, with two tests |
| 5 | Board numbers as labels let reasons name the wrong card after renumbering | Batch-local labels; reasons stripped of labels and `#n`; numbers drawn from `refs` |
| 6 | `maxLength` isn't supported on strings | The 120-character cap is a request plus a Python trim |
| 7 | `enum` on strings is documented | No PR4 check needed |
| 8 | `suggestions[].runId` can't name an older run's model | `suggestions[].model` |
| 9 | `actor_for_headers`, `stream_runner.py:63`, `actor_record` and the frontend unions | Cited and in scope |
| 10 | The lane order contradicted itself | PR10 → {PR10b, PR11} |
| 11 | PR19's trace line doesn't fire under Q25 a | Dropped |
| 12 | "Skip by url" after a cancel contradicted C11 for a selection | Skips only with nothing selected |
| 13 | The stream may be silent while Argon thinks | Longer first-byte and quiet bounds at `high`, calibrated by the probe |

### Not verified (check in the PR that needs it)

**Canvas (version 1, still open):**

- Gemini 4 Argon's per-token price and its image token cost (PR4). The checker's fetch shows output at $10.00 through November 30, 2026 and $20.00 from December 1, 2026; PR4 records both with the units and the input price.
- The overseer (§5.6.1): bytes during thinking, time to the first item, `thoughtsTokenCount`, thought summaries alongside a schema on image batches, and whether an aborted stream is billed (PR4's probe).
- That `estimate_run` prices a one-off `per: "request"` entry passed through `decide` with no further fields (PR4).
- React Flow speed with 300 image cards (PR5).
- Whether `CommandPalette`, `ContextMenu`, `KeyboardShortcuts` or `WorkspaceRail` act on keys inside the Studio (PR5).
- Whether `resolveAnchor` in `lib/agentCursorMotion.ts` fails quietly on an unknown id (PR8).
- Whether GM's "Gemini 3 Flash" and "Measure only" rows are meant as shown.
- Q7's recorded answer (this plan assumes yes).

**Looks:**

- Roll-up speed at 300 images in 20 or more frames (PR7b).
- Whether the Inspector can carry a dependent `moodboard-look` picker without a new param-type branch; expect one (PR7d).
- That `agent_params` and `canvas_proposals` can resolve a look name against the board while an edit is applied; today they only check the asset kind (PR7d).
- #18 as it merges. This plan follows `e457b51d`, where the names are verified in code; review may still change them (PR7b, PR13 rebase on what merges).

**Adapters (vendor facts are from the research note; WebFetch summaries, re-check quotes before a spec):**

- Krea 2's real reference limit (Nebula's 10 is its own number) and the effect of strength sums above 1 (PR15, Q21).
- Reference limits on fal for Kling O3 Ref, `gpt-image-1-5-edit` and the fal GPT Image copies, `nano-banana-fal-edit`, Ideogram v3 style count, `meshy-image-to-image`, Quiver per model, and the Krea Gemini Omni, Wan 3.0 and Grok video references.
- Nano Banana 2.1's image limits: the note's line likely joins it with 3.1 Flash; Nebula sends it text only until Google's page is re-read (PR14).
  GM's 2026-10-19 comparison sent five separate references to `gemini-nano-banana-2.1` through `/api/quick` and all runs succeeded, so 2.1 does take images; its limit is still unconfirmed.
- Which of Google's per-role counts limits board images on Gemini 3 Pro Image (6 object, 5 character, 3 style (r)). Board images in `look` mode are style references by meaning, which would cap them at 3, but Gemini has no role field, and the same comparison sent five to Gemini 3 Pro Image with no error. PR14 settles it from Google's page and states the cap it uses.
- What every Krea `style_images` model does with the images, except Seedream 4 (they default to text until verified); whether Nebula's Krea Seedream 4 param carries `strength`; Ideogram 3 and Runway gen-4 style meaning **on Krea's gateway** (verified on the makers' own APIs only).
- Whether Krea's routes refuse a start frame plus references on Hailuo 3, H3 Max and Gemini Omni (treated as refusing until checked, PR17).
- Whether Ideogram v3 reads a plain "first style reference matters most" line (paid comparison).
- Price per reference everywhere except OpenAI, Gemini 3 Pro, Krea 2, Krea 3, Recraft, Veo and Runway's Seedance 2.5 and Hailuo3.
- Prompt syntax for Gemini, Krea 3, Seedream and Lyria; whether fal's Kling O3 `image_urls` count as refer_image or element.
- Lyria: image count and Clip image support on `generateContent`; a price row.
- Meshy `texture_image_url` on image-to-3D (direct and fal v6), on text-to-3D refine, and the retexture style-image field.
- Veo `referenceImages` on Vertex `veo-3.1-generate-001` and on fal's reference-to-video.
- What fal's Luma Ray2 flash modify does with its "Reference Image".
- Whether a Recraft style id made on Recraft's API works through fal's Recraft nodes, and Recraft's style and generation schema (PR24).
- Whether `ideogram-edit-prompt`'s `images` are style or content.
- Whether Seedance's real-face rule is enforced by fal and Krea themselves, and how many false positives the local face check gives on painted references (PR17).
- Whether each handler's HTTP calls can be captured on the isolated stack for live checks, or only through the unit-test harness (PR13).
- Whether any saved graph wires a non-board value into Krea 2's `Any` `moodboard` port (PR13).
- The price figure on PR19's button is a placeholder.
- Which handler lines show each "Image"-labelled video port is a frame (rule 4 lists them by hand; PR17 cites each).
- Whether text-to-music nodes read a music direction well (no source; mocked in PR18).
- Price rows for the default-images nodes listed in §5.7.9: each PR adds a verified row or the marker.

**General:** line numbers drift; the ones here are from `12257250`.
