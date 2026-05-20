# Video Editor Tab — Phase 1 Design

> **Status:** Approved 2026-05-20 (brainstorm + research complete; ready for implementation planning)
> **Phase:** 1 of 5 (video editor — substrate + Tier 2 primitives)
> **Companion docs:**
> - Research notes: [`2026-05-20-video-editor-tab-research.md`](2026-05-20-video-editor-tab-research.md)
> - Future phases noted in §10 (out of scope)

---

## 1 — Goal & Success Criteria

**Goal.** Add a second canvas mode to Nebula Nodes: a per-node video editor that opens when an editable media node is selected and the Editor tab is clicked. Edits live on an auto-spawned `video-edit` node downstream of the source, so downstream AI nodes consume the edited version transparently. Edits **are** nodes — the integration is the portfolio piece.

**Success criteria.**

1. From a graph with one Veo node, the user can: select it → click **Editor** → land in a working editor with the generated video loaded → trim to a sub-range → click **Canvas** → see a new `video-edit` node downstream with the trimmed clip flowing to the next AI node.
2. The full Tier 2 primitive set (trim, speed, cut splits, volume, mute, multi-track view) is exercised in a single demo loop.
3. Re-running the upstream AI node (regenerating the source) preserves the edit params; the handler reapplies them to the new clip with graceful clamping when geometry changes.
4. The editor surface is portfolio-grade — visual aesthetic continuous with Slava (true-black canvas, white type in opacities, single `#FF5A1F` orange accent used as "user touched this" signifier). Interactions feel native to a real NLE.
5. Phase 1 ships in **4–5 focused weeks** (revised from 3–4 after research-driven additions). `/lab/nebula-video-edit` (or similar) goes live on `justinperea.com`.

**Non-goals for Phase 1.** Filters / color grading, text overlays (Phase 2). Transitions, audio replacement (Phase 3). Image editor (Phase 4). Audio editor (Phase 5).

---

## 2 — User Experience Flow

The portfolio demo loop. Each step is a single user action; everything between is automatic.

1. **Generate.** User drops a Veo 3 node, types a prompt, hits Run. After ~60 seconds they have an 8-second clip with audio, previewed inline on the node card.
2. **Enter editor.** With the Veo node still selected, user clicks **Editor** in the top pill control. The viewport swaps from React Flow graph to editor surface. Behind the scenes: a `video-edit` node is auto-created downstream and wired (Veo `video` → Edit `video_in`). The editor loads the source clip into the preview.
3. **Edit.** User trims from 8s to 3s by dragging in/out handles on the video track. Slows it to 0.5× via the speed slider. Cuts at the 2-second mark to split into two sub-clips. Lowers audio to 40%. The preview reflects every change live — virtual playback in `<video>`, no render yet.
4. **(Optional) Render Preview.** User hits **Render Preview** in the transport. The handler runs a fast low-res ffmpeg render (~1–2s). The preview window plays the actual rendered output for ~10s, then reverts to virtual playback. Confirms what the final output will look like before wiring downstream.
5. **Return to canvas.** User clicks **Canvas** in the top pill. Viewport swaps back. The new `video-edit` node sits downstream of Veo, its card showing a small thumbnail of the edited clip + edit summary strip.
6. **Wire downstream.** User drags from `video-edit` output to another node — say, a Veo I2V or Sora 2 node that consumes this as a reference clip. Hits Run.
7. **Execute.** Graph engine runs Veo (cached, skipped), then `video-edit` (handler invokes ffmpeg — first time the file actually gets rendered for real), then the downstream node which consumes the rendered MP4. The downstream node sees the **edited** 3s slow-mo clip, not the original 8s.
8. **Iterate.** User re-runs Veo with a different prompt. New 8s clip flows into the Edit node. Trim/speed/cut/volume params reapply; clips clamped if new geometry doesn't fit. No edit work is lost.

**Portfolio moment.** Step 6–7 is the shot: the user wires a *post-edit* output into a *new AI node*, runs the graph, and watches the AI react to their edit. Nobody else is doing this — the edit isn't an export; it's a node.

---

## 3 — Surface Design

### Pill tab control

Floating pill at the top center of the canvas, matching the bottom toolbar's Slava aesthetic exactly. Two buttons: **▣ Canvas** / **▤ Editor**. Glass background (`rgba(28,28,31,0.78)` + `backdrop-filter: blur`), 1px `rgba(255,255,255,0.06)` edge, pill border-radius. A faint dot-matrix `CANVAS(VIEW)` wordmark sits above it, echoing the `NEBULA(NODES)` label above the bottom toolbar.

