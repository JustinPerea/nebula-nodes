# Video Editor Tab — Research Notes

> Companion to `2026-05-20-video-editor-tab-design.md`. Documents the 9 open
> questions from §8 of that design and the answers that ultimately got baked in.
> Sources are primary (vendor docs, MDN, W3C, code in this repo) — no SEO blogs.

**Date:** 2026-05-20
**Researched by:** three parallel agents (local code-dive, ffmpeg + HTML5 video, web video editor patterns)
**Outcome:** all 9 questions resolved; 4 new spec additions.

---

## Q1 — No-op fast path: copy vs URL pass-through

**Answer: pass-through, no file copy.**

Precedent in this repo: `reroute` (`backend/execution/engine.py:634-639`), `router` (`engine.py:623-633`), `preview` (`engine.py:595-601`), `array-selector` (`engine.py:521-538`), and the freshest example, `style-reference` (`backend/handlers/style_reference.py:170-174`) with its explicit `passthrough` mode. All return the upstream `value` unchanged. Transformation nodes (frame-extractor, svg-rasterize, veo) always write a new file under `get_run_dir()`.

Aliasing risk is **safe** — the engine treats `outputs_cache` as immutable references (`engine.py:645-648`); no handler mutates an upstream file in place.

One subtlety: incoming `value` strings can be either a filesystem path (fresh execution) or a `/api/outputs/<rel>` URL (restored from save). Copy Style Reference's `_resolve_local_path` (`style_reference.py:63-85`) — frame-extractor doesn't, and that's a latent bug.

---

## Q2 — Inspector popover for nodes "configured elsewhere"

**Answer: keep the popover for Run/Duplicate/Delete. Add a primary "Open Editor" button in the settings bar (the same slot where ModelNode renders the `…` Inspector anchor at `ModelNode.tsx:202-218`).**

Surprise discovery: **selecting a node does NOT open the inspector automatically.** `uiStore.ts:129-141` explicitly hides the popover on selection unless pinned. The "…" button is the only opener. So the Edit node already won't show an inspector by accident — it only opens if the user clicks "…".

Precedent for nodes with reduced inspector surface: `RerouteNode.tsx` (24 lines, two handles, no settings bar, no inspector at all). Edit node sits between Reroute and ModelNode — has Run/Duplicate/Delete needs, but its primary configuration surface is the editor tab.

---

## Q3 — Orphan-source semantics

**Answer: match precedent. No cascade-delete, no special handling on upstream deletion.**

`deleteNode` (`graphStore.ts:993-1004`) removes the node + filters out edges. Downstream nodes stay; their incoming edge is gone. `validate_graph` (`backend/execution/engine.py:296-358`) catches the missing required input at execution time and emits a clear `ValidationErrorDetail`.

Polish: in the editor tab UI, detect "no `video_in` connected" and show a "Connect a video upstream to edit" empty state instead of an empty timeline. Match the catalog convention; don't invent cascade-delete.

---

## Q4 — ffmpeg progress cadence

**Answer: 0.5s default, configurable via `-stats_period`. Use `-stats_period 0.25` for snappier UI. For clips <2s, don't promise real progress ticks — animate a 0→100 sweep client-side.**

