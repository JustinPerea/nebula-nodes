# Soul Cinema → Nebula Nodes — Design Spec (Phase 0 + 1)

**Date:** 2026-05-29
**Status:** Approved, in build
**Branch:** `feat/soul-cinema-studio`
**Scope of THIS spec:** Phase 0 (deterministic pillar nodes) + Phase 1 (Cinema Studio editor). The Looks/preset library and chat-agent skill wiring are a **separate, later spec** and are OUT OF SCOPE here.

---

## 1. What we're building & why

Higgsfield Soul Cinema is not one model — it's a *stack of capabilities*: a cinematic base image model, **Soul ID** (character consistency), **Soul HEX** (color/palette control), a **film-look** post stage, and a **video-keyframe** handoff. That decomposition maps 1:1 onto a node graph, which is what Nebula is.

Inventory of those pillars against today's Nebula:

| Pillar | In Nebula today | This spec adds |
|---|---|---|
| Cinematic base | ✅ `flux-2-pro`, `seedream-4-5`, `imagen-4`, `nano-banana`, `flux-kontext`… | reuse (no new base model) |
| Soul ID (character) | ⚠️ reference-edit via existing edit models | reuse edit models fed character refs (reference-edit) |
| Soul HEX (color) | ⚠️ only a *text* palette (`style-reference`) | **`cinema-color`** — deterministic local color transfer |
| Film-look post | ❌ none | **`cinema-look`** — deterministic local grain/halation/LUT/tone |
| Keyframe handoff | ✅ `veo-3`/`kling`/`seedance`/… first-frame ports | reuse ("Send to motion") |

The user experience is a **multi-shot Cinema Studio editor** (storyboard): shared character + palette + film-look across many shots, each shot with its own prompt and preview — mirroring Nebula's existing Remotion editor pattern.

## 2. Locked decisions (from brainstorming)

1. **Deliverable:** native DIY pipeline + a dedicated Cinema Studio editor view.
2. **Editor unit:** multi-shot **scene/storyboard** (shared character/palette/look; per-shot prompts).
3. **Soul ID:** **reference-edit** (existing `nano-banana`/`seedream-4-5`/`flux-kontext` edit models fed a character reference image). Works for **non-human** subjects (steplings). No training infra.
4. **Color + film-look:** **deterministic local** processing (PIL/numpy for stills; ffmpeg later for video). Free, instant, cache-friendly, no new BYOK key.
5. **Base model:** model-agnostic; reuse the catalog. No new hosted model.
6. **Execution:** **self-contained `cinema-scene` handler** that orchestrates base→identity→color→look per shot, **plus** the two pillars shipped as standalone canvas nodes that call the *same* Python functions (single source of truth per pillar).
7. **Scene output:** **per-shot dynamic Image output ports** (DynamicNode pattern) + an in-editor "Send to motion" button.
8. **YAGNI cut:** **no standalone `cinema-identity` node** — reference-edit identity = using an existing edit model; a wrapper node would be redundant. Revisit later if it earns its place.

## 3. Data model

`cinema-scene` stores a `CinemaSceneSpec` on `node.data.params.scene` — exactly how `remotion-node` stores `params.manifest`.

```ts
// frontend/src/types/index.ts (new)
interface CinemaSceneSpec {
  version: 1;
  base: { model: string; params?: Record<string, unknown> };  // e.g. 'seedream-4-5' | 'nano-banana' | 'flux-kontext'
  character?: { refImageUrls: string[]; strength: number; sheetUrl?: string };  // shared, reference-edit
  palette?: { swatches: string[]; sourceImageUrl?: string; strength: number; method: 'lab-transfer' | 'reinhard' | 'histogram' };
  look?: {
    preset?: string;            // 'kodak-portra' | 'fuji-400h' | 'cinestill-800t' | 'bw-tri-x' | 'teal-orange' | 'custom'
    grain: number; halation: number; vignette: number;
    contrast: number; saturation: number; temperature: number;
    lutId?: string;             // optional .cube
  };
  aspectRatio: string;          // '16:9' | '2.39:1' | '4:5' | '1:1' | '9:16'
  shots: CinemaShot[];
}
interface CinemaShot {
  id: string;
  prompt: string;
  refImageUrls?: string[];                              // per-shot composition refs (optional)
  overrides?: { palette?: Partial<CinemaSceneSpec['palette']>; look?: Partial<CinemaSceneSpec['look']> };
  output?: { imageUrl?: string; status: 'idle' | 'running' | 'done' | 'error'; error?: string; hash?: string };
}
```

