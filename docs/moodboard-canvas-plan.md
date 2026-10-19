# Moodboard canvas (item 6): build plan

Merged from two independent plans ("model-first" and "experience-first") on 2026-10-19, against main `12257250`. Every path, route, field and function the plan relies on was checked in this worktree. Section 10 lists what was not verified. Line numbers are as of `12257250`.

---

## 1. Summary

Moodboard Studio's image grid becomes a second React Flow canvas (C1), with a List view that keeps today's grid (C6). Each reference is a card whose size is its weight (C2). One "Set aside" switch dims a card: it is still read for colours but never steers (C3). Looks are frames that you draw and name (C4). One image can sit in several frames as linked copies, each with its own weight (C13). Numbers stay in add order (C7). New references land in free space (C8). Agents see and edit the board the way they see and edit the main canvas: a view report, a picture, checked edits with a cursor, and your recent edits before each turn (C9). An Analyze button reads references with a vision model you pick, shows the price first, and sorts them into frames as a first draft you then edit (C10 to C13).

The plan does this in 12 PRs. The first four retire the riskiest unknowns before any canvas UI exists:

- **Old boards and lost writes (PR1, PR3).** Today every save replaces the whole `images` list, last write wins. PR1 makes writes lossless and gives old boards a layout without rewriting them. PR3 adds checked, atomic board edits, so a person's drag and an agent's add can't overwrite each other.
- **What set aside does to the analysis (PR2).** It's small and pinned by tests, so it goes early.
- **Model quality and price (PR4).** This is a dry run Justin can try on his real board from the CLI before any Analyze UI is built.

A usable canvas arrives with PR6. Main stays releasable after every PR: each one either changes nothing you can see, or ships a complete feature.

Out of scope: Avoid (C5, waiting on #18), one brief per look (analysis option 4), and the reading feeding the brief (analysis option 1). Frames organize the board; the brief stays whole-board.

---

## 2. Decisions, mapped to code

| Call | Justin's answer | What it means in code |
|---|---|---|
| C1 | React Flow, a second canvas in the Studio | `BoardCanvas` gets its **own** `<ReactFlowProvider>`. App's single provider (`App.tsx:272`) wraps every view, so without its own provider the board would share the main canvas's store. The board never touches `graphStore`, `uiStore.canvasZoomedOut`, `uiStore.canvasViewport` or `publishCanvasSelection`. |
| C2 | Size sets weight; full weight is a fixed area | A placement's weight is `area / FULL_AREA`, capped at 1. Each card's weight depends only on its own area. The roll-up already divides by total weight (`_roll_up`, `moodboard_analysis.py:524`), so resizing one card changes only shares, never another card's weight. |
| C3 | One "Set aside" switch: dims, keeps size and place, still read, never steers | The stored key stays `excluded`, and its meaning changes from "not read" to "read, never steers". Weight-0 images also show as set aside. Analysis version 5 measures set-aside images. The steering outputs stay byte-identical. See §4.4. |
| C4 | Only frames you draw and name are looks | Membership is explicit: a placement's `frameId`, written when a card is dropped into a frame or by an op. It is never inferred from position on read. |
| C5 | Later | Nothing is built. See §8. |
| C6 | Badges on the card; side panel for the selected reference; List view for bulk edits | Badges: `#n · w`, a dot per note, and a set-aside dim. The side panel holds the steering note, the private note, `ImageColors` and, from PR10, the reading. Today's grid (`MoodboardStudioView.tsx:554-610`) moves unchanged into `MoodboardListView`. |
| C7 | Numbered in add order; moving never renumbers | `#n` stays `index + 1` in `images[]`. **No canvas operation ever reorders `images[]`**: drag, frames, arrange, Analyze and undo all leave it alone. Removing a reference still renumbers the ones after it; the decision page's C7 "why" says so ("as today. Ids work everywhere for anything that has to be exact"). So there is no number field and no counter. Undoing a removal puts the image back at its old index, which restores its number. |
| C8 | Free space next to the view, else after the last; `--at`, `--in`, `--size`; `arrange --by look\|colour\|weight` | `moodboard_layout.place()` runs on the server only, so the CLI, MCP and Studio drops all land the same way. The view report (PR8) says what's in view. Arrange is a server-computed layout applied as one op batch (PR12). |
| C9 | The canvas agent model on the board | `GET /api/moodboards/{id}/look`, `GET …/picture`, `POST …/edits` (checked, atomic, with a cursor), `board.*` journal kinds, and a "Since your last turn" block in each runner. |
| C10 | Analyze sorts the selection, or the whole board; the result is an editable draft; your edits are signals; the price shows first | A new reader, `services/moodboard_reader.py`, works in two phases: per-image reading, then one sort call. Its result is applied as one edit batch from actor `analyze`. Gating: the person confirms above `runCostConfirmUsd`, and agents go through `agent_spend.decide`. |
| C11 | Nothing selected: keep what you placed or renamed, and sort only new and Unsorted. A selection: read those again | Decided by `placedBy` on each placement, `namedBy` on each frame, and `readings[imageId].url`. |
| C12 | b) A re-analyze may move a reference you placed, if you selected it; one Undo puts it back | When an image is selected, the sort may move its placement even if `placedBy` is `"person"`. The whole run is one undo step. |
| C13 | Linked copies, shared reading and notes, weight per frame, suggest a second look and never add one silently, hybrid frames | Several placements per image, at most one per frame. Second looks and hybrids are stored as `suggestions[]` and become memberships only when you accept them. Per-frame weight is stored now and read by nothing until option 4. |

---

## 3. Facts in the code that shape the plan

These were checked in the code. Some of them correct the subsystem maps or one of the two plans.

