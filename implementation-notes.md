# Implementation Notes

## 2026-06-03 — Create view Phase 2 (gallery, refs, variations, persistence)

Branch `feat/create-view-p2-p3`. Five sub-features: results gallery/History, reference-image attach, quantity>1 variations, all output types in the stage, and **backend-authored persistence**. Built subagent-driven in batches (Phase A persistence → B/C refs+quantity → D/E gallery+output-alignment) with spec + code-quality reviews. Plan: `docs/superpowers/plans/2026-06-03-create-view-phase-2.md`.

**The big reversal — clusters are now persisted (P1 debt closed).** P1 authored clusters client-side (uuid ids, never persisted). P2 flips `authorGenerationCluster` to **backend-first**: it POSTs the cluster to a new additive route `POST /api/graph/cluster` (mirrors `/api/graph/import` but no `clear()`), which adds the nodes/edges to `cli_graph` (assigning `n`-ids, persisting to `state.json` via `_maybe_persist`, normalizing image-input params) and returns them in React Flow shape. The client applies the returned nodes directly + tags model nodes `_createOrigin`. Switching to canvas shows the cluster; it now survives reload.

**Decisions / non-obvious calls:**
- **Tag race (caught in review).** The backend's graphSync WS broadcast usually delivers the new nodes (untagged) to the client store *before* `authorGenerationCluster`'s own `set` runs, so an insert-if-absent merge silently dropped `_createOrigin`. Fixed with an **upsert** that merges only the tag onto already-present nodes (never clobbering their state/outputs) — and a test that pre-seeds the node to actually exercise the ordering (the unit tests mock `wsClient`, so the race was previously untested = false green).
- **image-input accepts `/api/outputs/...` URLs.** The engine passed `filePath` verbatim and FAL's `_to_fal_url` treats any non-`http(s)`/`data:` value as a local disk path — so a served URL broke. Added `resolve_output_ref` (output.py) + an engine `_image_input_output` helper so generated outputs can be reused as references (execution side); the cluster route's `_normalize_image_input_params` handles the persistence side. "Use as input" stores the backend-RELATIVE pathname (not the absolute `http://localhost:8000/...` URL, which would reach external providers unresolved).
- **Gallery is session-scoped.** History is driven by a `generations: {genId, prompt, ts, modelNodeIds}[]` array in `CreateView` (not by scanning `_createOrigin`), so it's reliable in-session. The spec's "All outputs" tab and reload-repopulation are deferred (the canvas persists; the gallery starts fresh after reload). Shipped Grid/List toggle.
- **`deleteGeneration`** removes the model node(s) of a generation plus any now-orphaned `text-input`/`image-input` (an input feeding *other* surviving model nodes is kept). Fires a best-effort backend `DELETE /api/graph/node/{id}` for every id (harmless 404 for any non-cli id) — diverges from sibling delete paths' `CLI_ID_RE` guard, justified because Create clusters are backend-authored now.
- **Cluster-route response built directly, not via full re-export.** Initial impl re-exported the whole graph and filtered to new ids — which failed in the full pytest suite (a sibling test's autouse fixture swaps `main.cli_graph`; root cause proven). Fixed by extracting `_cli_node_to_rf(n, position, all_defs)` (shared by `export_graph_for_frontend` and the route) and looking up the new nodes directly in `cli_graph.nodes`. More robust + avoids export-time normalization side-effects on unrelated nodes.

**Verification:** backend `pytest` 839 passed (twice, order-independent); frontend `tsc` clean, 293 vitest tests, `vite build`, `eslint`, `check:slava-css-scope` all green. Persistence to `state.json` is structurally guaranteed (route → `add_node` → `_maybe_persist`) and covered by the route test. Full browser smoke (gallery progression, persistence-across-reload, use-as-input round-trip) is consolidated with P3 in the verify-and-finish step.

## 2026-06-02 — Create view (Higgsfield-style creation surface), Phase 1

Branch `feat/create-view`. A new full-screen `viewMode: 'create'` surface (4th studio) with a Higgsfield-style bottom-floating composer. Each **Generate** authors a real `text-input → model` node cluster and runs only that cluster via the existing engine. Spec: `docs/superpowers/specs/2026-06-02-higgsfield-create-view-design.md`; plan: `docs/superpowers/plans/2026-06-02-create-view-phase-1.md`.

**Architecture — graph-builder (chosen over single-node / hybrid).** `graphStore.authorGenerationCluster(request)` builds nodes/edges and `executeCluster(nodeIds)` POSTs only the cluster to `/api/execute` (reusing `lib/api.executeGraph`). Zero changes to the execution engine, handlers, or node definitions — the surface inherits output rendering, WS streaming, error handling, undo, and canvas editability for free. This is why it's ~640 lines of source for a full creation UI.

**Decisions made beyond the spec:**
- **Local node authoring, not backend-authored.** `authorGenerationCluster` creates nodes client-side (like `addDynamicNode`/paste) in one `set()`, for atomicity + testability + immediate ids. Consequence (verified in live smoke): **Create-authored clusters are client-only and do NOT persist to the backend `~/.nebula/state.json`** — after a generation, `state.json` still held only the pre-existing moodboard node. In-session "fill in" works (nodes are in the client graphStore, render on the canvas, and execute correctly). **Cross-reload durability is NOT wired in P1.** If we want authored clusters to survive a reload, P2 should author via `/api/graph/node-and-connect` (backend-authored, persisted) or push the cluster to the backend graph. Spec §4.3 was updated to reflect this.
- **`_createOrigin` tags model nodes only** (not the `text-input`/`image-input` wiring nodes) — from code review; the P2 results gallery filters on this tag, so tagging input nodes would pollute it.
- **`executeCluster` pre-marks cluster nodes `queued`** (clearing stale `error`/`progress`/streaming fields) before POSTing — from review; without it the stage flashed the previous result on every 2nd Generate.
- **Dropped `cinematic` + `universal` from the picker's `CREATE_MODEL_CATEGORIES`.** `cinematic` = post-process nodes (`cinema-color`/`cinema-look`/`cinema-scene`), not prompt-first generators. `universal` = the 4 dynamic nodes (OpenRouter/Replicate/FAL) — deferred to P4 (they need a model-schema fetch step). v1 picker = `image-gen`/`video-gen`/`audio-gen`/`3d-gen`/`text-gen`.
- **Accent = Slava orange (`--sr-accent`), not Higgsfield lime.** Copy the layout/interactions, render in the house skin.
- **`model-viewer` rendered via the existing `types/model-viewer.d.ts` JSX declaration** (no `@ts-expect-error` — that would be an unused-directive error), mirroring `MeshPreview.tsx`.

**Known debt / deferred:**
- DRY: `buildDefaultParams` (graphStore) duplicates `buildDefaultParamsForUi` (createParams) and the inline logic in `addNode`. Consolidate post-P1 (a shared param-defaults util imported by all three).
- Image-required models (e.g. `runway-video`, `meshy-image-to-3d`) appear in the picker but will fail backend validation without a reference image until P2 adds reference attach — acceptable; surfaces the real validation error.
- P2: results gallery/History, reference-image attach, quantity>1 UI, all output types in the stage. P3: presets/styles library. P4: universal dynamic nodes, generated preset thumbnails, draw/mask, @-mention elements.

**Verification:**
- Gates: `tsc` clean, **288 vitest tests pass** (incl. new createCluster/createModels/createParams/uiStore tests), `vite build` succeeds, `eslint` clean on all new/changed files, `check:slava-css-scope` passes. (`npm run lint` is red on `main` due to **pre-existing** `CrabMark.tsx` inline-style debt — unrelated to this branch.)
- Live smoke (real browser, not lspace): entered Create, opened the model picker (full catalog), typed a prompt, hit Generate → a **real nano-banana image of exactly the prompt** was generated end-to-end (`POST /api/execute → [exec] _run completed → output/.../*.jpeg`). The prompt-faithful output proves the `text-input → model` wiring carried the prompt.
- **Environment gotcha:** background dev servers get reaped (SIGTERM 143) in this harness; when Vite's dev server dies, its `@vite/client` intercepts `console.error` and recursively tries to `send` over the dead HMR socket → a multi-million-line "send was called before connect" storm. This is a Vite-client failure mode, NOT app code. The canvas-cluster screenshot wasn't captured for this reason; the cluster's existence is proven by the unit tests + the successful generation.

## 2026-05-26 — Codex chat agent

- Added Codex as a separate chat runtime rather than overloading the Claude runner. Codex has its own JSONL event stream, auth state, and resume command shape, so a dedicated adapter keeps the existing Claude/Daedalus paths untouched.
- Codex uses the local CLI login state (`codex login status`) instead of storing ChatGPT credentials in Nebula. This follows OpenAI's documented Codex auth model and avoids copying subscription tokens into `settings.json`.
- The Codex runner launches with `workspace-write`, `approval_policy="never"`, and local network enabled so it can call the Nebula CLI/backend without interactive approval prompts while still avoiding the full `--dangerously-bypass-approvals-and-sandbox` path.
- GPT Image 2 generation remains on Nebula's existing OpenAI/FAL nodes. ChatGPT-backed Codex auth is only for the Codex agent brain; Image API calls still require `OPENAI_API_KEY` or `FAL_KEY`.

## 2026-05-26 — Codex skill bootstrap

- Added a repo-backed skill bootstrap to the Codex runner instead of relying on private/global agent skill state. The bootstrap indexes `.agents/skills/*/SKILL.md`, lists available skills, preloads relevant root skill docs based on the user's message, and points Codex to tracked provider docs for exact node/API details.
- Kept preload bounded (`MAX_SKILL_BOOTSTRAP_CHARS`, `MAX_SKILL_DOC_CHARS`) so FAL's large model catalog remains available on disk without bloating every Codex turn.
- `.agents/skills` is not currently committed on `origin/main`; it exists locally as an untracked public-safe bundle. It needs to be added to the repo before the GitHub version has the same Codex/Nebula knowledge.

## 2026-05-26 — Agent connection instructions

- Added Claude auth status parity with Codex via `/api/agents/claude/status`. Nebula still does not collect credentials; it only reports the local CLI's installed/logged-in state.
- Added compact connection instructions inside the chat composer for Claude and Codex. They show the relevant local CLI login/status commands and open automatically when the selected CLI is missing, unavailable, or not logged in.

## 2026-05-26 — Codex announcement HyperFrames video

- Creating the announcement as a standalone HyperFrames composition under `hyperframes/codex-chat-announcement` so it can be rendered independently from the Vite frontend while still matching the Slava UI.
- `npx hyperframes` is not available in the local cache and registry access is blocked in this sandbox, so the work will produce valid composition source and local structural checks rather than a rendered MP4 in this pass.
- The video mirrors the actual Slava chat panel affordance: Claude / Codex / Daedalus selector with Codex active, `Codex · ChatGPT` status copy, dot-matrix canvas, glass panels, orange focus accent, and compact node graph surfaces.

## 2026-05-27 — Backend URL discovery

- Added frontend-side Nebula backend discovery instead of assuming every request and WebSocket lives at `localhost:8000`.
- Discovery checks the same-origin `/api/health` path first, then cached/local localhost candidates on ports 8000-8010, and caches the working base URL in localStorage.
- Kept `VITE_NEBULA_API_BASE` and `VITE_NEBULA_BACKEND_PORTS` as explicit overrides for users who run the backend on a nonstandard fixed port.
- Rewrote local `/api/outputs/...` asset URLs to the discovered backend origin so images, videos, downloads, and restored graph bundles still work when the backend is not on 8000.

## 2026-05-27 — Agent reconnect retry

- Fixed backend discovery treating the same-origin Vite proxy candidate (`""`) as not found even after `/api/health` succeeded.
- Added retry loops for Claude/Codex status checks and the chat WebSocket so a backend that starts after the page loads is picked up without switching tabs or reopening the panel.

## 2026-05-27 — Codex ChatGPT login from UI

- Added a Nebula-launched Codex ChatGPT login path instead of asking users to copy terminal commands first. The backend starts `codex login` and the frontend polls progress/status from the chat panel.
- Treat Codex API-key mode as not connected for the ChatGPT subscription path. The button is intentionally labeled `Connect ChatGPT Account`; starting it runs `codex logout` first, then `codex login`, so an existing API-key login can switch to ChatGPT OAuth cleanly.
- Nebula still does not store OpenAI OAuth tokens. Codex owns the browser/device OAuth flow and caches credentials in its normal local store; Nebula only reads `codex login status`.
- Added a `Device Code` fallback in the UI for machines where the browser callback flow is awkward or blocked.

## 2026-05-27 — GPT Image 2 graph run crash

- Diagnosed the GPT Image 2 "no images" symptom as a backend graph-sync crash before or after the image node, not a Codex auth problem. A long prompt Text output was being probed as if it might be an output file path.
- Hardened output-path normalization so `Path.exists()` / path parsing errors from long plain-text values are treated as "not a file" instead of crashing `/api/graph/run`.
- Verified the regression with the existing long-text output sync test plus the GPT Image 2 handler suite.

## 2026-05-27 — OpenAI API billing guard

- Added an explicit billing acknowledgement guard for OpenAI-direct image nodes (`gpt-image-1-generate`, `dalle-3-generate`, `gpt-image-2-generate`, `gpt-image-2-edit`).
- Frontend graph and node runs now show a native confirmation explaining that these nodes use `OPENAI_API_KEY`, bill the OpenAI API project, and do not use the ChatGPT subscription or Codex ChatGPT login.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` reject unacknowledged OpenAI-direct image runs with HTTP 409, so CLI/agent-triggered runs cannot silently spend API money.
- Human CLI users can deliberately opt in with `NEBULA_ALLOW_OPENAI_API_BILLING=1` for `nebula run` / `nebula quick`; agents do not get that bypass by default.

## 2026-05-27 — CLI graph text output normalization

- While generating media from long prompt text nodes, `/api/graph/run` crashed before downstream image nodes executed because output normalization treated every string output as a possible file path and called `Path.exists()` on the entire prompt.
- Fixed output URL normalization to treat filesystem probes as best-effort: `OSError` from impossible path strings now means "not a media asset", preserving text outputs unchanged.
- Added a regression test so long text-output values do not break CLI graph execution while real output file paths still normalize to `/api/outputs/...`.

## 2026-05-27 — Codex agent ChatGPT-only auth

- Hardened the Nebula Codex runner so `codex exec` only starts when `codex login status` reports `Logged in using ChatGPT`.
- API-key, access-token, unknown, not-installed, and not-logged-in states now return a chat error before any Codex subprocess can run.
- Stripped `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`, and `CODEX_ACCESS_TOKEN` from the Nebula-owned Codex subprocess environment so an inherited shell credential cannot silently flip the agent back to API billing.

## 2026-05-27 — GPT Image 2 visible run feedback

- Diagnosed a Nebula UI feedback gap after adding the OpenAI API billing guard: if the native confirmation was cancelled or suppressed, the run returned before any visible node state changed.
- Node execution now marks the selected execution scope as `queued` immediately after confirmation so GPT Image 2 nodes show visible activity even before the first backend websocket event arrives.
- Queued nodes now render the loading block, and start/validation failures write a visible node error instead of only logging to the browser console.

## 2026-05-27 — Removed API billing confirmation blocker

- Removed the OpenAI-direct image billing acknowledgement as a run blocker. The user decided the confirmation was slowing down normal workflow and was not needed now that Codex-agent auth is ChatGPT-only.
- Frontend Run / Run This Node no longer opens a native confirmation dialog before GPT Image 2 direct execution.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` no longer require `allowOpenAIApiBilling`, so CLI and agent-triggered runs use the same normal validation/execution path.
- GPT Image 2 direct nodes still use `OPENAI_API_KEY` and bill the OpenAI API project; this change only removes the extra acknowledgement gate.

## 2026-05-29 — Soul Cinema (Phase 0 + 1): cinematic pillars + Cinema Studio

Built overnight via a 7-wave dependency-ordered subagent workflow. Spec: `docs/superpowers/specs/2026-05-29-soul-cinema-nebula-design.md`. The framing decision: Higgsfield Soul Cinema is a *stack* (cinematic base + Soul ID + Soul HEX + film-look + keyframe handoff), which maps 1:1 onto our node graph — so we add the two genuinely-missing pillars as deterministic local nodes and a multi-shot Studio editor, reusing existing models for everything else.

**Decisions made beyond the spec (collated from wave reports):**
- **`_parse_recraft_color` was extracted into `backend/cinema/color.py`** as the single source of truth and re-imported back into `execution/sync_runner.py` (the old inline def removed), so `from execution.sync_runner import _parse_recraft_color` stays valid for `test_fal_handler.py`. Honors "extract/share, don't duplicate."
- **sRGB↔CIELAB (D65) implemented in pure numpy** rather than adding a color-science dependency (honored "add nothing else but Pillow/numpy", both already pinned in the venv).
- **Grain determinism**: RNG seed derived from a sha256 of the look params + image dims (no wall-clock), so identical inputs → byte-identical noise. Same idea for the whole pipeline → `ExecutionCache`-friendly.
- **`lab-transfer` (default color method)** = Reinhard mean/std match in Lab **plus** a per-pixel nudge toward the nearest target swatch at `strength·0.5`. This is what makes the cool-blue grade keep the forge fires hot orange (visible in the smoke set) instead of a flat global tint.
- **`cinema-scene` stores its spec exactly like `remotion-node` stores its manifest** — `params:[]` in the catalog, the real `CinemaSceneSpec` lives on `data.params.scene` at runtime (there is no `object` param type and adding one was out of scope). The editor writes it via `graphStore.updateScene`.
- **`cinema-scene` base dispatch reuses the full `get_handler_registry` path** (synthesize a GraphNode, invoke the chosen base model's registered closure) rather than the `fal_universal` fallback — a clean internal base→color→look call. Reference images are fed into BOTH `image` (single) and `images` (multiple) ports since edit bases differ (flux-kontext vs nano-banana); handlers ignore ports they don't map.
- **License guard**: an empty/missing or FLUX.1-dev base model is substituted with `seedream-4-5` (commercial-OK) instead of crashing.
- **Per-shot output ports** use `isDynamic:true` + `dynamicOutputPorts` on node data (mirrors `configureOpenRouterModel`) so `useIsValidConnection` resolves them and Send-to-motion can wire a shot into a `veo-3` first-frame input.
- **New `cinematic` category + `palette` param type** required extending the contract validators (`scripts/check-node-contracts.mjs`, `backend/tests/test_node_contracts.py`) and the model-reference generator (`scripts/generate-model-reference.mjs`) — extending the allowed sets, not weakening any shape rule. `docs/MODEL_REFERENCE.md` regenerated (107 nodes).
- **Inspector palette extraction is client-side k-means** (deterministic seeding, 96px downscale) per spec latitude; no backend `/api/cinema/extract-palette` endpoint was added.

**Orchestrator fix after the build (the one bug self-verification couldn't catch):**
- **Port-id mismatch**: frontend `shotPortId()` produced `shot_<id>` while the backend handler produced `shot-<id>`. Unit tests + `tsc` both passed because it's a cross-process string contract. Aligned the **backend** to `shot_<id>` (`backend/handlers/cinema_scene.py` `_output_port_id` + the `test_cinema_scene.py` assertions) — underscore matches the codebase's port-id convention (`video_in`, `first_frame_image`). Re-verified: 55 cinema tests + contract check green.

**Known gaps for the next (interactive) session — needs the live app:**
1. **In-Studio preview round-trip (verify live).** The handler writes finished shot URLs onto `node.params['scene'].shots[*].output` AND returns per-shot port outputs. Canvas per-shot ports + downstream wiring update via the normal executed-output mechanism; the *in-editor* preview reads `scene.shots[*].output.imageUrl`, which only refreshes when the backend re-pushes the node's params via `graphSync` after `cinema-scene` completes. Confirm the backend emits that graphSync (or have the Studio also read from `data.outputs[portId]`).
2. **Live base→color→look end-to-end** was only exercised with a **mocked** base model. Run a real `seedream-4-5`/`nano-banana` scene with character refs against live keys.
3. **Variations strip** is a single-slot placeholder (handler emits one image/shot); populate when multi-output lands.
4. **Send-to-motion** gives only an inline "Sent ✓"; the new `veo-3` node isn't visible until you exit the Studio — consider auto-exit or a toast.
5. **Offline node-create** falls back to `model-node` type for `cinema-scene` (same limitation as `remotion-node`); online graphSync assigns `cinemaSceneNode` correctly.
6. Pre-existing: `backend/.venv` `pytest` console-script has a stale shebang (points at the old `Documents/Projects` path) — run tests via `.venv/bin/python -m pytest`.

**Out of scope (next spec):** Looks/preset library + Studio "Looks" gallery; `soul-cinema` SKILL.md + Codex/Daedalus agent wiring; ffmpeg video film-look; trained-LoRA / PuLID identity modes.

**Smoke proof:** `docs/soul-cinema-smoke/` — 11 PNGs from a real Athens golden-hour still (color transfers, all 5 film presets, 2 full-pipeline grades). All deterministic, generated with no server.

### 2026-05-30 — Fix: named presets were being clobbered by neutral default sliders

First live test surfaced a real bug: a `cinema-look` node with `preset='kodak-portra'` produced a near-unchanged ("just darker") image. Root cause (found via systematic debugging, evidence-first):

- `cinema.look._resolve_params` correctly lets **explicit** float sliders override a preset (this is intentional — per-shot Studio overrides rely on it; `test_explicit_param_overrides_preset` pins it).
- BUT the node always carries its slider params (catalog defaults `grain 0.2 / halation 0.2 / vignette 0.25 / contrast 0 / saturation 0 / temperature 0`), and the frontend forwards them even though `visibleWhen` only *shows* them for `preset==='custom'`. Hiding a control doesn't remove its value.
- So `_build_look` forwarded those neutral defaults as if explicit → they overrode kodak-portra's grade (`temperature 0.18, contrast 0.12, saturation 0.08`) back to **0**, leaving only a uniform vignette darken. Channel evidence: buggy `R−18 G−17 B−15` (uniform darken, no colour) vs correct preset-only `R−2 G−9 B−19` (warm R-vs-B separation).

**Fix at the build sites (intent is known there), not the pillar:**
- `backend/handlers/cinema_look.py::_build_look` — when `preset in PRESETS` (a real named preset), do **not** forward the float sliders; the preset's own bundle stands. `'custom'`/unset still forwards sliders. LUT always honored. (+5 regression tests in `test_cinema_look.py`, red→green; the existing pillar override test still passes.)
- `frontend/.../CinemaSharedControls.tsx` — selecting a preset chip now calls `selectPreset()` which sets `look = { preset: id }` (drops neutral sliders); `'custom'` restores editable sliders. Required making the `CinemaSceneSpec.look` slider fields **optional** (`types/index.ts`) — semantically correct: a named-preset look omits sliders, matching the backend "missing → use preset" behavior.

**Gotcha for re-testing:** `cinema-color`/`cinema-look` are deterministic and cached (`services/cache.py` `ExecutionCache`, in-memory). Re-running a node with identical params returns the cached result — switch the preset (or restart the backend, which clears the cache) to see a fresh render. Also: running a node re-executes its whole subgraph, so re-running a `cinema-look` wired off a `gpt-image-2` node will re-generate the (paid) base image; wire film-look off a static image-input to iterate for free.

**Follow-up (not done, user's call):** the node/scene default preset is `'custom'` (subtle grain+vignette, no colour) — consider defaulting to a named preset like `kodak-portra` so a freshly-dropped node obviously "does the film thing."

### 2026-05-30 — Canvas ↔ Studio parity for character refs

User principle: "what happens in the node view should happen in all views and vice versa." Gap found while testing: an image wired into the `cinema-scene` node's `character_refs` port on the canvas was used by generation (the handler reads `inputs['character_refs']`) but was **invisible** in the Studio's CHARACTER REFS box (which only rendered uploaded `scene.character.refImageUrls`).

- `CinemaStudioView` now resolves canvas edges into the node's `character_refs` port to image URLs (robust to both a generated source — `data.outputs[handle].value` — and a static `image-input` — `data.params._previewUrl`/`filePath`, whose `outputs` may be empty until run) and passes them to `CinemaSharedControls`.
- `CinemaSharedControls` renders connected refs read-only with a 🔗 badge (disconnect on the canvas to remove); uploaded refs keep their × remove button.
- Reverse direction: `CinemaSceneNode`'s card summary now shows the uploaded-ref count (`2 shots · 1 ref`), so refs added inside the Studio are reflected on the canvas (connected refs already show as the edge).
- Verified live: constructed `image-input → cinema-scene:character_refs` via the API and ran the exact resolution logic against `/api/graph/export` → resolved the ref URL; tsc + vite build clean.

### 2026-05-30 — Krea 2 direct provider plan

- Created branch `codex/krea-2-direct-provider` from the current dirty `main` state as requested; unrelated existing worktree changes are being left untouched.
- Scope decision: implement Krea direct API only. FAL Krea endpoints are intentionally skipped for this goal even though they exist, because Krea-native style IDs, moodboards, assets, and style training are not covered equivalently by the generic FAL node.
- Node-family decision: add one main `krea-2-generate` node plus Krea resource wrapper/training/search nodes. This keeps simple prompt-to-image easy while allowing graph-native use of `image_style_references`, `moodboards`, and `styles`.
- Moodboard limitation: verified Krea docs expose moodboard use by ID but no public create/list moodboard endpoints, so Nebula will model moodboards as existing-ID wrapper nodes and direct fallback params.
- Asset handling decision: local or generated images connected as Krea style references will be uploaded internally via `POST /assets`; users should not have to paste URLs for normal graph workflows.
- Shipped direct Krea implementation: `krea-2-generate`, `krea-image-style-reference`, `krea-style`, `krea-moodboard`, `krea-style-search`, and `krea-style-train`.
- `krea-2-generate` accepts raw image style inputs and typed Krea resource objects together; the handler merges them into Krea's documented `image_style_references`, `styles`, and `moodboards` request fields, enforcing max 10 image refs and max 1 moodboard.
- Style training uploads local graph images to Krea assets before calling `/styles/train`, polls `/jobs/{id}`, emits a reusable style object, and optionally shares the style with the API workspace.
- Verification: Krea handler tests, node registry/contract tests, Codex skill bootstrap tests, full backend suite (`827 passed`), frontend production build, and `git diff --check` all passed. No live Krea smoke was run because no `KREA_API_TOKEN` was available in this session.

### 2026-05-31 — Krea agent skill

- Added/expanded the project-local Krea agent skill at `.agents/skills/krea/SKILL.md` so Codex/Daedalus agents know the direct-Krea node IDs, graph wiring patterns, resource wrapper shapes, API key naming, and Krea-specific live-test caveats.
- Kept the skill as one concise `SKILL.md` rather than adding extra docs, because detailed provider research already lives in `docs/model-providers/krea/krea-2.md` and skills should stay lightweight.
- Included the `402` API-balance caveat from live testing: a valid Krea token can authenticate and still fail generation until the separate API balance is topped up.

### 2026-05-31 — Native Moodboard Studio

- User chose Nebula-native moodboards rather than Krea-owned moodboards. Decision: make Moodboard a first-class Nebula resource and port type; Krea is only a downstream adapter.
- First canvas mirror is a custom `nebula-moodboard` node/card with grouped visual state and multiple outputs (`Moodboard`, style brief, negative prompt, images, palette). True React Flow parent/child grouping is deferred because the current graph persistence path does not carry parentId/extent/group metadata.
- Analysis starts as deterministic local extraction: resolve Nebula-local images, extract palettes with the existing CIELAB k-means code, and produce an editable creative-direction object. The schema is intentionally richer than the local analyzer can fully populate so a future vision-model analyzer can fill materials, motifs, and semantic cues without changing stored resources.
- Krea integration consumes native Moodboards by adapting representative images to `image_style_references` and appending the extracted style brief to the prompt. We still keep Krea-owned moodboard IDs as their own `krea-moodboard` wrapper because Krea does not expose public create/list moodboard endpoints.
- Browser smoke used the existing local backend (`127.0.0.1:8000`) and Nebula Vite dev server (`127.0.0.1:5180`) in Chrome. A temporary "Smoke Moodboard" verified library listing, Studio loading, canvas node mirroring, and Analyze output; the temporary moodboard, canvas nodes, and generated test image were removed afterward.
- Follow-up fix: the Studio "Add Images" action no longer relies on a script-triggered `.click()` against a hidden file input. It is now a native file input inside the visible label with the input layered above the styled text, so normal mouse clicks hit browser-native file picker behavior. Drag/drop still uses the same upload path.