`overrides` lets one shot deviate from the shared palette/look without breaking the rest.

## 4. The two pillars (deterministic, local — `backend/cinema/`)

New package `backend/cinema/` holds pure functions reused by BOTH the standalone nodes and the scene handler. **Dependencies:** Pillow + numpy. Check `backend/pyproject.toml`/`requirements*.txt`; if absent, add `Pillow` and `numpy` (both old, stable — fine under the 14-day package-age rule). Do NOT add anything else.

### 4.1 `backend/cinema/color.py` (Soul HEX)
- `extract_palette(img, k=6) -> list[str]`: k-means in **CIELAB** (convert RGB→Lab, cluster, return cluster-center hexes). **Fixed random seed** for deterministic tests.
- `transfer_to_palette(img, swatches, strength, method) -> img`:
  - `'lab-transfer'` (default): Reinhard-style mean/std match in Lab toward the target palette's aggregate statistics, then nudge each pixel toward its nearest target swatch by `strength`.
  - `'reinhard'`: classic Reinhard global mean/std color transfer using the palette as the reference distribution.
  - `'histogram'`: per-channel histogram matching toward the palette distribution.
- Reuse the existing hex→rgb parser `_parse_recraft_color` (in `sync_runner.py`) — extract/share it rather than re-implement.
- Deterministic: identical (image, swatches, strength, method) → identical output (ExecutionCache-friendly).

### 4.2 `backend/cinema/look.py` (film-look post)
Composable passes, applied in this order, each gated by its param (0 = no-op):
1. **tone curve / contrast** (`contrast`), **saturation**, **temperature** (warm/cool white-balance shift).
2. **teal-orange** channel split (only when `preset='teal-orange'` or via the mixer).
3. **film grain** (`grain`): gaussian noise, **luminance-masked** (more in mids), blended.
4. **halation** (`halation`): threshold highlights → gaussian blur → reddish **screen** blend.
5. **vignette** (`vignette`): radial luminance falloff.
6. **LUT** (`lutId`): parse a `.cube` file, apply via **trilinear** interpolation. Bad/missing LUT → skip + warn, never crash.
- `apply_look(img, look_dict) -> img`. Curated **presets** = named param bundles in `look.py` (`PRESETS: dict[str, dict]`): `kodak-portra`, `fuji-400h`, `cinestill-800t`, `bw-tri-x`, `teal-orange`. `custom` = use the raw sliders.
- Deterministic (fixed grain seed derived from a stable hash of inputs).

### 4.3 `backend/cinema/palette.py`, `backend/cinema/lut.py`
Split palette extraction and `.cube` parsing into their own modules if `color.py`/`look.py` get large; otherwise inline. `__init__.py` re-exports `extract_palette`, `transfer_to_palette`, `apply_look`.

## 5. Backend handlers (`backend/handlers/`)

**Canonical template:** `backend/handlers/style_reference.py`. Read its `_resolve_local_path`, `OUTPUT_ROOT` usage, and signature. Conventions:
- Signature: `async def handle_X(node: GraphNode, inputs: PortValueDict, api_keys, emit) -> <port-value-dict>`.
- Read an input image: resolve the port value / `params.filePath` via a `_resolve_local_path`-style helper against `services.output.OUTPUT_ROOT`.
- Write output: save the processed PNG under `OUTPUT_ROOT`, return the `/api/outputs/<rel>` URL in the output port dict.
- Register in `backend/execution/sync_runner.py` `get_handler_registry(...)` exactly like `registry["style-reference"] = _style_reference_handler` (async closure that lazily imports the handler and passes `emit`).