Active tab gets an `rgba(255,90,31,0.10)` background with `rgba(255,90,31,0.45)` border (orange = edit-bearing). Inactive tab is `rgba(255,255,255,0.55)` text on transparent.

**Disabled state** for the Editor button:
- No selection
- Selected node's output type ≠ `Video`
- Selected video node hasn't executed yet (hover tooltip: "Run the node first")

### Editor surface layout (stacked)

When `viewMode === 'editor'`:

```
┌──────────────────────────────────────────────────────────┐
│           [▣ Canvas]  [▤ Editor●]    ← pill tab control │
├──────────────────────────────────────────────────────────┤
│ EDITING  veo-3 · clip-a73b  →  video-edit-9f12           │
│                                         ⌘S save · ⎋ exit │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                  ┌──────────────────┐                    │
│                  │                  │                    │
│                  │  VIDEO PREVIEW   │   ← 1920×1080      │
│                  │   (or source     │     (or source     │
│                  │    aspect)       │      aspect)       │
│                  │                  │                    │
│                  │  00:01:84/03:00  │                    │
│                  └──────────────────┘                    │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ ⏵ Play  ⏮ ⏭ │ ✂ Trim · ⏩ Speed · ⌖ Cut · 🔊 Vol │ 3 clips · 03:00 · 0.5× │ ⟳ Render Preview │
├──────────────────────────────────────────────────────────┤
│ 0:00    1:00    2:00    3:00    4:00    ...    8:00      │
│ VID  ▰▰▰▰   ▰▰▰▰▰▰▰▰▰▰          ← sub-clips with handles│
│ AUD  ▁▂▄▆▅▃▂  ▁▂▃▄▅▃▂           vol 40%                  │
└──────────────────────────────────────────────────────────┘
```

- **Breadcrumb strip** (small mono text): `EDITING <source-id> → <edit-node-id>` + shortcut hints right-aligned.
- **Preview window** respects source aspect. Letterboxed against pure black if container ≠ source aspect. SMPTE timecode overlay at bottom center (`HH:MM:SS:FF`).
- **Transport strip**: Play / scrub controls left; tool toggles middle (Trim / Speed / Cut / Volume); live summary + **Render Preview** button right.
- **Timeline**: time ruler with **lazily-generated thumbnail strip** (1 frame per ~2s on the VID row, generated via offscreen `<video>` + canvas), two tracks (VID + AUD). Sub-clips render as draggable blocks; AUD row shows **real waveforms via wavesurfer.js v7**. White playhead with orange accent on drag.
- **Color convention**: orange (`#FF5A1F`) means "user touched this" — applies to playhead, active editor tab, sub-clip blocks that differ from defaults (e.g., speed ≠ 1.0), Edit node card border, speed badge, edit-node ID chip on breadcrumb. Un-edited sub-clips stay subtle white-on-white so orange always reads as edit signal.

### Edit node card (on the canvas)