- **`_normalize_images` drops unknown keys** (`moodboard_store.py:119-143`), and `MoodboardImageModel` is `extra="forbid"` (`main.py:10547`). Every new image field needs both changed.
- **A PUT turns a missing key into its default.** The route calls `img.model_dump()` (`main.py:10890-10891`), so a client that leaves out `privateNote` erases it today. Merging by id needs `model_dump(exclude_unset=True)`.
- **The CLI and MCP send back what they read.** `update_board` and `add_to_board` re-PUT the images they got from GET (`moodboard_client.py:538-552`, `:700-740`). Once GET returns `placements`, the image model must accept them, or every `nebula moodboard set` returns a 422.
- **The CLI's "did this steer?" check would clear the analysis on any layout change.** `moodboard_client._steering` (`:833`) compares every key except `privateNote`, and the Studio's `updateImage` does the same (`MoodboardStudioView.tsx:272-280`). Both need an explicit list of steering keys: `url, weight, notes, excluded`.
- **New fields would leak into node outputs.** `handlers/moodboard.py:61-64` copies every image key into `bundle.images`. That list needs a whitelist.
- **The Studio doesn't follow outside edits.** It only relists the rail on `storedAssetChanged` (`MoodboardStudioView.tsx:708`). Its autosave sends the whole draft 600 ms after a change (`:233-236`), so a CLI add made while the board is open is overwritten.
- **`version` is a write counter that nothing compares** (`moodboard_store.py:387`). It becomes the compare-and-set token.
- **`excluded` and weight 0 differ today.** Excluded images are skipped before measuring (`moodboard_analysis.py:145, 155-157`). Weight-0 images are measured but don't steer (`:122-129, 197`). `rank_representative_images` already skips both (`:359-385`).
- **`source_hash` already includes `excluded`** (`:448-472`). If `excluded` becomes the set-aside switch, the hash payload doesn't change, so every saved analysis and every hand-written brief's basis (`brief_basis`, `moodboard_brief.py:186`) stays current. Layout fields stay out of the hash.
- **The defaults pin covers per-image colours.** `pinned_view` includes `imageColors` for every entry in `analysis.images` (`test_moodboard_defaults_pin.py:~110`), and the pinned "brand" board has an excluded image. Under C3 that image gains a colour entry. See §4.4 and Q7.
- **The summary counts only non-excluded images** (`_summary(mode, len(images), …)`, `:220`). It keeps counting only references that aren't set aside.
- **Pricing keys must be node definitions.** `validate_pricing` refuses an entry with no node definition (`model_pricing.py:196-198`), and `test_model_pricing.py:39` checks the real table. A `moodboard-read` pricing entry would fail that check, so the reader prices itself (§5.6).
- **There is a precedent for token-priced vision requests.** `qc-camera-geometry` (`model_pricing.json:12128`) prices one request as a `[low, high]` range, with a live token probe written into its notes.
- **The journal accepts a group name.** `kinds` filtering accepts the part before the dot (`EVENT_GROUPS`, `canvas_events.py:80`), so `board.*` kinds get `kinds=board` for free. The ring holds 500 events (`:41`), shared with the graph, so board batches must journal one event per batch.
- **The MCP instructions test** (`test_mcp_tools.py:~280`) fails if `INSTRUCTIONS` names a `snake_case` word that isn't a tool. That rules out a journal kind named `board.set_aside`; it is `board.setAside`.
- **React Flow 12.10.2** ships `NodeResizer`/`NodeResizeControl` and `onlyRenderVisibleElements`, and its viewport moves take an `ease` function (`@xyflow/system` `types/general.d.ts:140, 182`). Read from the main checkout's `node_modules`, since this worktree has none.
- **Uploads already get thumbnails.** Studio and CLI uploads land at `/api/outputs/chat-uploads/…` (`main.py:2432`), and `serve_output(rel, thumb)` serves 512 px thumbnails (`main.py:11565`, `output_thumbnail.py:26`).
- **The tab echo rule can be reused as is.** `_graph_edit_origin` (`main.py:6304`) gives `{actor, tab}` and trusts the tab only with the person token. The Studio's `apiFetch` already sends `X-Nebula-Tab` on every write (`lib/backend.ts:321`).
- **`FORjustin.md` is gitignored** (`.gitignore:60`) and lives in the main checkout, where the coordinating session appends to it after each PR. Builders never create it in the repo. `implementation-notes.md` exists at the root. Contract 07 already uses sections 1.1 to 1.10, so new sections start at 1.11.

---

## 4. The board data model

### 4.1 Board fields (new)

| Field | Default | Limits | Meaning |
|---|---|---|---|
| `layoutVersion` | absent | `1` | Absent: an old board, laid out on read (§4.8). Stamped `1` by the first write that saves a layout. |
| `frames[]` | `[]` | ≤ 100; at most one `kind: "unsorted"`; names 1 to 60 characters, unique on the board ignoring case | `{id (12 hex), name, kind: "look"\|"unsorted", x, y, w, h, createdBy, namedBy: "person"\|"agent"\|"analyze", createdAt}`. Coordinates are absolute flow pixels, rounded to 1 px. `w, h` ≥ 160. |
| `suggestions[]` | `[]` | ≤ 200 | `{id, kind: "alsoIn"\|"hybrid", imageIds[], frameIds[], name?, reason (≤ 200), by: "analyze"\|"agent", runId, status: "open"\|"dismissed", createdAt}`. Dismissed suggestions are kept so a re-analyze doesn't repeat them. The key is the kind plus the sorted ids. |
| `readings{}` | `{}` | one per image id, ≤ 2 KB each | `{model, at, url, readerVersion, medium, style, light, motifs[], looks: [{name, fit}], reason}`. Written by Analyze only. Never in `source_hash`, `brief_basis`, `compose` or node outputs (analysis option 1 is unpicked). `url` makes a reading stale when the image's file changes. |
| `lastRead` | `null` | — | `{runId, model, at, imageIds, estimate: {low, high}, spent?}` |

### 4.2 Image fields

Unchanged: `id, url, weight, notes, privateNote, excluded`. New: `placements[]`.

```
placements: [{id, frameId: str|null, x, y, w, h, weight, placedBy: "person"|"agent"|"analyze", placedAt}]
```

Placement rules:

- 1 to 8 placements per image, and at most one per frame.
- `frameId: null` (loose) is allowed only when it is the image's only placement. "Loose" means in no look. This rule is from experience-first; model-first allowed a loose copy beside framed ones.
- Each placement is one card, and its `id` is the React Flow node id.
- Coordinates are absolute flow pixels. |x| and |y| are at most 1e6.
- `weight` is the per-frame weight (C13). `w × h = weight × FULL_AREA`, to within 1 px rounding. The server writes `w, h` from `weight` and the card's aspect ratio, and never recomputes them on read.
- Linked copies are several placements on one image record. Notes, the private note, the reading and the colours live once, on the image.

### 4.3 Weight and size (C2)

- `FULL_AREA = 129_600` px², the area of a 480×270 card. New drops in GM's mockup are 480×270 (`CARDS` test1/test2). See Q1.
- `MIN_WEIGHT = 0.05`, today's slider step. A 16:9 card at that weight is about 107×60. Weight 0 can't be reached by size; Set aside covers it. See Q3.
- Resizing is capped at full weight (Q2). A drag resize snaps to steps of 0.05 and keeps the aspect ratio. A weight set by the CLI or MCP is stored exactly (0.33 stays 0.33).
- **`image.weight` stays the one steering weight.** The analysis, `source_hash`, Krea strength (`handlers/krea.py:387-397`), CLI `--weight` and the List view all keep reading it.
  - For a steering image, `image.weight` is the largest placement weight (Q4), so a double membership never counts twice in the whole-board roll-up.
  - A resize recomputes it.
  - A `weight` edit that doesn't come from a resize (CLI, MCP, the List view slider) scales every placement by the same factor, so the largest equals W. Smaller placements are clamped at `MIN_WEIGHT`.
  - Migration, saving, moves and frame operations never recompute it. That keeps the hash, and so every old analysis and brief, current.
- The live weight readout while resizing is frontend-only: `onResize` updates the badge, and `onResizeEnd` sends one `resize` op.

### 4.4 Set aside (C3)

- The stored key stays `excluded`. Today's API, `--exclude/--include` and the hash payload keep working, and there is no disk migration.
- **The meaning changes.** An excluded image is now measured, gets an `analysis.images` entry with `setAside: true` and its colours, and never steers.
- **Set aside = `excluded || weight == 0`** in the Studio, the CLI and agent output. Old weight-0 images show as set aside at full size, with their stored weight 0 kept until you use them again (Q8).
- **The switch.**
  - Turning it on sets `excluded: true`; weight and size are kept.
  - Turning it off sets `excluded: false`. For a weight-0 image it also sets `weight` from the card's size.
- **`steers(weight)` becomes `steers(image)`**: not excluded and weight > 0. Its callers are `analyze_moodboard`, `rank_representative_images`, the `_Steering` list, the keyword, lighting and composition inputs, and the all-set-aside warning, which becomes "Every reference is set aside, so none of them shapes the board."
- **Unchanged.** The bundle still drops excluded images (`handlers/moodboard.py:61-64`), so Krea's references and strengths are unchanged. The palette, accents, `sources`, keywords, summary, `styleBrief`, negatives and representative images stay byte-identical for every pinned board.
- **What the pin sees.** The only change it sees is an extra `imageColors` entry for the brand board's excluded image. `pinned_view` filters entries marked `setAside`, and a new pinned assertion checks the set-aside colours separately. This touches a test that guards gap #20, so it is Q7.
- **Rejected alternative.** Experience-first proposed a new `setAside` key and keeping legacy `excluded` as "not read". That keeps two states on old boards ("Set aside · colours not read · Read it"), which is option b) of C3, the one Justin didn't pick.