### 5.1 `cinema_color.py` → node `cinema-color`
Thin wrapper: resolve input image → `cinema.color.transfer_to_palette(...)` (or `extract_palette` when a `source_image` is given and no swatches) → save → return Image. `executionPattern: 'sync'`.

### 5.2 `cinema_look.py` → node `cinema-look`
Thin wrapper: resolve input image → `cinema.look.apply_look(...)` → save → return Image. `executionPattern: 'sync'`.

### 5.3 `cinema_scene.py` → node `cinema-scene`
`executionPattern: 'async-poll'`. Per shot, respecting per-shot cache by input hash:
1. **Base/identity:** call the chosen base **edit** model with `{prompt (+ shot prompt), image_urls = character.refImageUrls + shot.refImageUrls, aspectRatio}`. **Reuse the existing handler path** — study how `sync_runner` dispatches the chosen base node's handler and invoke it internally (synthesize a `GraphNode`-like params dict); fallback to `handlers.fal_universal.handle_fal_universal` with the model's endpoint if direct reuse is impractical. Identity is achieved purely by conditioning on the character refs (reference-edit).
2. **Color:** `cinema.color.transfer_to_palette` with shared `palette` (or shot `overrides.palette`).
3. **Look:** `cinema.look.apply_look` with shared `look` (or shot `overrides.look`).
4. Save the finished shot, set `shot.output = {imageUrl, status:'done', hash}`, and `emit` per-shot progress so the editor/canvas preview updates via the existing streaming mechanism.
- **Per-shot isolation:** a shot that errors → `status:'error'`, error recorded, **continue** the other shots. Scene completes partially.
- Output mapping: each shot's image maps to that shot's **dynamic output port** (port id derived from `shot.id`). License guard: default base must be a commercial-OK model (`seedream-4-5`/`nano-banana`), never FLUX.1-dev.

## 6. Catalog wiring (frontend → backend export)

1. **New category `'cinematic'`:**
   - `frontend/src/types/index.ts`: add `'cinematic'` to the `NodeCategory` union; add `'palette'` to `ParamDefinition['type']`; add the `CinemaSceneSpec`/`CinemaShot` interfaces.
   - `frontend/src/constants/ports.ts`: add `CATEGORY_COLORS['cinematic']` (pick a filmic accent, e.g. amber/gold `#d9a441`).
   - `frontend/src/components/panels/NodeLibrary.tsx`: add `CATEGORY_LABELS['cinematic'] = 'Cinematic'`.
   - `frontend/src/constants/nodeDefinitions.ts`: add a `CATEGORY_ORDER` slot for `'cinematic'`.
2. **Three node defs** in `nodeDefinitions.ts`:
   - `cinema-color`: cat `cinematic`, provider `'utility'`, `envKeyName: []`, `executionPattern:'sync'`. Input `image` (Image, required). Output `image` (Image). Params: `palette` (type `'palette'`, default `[]`), `strength` (float 0–1, default 0.7), `method` (enum lab-transfer/reinhard/histogram, default lab-transfer), `source_image` (type `file`, optional — extract palette from it).
   - `cinema-look`: cat `cinematic`, provider `'utility'`, `executionPattern:'sync'`. Input `image` (Image, required). Output `image` (Image). Params: `preset` (enum incl. `custom`), `grain`/`halation`/`vignette`/`contrast`/`saturation`/`temperature` (floats, sensible defaults), `lut` (type `file`, optional). Use `visibleWhen` to reveal the manual sliders only when `preset === 'custom'`.
   - `cinema-scene`: cat `cinematic`, provider `'utility'`, `apiEndpoint:''`, `envKeyName:[]`, `executionPattern:'async-poll'`. **Mirror `remotion-node`'s shape.** Optional input `character_refs` (Image, `multiple:true`). Output ports are **dynamic per shot** (start with none). Params: `scene` (object, editor-managed — not rendered by Inspector, like remotion's `manifest`).
