# Create View — Higgsfield-style creation surface (design)

- **Date:** 2026-06-02
- **Status:** Approved (design); pending spec review → implementation plan
- **Branch:** `feat/create-view`
- **Working name:** "Create" (branded alternatives considered: *Nova*, *Forge*)

---

## 1. Goal

Add a new full-screen **Create** view to Nebula Nodes that reproduces Higgsfield's
"create work" UI — a dark, full-bleed results stage with a floating bottom-center
composer — where **every generation authors real nodes + edges onto the canvas** and
runs them through Nebula's existing execution engine. Switching back to the canvas
reveals the actual node pipeline the user composed: the node editor *fills in* as they
work, exactly as the existing Cinema/Moodboard/Character studios do, but as a
**graph-builder** rather than a single-node editor.

**Design stance:** copy Higgsfield's *layout and interactions*; render them in the house
skin **Slava Restraint**. Near-black backgrounds are already shared; the primary
"Generate" CTA uses Slava's orange accent (`--sr-accent`, `#FF5A1F`), not Higgsfield's
lime. We adapt structure and interaction patterns, not the palette.

---

## 2. Research findings (condensed)

### 2.1 Higgsfield's create UI (verified live on higgsfield.ai, 2026-06-02)
- **Pattern A — bottom-floating composer** (used by `/ai/image`, `/cinema-studio`): a
  full-bleed dark stage; a floating glass composer pinned bottom-center containing
  `(+) attach → prompt textarea → compact control pills (Model ▾ / Aspect / Resolution /
  Quantity ± / Draw) → "Generate · N" button` (credit cost printed on the button).
  Generations accumulate in the center as a grid with History/Community tabs.
- **Model picker** = a search popover with `Featured models` / `All models` rows, each a
  thumbnail + name + badge (New/Premium) + one-line descriptor.
- **Preset/style library** = model-filtered tabs + a masonry of auto-playing video
  thumbnail cards with ALL-CAPS name overlays + creator attribution + bookmark. Their
  strongest merchandising surface.
- **Design language:** near-black `#0f1113`, glassy rounded pills, one bold accent for the
  Generate CTA, ALL-CAPS name overlays on media tiles, `@`-mention of reusable assets.
- Higgsfield's **Canvas** is a node-graph product conceptually equal to Nebula itself
  (auth-gated; not the surface we are copying — we are copying the *create composer*).

Reference screenshots captured under `/tmp/higgsfield-research/` (ai-image, model-picker,
preset-library, cinema-studio, video-flow, cinema-camera).

### 2.2 Codebase "Studio" pattern (the machinery we reuse)
- **View switching** is a single discriminant `viewMode` in `store/uiStore.ts`
  (`'canvas' | 'editor' | 'remotion-editor' | 'cinema-editor' | 'character-editor' |
  'moodboard-editor'`). `App.tsx` renders the matching full-screen view. No router.
- Each studio adds `enter<X>Editor(id)` / `exit<X>Editor()` actions to `uiStore` and is
  reached from a node "Open Studio" button or a Library "New" button.
- **Two sync flavors already exist:** state-on-node (Cinema writes `node.data.params.scene`
  directly; one dynamic output port per shot) and backend-store + pointer node (Moodboard:
  data in `~/.nebula/moodboards/<scope>/<id>.json`, node holds `_moodboardId` + denormalized
  preview).
- **Library panels** (`MoodboardLibrary.tsx`, `CharacterLibrary.tsx`) mount only when
  `viewMode === 'canvas'`, list saved assets from the backend store, support scope tabs
  (Project/Global), and drag/click to drop nodes.
- **Styling:** single active skin **Slava Restraint** (`styles/slava-restraint.css`, loaded
  unconditionally). Every studio/node CSS selector is scoped under
  `body.app-slava-restraint`. Studios use `position:fixed; inset:0; z-index:50` and a CSS
  grid (`grid-template-rows: 44px 1fr; grid-template-columns: 250px 1fr`). Tokens:
  `--sr-canvas`, `--sr-glass`, `--sr-glass-raised`, `--sr-glass-strong`, `--sr-edge`,
  `--sr-edge-strong`, `--sr-ink*`, `--sr-accent` (`#FF5A1F`), `--sr-ui`.
  (Default + Hermes skins are deprecated — do **not** target them.)

### 2.3 Validated execution & authoring primitives (no engine changes needed)
- `graphStore.executeGraph()` (`store/graphStore.ts:1770`) serializes all nodes+edges and
  POSTs to `/api/execute`.