When viewing the canvas, the `video-edit` node renders:
- Orange border (`rgba(255,90,31,0.45)` + soft glow)
- Title bar: `✂ VIDEO EDIT`
- Thumbnail preview (first sub-clip's first frame, via HTML5 virtual playback)
- Top-right corner badge showing speed if ≠ 1.0 (`0.5×`)
- Bottom strip: small edit-summary text — `trim · 2 cuts · 0.5× · 40%`
- Settings bar (on selection): primary **"Open Editor"** button (large, orange-tinted); the standard `…` Inspector anchor remains for Run / Duplicate / Delete

### VFR source warning

If `ffprobe` detects variable frame rate at editor entry (`avg_frame_rate` ≠ `r_frame_rate`), show a non-blocking banner across the top of the editor surface:

> ⚠ Variable frame rate source — virtual preview may differ from rendered output. Use **Render Preview** to verify.

### Empty / loading / error states

- **No `video_in` connected** (orphan Edit node): preview area shows "Connect a video upstream to edit." with a "Back to Canvas" button.
- **Source video URL 404 or fails to load**: "Source unavailable — try re-running upstream." with Back to Canvas link.
- **Waveform decoding in progress**: AUD row shows a subtle placeholder stripe + a small spinner.
- **Render Preview in progress**: button shows spinner; preview window dims slightly; user can still scrub.

### Responsive behavior

**Minimum supported viewport: 1280 × 800.** Below that, a polite banner at the top of the editor:

> Best viewed at ≥ 1280px wide. Some controls may be cramped.

Collapse order as viewport shrinks: inspector first → ruler tick density halves → preview area shrinks. **Multi-track view stays multi-track always** — never collapses to one row.

---

## 4 — Data Model

### Registry entry

`backend/data/node_definitions.json` (mirrored in `frontend/src/constants/nodeDefinitions.ts`):

```json
"video-edit": {
  "id": "video-edit",
  "displayName": "Video Edit",
  "category": "utility",
  "apiProvider": "utility",
  "executionPattern": "async-poll",
  "envKeyName": null,
  "inputPorts": [
    { "id": "video_in", "label": "Source Video", "dataType": "Video", "required": true }
  ],
  "outputPorts": [
    { "id": "video", "label": "Edited Video", "dataType": "Video", "required": false }
  ],
  "params": []
}
```

`async-poll` because ffmpeg can take several seconds on long clips; the existing progress-event stream pattern is reused.

### Edit operations

All edit state lives in the node's `params` field as an ordered list of sub-clips:

```json
"params": {
  "sourceDuration": 8.0,
  "sourceFps": 30,
  "sourceIsVfr": false,
  "clips": [
    { "id": "c1", "sourceIn": 0.5, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": false },
    { "id": "c2", "sourceIn": 2.0, "sourceOut": 5.0, "speed": 0.5, "volume": 0.4, "mute": false }
  ]
}
```

- **One source, many sub-clips.** Virgin Edit node: `clips = [{ sourceIn: 0, sourceOut: sourceDuration, speed: 1.0, volume: 1.0, mute: false }]` (single full-range entry). Trim mutates that entry; Cut splits one into two. Array order = playback order. Drag-to-reorder is **deferred** (Phase 2 nice-to-have).
- **Source-relative timestamps** so re-execution survives source-duration changes via clamping.
- **`sourceDuration` / `sourceFps` / `sourceIsVfr`** cached from `ffprobe` at handler execution. Used for clamping, frame-grid snapping, and the VFR warning banner.
- **`speed`** is a multiplier (0.25–4.0). `1.0` = no change.
- **`volume`** is 0.0–1.0. `mute: true` is independent of `volume` so toggling mute off restores prior level.

### Re-execution semantics

On every handler invocation:
1. Run `ffprobe` against source. Get duration, fps, VFR flag.
2. Update `params.sourceDuration`, `params.sourceFps`, `params.sourceIsVfr`.
3. For each sub-clip:
   - If `sourceIn >= newDuration` → drop entry, emit warning event flagging the Edit node card.
   - Else clamp `sourceOut = min(sourceOut, newDuration)`.
   - Snap `sourceIn` and `sourceOut` to source frame grid: `Math.floor(t * sourceFps) / sourceFps`.
4. If `clips` ends up empty after clamping, fall back to a single full-range entry.

### Backend mapping

No model changes — edit ops ride in `GraphNode.params: dict[str, Any]`. Save / load / cache get the structure for free.

---

## 5 — Execution Model

### Trigger

Standard Nebula execution. `video-edit` runs whenever:
- A downstream node executes and needs its output, OR
- The user hits Run with the Edit node in the active subgraph.

Cache short-circuits when `params` AND upstream source haven't changed (engine's existing cache key extended with `params.clips` + source hash). Changing a trim handle invalidates the cache.

### Handler

`backend/handlers/video_edit.py` — `handle_video_edit`. Local utility, no API keys.

**Flow:**

1. **Resolve source path.** Read `inputs["video_in"].value`. Use Style Reference's `_resolve_local_path` pattern (`backend/handlers/style_reference.py:63-85`) — accepts both filesystem paths (fresh execution) and `/api/outputs/...` URLs (restored from save).
2. **Probe source.** Run `ffprobe -v error -show_entries format=duration,r_frame_rate,avg_frame_rate -of json` to get duration + fps + VFR flag. Update `params`.
3. **Clamp + snap clips.** Per §4 re-execution semantics.
4. **Detect no-op fast path.** If `len(clips) == 1` AND the single clip covers full source AND `speed == 1.0` AND `volume == 1.0` AND `mute == false`:
   - Return `{"video": {"type": "Video", "value": inputs["video_in"].value}}` — **upstream value unchanged**. No ffmpeg invocation. No file copy. Matches the `reroute` / `style-reference` passthrough precedent.