3. Run `scripts/export-node-defs.ts` to regenerate `backend/data/node_definitions.json`. The node↔handler contract tests (`backend/tests/test_node_contracts.py`, `scripts/check-node-contracts.mjs`) MUST pass.

## 7. Frontend: node renderer, Inspector control, store

- **`frontend/src/components/nodes/CinemaSceneNode.tsx`** (new): card shows a contact-sheet thumb + shot count + **"Open Studio"** button (`onClick → uiStore.enterCinemaEditor(id)`), an optional `character_refs` target handle, and **one source Handle per shot** (dynamic, ids from the spec's shots). Register in `frontend/src/components/Canvas.tsx` `nodeTypes` as `cinemaSceneNode` (alongside `remotionNode`). The `cinema-scene` def's render type points at this.
- **`frontend/src/store/uiStore.ts`**: add `cinemaEditorNodeId: string | null`, `enterCinemaEditor(id)`, `exitCinemaEditor()` — mirror `enterRemotionEditor`.
- **`frontend/src/store/graphStore.ts`**: `addShot(nodeId)`, `removeShot(nodeId, shotId)`, `updateScene(nodeId, spec)` — on shot add/remove, **rewrite the node's dynamic output ports and prune now-dead edges**, mirroring `configureOpenRouterModel` (line ~1934). Follow the optimistic-store + `/api/graph/*` POST + `graphSync` round-trip, with the offline-UUID fallback like `addNode`'s catch branch.
- **`frontend/src/components/panels/Inspector.tsx`**: add a `'palette'` branch to `renderParamControl` — editable hex swatches (add/remove/edit) + an **"Extract from reference"** button that uploads an image (POST `/api/uploads`, the existing `file` pattern) and calls the backend palette extractor (or a small `/api/cinema/extract-palette` endpoint; if adding an endpoint is heavy, extract client-side is acceptable for v1). Writes the swatch array via `onParamChange`.

## 8. The Cinema Studio editor (`frontend/src/components/cinema-studio/`)

Mirror `frontend/src/components/video-editor/` structure and the `App.tsx` mount pattern (`mainView = <RemotionEditorView />` when in that mode).

- `CinemaStudioView.tsx` — full-screen host; mounted in `frontend/src/App.tsx` `mainView` when `uiStore.cinemaEditorNodeId` is set. Reads the target node's `data.params.scene`; all edits write back via `graphStore.updateScene`.
- `CinemaSharedControls.tsx` — header: **base-model picker** (enum of edit-capable models), **character refs** dropzone (multi-image; reuse `/api/uploads`), **palette swatches** (the new control), **film-look** sliders + preset chips, **aspect ratio**.
- `CinemaShotsRail.tsx` — horizontal rail of shot thumbnails; **+ Add shot** (`graphStore.addShot`), drag-reorder, select; per-shot status/error badge.
- `CinemaShotPanel.tsx` — selected shot: prompt textarea, per-shot composition refs, palette/look **override** toggles, big preview, variations strip, **[Generate shot] / [Generate all] / [Send to motion ▸]**.
- `CinemaStudioToolbar.tsx` + CSS (`cinema-studio.css`) — breadcrumb back to canvas (`exitCinemaEditor`), generate-all, save.
- **Generate flow:** reuse the existing node-execution + result-streaming mechanism (how `ModelNode` previews update from the store after `executeNode`/`executeGraph` in `lib/api.ts`). Do NOT invent a new channel. **Send to motion:** create a `veo-3`/`seedance`/`kling` node on the canvas and wire the chosen shot's port into its first-frame Image input.

## 9. Execution & caching
- `cinema-color`/`cinema-look`: `sync`, deterministic → `ExecutionCache` keys on inputs; re-runs are free.
- `cinema-scene`: `async-poll`, **per-shot cache by input hash** (store `shot.hash`); re-running a scene regenerates only changed shots.

## 10. Error handling
- **Per-shot isolation** (see §5.3): one shot's failure never aborts the scene.
- Missing BYOK key for the chosen base → clear editor message, no crash.
- **License guard:** default base = commercial-OK; never FLUX.1-dev by default.
- Bad `.cube` LUT → skip + warn.
- Dynamic-port edits use the existing `graphSync` round-trip + offline fallback.

## 11. Testing
- **Contract tests** (auto): every new node id has a registered handler — `backend/tests/test_node_contracts.py`, `scripts/check-node-contracts.mjs`.
- **Unit (golden):** `backend/tests/test_cinema_color.py`, `test_cinema_look.py` — generate small **synthetic** fixtures in-test (numpy), assert determinism (same input → identical bytes), and assert known properties (e.g. transferred image's mean hue shifts toward the palette; vignette darkens corners; grain raises variance). Fixed seeds.
- **Handler smoke:** `backend/tests/test_cinema_scene.py` — `cinema-scene` with a **mocked** base-model call; verify per-shot outputs map to dynamic ports and a failing shot is isolated.
- **Frontend:** `tsc --noEmit` + `vite build` must pass; a Playwright smoke (open scene node → Studio → add shot → generate (mock) → send-to-motion wires a video node) with screenshots is a bonus, not a blocker.
- **Parity:** frontend `nodeDefinitions.ts` ↔ backend `node_definitions.json` stay in sync (run the exporter; commit both).

## 12. Build order (workflow waves)
1. **Backend pillars** — `backend/cinema/*` + unit tests; self-verify pytest.
2. **Backend handlers** — `cinema_color/look/scene.py` + register in `sync_runner.py` + handler smoke; self-verify pytest + contract test.
3. **Frontend foundation** — `types`, `nodeDefinitions` (3 defs + category), `ports`, `NodeLibrary`, run exporter; self-verify tsc + parity + `check-node-contracts.mjs`.
4. **Node + Inspector + store** (parallel, disjoint): (a) Inspector `palette` control; (b) `CinemaSceneNode` + Canvas register + `uiStore` + `graphStore` shot ops; self-verify tsc.
5. **Cinema Studio editor** — `cinema-studio/*` + `App.tsx` mount; self-verify tsc + build.
6. **Full-system verify** — full pytest + tsc + vite build + parity/contract checks; fix cross-cutting; report.
7. **Real-image smoke** — run `cinema-color` + `cinema-look` on an existing `output/` image, save before/after PNGs to `docs/soul-cinema-smoke/`; best-effort nano-banana test still via the nebula CLI if the backend is reachable.

## 13. Out of scope (next spec)
- Looks/preset **library** (Nebula's first preset system) + Studio "Looks" gallery.
- `soul-cinema` `SKILL.md` (both `.claude/skills/` and `.agents/skills/`) + Codex `SKILL_TRIGGER_KEYWORDS` + Daedalus stage-list wiring.
- ffmpeg **video** film-look (extend `video_edit.py` `_build_filter_complex`).
- Trained-character (LoRA) identity + identity picker; PuLID face mode.
- Multi-shot scene → automatic video sequence assembly.

## 14. Constraints for build agents
- **No git** (no commit/add/checkout/branch) — the orchestrator handles all git. Edit the working tree only.
- Match existing code style/conventions; the node UI is **catalog-driven** — prefer a catalog entry + handler over bespoke React.
- Keep `backend/data/node_definitions.json` generated from `nodeDefinitions.ts` (run the exporter; never hand-edit the JSON).
- Cap fix loops at ~3 attempts per slice, then report the blocker clearly rather than thrashing.
- Append notable deviations/decisions to your wave report (the orchestrator collates them into `implementation-notes.md`).