- `graphStore.executeNode(nodeId)` (`store/graphStore.ts:1802`) runs **only the subgraph
  feeding a target node** via `/api/execute-node` → backend `get_subgraph()` (target +
  ancestors). Guarded by a global `isExecuting` lock.
- Backend routes (all in `backend/main.py`): `/api/execute` (948), `/api/execute-node`
  (1000, computes subgraph), `/api/graph/node-and-connect` (1365, authors node+edge),
  `/api/uploads` (513, image/video upload with validation + content-hash dedup, returns
  metadata + served path).
- Param serialization for the backend uses `paramsForBackend(definitionId, params)`.
- WebSocket streams `queued → executing → progress → executed → graphComplete`, applied by
  node id in `wsClient` → `handleExecutionEvent`, updating `node.data.outputs` /
  `streamingText`. `graphComplete` resets `isExecuting`.

### 2.4 Catalog facts that shape the model picker
`NODE_DEFINITIONS` categories (count): `video-gen` (28), `image-gen` (26), `utility` (21),
`audio-gen` (13), `3d-gen` (10), `universal` (4), `transform` (4), `text-gen` (3),
`cinematic` (3), `moodboard` (1), `character` (1), `analyzer` (1).
- **Model nodes** (picker source) = `image-gen`, `video-gen`, `audio-gen`, `3d-gen`,
  `text-gen`, `cinematic`. `universal` = the 4 dynamic nodes (OpenRouter/Replicate/FAL),
  **deferred to P4** (they need a model-schema fetch step).
- **Input nodes already exist:** `text-input` (`nodeDefinitions.ts:1249`),
  `image-input` (`nodeDefinitions.ts:1273`). We author these — **no new node definitions**,
  so the frontend↔backend node-contract tests (`scripts/check-node-contracts.mjs`) are not
  triggered by this feature.

---

## 3. Non-goals (out of v1 scope)

- **Universal dynamic nodes** (OpenRouter / Replicate / FAL) in the picker — P4 fast-follow.
- **Auto-playing / generated preset thumbnails** — v1 uses static thumbnails.
- **Draw / mask (inpaint) tool** — P4.
- **`@`-mention reusable "elements"** (characters/locations) inline in the prompt — P4
  (Character/Moodboard studios already cover saved assets).