### 4.5 Numbers (C7)

- `#n` is `index + 1` in `images[]`, as today in the analysis (`moodboard_analysis.py:139-143`), the grid (`MoodboardStudioView.tsx:559`), CLI `show`, `find_image` (`moodboard_client.py:565`) and `brief()` (`:1005`).
- The only things that change the array are add (append), remove, and undo of a remove (reinsert at the old index through the `add` op's `index`).
- `thumbnail` stays `images[0].url`, the lowest number.

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
- **Merging** moves the copies into the target frame. Where an image is in both frames, the heavier copy is kept.
- **Unsorted** is a frame with `kind: "unsorted"`: dashed, tab "Unsorted · N", never a look. It disappears when emptied (Q14).
- **"Also in Dither" chip.** It lists the other placements of the same image.
- **Tab counts.** "Painterly · look · 7" counts placements per frame.

### 4.7 Versions

- `version`: still +1 per write, and now also a compare-and-set token. `baseVersion` on `PUT` and on `/edits` returns 409 when it doesn't match.
- `layoutVersion: 1`: the board's layout has been saved.
- `ANALYSIS_VERSION` 4 → 5 (PR2): set-aside images are measured and `analysis.images[].setAside` is added. `source_hash` doesn't change, so version 4 and 3 analyses stay current until the board changes.
- `briefVersion` is unchanged.
- `readings[].readerVersion` starts at 1.

### 4.8 Old boards: nothing moves, nothing goes stale, no disk rewrite

1. **No startup migration and no backup folder.** Files keep their bytes, `version` and `updatedAt` until someone edits.
2. **`get` and `update` lay the board out in memory** with `moodboard_layout.legacy_layout(board)`, called from `_migrated` (`moodboard_store.py:162`) behind a flag. `list` skips it, so the rail stays cheap. `moodboard_client.get_board` refetches by id after a name match (`:487-494`), so `show "Name"` gets the layout too.
   - It is a deterministic grid in number order: 6 columns, 40 px gaps, row height set by the tallest card.
   - Each card's area is `max(weight, MIN_WEIGHT) × FULL_AREA`. Weight-0 cards are full size.
   - The aspect ratio comes from `analysis.images[].width/height` if analyzed. Otherwise it comes from the image header through `resolve_moodboard_image_path` (`moodboard_analysis.py:388`), cached by path and mtime. If neither works, 4:3.
   - `placedBy: "person"`, since the order was theirs.
3. **The first write saves that layout and stamps `layoutVersion: 1`.** Since the layout is deterministic, nothing moves. Opening a board without editing it writes nothing, because `initialize` loads with `dirty: false`.
4. **`frames`, `suggestions` and `readings` read as empty.** There is no Unsorted frame until Analyze runs or the person makes one.
5. **The brief and Krea outputs for every old board stay identical.** This is pinned by a golden file captured on main before PR1 (PR1 tests).

### 4.9 Who writes what

- **Layout is written only through checked edits** (`POST …/edits`, PR3) and through server placement of new images.
  - **PUT.** It merges images by id: a key a client leaves out keeps its stored value. Incoming `placements` on images already on the board are ignored, so a stale tab or an echoing CLI can never undo a layout edit. On a new image, `placements` are validated and used as the requested placement. That is how a new board's first save carries drop positions.
  - **Board-level layout fields.** `frames`, `suggestions`, `readings` and `layoutVersion` are refused on PUT with a 422 that names `/edits`.
- **After PR3, the Studio sends board fields only on PUT** (name, notes, mode, strength, the brief fields) with `baseVersion`. Every image change goes through `/edits`. PUT keeps accepting `images` for the CLI, MCP and API callers.

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
| Undo steps | 50 per board (graph `UNDO_CAP` is also 50) | Studio |
| Journal | one event per batch; `data` ≤ 4 KB (the journal's own cap) | `canvas_events.py` |

---

## 5. Shared machinery (built once, used by later PRs)

### 5.1 Checked board edits: `POST /api/moodboards/{id}/edits`

- **Body:** `{ops: [...], baseVersion?, say?}`.
- **Atomic.** Ops are staged on a copy, validated, and committed once with `version + 1`. Either all land or none. The pattern is `/api/graph/apply` (`main.py:7973`) and `canvas_edits.parse_edit` (`:119`).
- **Ops are absolute sets**, so replaying them is idempotent and the Studio can rebase.
  - Images: `add` (urls, `at`, `in`, `size`, `index`), `remove`.
  - Cards: `place` (placement or image, x, y, `frameId?`), `resize` (`weight`, or `w×h` with the aspect kept), `link` (image → frame), `unlink`.
  - Image settings: `setAside` (image, bool), `weight` (image, value; scales copies), `note` (image, `notes` or `privateNote`).
  - Frames: `frame.create` (rect or `around: [placements]`, name), `frame.update` (name or rect; a move moves members), `frame.delete`, `frame.merge`.
  - Suggestions: `suggestion.accept`, `suggestion.dismiss`.
  - Later PRs: `arrange` (PR12), `restore`.
- **Naming.** Images are named by number or id, frames by id or name, and placements by id or `image@frame`.
- **Effect on the analysis.** Steering ops (`add`, `remove`, `setAside`, a `note` on `notes`, `weight`, a `resize` that changes the image's weight) null the analysis, as the CLI does today. Layout ops keep it.
- **`restore`** carries before-slices, each with an `expect` after-slice. A slice that changed since is skipped and reported, so one stale reference doesn't block undoing twenty moves. This is model-first's rule. Experience-first refused the whole undo with a 409.
- **Response:** `{board, version, applied, undo: {ops}}`.
- **Broadcast:** `storedAssetChanged` gains `version`, `edit: {actor, tab}` (from `_graph_edit_origin`), `touched: {images, frames}` and `undo`. `undo` is null when a batch is over 200 ops; the Studio then refetches, and the step can be undone only from the tab that made it.

### 5.2 Journal

- **New kinds** in `EVENT_KINDS` (`canvas_events.py:53`): `board.added`, `board.removed`, `board.moved`, `board.resized`, `board.grouped`, `board.setAside`, `board.noted`, `board.frame`, `board.sorted`, `board.arranged`, `board.suggested`.
- **One event per batch**, with `data: {boardId, boardName, scope, refs: [{number, id}]}`. A move counts only above 8 px, as on the canvas.
- **Private notes.** A private-note change is journaled as "private note changed" without its text.
- **Project tag.** The journal is tagged with the open canvas project (`set_project`, `:259`) while boards can be Global, so the board's own scope goes in `data`.
- **Sources.** Events come from `/edits` and from Analyze. They also come from PUT diffs, so old clients' edits show up.

### 5.3 The Studio's edit queue and rebase

- Each edit applies to the draft at once and goes into a per-board queue.
- A drag or resize sends one op at pointer-up. Text sends after 600 ms or on blur.
- On a foreign `storedAssetChanged` (a newer `version` that isn't this tab's echo), the Studio refetches the board and replays its unconfirmed ops on top. This is new: today the open draft never refetches.
- On 409 it does the same, then resends.

### 5.4 Undo in the Studio (C12's "one Undo")

- **The stack.** It is per board, keyed by the draft key, capped at 50, and cleared on an epoch change, a board switch or a delete. Each step is `{label, origin: self|agent|analyze, actorName, ops, undo}`.
- **What makes one step.**
  - A drag end or a resize end.
  - A frame op.
  - A set-aside toggle.
  - A note (on blur or after 600 ms).
  - A whole Analyze run.
  - A whole agent batch.
- **Undo and redo.** Undo sends `restore` with `expect`; redo resends the ops. Skipped slices show a notice: "#12 changed since, left as is".
- **Foreign steps.** Agent and Analyze batches arrive with `edit.actor` and `undo`, and become one foreign step with a notice: "Claude moved #12 into Dither · Undo". This follows `ForeignEdit` (`lib/canvasUndo.ts:50`).
- **The analysis.** Undo never brings an analysis back. With Q9, Measure reruns on its own.
- **Keys.** Studio-scoped Cmd+Z, Shift+Cmd+Z and Cmd+S, all skipped inside text fields. Cmd+S calls `preventDefault`, so `GraphFileActions` (which yields on `defaultPrevented`, `GraphFileActions.tsx:129`) never opens the graph save.
- **Delete.** React Flow's `deleteKeyCode` is `null`. Delete removes the selected references with an Undo toast (Q15).

### 5.5 Agents on the board (C9)

| Main canvas | Board |
|---|---|
| `CanvasViewReporter` → `POST /api/canvas/view` | The Studio posts to `POST /api/moodboards/{id}/view` every 300 ms: `{viewport, screen, visible: [placementIds], selection: [imageIds], view: "board"\|"list"}`. `BoardViewBook` keeps one slot per board in memory and marks it stale after 30 s (as `VIEW_STALE_SECONDS`, `agent_presence.py:34`). The main canvas's single slot (`agent_presence.py:304`) is left alone. |
| `look_at_canvas` | `GET /api/moodboards/{id}/look` (shape below). MCP `moodboard_look`, CLI `nebula moodboard look`. `look_at_canvas` adds `studio: {boardId}` when a board is open. |
| `view_output` | `GET /api/moodboards/{id}/picture?area=view\|board&size=small\|medium\|large` (512, 1024 or 1568 px), a Pillow composite of the 512 px thumbnails at placement positions: frame outlines and tabs, `#n · w` badges, set-aside cards dimmed, the selection outlined. It needs no browser, so it works headless. MCP `moodboard_picture` returns an `Image`, as `view_output` does. CLI `nebula moodboard picture -o FILE`. |
| `edit_canvas` | MCP `moodboard_edit` (the ops in §5.1). CLI `nebula moodboard edit <board> --place 12=x,y --resize 12=0.6 --in 12=Dither --link 12=Glass --set-aside 12 --note 12=…`. |
| Agent cursor | `agent_presence.point(target={surface: "moodboard", boardId, placementId} or {…, x, y}, say)` after each batch (`agent_presence.py:226`). The Studio mounts its own cursor layer in its viewport and reuses `agentCursorMotion`. The main `AgentCursorLayer` ignores targets that carry `surface`. |
| Journal and `wait_for_canvas_change` | The `board.*` kinds. `wait_for_canvas_change kinds=board` works through `EVENT_GROUPS`. |
| Per-turn context | The chat payload carries `studio: {kind: "moodboard", boardId, selectedImageIds}`. Next to `selection_prompt_context` (`main.py:3184`), the runner adds a board block: looks with counts, plus the selected references' structure (never private-note text). It also adds **"Since your last turn"**: the person's `board.*` events after a cursor kept per chat session, read with `exclude_actor_id` (`canvas_events.py:316`), at most 20 lines. All three runners take it through their existing `selection_context` argument (`chat_session.py:231`, `codex_session.py:364`, `acp_session.py:510`). |

`look` returns:

- `view: {reported, stale, secondsAgo, visibleArea}`
- **In view:** `[{number, id, placementId, x, y, w, h, weight, look, alsoIn[], setAside, hasNote, hasPrivateNote}]`.
- **Off-screen:** `{looks: [{frameId, name, count}], loose: n}`.
- `frames`.
- **The selection in full:** both notes, with the private note flagged "never put in a prompt" as `moodboard_get` already does, plus the weight per look, the colours and the reading.
- `events.cursor`.

With nobody looking, or a stale report, `look` describes the whole board.

**Placement (C8).** `moodboard_layout.place(board, sizes, *, view, at, in_frame)` is a rectangle-based free-space finder, not the 320×220 slots in `nodePlacement.ts`.

- **With a fresh view:** free rectangles inside the visible area, next to the visible cards first.
- **Otherwise:** after the last-added card. That means its row if the row has room, else a new row under the board.
- **Spacing:** a 24 px gap, never overlapping.
- **`--in <look>`:** free space inside that frame; the frame grows to fit.
- **`--at x,y`:** exact.
- **`--size`:** a weight or `WxH`.
- **Studio file drops:** the drop point is the anchor.

### 5.6 The reader and its price (C10)

- **`services/moodboard_reader.py`**, modelled on `services/vision_llm.py`:
  - The person picks `(provider, model)` explicitly. `vision_llm` always uses `providers[0]` and caps a call at 13 images (`:21`); the reader does neither.
  - Batches of 6 images, longest edge 1024 px (Q13), JPEG in memory.
  - At most 2 requests at once, 60 s each, one retry on invalid JSON.
  - `responseSchema` for Gemini, plus the Argon settings `GEMINI_CHAT_NO_SAMPLING`, `GEMINI_CHAT_THINKING_LEVELS` and `GEMINI_CHAT_MAX_OUTPUT` (`handlers/google_gemini.py:32-45`). Output is capped per batch.
  - `usageMetadata` is captured.
- **Phase 1 (per image):** medium, style, light, motifs, and candidate looks with a fit score. Existing frame names go into the prompt so the model reuses them.
- **Phase 2 (one text-only sort):** assignments, Unsorted, `alsoIn` and hybrids.
- **Python enforces the rules afterwards:**
  - Only targets move (C11 and C12).
  - Frames you named are never renamed or deleted.
  - At most 8 new frames per run.
  - A fit below 0.5, or a failed read, goes to Unsorted (Q17).
  - Each image goes to its best frame only. A second fit becomes an `alsoIn` suggestion.
  - When 3 or more references share a pair, one `hybrid` suggestion replaces their `alsoIn` suggestions (Q10).
- **Menu ("READ THEM WITH").**
  - It lists curated models filtered by `node_readiness.configured_keys(load_settings())` (`node_readiness.py:328`, `services/settings.py:89`). Gemini 4 Argon on Google (`gemini-chat`'s default, `node_definitions.json:6495`) comes first, which is source-direct.
  - "Measure only" is today's free `analyze_moodboard`.
  - GM's "Gemini 3 Flash" row appears only after its price and vision support are verified.
- **Price.**
  - `POST /api/moodboards/{id}/read/estimate {model, imageIds?}` returns `{count, batches, low, high, unconfirmed, sources}`.
  - Low/high = (image tokens at 1024 px + prompt) per batch, plus capped output per batch, plus phase 2, at the vendor's per-token prices.
  - The prices live in a curated `backend/data/moodboard_reader_models.json`, each entry with `sources`, `checked` and `unconfirmed`, and a test validates it. This is not `model_pricing.json`, whose validator needs a node definition.
  - **Gemini 4 Argon's price is not in the repo.** PR4 fetches Google's pricing page. If it isn't exact, the row says "No list price, may cost more" and asks for confirmation (Q16).
- **Gating.**
  - **The person:** the price shows in the menu row and on the button. Above `runCostConfirmUsd`, the bar asks inline (`shouldConfirmRunCost`, `lib/runScope.ts:359`).
  - **Agents:** `agent_spend.decide` (`agent_spend.py:590`) takes `pricing` and `definitions` as arguments. The reader passes one item, `{definitionId: "gemini-chat", params: {model}}`, with a one-off pricing entry built from its own estimate. Per-model caps then apply to the chat model the person already sees in Settings (Q11).
  - **The hold:** the high estimate is held at the start. Batches that never start are given back (the pattern is `_release_unspent_hold`, `main.py:1896`). An unpriced read under any USD limit is refused, as for unpriced nodes.

---

## 6. PR sequence

**Live check, the same for every PR.**

- **Backend:** port 8791, with a temp `HOME`, `NEBULA_SETTINGS_PATH`, `NEBULA_STATE_DIR`, `NEBULA_OUTPUT_ROOT` and `NEBULA_MOODBOARD_ROOT` (CONTRIBUTING.md "Running a second, isolated dev instance").
- **Vite:** port 5791 with `VITE_NEBULA_BACKEND_PORT=8791`.
- **Puppeteer:** blocks 8000-8010 and 5173 through CDP. Desktop sizes only: 1440×900 and 1920×1080.
- **Seed:** the golden old-board JSONs (PR1) plus their fixture images, copied into the temp root.
- **Byte check:** sha256 of every board file, then open and close each board in the Studio, then assert the files are unchanged.
- Never touch Justin's `nebula` tmux session.
- **Docs and notes:** every PR updates `implementation-notes.md` and the contract 07 changelog. `FORjustin.md` (gitignored, main checkout) is extended by the coordinating session after each PR, never committed.

### PR1: Board model v2, lossless writes (backend; nothing visible)

- **Goal.** New fields survive every write. Old boards read with a layout and nothing else changes, so the old-board risk is retired first.
- **Scope.**
  - **New `services/moodboard_layout.py`:** `FULL_AREA`, `MIN_WEIGHT`, `weight_of`, `size_for`, `legacy_layout`, `place` (the "after the last one" mode only), and an aspect cache.
  - **`moodboard_store.py`:**
    - `_normalize_images(images, stored)` merges by id and validates placements.
    - New images are placed by the server.
    - `_migrated(board, layout=True)` runs on `get` and `update` only.
    - `frames`, `suggestions` and `readings` are normalized.
    - `layoutVersion` is stamped on the first layout write.
  - **`main.py`:**
    - `MoodboardImageModel` gains `placements`.
    - PUT uses `model_dump(exclude_unset=True)` per image.
    - Board-level layout fields are refused with a pointer to `/edits` (which lands in PR3, so the message just says layout can't be set by PUT).
  - **`handlers/moodboard.py`:** whitelist the bundle image keys `{id, url, weight, notes, excluded}`.
  - **`moodboard_client.py`:**
    - `_steering` uses explicit keys.
    - `get_board` refetches by id after a name match.
    - `brief()` adds `placements` and the board's `frames`.
  - **`types/index.ts`:** optional fields.
  - **`moodboardToDraft`** keeps placements.
- **What the person sees.** Nothing. `nebula moodboard show --json` lists placements.
- **Tests that fail on main first.**
  - `test_put_keeps_private_note_when_omitted`: main resets it to "".
  - `test_put_keeps_placements_from_a_stale_client`.
  - `test_cli_set_on_a_board_with_placements`: main returns 422 once GET has placements. Written against a fixture board that has them.
  - `test_cli_layout_change_keeps_analysis`.
  - `test_bundle_images_have_only_output_keys`.
- **New tests.**
  - An old board reads with a grid and the same `source_hash` and `brief_basis`.
  - Opening without an edit leaves the bytes unchanged.
  - A new image lands after the last one, with no overlap.
  - The layout is deterministic across two reads.
- **Golden file, captured on main before any change.** It covers `brief`, `analysis_is_current` and the handler outputs for these old-board shapes:
  - before the brief fields
  - before `privateNote`
  - a version 3 analysis
  - a version 4 analysis
  - weight 0
  - excluded
  - an unresolvable URL

  It must stay identical after every later PR.
- **Live check.**
  - The byte check.
  - `nebula moodboard add` on an old board saves the grid with the new image last.
  - An open Studio still edits and autosaves the grid.
- **Docs.**
  - Contract 07 §1.1 (fields; "layout is written only by edits"), §1.5 (old boards read with a layout).
  - `implementation-notes.md` (the PUT merge change).
- **Risks.**
  - Image header reads on a large board's GET (cached by mtime; `list` skips them).
  - Changing PUT semantics for API callers who relied on "omitted = default" (pinned by tests; the contract says so).
- **Deferred.** The edits route, all UI.

### PR2: One "Set aside" switch (C3, analysis v5)

Can be built alongside PR1; merges after it.

- **Goal.** Set-aside images are read for colours and never steer. Steering outputs are unchanged.
- **Scope.**
  - The analysis changes in §4.4.
  - `ANALYSIS_VERSION = 5`.
  - The List view label "Exclude" becomes "Set aside". Weight-0 tiles dim and show as set aside.
  - CLI `--set-aside N` and `--use N`, with `--exclude/--include` kept as aliases. `show` prints "set aside".
  - MCP `moodboard_update` docstring. `brief()` adds `setAside`.
- **What the person sees.** "Set aside" in the List view. After Analyze, set-aside images show their colours. The brief and generator output are unchanged.
- **Tests that fail on main first.**
  - `test_set_aside_is_measured_never_steers`
  - `test_set_aside_colours_have_no_sources_or_contribution`
- **New tests.**
  - `test_v4_analysis_stays_current`.
  - The summary count leaves out set-aside images.
  - The all-set-aside warning.
  - Krea's references never include a set-aside image.
  - The pin's steering view is unchanged, plus the new set-aside assertion (Q7).
  - A Studio label test.
- **Live check.** Re-analyze an old board that has an excluded image. The palette, brief and Krea references are identical, and the image's colours appear.
- **Docs.** Contract 07 §1.1 and §1.3a. `skills/nebula/SKILL.md` (moodboard section, ~120-219). `docs/MCP-SETUP.md:1142+`. The `INSTRUCTIONS` moodboard paragraph.
- **Risks.** An excluded image whose file is gone now adds a "Could not resolve" warning. That is acceptable, and the contract says so.

### PR3: Checked board edits, journal and live Studio (backend + Studio plumbing)

- **Goal.** Retire the concurrency risk: no writer can overwrite another, and an open Studio follows outside edits.
- **Scope.**
  - **New `services/moodboard_edits.py`:** parse, validate, apply and inverse for the ops in §5.1, minus `arrange` (PR12).
  - **`main.py`:** `POST /api/moodboards/{id}/edits`, `baseVersion` on PUT (409), the richer broadcast, and journal kinds plus PUT diffs.
  - **`moodboard_client.py`:**
    - `edit_board`.
    - `add_to_board` uses the `add` op, so placement is server-side and the "read again after downloading" race goes away.
    - `previous` comes from the route's `undo`, and `RESTORE_KEYS` gains `ops`.
  - **Studio:**
    - Grid edits (weight, notes, set aside, add, remove) become ops through the queue in §5.3.
    - PUT carries board fields only, with `baseVersion`.
    - The open draft refetches and rebases on foreign changes.
- **What the person sees.** A CLI `add` or `set` now appears live in an open Studio and is no longer overwritten by its autosave.
- **Tests that fail on main first.**
  - A Studio `storedAssetChanged` for the open board updates the draft (main ignores it).
  - A CLI `add` racing a Studio weight edit keeps both.
  - A stale `baseVersion` returns 409.
- **New tests.**
  - The batch is atomic (a bad op leaves the file unchanged).
  - The inverse round-trips.
  - `restore` is partial when an `expect` doesn't match.
  - A move keeps the analysis; a resize sets weight from area.
  - Journal kinds and actors.
  - The broadcast carries `edit.actor`, and an agent can't send a tab.
  - A private note is never journaled with its text.
  - Every pinned board's hash is unchanged after a layout-only write.
  - The existing 337-line Studio test file stays green.
- **Live check.** Run `nebula moodboard add` while the Studio is open: the tile appears without a reload, then edit a note and both survive. Run a byte check on untouched boards.
- **Docs.** Contract 07 §1.3 (routes) and a new §1.11 "Board edits". `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md` (the `previous` shape).
- **Risks.**
  - Rebase bugs. Mitigated because every op is an absolute set and the queue is small.
  - The size of the op set. Keep it to §5.1.
- **Deferred.** Canvas UI, agent tools for ops (PR9).

### PR4: Reader dry run, price and spend gate (backend + CLI)

Runs alongside PR3 and PR5.

- **Goal.** Retire the model-quality and price unknowns before any Analyze UI. Justin judges the sort on his real board from the CLI.
- **Scope.**
  - `services/moodboard_reader.py`, both phases (§5.6).
  - `data/moodboard_reader_models.json` with vendor sources.
  - `POST …/read/estimate` and `POST …/read?dryRun=1`. The dry run saves nothing and returns proposed looks, Unsorted and suggestions.
  - CLI `nebula moodboard analyze <board> --read-with gemini-4-argon --dry-run [--only 3,5]` prints the price, then the proposed looks.
  - MCP `moodboard_analyze(read_with, dry_run)`.
  - The spend gate for agents.
- **What the person sees.** Nothing in the app. In the CLI, a priced dry run.
- **Tests.**
  - Recorded provider responses (`tests/fixtures/provider_schemas/`).
  - More than 13 images per run.
  - Batching and the schema.
  - A retry on malformed JSON.
  - Partial failure leaves those images unsorted.
  - The estimate maths.
  - An agent is refused when any USD limit is set and the read is unpriced.
  - The hold is given back when the key is missing.
  - The person passes.
- **Live check.**
  - A mocked provider on the isolated stack.
  - One real Argon probe with Justin's key, but only after he approves the spend. It records tokens per image at 1024 px and writes them into the model file's notes, as the qc-* entries do.
- **Docs.** `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`, contract 07 §1.12 "Reading references".
- **Risks.** Argon pricing is unverified. Sort quality may vary between runs, which is acceptable as a first draft (C10), but Justin should see it before PR10.

### PR5: The Board view (preview, behind a switch)

- **Goal.** Retire the React Flow feel and speed risk on real boards.
- **Scope.**
  - **New components:** `BoardCanvas.tsx` (its own `ReactFlowProvider`), `BoardCardNode.tsx` (no handles), `BoardSidePanel.tsx`, `MoodboardListView.tsx` (today's grid, moved unchanged), `boardCanvasStore.ts` (memoized nodes, the queue from PR3), `boardUndo.ts`.
  - **Layout:** rail | canvas | panel. `.moodboard-studio-view__main` gets an explicit height for React Flow.
  - **Top bar:** a Board/List switch. It is remembered per viewer in `localStorage` with try/catch. List stays the default in this PR.
  - **Interaction:** from `CANVAS_INTERACTION_PROPS` (`lib/canvasNavigation.ts:24`).
  - **`visibleFlowRect`** moves from `Canvas.tsx:823` into `lib/`.
  - **Level of detail:** studio-local. Cards use `?thumb=1` unless their on-screen width is above about 480 css px.
  - **Speed:** `onlyRenderVisibleElements` and stable node objects.
  - **Drag:** one `place` op and one undo step.
  - **File drop** at the pointer (`screenToFlowPosition`).
  - **Side panel:**
    - A reference selected: the steering note, the private note (`AutoGrowTextarea`, `PRIVATE_NOTE_LIMIT`), `ImageColors`, a Set aside switch and a weight slider.
    - Nothing selected: the board fields, `BriefFields`, the brief and swatches.
  - **Studio undo and keys** (§5.4).
- **What the person sees.** A "Board" switch. His board as a canvas in the same order, with nothing moved. Drag, drop images where he points, undo. List is today's grid.
- **Tests.**
  - Provider isolation: the main `useReactFlow` is untouched.
  - Cards render at server positions.
  - A drag gives one op and one undo step.
  - A foreign edit rebases without losing a pending note.
  - The List and Board views stay consistent.
  - Opening doesn't set `dirty`.
  - Cmd+S doesn't trigger the graph save.
  - Delete removes and offers Undo.
- **Speed check.** A Puppeteer run on a seeded 300-reference board drags a card 400 px, then pans and fits. The rAF frame p95 must stay under 20 ms. Fallback: no shadows or filters while dragging. The PR states the measured number.
- **Live check.** Screenshots at fit, 40% zoom and a drag in progress, plus the List view. The byte check.
- **Docs.** Contract 07 §1.7 (opening a board: Board/List).
- **Risks.**
  - Global `.react-flow` CSS bleeding in (`slava-restraint.css:391-416`). The handle styles don't matter, since cards have no handles.
  - Document-level key listeners (`CommandPalette`, `ContextMenu`, `KeyboardShortcuts`) acting in the Studio. Each one is checked in the PR.

### PR6: Size is weight (C2), badges, motion; Board becomes the default

- **Goal.** Feature parity with the grid, so the canvas can be the default view.
- **Scope.**
  - **Resize:** a corner `NodeResizeControl` with `keepAspectRatio`. The weight readout in `onResize` pops on each 0.05 step. One `resize` op is sent in `onResizeEnd`. Size is capped at full weight.
  - **Badges:** `#n · w`, a dot for each note, and a set-aside dim with desaturation.
  - **Sliders:** the side panel loses the weight slider. The List view slider now resizes the card.
  - **Motion tokens** in `moodboard-canvas.css`, sampled by a new `lib/springs.ts` as `linear()` curves, following `provider-switcher.css:7-12` and `asset-trash.css:138`:
    - `--mb-spring-move`: k 380, c 34, about 420 ms. Programmatic moves: add, sort, arrange, undo, agent edits.
    - `--mb-spring-pop`: k 500, c 36, 320 ms. Badges, chips, count ticks.
    - `--mb-spring-soft`: k 220, c 28, about 520 ms. Frames appearing.
  - **Drag lift:** scale 1.04 plus a shadow, on a spring.
  - **Programmatic moves** add a `.mb-moving` class (a transition on `transform`), staggered 18 ms by number and capped at 500 ms. The class is removed on `transitionend` and never applies while dragging.
  - **Camera:** `fitView`/`setViewport` with `ease` = the sampled spring.
  - **Reduced motion** sets every duration to 0, as `Canvas.tsx:267` does.
  - **Board becomes the default view.**
- **What the person sees.** A big card counts more, and the weight shows while he resizes. The board opens as a canvas.
- **Tests.**
  - Badge maths match the server's rounding.
  - Resizing one card never changes another's badge.
  - The resize cap.
  - A vitest fails if `moodboard*.css` contains `ease-in-out` or bare `ease`.
- **Live check.** Screenshots during a resize. A real resize changes the palette shares after Measure.
- **Docs.** Contract 07 §1.11 (size and weight).

### PR7: Frames and linked copies by hand (C4, C13)

- **Goal.** Looks you draw and name. One image can sit in several looks.
- **Scope.**
  - **Frame node:** below the cards in z-order, the tab as its drag handle, and `NodeResizer` with the members' bounding box as its minimum.
  - **Drawing frames:** F draws a frame, and Cmd+G frames the selection. The name is edited inline. The tab reads "Painterly · look · 7".
  - **Membership:** set on drop. Moving a frame moves its members.
  - **Editing frames:** merge by dropping one tab onto another frame; split with "New look from these"; deleting a frame keeps its cards.
  - **Linked copies:** Option-drag into another frame, or "Also in ▾" in the side panel. The "also in Dither" chip shows on the copy, and each look has its own weight.
  - **Unsorted** renders as dashed.
  - **List view:** a Looks column, and a weight per look.
  - **CLI:** `set --in 12=Dither`, `--link 12=Glass`, and `nebula moodboard frame new|rename|merge|delete`. `show` lists looks.
  - **MCP:** frames and copies in `moodboard_get`.
- **What the person sees.** He can draw and name looks, drag references into them, and have one reference in two looks at different sizes.
- **Tests.**
  - Being near a frame doesn't make a card a member.
  - One copy per frame.
  - Linked copies share notes and the reading.
  - `image.weight` is the largest copy.
  - Moving a frame moves its copies.
  - The brief from `compose` and `source_hash` are identical before and after framing a board.
  - The Q5 and Q6 rules.
- **Live check.** Screenshots of frames, a linked copy with its chip, and a merge. Undo of each frame op.
- **Docs.** Contract 07 §1.11. `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`.

### PR8: Agents see the board, and placement next to the view (C8, read half of C9)

- **Goal.** An agent can see what Justin sees on the board.
- **Scope.**
  - The Studio view reporter and `BoardViewBook`.
  - The `look` and `picture` routes.
  - MCP `moodboard_look` and `moodboard_picture`. CLI `nebula moodboard look` and `picture`.
  - `studio` in `look_at_canvas`.
  - `place()` with the view mode.
  - `add --at/--in/--size` and the matching `moodboard_add` arguments.
  - The Studio cursor layer, so an agent's add points at the new card.
  - New tools are added to `NEBULA_MCP_TOOLS` (`krea_agent_mcp.py:38`) and the allow-list (`agent_profiles.py:70`).
- **What the person sees.** "Claude, put these in free space" lands next to what he's looking at, and the cursor shows where.
- **Tests.**
  - Placement prefers the visible area, and goes after the last card when the view report is stale.
  - Never on top of another card (a property test over 500 random boards).
  - The shape of the look report, with off-screen looks and their counts.
  - The private note is flagged.
  - The picture renders headless.
  - `test_agent_mcp_registration.py`.
  - The instructions test.
  - The CLI help verbs.
- **Live check.** An agent adds three references while the Studio is panned to one corner: they land in view. Look at the picture output.
- **Docs.** `INSTRUCTIONS` (moodboard paragraph), `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`, contract 07.

### PR9: Agents edit the board, recent edits, undo credit (write half of C9)

- **Goal.** Agents change the board the way they change the canvas.
- **Scope.**
  - MCP `moodboard_edit` and CLI `nebula moodboard edit`. The cursor follows each batch.
  - The "Since your last turn" block and the board context for all three runners.
  - The chat payload's `studio` field.
  - The foreign undo step and notice in the Studio.
- **What the person sees.** "Claude moved #12 into Dither · Undo". The agent knows what he moved since its last turn.
- **Tests that fail on main first.**
  - An agent's edit undoes as one step in the Studio.
  - The next turn lists the person's moves.
- **New tests.**
  - A private note never appears in the per-turn block.
  - Canvas chat behaviour is unchanged.
  - An agent can't spoof a tab.
- **Risks.** Boards can be Global while the journal is project-tagged (§5.2). Test reading a Global board's events from inside a project.

### PR10: Analyze sorts into looks (C10, C11, C12)

- **Goal.** One button turns a pile into an editable first draft.
- **Scope.**
  - **The bar** sits in screen space, top-centre, under the top bar. It reads "20 new references · not analyzed", with an "Analyze ▾" button.
  - **The menu** has the price on each row, a cancel button, and the progress states from GM's beats:
    1. "Analyzing with Gemini 4 Argon · 7 of 20"
    2. "Read with Gemini 4 Argon · sorting into looks"
    3. "Sorted 19 into 4 looks · 1 Unsorted · Undo"
  - **Job:** one in-memory job per board, with a WS `moodboardRead` event and `GET`/`DELETE …/read/{job}`.
  - **Targets (C11):** with a selection, those references are read again. With nothing selected, the targets are the references with no reading for their current URL, plus the Unsorted ones.
  - **Applying the result:** one edit batch from actor `analyze`, credited to whoever asked, journaled as `board.sorted`, and one undo step. The rules are in §5.6. C12 b): a selected reference the person placed may move.
  - **Unsorted** is created in free space.
  - **Motion:** cards spring into frames, and frames fade in.
  - **Measure** runs as part of the run (free).
  - **CLI and MCP:** the same call without `--dry-run`.
  - **The side panel** shows the reading, read-only (Q12).
- **What the person sees.** The full flow from GM's video, frames 2 to 2b.
- **Tests.**
  - The C11 rule matrix.
  - C12 b): a selection moves a reference the person placed, and one Undo restores it.
  - A frame the person named is never renamed.
  - Partial failure lands in Unsorted with a "couldn't read" dot.
  - Cancel gives back the batches that never started.
  - The button stays disabled until the estimate arrives.
  - An agent-run Analyze goes through the gate.
- **Live check.** A mocked provider for the flow and screenshots. One real run only with Justin's approval.
- **Docs.** Contract 07 §1.12. `skills/nebula/SKILL.md`, `docs/MCP-SETUP.md`.

### PR11: Second-look and hybrid suggestions (C13 from Analyze)

- **Scope.**
  - Suggestions from phase 2 appear as chips: "Fits Dither too?" with accept or dismiss. Accepting creates a linked copy in free space in that frame, at the same weight.
  - The hybrid suggestion is "Make a 'Painterly × Pixel' look for #3, #9, #14?". Accepting creates the frame, moves those references in (Q10), and replaces their `alsoIn` suggestions. It is one Undo.
  - CLI `nebula moodboard suggestions [--accept ID|--dismiss ID]`. Suggestions also appear in `moodboard_look`.
- **Tests.**
  - A second frame is never added without an accept.
  - A hybrid replaces the pair suggestions.
  - A dismissed suggestion never comes back.

### PR12: Arrange (C8)

Runs alongside PR9 to PR11.

- **Scope.**
  - An `arrange(by, scope)` op, computed on the server.
  - CLI `nebula moodboard arrange <board> --by look|colour|weight [--only …]`, MCP `moodboard_arrange`, and a "Tidy ▾" menu.
  - **By look:** frames packed in a grid, cards packed inside them.
  - **By colour:** the dominant hue from `analysis.images`. If the analysis is stale, it measures first.
  - **By weight:** heaviest first.
  - It never changes sizes, memberships or `images[]` order, and it is one Undo.
- **Tests.**
  - No overlap.
  - Numbers are unchanged.
  - Arrange is idempotent.

---

## 7. Open questions for Justin

Each question has a recommended answer. The plan builds the recommendation unless he says otherwise.

| # | Question | Recommendation | Why |
|---|---|---|---|
| Q1 | What size is full weight? | A 480×270 card (129,600 px²). | It is the size GM's mockup gives new drops, so a new reference lands at full weight, as with today's default weight of 1.0. |
| Q2 | Can a card grow past full weight? | No, resizing caps there. | Size always reads as weight. Larger cards at 1.0 would break "read the board's priorities at a glance". Zoom covers looking closely. |
| Q3 | What is the smallest card? | Weight 0.05 (about 107×60), today's slider step. | Every weight the slider makes today survives. Below that is Set aside. |
| Q4 | An image in several looks: what weight does the whole-board brief use, until per-look briefs exist? | Its heaviest copy. | A double membership never counts twice, and "heavy for Dither" is still felt. |
| Q5 | Dragging a linked copy onto empty canvas? | It leaves that look (with Undo). The last copy becomes loose. | It keeps "loose = in no look" true, and frame membership stays the only signal (C4). |
| Q6 | Drawing a frame over references? | The ones fully inside join it. | It is the obvious gesture, and a membership written then is still explicit. |
| Q7 | Old "Excluded" images become Set aside: read for colours, never steer. The pin test then filters set-aside entries out of `imageColors` and pins their colours in a separate check. OK? | Yes. | It is C3's single switch, and every steering output stays pinned byte for byte. The alternative keeps a second "not read" state on old boards, which is C3 b). The pin guards gap #20, so this test change needs your nod. |
| Q8 | Old weight-0 images? | They show as Set aside at full size. Stored weight 0 is kept until you use them again. | Nothing about their analysis changes, and they don't shrink to nothing. |
| Q9 | Run the free Measure automatically after an edit that steers? | Yes, in the Studio, 1.5 s after the last steering edit. | With size as weight, every resize clears the colours today until you press Analyze. The local measure is free. |
| Q10 | Hybrid frames: when, and what does accepting do? | Suggest one at 3 or more references sharing a pair. Accepting moves them in as a single membership. | It follows C13's "instead of many double memberships". |
| Q11 | What limit does an agent-run Analyze count against? | The chat model's existing per-model cap (Gemini chat for Argon). | It is the same model and bill, and there's no new setting to find. |
| Q12 | Show the reading (medium, style, light) in the side panel once Analyze exists? | Yes, read-only, outside the brief. | C6 said "later", and later arrives with Analyze. It explains the sort. Feeding it into the brief waits on analysis option 1. |
| Q13 | What size are images sent to the reader? | 1024 px on the longest edge. | Dither and grain are the looks being sorted, and 768 px (`vision_llm`'s size) blurs them. The cost difference is measured in PR4. |
| Q14 | Unsorted when it's empty? | It disappears, and comes back on the next Analyze. | It's a holding pen, not a look. |
| Q15 | The Delete key on the board? | It removes at once, with an Undo toast and no dialog. | Undo is cheap and covers it, and a dialog on every delete is friction. |
| Q16 | Gemini 4 Argon's price, if Google's page doesn't list it exactly? | Show "No list price, may cost more" and require a confirmation. Agents are refused under any USD limit. | It follows "verify before reporting" and how unpriced nodes already work. |
| Q17 | When does a reference go to Unsorted? | When the model says it fits none, or its fit is below 0.5. | Unsorted should hold the genuinely unclear ones. 0.5 is a start that PR4's dry run will tune. |

---

## 8. Out of scope, and what this waits on

- **C5 Avoid area.** It waits on the brief-conflicts calls (#18). A frame `kind: "avoid"` is cheap to add later, and nothing here prevents it.
- **Analysis option 1 (a reader that describes images and feeds the brief).** It is unpicked. Readings are stored and shown, but never enter `source_hash`, `brief_basis`, `compose`, the node bundle or any generator.
- **Analysis option 4 (one brief per look).** It is unpicked. Per-frame weight is stored as `placement.weight` and read by nothing. The brief stays whole-board, with `image.weight` = the heaviest copy. A generator can't ask for one look yet.
- **GM video beats 5 to 12** are separate GM ideas, not item 6: marking a region, a correctable reading, comments and approvals, test images and reactions, liked vs decided, "more like this", and board history.
- **A board picture captured from the browser.** The server composite covers C9.
- **A hard cap on images per board.** None exists today. PR5 measures speed at 300 images.

---

## 9. Sizes

| PR | Code | Tests | Agent-days | Depends on |
|---|---|---|---|---|
| 1 Board model v2 | ~600 | ~500 | 2.5 | — |
| 2 Set aside | ~250 | ~250 | 1.5 | 1 (merge order) |
| 3 Checked edits + live Studio | ~1,100 | ~700 | 3.5 | 1 |
| 4 Reader dry run + price | ~1,000 | ~500 | 3 | 1 |
| 5 Board view (preview) | ~1,300 | ~400 | 4 | 3 |
| 6 Size is weight, motion, default | ~500 | ~200 | 2 | 2, 5 |
| 7 Frames + linked copies | ~1,500 | ~550 | 4 | 6 |
| 8 Agents see + placement | ~1,300 | ~500 | 3.5 | 5 |
| 9 Agents edit + recent edits | ~1,000 | ~400 | 3 | 8 |
| 10 Analyze sorts | ~1,500 | ~600 | 4.5 | 4, 7 |
| 11 Suggestions | ~800 | ~350 | 2.5 | 10 |
| 12 Arrange | ~700 | ~300 | 2 | 7 |

- **Total:** about 11,600 lines of code and 5,250 lines of tests (about 16,800), about 36 agent-days in sequence.
- **With two lanes:** PR2 and PR4 run early, and PR8, PR9 and PR12 run beside PR7, PR10 and PR11. The critical path (PR1 → PR3 → PR5 → PR6 → PR7 → PR10 → PR11) is about 23 days.
- **When Justin gets something:** a usable canvas after PR6 (about 12 days), and a priced CLI dry run of the sort after PR4 (about 6 days).

---

## 10. How the two plans were merged

- **Structure.** Model-first's PR split (small backend PRs first, a separate set-aside PR, the canvas shell before size-is-weight) is combined with experience-first's later order (see before edit, Analyze before suggestions, arrange on its own) and its dry-run CLI for judging sort quality early.
- **Studio plumbing.** The plumbing (the queue and the rebase) lands with the edits route (PR3), as experience-first had it. Model-first had it in the canvas PR. The edits route is then proven end to end on the grid before any canvas exists.
- **Set aside.** Model-first: keep `excluded` as the stored switch and give it the new meaning. Experience-first wanted a new key and a second legacy state, which is C3 b). The hash and the steering outputs stay unchanged either way.
- **Numbers.** Both plans: `index + 1`, never reorder. The board-model map's never-reused counter is dropped, per the C7 "why" on the decision page.
- **Field names.** `placements` (model-first) over `cards`, `layoutVersion` over `canvas.version`, and the route `/edits`.
- **Placement weight.** It is stored on the placement, and `w, h` are written from it. Neither plan had exactly this. It removes the "within 0.005" tolerance experience-first needed and model-first's rounding of copy weights.
- **Loose copies.** A loose placement only when it's the only one (experience-first). Model-first allowed a loose copy beside framed ones.
- **Undo conflicts.** Partial `restore` with `expect` (model-first) over an all-or-nothing 409 (experience-first).
- **Price.** The reader's own price table plus `decide` with a one-off entry, billed as the chat model. Both plans proposed a `moodboard-read` entry in `model_pricing.json`, which `validate_pricing` and `test_model_pricing.py:39` would reject.
- **Resizing.** Capped at full weight (experience-first's recommendation), against model-first's "grow past, stay at 1.0". It is Q2.
- **Minimum weight.** 0.05 (today's slider step), between model-first's ~0.02 and experience-first's 0.1. It is Q3.
- **`FORjustin.md`.** Extended after every PR by the coordinating session (it is gitignored), not saved for the last PR.
- **Dropped claims.** Experience-first's "contract 07 §1.7" for the canvas (§1.7 already exists; new sections start at §1.11), and its steering-weight hash (not needed once `excluded` keeps its place in the hash).

### Not verified (check in the PR that needs it)

- Gemini 4 Argon's per-token price and its image token cost (PR4: fetch Google's pricing page, then run one approved probe).
- That `estimate_run` prices a one-off `per: "request"` entry passed through `decide` with no further fields (PR4).
- React Flow speed with 300 image cards (PR5's speed check).
- Whether `CommandPalette`, `ContextMenu`, `KeyboardShortcuts` or `WorkspaceRail` act on keys inside the Studio (PR5).
- Whether `resolveAnchor` in `lib/agentCursorMotion.ts` fails quietly on an unknown id (PR8).
- Whether GM's "Gemini 3 Flash" and "Measure only" rows are meant as shown. The mockup is not a spec.
- Line numbers drift; the ones here are from `12257250`.