Per [ffmpeg docs](https://ffmpeg.org/ffmpeg.html): "Set period at which encoding progress/statistics are updated. Default is 0.5 seconds." A 3-second `libx264 -preset fast` clip emits ~5–7 `progress=continue` blocks plus one `progress=end`. ffmpeg explicitly flushes after each progress block, so stdout buffering is not a problem in practice. Parse line-by-line on `\n`.

---

## Q5 — HTML5 `currentTime` precision

**Answer: NOT frame-accurate by default. Cross-browser inconsistent. Snap all times to the source frame grid before using them. Use `requestVideoFrameCallback` with `metadata.mediaTime` (not `currentTime`) for frame identification.**

Key findings:
- Firefox rounds `currentTime` to 2ms (anti-fingerprinting). ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime))
- Chromium backs `currentTime` with the audio clock, not video PTS — drifts from frame PTS.
- Cross-browser frame divergence is documented: same `currentTime = 9.562167` displays frame 269 in Chrome/Safari, 268 in Firefox ([videojs#5142](https://github.com/videojs/video.js/issues/5142)).
- Workaround: `Math.floor(t * sourceFps) / sourceFps` to snap to frame grid.
- `requestVideoFrameCallback`: Baseline 2024 (Chrome 83+, Safari 15.4+, Firefox 132+), 94.74% support. `metadata.mediaTime` is the only reliable frame ID.
- One-vsync offset (~16ms) on callback firing is expected.

Drift on a 0.2s sub-clip: ±1 frame at boundaries. Acceptable for portfolio-grade live preview.

---

## Q6 — Virtual vs rendered preview divergence

**Answer: ship a "Render Preview" button. Virtual preview is approximate; ffmpeg render is source-of-truth.**

Four divergence axes documented:

1. **VFR sources** — HTML5 `<video>` advances by wall-clock; ffmpeg with `-fps_mode cfr` resamples and produces duplicate/dropped frames preview never showed.
2. **Color space tagging** — ffmpeg can encode BT.601 pixels tagged as BT.709, causing browsers to mis-decode. ([Canva engineering blog](https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/))
3. **`atempo` chaining for extreme speeds** — accumulated rounding ~1 frame per minute at chained 4×. ([ffmpeg-filters.html#atempo](https://ffmpeg.org/ffmpeg-filters.html#atempo))
4. **Boundary frames** — HTML5 displays the frame containing `currentTime`; ffmpeg's `-ss before -i` is keyframe-coarse, `-ss after -i` is frame-accurate but re-decodes. ±1 frame at boundaries.

Render Preview button: a low-res ffmpeg render (`-vf scale=640:-2 -preset ultrafast -crf 32`) is cheap (<2s for 30s edit) and catches all four classes. Reverses the earlier "defer to Phase 2" decision — this is now in Phase 1.

Spec cross-cutting:
- Snap source-in/out to `Math.floor(t * sourceFps) / sourceFps` before passing to preview OR ffmpeg.
- Detect VFR sources at import: `ffprobe -show_streams -select_streams v` → compare `avg_frame_rate` vs `r_frame_rate`. Warn user.
- Always pass explicit color tags: `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv`.
- Audio sync: chain `aresample=async=1` on output.

---

## Q7 — Audio waveform rendering

**Answer: real waveforms via [wavesurfer.js v7](https://wavesurfer.xyz/docs/) with client-side decode.**

30-second clips decode in well under 1s via `decodeAudioData` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)). Cache `exportPeaks()` output in memory keyed by clip ID — re-renders on zoom/trim are free.

`bbc/audiowaveform` server-side is the Phase 2 escape hatch for clips >2-3 min. Don't roll our own with `AnalyserNode` — wavesurfer handles min/max bucketing, zoom, and DPR correctly.

Note: cannot read PCM from `HTMLVideoElement` directly. Fetch source as ArrayBuffer and pass through `decodeAudioData`.

---

## Q8 — Responsive behavior on smaller viewports

**Answer: 1280×800 minimum supported viewport. Below that, show a polite "best viewed at ≥1280px wide" banner — don't ship a mobile layout.**

Collapse order (when viewport shrinks): right-side inspector docks into a drawer → ruler tick density halves → preview shrinks → left media bin becomes a popover. **Multi-track stays multi-track always** — collapsing to single track universally avoided across web NLEs (Remotion, Editframe, Etro).

No canonical doc from web NLEs prescribes a minimum width; this is the field's de-facto convention based on observed behavior.

---

## Q9 — `requestVideoFrameCallback` adoption

**Answer: assume available; feature-detect with `'requestVideoFrameCallback' in HTMLVideoElement.prototype`; fall back to `requestAnimationFrame` polling on `currentTime`.**

Browser support ([caniuse](https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback)):

| Browser | Supported from |
|---|---|
| Chrome / Edge | 83 (May 2020) |
| Safari | 15.4 (March 2022) |
| Firefox | 132 (October 2024) |

Global support 94.74% as of mid-2026. Do NOT use `timeupdate` for the polling fallback — it only fires 4–5×/second.

---

## New topics surfaced (not in the original §8 list)

### Thumbnail strip on the timeline ruler

**Recommendation: Phase 1 must-have.** Per the web video editor research: "even a sparse one (1 frame every ~2s, generated lazily via an offscreen `<video>` + `drawImage` into canvas) is what makes a timeline feel real. Skip this and the editor reads as a wireframe."

Implementation: lazily generate thumbnail frames, cache as data URLs keyed by clip + timestamp. No external dependency needed — pure HTML5 + canvas.

### Large-file ingestion path

Use streaming `Blob` URLs for the `<video src>`. Only fetch the bytes needed for peaks/thumbnails. Don't await `arrayBuffer()` on the whole source — locks the UI on 100MB+ files.

### Keyboard-first interaction is load-bearing

The keyboard reference already in §7 (Space, J/K/L, I/O, S, M, ⌫, ⌘Z/⌘⇧Z, ⌘S, ⎋) is correct — keep all of them as Phase 1 must-have. Per research: "they cost almost nothing and are the single biggest signal that the editor is 'portfolio-grade' rather than a toy."

---

## Sources

- ffmpeg docs: https://ffmpeg.org/ffmpeg.html, https://ffmpeg.org/ffmpeg-filters.html#atempo
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime, https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- web.dev rVFC article: https://web.dev/articles/requestvideoframecallback-rvfc
- caniuse: https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback
- HTML Living Standard — Seeking: https://html.spec.whatwg.org/multipage/media.html#seeking
- W3C M&E IG #4: https://github.com/w3c/media-and-entertainment/issues/4
- videojs#5142: https://github.com/videojs/video.js/issues/5142
- Canva engineering — ffmpeg color: https://www.canva.dev/blog/engineering/a-journey-through-colour-space-with-ffmpeg/
- wavesurfer.js: https://wavesurfer.xyz/docs/, https://github.com/katspaugh/wavesurfer.js
- BBC Peaks.js: https://github.com/bbc/peaks.js
- BBC audiowaveform: https://github.com/bbc/audiowaveform
- Local code: `backend/handlers/style_reference.py`, `backend/execution/engine.py`, `backend/services/output.py`, `frontend/src/components/panels/NodeInspectorPopover.tsx`, `frontend/src/components/panels/Inspector.tsx`, `frontend/src/components/nodes/ModelNode.tsx`, `frontend/src/components/nodes/RerouteNode.tsx`, `frontend/src/store/uiStore.ts`, `frontend/src/store/graphStore.ts`