5. **Build ffmpeg command.** For each sub-clip, generate a filter chain:
   - Video: `[0:v]trim=start={sourceIn}:end={sourceOut},setpts=PTS-STARTPTS,setpts=PTS/{speed}[v{i}]`
   - Audio (if not muted): `[0:a]atrim=start={sourceIn}:end={sourceOut},asetpts=PTS-STARTPTS,atempo={speed},volume={volume}[a{i}]` (chain `atempo` for `speed` outside [0.5, 2.0])
   - Audio (if muted): omit; the concat will substitute silence
   - Concat: `[v0][a0][v1][a1]...concat=n={N}:v=1:a=1[outv][outa]`
6. **Invoke ffmpeg.** Subprocess via `backend/services/ffmpeg.py` (new). Command flags:
   - `-i <source>` — input
   - `-filter_complex <chain>` — the sub-clip + concat graph
   - `-map "[outv]" -map "[outa]"`
   - `-c:v libx264 -preset fast -crf 23` — H.264 default
   - `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv` — explicit color tags to prevent browser mis-decoding
   - `-af aresample=async=1` (already in the audio filter chain; appended on output side) — A/V sync
   - `-progress pipe:1 -stats_period 0.25` — progress events every 250ms
7. **Stream progress.** Parse stdout line-by-line on `\n`. Each `out_time_us=` line → emit `ProgressEvent(value=elapsed/expected)` via the existing WebSocket. For clips <2s, emit a synthetic 0→100 sweep client-side instead of waiting for real ticks.
8. **Save output.** `output/<run-dir>/<uuid>.mp4` via `services.output.get_run_dir()`.
9. **Return.** `{"video": {"type": "Video", "value": str(output_path)}}`. API layer rewrites to `/api/outputs/...` per existing convention (`backend/main.py:_rewrite_output_paths`).

### Render Preview path

Triggered by the **Render Preview** button. Separate API endpoint `POST /api/video-edit/preview-render` accepting `{nodeId, params}`. Runs ffmpeg with:
- `-vf scale=640:-2` — low-res
- `-preset ultrafast -crf 32` — fast encode
- Output to `output/<run-dir>/_preview/<uuid>_preview.mp4`

Returns the preview URL. Auto-cleaned when:
- The editor is closed (`exitEditor` action)
- A fresh Render Preview is generated (overwrites or replaces the prior file)

Preview is **not** exposed to downstream nodes — purely a UI artifact for verifying virtual-vs-rendered divergence before committing to the real Run.

### Live preview (no handler involvement)

The editor surface uses an HTML5 `<video>` element pointed at the source clip. For the active sub-clip:
- `currentTime = sourceIn` (snapped to frame grid)
- `playbackRate = speed`
- `volume = volume`, `muted = mute`

When playback reaches the sub-clip's `sourceOut`, JS seeks to the next sub-clip's `sourceIn`. Loop rewinds to first sub-clip's `sourceIn`. Frame-accurate stepping uses `requestVideoFrameCallback` where available (feature-detected; `requestAnimationFrame` polling fallback). Per-frame metadata uses `metadata.mediaTime` (not `currentTime`) for frame identification.

Expected live preview drift: ±1 frame at sub-clip boundaries (per HTML5 currentTime cross-browser variance). Acceptable for portfolio-grade preview. The VFR banner + Render Preview button cover the divergence honestly.

### Errors

Non-zero ffmpeg exit → `RuntimeError(stderr last 1KB)`. Node card flips to error state. Re-run retries from scratch.

---

## 6 — Architecture & Components

### New frontend modules