- **Concurrent / queued generations** — v1 runs one generation at a time (consistent with
  the canvas Run button's `isExecuting` lock). Queueing is P4.
- **Community feed / creator attribution** — not applicable to a local BYOK app.
- **Multiplayer / collaboration** — not applicable.

---

## 4. Architecture

### 4.1 The graph-builder generation flow (core)
On **Generate**, the Create view:

1. **Authors a node cluster** in `graphStore`:
   - One `text-input` node carrying the prompt (omitted if prompt is empty and the model
     does not require text).
   - One `image-input` node per attached reference image (each uploaded via `/api/uploads`
     first; the returned served path becomes the node's value).
   - The selected **model node** with the composer's param values applied.
   - Edges: `text-input.text → model.<prompt port>`; `image-input.image → model.<image
     port>` (port ids resolved from the model node's `inputPorts`).
   - For **quantity = N > 1**: author N model nodes that share the same input node(s); each
     gets a distinct seed where the model exposes a `seed` param.
   - Every authored node is tagged `data._createOrigin = { sessionId, genId, ts, prompt }`.

2. **Places the cluster** via a downward-advancing **auto-layout cursor** kept in the Create
   session state, so successive generations never overlap on the canvas. Input nodes sit
   left of their model node(s); N variations stack vertically.

3. **Executes only that cluster.** A new store action
   `executeCluster(nodeIds: string[])` serializes the cluster's nodes (the model node(s) +
   their input ancestors) and the edges among them, then calls `apiExecuteGraph(clusterNodes,
   clusterEdges)` — i.e. POSTs *only the cluster* to `/api/execute`. This is preferred over
   `executeNode` because quantity>1 means multiple target model nodes in a single run, and
   `executeNode` is single-target. Sets `isExecuting` like `executeGraph`; `graphComplete`
   clears it.

4. **Renders results.** The gallery subscribes to `graphStore.nodes` filtered to
   `_createOrigin.sessionId === current` model nodes, ordered by `ts` desc. It shows
   streaming previews during `executing` and final `node.data.outputs` on `executed`,
   rendered by output `type`.

No execution-engine, handler, or node-definition changes. The Create view is a thin
authoring + presentation layer over existing store actions and routes.

### 4.2 Why graph-builder (recap of the approved decision)
Chosen over "single Creation node" and "hybrid session node" because it is the most literal
realization of "the node editor fills in," produces fully-editable/re-runnable real
pipelines, and reuses 100% of the execution machinery. Cost: cluster authoring + auto-layout
+ a small `executeCluster` action.

### 4.3 Persistence
Authored nodes live in the client graph store (created locally, like dynamic/paste nodes)
and render on the canvas in-session. **P1 caveat (verified in the live smoke):** because
`authorGenerationCluster` builds nodes client-side and only sends them to `/api/execute`
(not `/api/graph/node`), the authored clusters are **client-only and do NOT auto-persist to
the backend `~/.nebula/state.json`** — they will not survive a page reload in P1. In-session
"fill in" (switch to canvas → see the cluster) works fully. To make clusters durable across
reloads, **P2 should author via `/api/graph/node-and-connect`** (backend-authored +
persisted) or push the cluster to the backend graph. The Create "session History" is
*derived* from `_createOrigin`-tagged model nodes in the current graph; no separate results
store. A
`sessionId` is minted per Create-view entry (stored in the Create session state) so the
History tab shows the current session, while an "All outputs" tab can show every
`_createOrigin` node in the graph.

---

## 5. The Create view — layout & components

Full-screen shell: `position:fixed; inset:0; z-index:50`, Slava-scoped. Unlike the
rail+main grid of other studios, Create is a **layered stage**: a full-bleed results layer
with an absolutely-positioned floating composer and top strip over it.

```
┌───────────────────────────────────────────────────────────────┐
│ [History] [All outputs]                     [grid|list]  [size] │  top strip
│                                                                 │
│                     results gallery / empty state               │  stage (fill)
│                                                                 │
│      ┌─────────────────────────────────────────────────┐       │
│      │ (+)  prompt textarea…                            │       │  floating
│      │ [Model ▾][Aspect][Res][Qty ±][Styles]  [Generate]│       │  composer
│      └─────────────────────────────────────────────────┘       │
└───────────────────────────────────────────────────────────────┘
```

Component breakdown (each unit: one purpose, a clear interface, minimal deps):

- **`CreateView.tsx`** — root host. Reads `viewMode === 'create'`, owns Create session state
  (`sessionId`, auto-layout cursor, active model id, composer draft, attached refs,
  selected preset). Renders the top strip, `ResultsGallery`, and `CreateComposer`. Owns the
  `handleGenerate` orchestration (authoring → `executeCluster`).
- **`CreateComposer.tsx`** — the floating composer: `(+)` attach, prompt `<textarea>`,
  `ModelPickerButton`, the dynamic `ParamPills`, a `Styles` button (opens the preset
  library), and the `Generate` button. Pure controlled component; emits a typed
  `GenerationRequest` upward.
- **`ModelPicker.tsx`** — popover: search box + `Featured`/`All` grouped rows from
  `NODE_DEFINITIONS` (model categories only). Emits the selected `definitionId`.
- **`ParamPills.tsx`** — renders compact dropdown/stepper pills derived from the selected
  node's `params` definition (the same metadata the Inspector renders, presented as pills).
  Emits a `params` object.
- **`ResultsGallery.tsx`** — grid/list of generations sourced from `_createOrigin` model
  nodes; renders each by output type and exposes per-item actions.
- **`ResultCard.tsx`** — single generation tile: streaming preview / final output, status,
  hover actions (download · open-in-canvas · use-as-input · delete).
- **`PresetLibrary.tsx`** — popover/panel: masonry of `PresetCard`s (ALL-CAPS overlay),
  search + category filter, "Save current as style". Emits an "apply preset" event that
  pre-fills the composer.
- **`OutputRenderer.tsx`** — shared switch on output `type` → `<img>` (Image/SVG),
  `<video>` (Video), audio player (Audio), `<model-viewer>` (3D, as `MeshPreview` does),
  text card (Text). Reused by `ResultCard` and node previews where convenient.

`CreateLibrary` entry (the launcher) lives in the existing canvas chrome
(`components/panels/PanelLaunchers.tsx`) — a "Create" button + keyboard shortcut that calls
`enterCreateView()`.

---

## 6. Feature specs (v1)

### 6.1 Model-picker popover
- Source: `NODE_DEFINITIONS` filtered to `{image-gen, video-gen, audio-gen, 3d-gen, text-gen,
  cinematic}`. Group `Featured` (a curated `FEATURED_MODEL_IDS` shortlist, e.g. nano-banana,
  flux, seedream, gpt-image-2, veo, kling) and `All` (grouped by category).
- Each row: display name, a one-line descriptor (`apiProvider` + category), optional badge.
- Search filters by name/provider/category. Selecting sets the active model and re-derives
  `ParamPills`.

### 6.2 Dynamic param pills
- Built from the selected node's `params` array. Enum params (aspect ratio, resolution) →
  dropdown pills; number params (quantity, duration, seed) → stepper/dropdown pills; booleans
  → toggle pills. Hidden params (`hidden: true`) are skipped.
- `quantity` is a Create-view concept (1–4) that maps to N authored model nodes; if a model
  has a native batch/`n` param, prefer that and skip cluster fan-out.

### 6.3 Results gallery / History
- Two tabs: **History** (current `sessionId`) and **All outputs** (every `_createOrigin`
  node in the graph). Grid/list toggle + thumbnail-size slider.
- Per-card actions:
  - **Download** — the served output file.
  - **Open in canvas** — `exitCreateView()` then select/center that node (reuse existing
    select + fitView).
  - **Use as input** — attach this output as a reference for the next generation (the
    one-click image→video / iterate pattern).
  - **Delete** — remove the generation's cluster from the graph (with the existing
    "undo never drops outputs" behavior respected).
- Streaming previews during `executing` (image partials / SVG drafts / streaming text)
  reuse the same rendering the nodes already do.

### 6.4 Reference-image attach
- `(+)` button and drag-drop onto the stage → `POST /api/uploads` → served path → an
  `image-input` node authored and wired to the model's image/reference port on Generate.
- Multiple references allowed when the model has multiple image input ports (e.g.
  multi-reference models); otherwise the first is used and extras are flagged in the UI.

### 6.5 Presets / styles library
- **Data model** (`Preset`):
  ```ts
  interface Preset {
    id: string;
    name: string;          // shown ALL-CAPS in the UI
    category: string;      // e.g. "Cinematic", "Portrait", "Illustration"
    thumbnail: string;     // served path to a static image (v1)
    prompt?: string;       // prompt fragment, appended/prepended to user prompt
    params?: Record<string, unknown>;  // param overrides applied to the model
    modelId?: string;      // optional model hint (definitionId)
    refImages?: string[];  // optional served paths attached on apply
    scope: 'global' | 'project';
  }
  ```
- **Backend store:** `backend/services/preset_store.py`, mirroring `moodboard_store.py` /
  `character_store.py`. Files in `~/.nebula/presets/<scope>/<id>.json`. Routes in
  `backend/main.py`: `GET/POST /api/presets`, `GET/PUT/DELETE /api/presets/{id}`, all
  scope-aware.
- **Seeded starter set:** ~16 curated presets shipped in `backend/data/presets/seed/*.json`
  (or a single `seed.json`), copied into the global store on first run if empty. Each =
  name + category + prompt fragment + recommended params (+ optional model hint). Static
  thumbnails shipped alongside (generated with Nebula itself or simple branded placeholders).
- **UI:** `PresetLibrary` popover opened from the composer's `Styles` button — masonry of
  `PresetCard`s with ALL-CAPS overlays, search + category filter. Apply pre-fills the
  composer (merge prompt fragment, apply params, set model if hinted, attach refImages).
  "Save current as style" captures the composer state into a new project-scope preset.

---

## 7. Files to create / modify

### Create (frontend)
- `frontend/src/components/create-studio/CreateView.tsx`
- `frontend/src/components/create-studio/CreateComposer.tsx`
- `frontend/src/components/create-studio/ModelPicker.tsx`
- `frontend/src/components/create-studio/ParamPills.tsx`
- `frontend/src/components/create-studio/ResultsGallery.tsx`
- `frontend/src/components/create-studio/ResultCard.tsx`
- `frontend/src/components/create-studio/PresetLibrary.tsx`
- `frontend/src/components/create-studio/OutputRenderer.tsx`
- `frontend/src/styles/create-studio.css`
- `frontend/src/lib/createModels.ts` *(model-catalog filtering + `FEATURED_MODEL_IDS`)*
- `frontend/src/lib/presets.ts` *(preset API client)*

### Modify (frontend)
- `frontend/src/store/uiStore.ts` — add `'create'` to `viewMode`; add `enterCreateView()` /
  `exitCreateView()`.
- `frontend/src/store/graphStore.ts` — add `executeCluster(nodeIds)`; a cluster-authoring
  helper (`authorGenerationCluster(request) → nodeIds`); auto-layout cursor support;
  `_createOrigin` tagging.
- `frontend/src/App.tsx` — mount `<CreateView />` when `viewMode === 'create'`.
- `frontend/src/components/panels/PanelLaunchers.tsx` — "Create" launcher button + shortcut.
- `frontend/src/types/index.ts` — `Preset`, `CreateOriginTag`, `GenerationRequest` types.

### Create / modify (backend)
- `backend/services/preset_store.py` *(new)* — file-backed preset store.
- `backend/data/presets/seed.json` *(new)* + static thumbnails.
- `backend/main.py` *(modify)* — `/api/presets` routes; first-run seed of global presets.

### Tests
- Backend: `backend/tests/test_preset_store.py` (CRUD + scope + seed idempotency).
- Frontend: tests for `executeCluster` + cluster authoring (`frontend/tests/store/`),
  `ParamPills` derivation, `ModelPicker` filtering/search, `PresetLibrary` apply.

> No new entries to `NODE_DEFINITIONS` / `node_definitions.json`, so
> `scripts/check-node-contracts.mjs` is unaffected. `tsc` + `vite build` + the existing
> backend pytest suite remain the gates.

---

## 8. Build phases

- **P1 — Shell + composer + graph-builder core.** `viewMode 'create'`, `CreateView`,
  launcher + shortcut, `CreateComposer`, `ModelPicker` (static model nodes), `ParamPills`,
  prompt → `authorGenerationCluster` → `executeCluster` → a single latest-result preview on
  the stage. Slava styling. *Delivers the "node editor fills in while you create" core.*
- **P2 — Gallery / History + references + variations + all output types.** `ResultsGallery`
  + `ResultCard` actions, History/All-outputs tabs, `(+)` upload → `image-input` wiring,
  quantity>1 fan-out, `OutputRenderer` for Image/Video/Audio/3D/SVG/Text.
- **P3 — Presets / styles library.** `preset_store` + routes + seed, `PresetLibrary` UI,
  apply + save-current-as-style.
- **P4 — Fast-follow (out of v1).** Universal dynamic nodes in the picker; generated/auto-
  playing preset thumbnails; Draw/mask; `@`-mention elements; concurrent/queued generations.

---

## 9. Risks & mitigations

- **`isExecuting` global lock blocks concurrent generations / canvas Run during a Create
  run.** Mitigation: v1 disables Generate while a run is in flight (matches canvas Run UX);
  queueing deferred to P4.
- **Auto-layout overlap as the graph grows.** Mitigation: a per-session downward cursor with
  fixed cluster spacing; clusters are read-only-positioned by Create but remain draggable on
  the canvas.
- **Param diversity across 95+ models.** Mitigation: drive `ParamPills` entirely from node
  `params` metadata (no per-model special-casing); unknown/complex param types fall back to a
  "more options in Inspector" affordance.
- **Preset thumbnail content.** Mitigation: ship a small curated seed set with static images;
  treat richer thumbnails as P4.
- **Cross-process contract drift** (the Soul Cinema `shot_`/`shot-` lesson). Mitigation: this
  feature adds no new cross-process node contract; the only new contract is the preset REST
  shape, covered by `test_preset_store.py` + a frontend client test.

---

## 10. Testing & verification strategy

- **Unit (frontend):** cluster authoring produces correct nodes/edges/params; `executeCluster`
  posts only the cluster; `ParamPills` derive from a sample node def; `ModelPicker` filters to
  model categories; preset apply merges correctly.
- **Unit (backend):** `preset_store` CRUD, scope isolation, seed idempotency; `/api/presets`
  routes.
- **Build gates:** `tsc` clean, `vite build` clean, backend pytest green,
  `check-node-contracts` unaffected/green.
- **Live smoke (per the project's two-gate rule):** with backend + Vite running in a normal
  browser (not lspace), generate an image from the Create view, confirm (a) the result
  renders in the gallery, (b) switching to the canvas shows the authored `text-input → model`
  cluster, (c) the cluster is re-runnable from the canvas, (d) a reference image wires into an
  `image-input`, (e) a preset pre-fills the composer.

---

## 11. Success criteria

1. A user opens **Create**, types a prompt, picks any of the ~95 static model nodes, sets
   params via pills, clicks **Generate**, and sees the result appear in the stage/gallery.
2. Switching to the canvas shows a real, editable, re-runnable node cluster authored by that
   generation (`text-input` [+ `image-input`] → model node), tagged `_createOrigin`.
3. Quantity>1 produces N variations; the gallery shows all of them.
4. A reference image attaches and wires into the model's image port.
5. The preset library lists the seeded styles, applying one pre-fills the composer, and the
   user can save the current composer state as a new style.
6. Everything renders in Slava Restraint with the orange Generate CTA; no Default/Hermes work.
7. All build gates green; live smoke passes.