| File | Responsibility |
|---|---|
| `components/CanvasTabs.tsx` | Pill control at top center. Two buttons (Canvas / Editor). Disables Editor when no eligible node is selected. Mounted at App level. |
| `components/editor/EditorView.tsx` | Top-level editor surface. Mounted instead of Canvas when `viewMode === 'editor'`. Owns keyboard shortcuts (⌘S, ⎋, all NLE keys). |
| `components/editor/EditorBreadcrumb.tsx` | Top strip — source → edit node IDs + shortcut hints + VFR warning banner. |
| `components/editor/VideoPreview.tsx` | HTML5 `<video>` driven by JS — applies `currentTime` / `playbackRate` / `volume` to step through sub-clips for virtual preview. SMPTE timecode overlay. Handles Render Preview file substitution (~10s playback, then revert). |
| `components/editor/EditorTransport.tsx` | Play / scrub controls, tool toggles, live summary string, Render Preview button. |
| `components/editor/Timeline.tsx` | Multi-track timeline container. Renders ruler, two tracks, playhead. |
| `components/editor/TimelineRuler.tsx` | Time tick marks (SMPTE-style labels) + thumbnail strip (lazily generated). |
| `components/editor/TimelineTrack.tsx` | One row (VID or AUD). Hosts `TimelineClip`s. Handles drag-to-trim, click-to-cut. |
| `components/editor/TimelineClip.tsx` | A single sub-clip block with handle UI. Reads/writes `params.clips[i]`. Orange when edited from defaults. |
| `components/editor/TimelinePlayhead.tsx` | White/orange playhead, draggable for scrubbing. Snaps to frame grid on release. |
| `components/editor/WaveformAudio.tsx` | Thin wrapper around wavesurfer.js v7 for rendering audio waveforms per sub-clip. Caches `exportPeaks()` keyed by clip ID. |
| `components/nodes/EditNode.tsx` | Edit node card on the canvas. Renders inline thumbnail preview, edit-summary strip, orange border, primary "Open Editor" button in settings bar. |

### Modified frontend modules

| File | Change |
|---|---|
| `App.tsx` | Render `<CanvasTabs />` at top. Conditionally render `<Canvas />` or `<EditorView />` based on `uiStore.viewMode`. |
| `store/uiStore.ts` | Add `viewMode: 'canvas' \| 'editor'`, `editorTargetNodeId: string \| null`, `enterEditor(sourceNodeId)`, `exitEditor()`. `enterEditor` calls into graphStore for auto-spawn. |
| `store/graphStore.ts` | Add `getOrCreateEditNodeDownstream(sourceNodeId): string`. Add `removeEmptyEditNode(nodeId)` for bail-out cleanup. |
| `constants/nodeDefinitions.ts` | Mirror the backend `video-edit` entry. |

### New frontend utilities

| File | Responsibility |
|---|---|
| `lib/editor/virtualPlayback.ts` | Pure functions for sub-clip stepping (which sub-clip at output-time T? next seek point?). Unit-testable in isolation. |
| `lib/editor/frameAccurate.ts` | Snap times to source frame grid. `requestVideoFrameCallback` feature detection + fallback wrapper. |
| `lib/editor/thumbnailStrip.ts` | Lazily generate timeline thumbnails via offscreen `<video>` + canvas `drawImage`. Cache as data URLs keyed by `(clip, timestamp)`. |
| `lib/editor/timecode.ts` | SMPTE timecode formatting / parsing — `HH:MM:SS:FF`. |

### Backend modules

| File | Responsibility |
|---|---|
| `backend/handlers/video_edit.py` *(new)* | `handle_video_edit` — the handler from §5. |
| `backend/services/ffmpeg.py` *(new)* | Thin wrapper around the ffmpeg binary. Subprocess + line-buffered progress parsing. Reusable beyond Phase 1. |
| `backend/routes/video_edit_preview.py` *(new)* | `POST /api/video-edit/preview-render` endpoint. Low-res render-on-demand. |
| `backend/data/node_definitions.json` | Add the `video-edit` entry. |
| `backend/execution/sync_runner.py` | Register the handler. |

### Tests

| File | Coverage |
|---|---|
| `backend/tests/test_video_edit_handler.py` *(new)* | Body-shape tests: no-op fast path (returns upstream URL), single-clip trim, single-clip speed, multi-clip cut sequence, clamp-on-shrink, mute behavior, error propagation, VFR source detection. |
| `backend/tests/test_video_edit_preview.py` *(new)* | Preview endpoint smoke + cleanup. |
| `backend/tests/test_node_contracts.py` | Auto-picks up the new node via the registry walker. |
| `frontend/tests/editor/virtualPlayback.test.ts` *(new)* | Sub-clip stepping math. |
| `frontend/tests/editor/frameAccurate.test.ts` *(new)* | Frame grid snapping correctness. |
| Live-smoke (manual for Phase 1) | Demo loop run on a real Veo clip. Recorded for `/lab`. |

### Dependencies added

- **Backend:** `ffmpeg` binary on host (already present on dev). `ffprobe` (same package). Optional: avoid `ffmpeg-python` library by using subprocess directly.
- **Frontend:** [`wavesurfer.js`](https://wavesurfer.xyz) v7 — adds ~50KB gzipped. No other deps.

---

## 7 — Phase 1 Scope Detail

### Entry / exit gates

| State | Editor button |
|---|---|
| No selection | Disabled |
| Selected node's output type ≠ `Video` | Disabled |
| Selected video node hasn't executed (`state !== 'complete'`) | Disabled with tooltip "Run the node first" |
| Selected video node has output ready | **Enabled** |
| Already in editor view | Pill highlights Editor; clicking Canvas exits |

**Enter editor** (`uiStore.enterEditor(sourceNodeId)`):
- Look for an existing `video-edit` node: any node with `definitionId === 'video-edit'` that has an edge from `sourceNode`'s `video` output port to its `video_in` input port. If exactly one matches → focus it. If multiple match (rare, user manually wired extras) → focus the most recently created one (tiebreak by node ID timestamp suffix).
- Else create a new `video-edit` node, wire `source.video → edit.video_in`, position it ~150px to the right of source.
- Swap viewport: `viewMode = 'editor'`, `editorTargetNodeId = editNode.id`.

**Exit editor** (Canvas tab click or `⎋`):
- If Edit node was spawned **this session** AND has zero non-default operations (still virgin `clips = [{full-range, speed:1.0, volume:1.0, mute:false}]`) → remove + unwire it.
- Else leave it. Swap viewport back: `viewMode = 'canvas'`.

### Primitive 1 — Trim

- **Interaction:** Drag the left or right edge of a sub-clip block. Cursor changes to edge-drag. Playhead snaps to the dragged edge during drag.
- **Data:** Updates `clips[i].sourceIn` or `clips[i].sourceOut`. Snapped to frame grid on release.
- **Constraints:** Min sub-clip width 0.1s; can't drag past adjacent sub-clip edges; clamps to `[0, sourceDuration]`.
- **Keyboard:** `I` sets `sourceIn` at playhead for active sub-clip; `O` sets `sourceOut`.

### Primitive 2 — Speed

- **Interaction:** Select sub-clip → Transport's Speed control activates. Slider 0.25× to 4× + quick presets 0.5× / 1× / 2×.
- **Data:** `clips[i].speed = value`. Block shows speed badge when ≠ 1.0.
- **Output duration:** `(sourceOut - sourceIn) / speed` per sub-clip.
- **Audio:** ffmpeg's `atempo` handles speed-shifted audio. Chains for speeds outside [0.5, 2.0] per ffmpeg docs.

### Primitive 3 — Cut splits

- **Interaction:** Click Cut tool, then click inside a sub-clip block. Splits at the playhead. Both halves inherit parent's `speed`/`volume`/`mute`.
- **Data:** `clips[i]` → `clips[i]` (left, ends at split) + `clips[i+1]` (right, starts at split). Fresh IDs.
- **Keyboard:** `S` or `⌘K` cuts at playhead in active sub-clip.
- **Delete:** Select sub-clip → `⌫`. Removed from array. Minimum: cannot delete the only sub-clip.

### Primitive 4 — Volume

- **Interaction:** Select sub-clip → Volume slider (0–100%) in Transport activates. Reflects `clips[i].volume * 100`.
- **Data:** `clips[i].volume = value / 100`. AUD block shows percentage at right edge.

### Primitive 5 — Mute

- **Interaction:** Select sub-clip → speaker icon in Transport (or `M`). Toggles `clips[i].mute`. Muted blocks gray out on AUD row.
- **Data:** `clips[i].mute = true/false`. `volume` preserved so unmuting restores level.

### Primitive 6 — Multi-track view

- Always visible. VID top, AUD bottom. Sub-clips align vertically (same `sourceIn`/`sourceOut` window).
- Phase 1 keeps VID + AUD **linked**. Mute/volume affect audio only; speed affects both.
- AUD track shows **real waveforms via wavesurfer.js v7** (client-side decode, peaks cached).
- For video-only sources (no audio track), AUD row renders empty with faint "no audio" label; Volume/Mute disabled.

### Render Preview (new in Phase 1 per research)

- **Interaction:** Click **Render Preview** in transport right side. Button shows spinner during render (~1–2s for typical 30s edits). When done, preview window plays the rendered MP4 for ~10s, then auto-reverts to virtual playback. Button label changes to "Re-render."
- **Endpoint:** `POST /api/video-edit/preview-render` with `{nodeId, params}`.
- **Render command:** Same as the final-render ffmpeg invocation but with `-vf scale=640:-2 -preset ultrafast -crf 32`.
- **Output:** `output/<run-dir>/_preview/<uuid>_preview.mp4`. Auto-cleaned on editor close or next render.

### Save / undo / persistence

- **Auto-save:** Every change writes through to `graphStore` immediately. No separate save action. ⌘S in editor view = "save graph" (same handler as canvas). Auto-save coordinator debounces graphStore writes by 100ms to handle rapid drag updates.
- **Undo / redo:** Uses existing 50-step graph history. `⌘Z` / `⌘⇧Z` work in both views. One trim drag = one history step.
- **Re-execution resilience:** Per §4.

### Keyboard reference

| Key | Action |
|---|---|
| `␣` | Play / Pause |
| `J` / `K` / `L` | Reverse / Stop / Forward (classic NLE) |
| `←` / `→` | Frame step |
| `I` / `O` | Set in / out at playhead |
| `S` or `⌘K` | Cut at playhead |
| `M` | Mute toggle |
| `⌫` | Remove selected sub-clip |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| `⌘S` | Save graph |
| `⎋` | First press: deselect sub-clip. Second press: exit to canvas. |
| `Click` | Select sub-clip / playhead position |

---

## 8 — Design Decisions Locked

These are the 14 design defaults confirmed during brainstorming. Each is baked into the spec above; this section is the canonical reference.

| # | Decision | Resolution |
|---|---|---|
| 1 | Preview aspect ratio | Respects source aspect; letterboxed in container if different. |
| 2 | Video-only sources | AUD row renders empty with "no audio" label; Volume/Mute disabled. |
| 3 | Alpha / non-H.264 output | Phase 1 = MP4 + H.264 only. Alpha sources flattened against black. WebM/ProRes deferred to Phase 3+. |
| 4 | Time display format | SMPTE-style `HH:MM:SS:FF`. Frame count from source FPS. |
| 5 | Render Preview output file | `output/<run-dir>/_preview/<uuid>_preview.mp4`. Auto-cleaned on editor close or fresh render. Not exposed downstream. |
| 6 | Render Preview button placement | Right side of Transport, next to live summary. Spinner during render; "Re-render" label after first use. |
| 7 | Multiple Edit nodes downstream of same source | Auto-spawn focuses the **first existing** `video-edit` directly downstream. Manual second Edit nodes work but auto-spawn doesn't see them. |
| 8 | Sub-clip selection / deselection | Click sub-clip block → select (orange outline). Click anywhere in the timeline area that is NOT a sub-clip block (ruler, track background, between clips) → deselect. `⎋` first press deselects; second exits editor. |
| 9 | Playhead scrubbing | Drag the playhead. `<video>.currentTime` updates live (frame-snapped via rVFC). On drag release, final snap to nearest source frame boundary. |
| 10 | Save indicator | Silent auto-save (matches existing Nebula behavior). No "saving…" indicator. |
| 11 | Accessibility | Match existing Nebula level — `aria-label` on every button, logical tab order, full keyboard navigation. No formal AAA target. |
| 12 | Source-load error | "Source unavailable — try re-running upstream" with Back to Canvas link. |
| 13 | Long-source performance | Optimized for 5–60s clips. Warns at 5+ min. Hard performance budget for longer is Phase 3+. |
| 14 | Max sub-clip count | No hard limit. Soft warning at 50 sub-clips. ffmpeg `concat` handles arbitrary counts. |

---

## 9 — Open Risks (track during implementation)

These are not blockers — they're things to keep an eye on during the build.

1. **Render Preview wall-clock on long sources.** Promised 1–2s for typical 30s edits. May be 5+ seconds on 5-minute sources at low-res. If users hit this, add a "Render Preview" cancel button.
2. **wavesurfer.js decode performance on 5-min+ audio.** Research said 30s clips decode in <1s; longer is untested in this codebase. Phase 1 escape hatch: fall back to placeholder stripe if decode takes >3s. Phase 2 may need `bbc/audiowaveform` server-side.
3. **Frame-grid snapping on VFR sources.** Snapping to `Math.floor(t * fps) / fps` assumes constant FPS. VFR sources get treated as their `avg_frame_rate`. The VFR banner is the user-visible disclaimer.
4. **Cross-browser playhead scrubbing precision.** Firefox's 2ms `currentTime` rounding might cause sub-clip stepping to feel less precise than Chrome. Acceptable; flagged if user testing surfaces it.
5. **graphStore auto-save coordination.** 100ms debounce should handle rapid drags. Watch for serialization spikes on graphs with 20+ nodes; may need to scope the debounce to only the Edit node's params instead of full graph.

---

## 10 — Out of Scope (Phase 1)

Explicitly deferred. Each becomes its own future spec.

| Feature | Phase |
|---|---|
| Color filters / grading (brightness, contrast, saturation, hue) | Phase 2 |
| Text overlays (font, size, position, timing, color) | Phase 2 |
| Sub-clip drag-to-reorder | Phase 2 nice-to-have |
| Crop / aspect-ratio change | Phase 2 |
| Transitions between sub-clips (crossfade, dissolve, cut) | Phase 3 |
| Audio replacement (swap audio from external file or another node) | Phase 3 |
| Audio/video **unlink** toggle | Phase 3 |
| Export resolution / codec selection | Phase 3 |
| Alpha channel / WebM / ProRes | Phase 3 |
| Multi-source mixing (two video inputs into one Edit node) | Future |
| **Image editor** (photoshop-like) | Phase 4 |
| **Audio editor** (Ableton-like) | Phase 5 |
| Render Preview cancel button | If risk #1 materializes |
| `bbc/audiowaveform` server-side decode | If risk #2 materializes |
| Mobile / touch input | Future |

---

## 11 — References

- **Research notes:** [`2026-05-20-video-editor-tab-research.md`](2026-05-20-video-editor-tab-research.md) — primary-source citations for all 9 research questions.
- **Master plan context:** [`docs/superpowers/plans/2026-05-16-node-input-api-contract-hardening.md`](../plans/2026-05-16-node-input-api-contract-hardening.md) — current state of the catalog (102 nodes); this Phase 1 spec extends it.
- **Slava style tokens:** `frontend/src/styles/slava-restraint.css` — color values, glass surfaces, pill border-radius, accent (`#FF5A1F`).
- **Precedent handler patterns:**
  - `backend/handlers/style_reference.py` — passthrough mode, `_resolve_local_path`
  - `backend/execution/engine.py:634-639` (reroute), `595-601` (preview), `481-512` (frame-extractor — VFR-bug example to avoid)
  - `backend/services/output.py:20-24` — output file naming convention
  - `backend/main.py:_rewrite_output_paths` — handler-to-URL rewrite
- **Component precedents:**
  - `frontend/src/components/nodes/ModelNode.tsx:202-218` — settings bar pattern
  - `frontend/src/components/nodes/RerouteNode.tsx` — stripped-down node card precedent
  - `frontend/src/components/panels/NodeInspectorPopover.tsx` — popover anchor pattern
- **Store patterns:** `frontend/src/store/uiStore.ts:129-141` (selectNode), `frontend/src/store/graphStore.ts:993-1004` (deleteNode).

---

## 12 — Acceptance Checklist

Phase 1 is shippable when:

- [ ] All Tier 2 primitives (trim, speed, cut, volume, mute, multi-track view) work end-to-end in a single demo loop.
- [ ] Render Preview button produces a low-res ffmpeg render that plays inline in the preview window.
- [ ] VFR source detection emits the warning banner.
- [ ] Real audio waveforms render via wavesurfer.js for sources with audio.
- [ ] Timeline thumbnail strip renders lazily for the VID row.
- [ ] Frame-grid snapping applies to all sub-clip times.
- [ ] Auto-spawn / focus-existing / auto-cleanup-on-empty-exit all work.
- [ ] Re-execution preserves edit params with graceful clamping.
- [ ] No-op fast path returns upstream URL unchanged (no file copy).
- [ ] Editor button correctly disables / enables based on selection state.
- [ ] All keyboard shortcuts work (Space, J/K/L, I/O, S, M, ⌫, ⌘Z, ⌘S, ⎋).
- [ ] Edit node card on the canvas shows the orange edit-bearing border + edit summary strip + "Open Editor" button in settings bar.
- [ ] Responsive banner shows at viewports <1280px wide.
- [ ] All new backend tests pass (`test_video_edit_handler.py`, `test_video_edit_preview.py`, contracts).
- [ ] Frontend unit tests for virtual playback + frame snapping pass.
- [ ] Manual live-smoke recorded for `/lab/nebula-video-edit` page on `justinperea.com`.
