# Nebula Nodes — Competitive Gap Analysis: Flora AI + ComfyUI

> Generated 2026-06-21 via a multi-agent research workflow (12 research agents → gap synthesis → adversarial verification against the real codebase → per-view design mapping).
> **Scope:** what Flora AI and ComfyUI offer that Nebula is missing, and how to fold the gaps into Nebula's **non-node views** (Create, Cinema, Character, Moodboard, Video Editor, Remotion) plus net-new global surfaces.
> **Distinct from** `docs/perplexity-research/nebula-gap-analysis.md` (April 2026), which is a *parameter-level* node audit. This is a *competitive feature* analysis.
> **Method note:** every candidate gap was re-checked against the actual code (grep/read of `frontend/src`, `backend/`, `node_definitions.json`, docs). 41 candidates → **40 confirmed, 1 rejected** (we already ship it). A follow-up **completeness-critic sweep** (3 critics → 26 blind spots → fill+verify) added **14 more** confirmed gaps the facet research missed — almost all cross-cutting UX/platform surfaces (§2b). A later **ComfyUI-only completeness audit** (2026-06-22; 387 capabilities classified, see §2c) added **11 more** — the developer-extensibility/platform-packaging layer + node-editor interaction primitives the Flora-weighted pass missed — and an explicit *out-of-scope-by-design* note for ComfyUI's local-inference + hosted-auth stack. **Total: 65 confirmed gaps** (5 high · 35 medium · 25 low). See §2b + §2c.

---

## 0. The two competitors, in one line each

- **Flora AI (florafauna.ai)** — a browser-based, **multiplayer** infinite node-canvas aggregating **50+ frontier models** (~20 providers) across image/video/audio/text behind one billing surface, with an in-canvas agent (**FAUNA**) that builds the graph for you, packaged reusable **Techniques**, **dollar-transparent** cost, and **Action Nodes** (deterministic non-AI editing on the canvas). Nebula is the closest structural analog of the three.
- **ComfyUI** — the open-source (GPL-3.0) **local-first** node engine for generative media. Deepest open-weight model coverage, a huge **custom-node ecosystem** (Registry + Manager), **subgraphs**, **lazy-eval/ExecutionBlocker**, **partial re-execution**, workflow-in-PNG-metadata, and a free **Desktop** app + **Comfy Cloud** that runs the *same* workflow JSON.

**Where Nebula already wins / matches:** BYOK-with-no-markup, 138 first-class nodes + 4 universal nodes (300+ models), smart subgraph caching, typed ports, streaming previews, the Daedalus agent, and — uniquely — **seven specialized non-node workspaces** that neither competitor has. Flora is canvas-only; ComfyUI is canvas-only. Nebula's non-node views *are* the differentiator. That's why the gaps below are mapped *into* those views.

---

## 1. Strategic framing — local-first is a fork in the road

Several of Flora's headline features assume a **hosted, multi-tenant, account-backed** product. Nebula is **local-first, BYOK, AGPL, no server**. Before prioritizing, split the gaps into three honesty buckets:

| Bucket | Meaning | Examples |
|---|---|---|
| ✅ **True to the product** | Buildable now without violating local-first | Assets library, cost meter, variation fan-out, compare slider, subgraphs, Techniques, per-shot cinema, LoRA character, action nodes, MCP server, prompt improver |
| ⚠️ **Needs an honest OSS reframe** | Flora's hosted version doesn't fit; a local/self-hosted-relay version does | Real-time collab (CRDT + self-hosted relay, no account auth), Project sharing (portable zip export + clone-from-community, not role/seat permissions), App Mode (local param-only wrapper, shareable as a bundle) |
| 🛑 **Against the thesis** | Only meaningful as a hosted service | Cloud-hosted GPU execution, hosted multi-user accounts/seats/roles |

Recommendation: pour effort into ✅, ship the ⚠️ items in their OSS-honest form (and *say so* in-UI rather than faking disabled enterprise toggles), and treat 🛑 as explicitly out-of-scope for the local build.

---

## 2. The gap matrix (40 confirmed)

Legend — **F/C/N** = Flora has / Comfy has / Nebula has. `y`=yes `n`=no `u`=unknown · N: `none`/`partial`.

### 🔴 High severity (4)

| id | Gap | F/C/N | Why it matters |
|---|---|---|---|
| `g-llm-tool-calling` | LLM tool / function calling on the 4 chat nodes | u/u/none | Unlocks agentic graphs; all four LLM nodes (claude/gpt/gemini/ideogram) expose no tools param today |
| `g-realtime-collab` | Real-time multiplayer canvas + comments | y/n/none | Flora's signature. Only `/ws` (exec bus) + `/ws/chat` exist. ⚠️ OSS-reframe needed |
| `g-project-sharing` | Project sharing / publish-to-community | y/y/none | No share/roles/publish endpoints. ⚠️ ship as portable-zip export + clone gallery |
| `g-marketing-ugc-studio` | Marketing / UGC studio (product-URL → ad pipeline) | y/n/none | A *new dedicated non-node studio*; zero hits in repo. Highest product-surface ambition |

### 🟡 Medium severity (19)

| id | Gap | F/C/N | Natural home |
|---|---|---|---|
| `g-batch-fanout-node` | First-class Batch node w/ Cross & Zip modes | y/y/partial | Canvas (iterators exist but no combinatorial node) |
| `g-variation-fanout` | "1 image → N variations" node | y/y/partial | **Create** + **Cinema** (per-shot) |
| `g-action-nodes` | Non-AI editing action nodes (grade/crop/trim/text) | y/y/partial | Canvas + **Video Editor** (deterministic subset) |
| `g-layer-editor-compositing` | Multi-image layer/compositing surface | y/y/none | New editor (+ Video Editor's overlay-track slice) |
| `g-subgraphs` | Collapse a region into one editable node | y/y/none | Canvas |
| `g-node-groups-color-tags` | Groups/frames, color tags, bulk edit, canvas search | y/y/partial | Canvas |
| `g-auto-layout` | Dependency-aware auto-layout (agent/Create graphs land in a naive row today) | y/y/partial | Canvas |
| `g-techniques-reusable-workflows` | Packaged reusable workflows / blueprints | y/y/none | Global gallery + canvas collapse primitive |
| `g-document-node` | PDF/document ingestion node | y/n/none | Canvas (input primitive) |
| `g-video-lipsync` | Audio-driven lipsync / talking avatar | y/y/none | **Cinema** hand-off; needs backend node |
| `g-in-app-mask-editor` | GPU mask editor w/ brush/layers/color-select | y/y/partial | Upgrade `MaskPainterModal` (single-layer today) |
| `g-image-compare-slider` | Before/after wipe slider in-app | u/y/partial | **Every view** (compare node passes through today) |
| `g-elements-asset-library` | Unified reusable reference library across surfaces | y/n/partial | **Global** (3 siloed libraries today) |
| `g-mcp-server` | MCP server exposing the studio to external agents | y/n/none | Settings + backend |
| `g-lazy-eval-execution-blocker` | Lazy inputs + prune unused branches at runtime | n/y/none | Engine (strict topo-sort today) |
| `g-local-lora-training-character` | Trained-LoRA Character (true persistent identity) | y/y/partial | **Character Studio** (training backend already exists for Ideogram) |
| `g-cinema-per-shot-backend` | Cinema per-shot generation + variations | u/u/partial | **Cinema Studio** (Generate-shot re-runs whole scene today) |
| `g-usage-cost-tracking` | Per-generation cost + usage analytics | y/y/none | **Global** + inline on Generate buttons |
| `g-controlnet-structural-conditioning` | ControlNet / depth / pose / canny / IP-Adapter | y/y/none | Canvas + **Create** (reference *roles*) |

### ⚪ Low severity (17)

| id | Gap | F/C/N |
|---|---|---|
| `g-asset-import-drive-unsplash` | External import (Drive, Unsplash) | y/n/none |
| `g-character-library-palette` | Character palette reusable across surfaces | y/n/partial |
| `g-router-node` | Router one-to-many pass-through | y/y/partial |
| `g-split-into-layers` | Image decomposition into 2–5 layers | y/n/partial |
| `g-export-node-multiformat` | Multi-format export + batch ZIP | y/n/partial |
| `g-image-relight` | Image relighting primitive | u/u/none |
| `g-public-api` | Public REST API + SDK | y/y/partial |
| `g-cloud-hosted-gpu` | Hosted/cloud execution | y/y/none 🛑 |
| `g-custom-node-ecosystem` | Third-party extension registry + manager | n/y/none |
| `g-node-expansion-loops` | Node expansion / loops & recursion | n/y/none |
| `g-workflow-in-output-metadata` | Workflow embedded in output metadata (drag image → restore graph) | n/y/none |
| `g-inpaint-outpaint-in-view` | Direct on-image inpaint/outpaint UX | y/y/partial |
| `g-app-mode-share` | Simplified param-only "app" view | y/y/partial |
| `g-prompt-improver-builtin` | Inline prompt improver on generation nodes | y/n/partial |
| `g-veo3-ingredients-r2v` | Multi-image reference-to-video (Veo 3.1 Ingredients/Frames) | y/u/partial |
| `g-video-modify-restyle` | Text-driven video restyle / v2v | y/y/partial |
| `g-video-motion-transfer-subject-swap` | Video motion/style transfer & subject swap | y/y/partial |

### ✅ Rejected — already shipped (1)

- `g-style-presets-library` — Nebula already ships a curated named-style preset catalog (`backend/data/presets/seed.json`: 12 styles incl. Cinematic Noir, Anime Cel, Cyberpunk Neon, Watercolor Wash, each with thumbnail, render-time style prompt, params, modelId), auto-seeded at boot and browsable/searchable/applicable in the Create `PresetLibrary`. The only nuance is brand-neutral names. **Not a gap.**

---

## 2b. Completeness-sweep additions (14 new gaps)

Found by a second pass that asked "which capability *areas* did the facet research never probe?" These are overwhelmingly **cross-cutting UX / platform** surfaces — exactly the blind spot of a model-and-feature-oriented analysis. Several cluster; the table lists them as found, the note after collapses them.

### 🔴 High (1)
| id | Gap | F/C/N | Note |
|---|---|---|---|
| `g-onboarding-firstrun` | Onboarding / first-run experience (guided tour, seeded sample graph, "describe what you want" agent entry) | y/u/none | Today: only a static Slava empty-canvas splash (`Canvas.tsx:607`). No tour, sample project, or welcome flow anywhere |

### 🟡 Medium (9)
| id | Gap | F/C/N | Home |
|---|---|---|---|
| `g-creative-history-branching` | Project version history + restore + **non-destructive branching genealogy** | y/n/partial | Canvas + new History panel (we have only linear undo/redo) |
| `g-output-provenance-browser` | Persistent generation-history / provenance browser + graph revert | y/y/partial | Global History panel (Create gallery is session-only `useState`, never persisted) |
| `g-queue-history-manager` | Global **queue/run manager** (queued/running/done, per-job cancel/retry/clear) | u/y/partial | New sidebar panel |
| `g-asset-search` | **Search across generated outputs / uploaded assets** | n/na/none | ResultsGallery + global History (search exists only for models/presets/node-library) |
| `g-command-palette` | Global **⌘K command palette** + keybinding customization + shortcut reference | y/y/partial | New top-level component in `App.tsx` (Cmd+K exists only in the video editor) |
| `g-large-graph-perf` | Large-graph performance knobs (`onlyRenderVisibleElements`, MiniMap, FPS cap, low-quality-on-zoom) | u/y/none | Canvas + Settings (React Flow currently mounts with none of these) |
| `g-job-notifications` | **Notifications for long-running jobs** (browser Notification, tab-title/favicon badge, completion sound) | n/y/none | App-shell layer off the WS events (grep: zero `Notification`/`document.title` usage) |
| `g-friendly-moderation-errors` | Friendly **content-moderation / safety error** handling | n/n/none | Error mapper in `engine.py` → node error UI (raw provider 4xx shown verbatim today) |
| `g-audio-node-ux` | Audio Node UX: inline **voice picker + play-preview**, connection-driven bidirectional mode, MP3/WAV pick, auto-refund-on-fail | y/n/partial | Node/Inspector (distinct from audio *model* coverage, which we have) |

### ⚪ Low (4)
| id | Gap | F/C/N |
|---|---|---|
| `g-headless-jobs-api` | Unified headless `/api/jobs` create/list/delete + `/view` download (we have `/ws` + `/api/execute`, no addressable job API) | y/y/partial |
| `g-3d-gaussian-splats` | Interactive 3D **Gaussian-splat / point-cloud** preview (mesh viewer via `<model-viewer>` already shipped) | n/y/partial |
| `g-i18n` | Internationalization / localization (ComfyUI ships 5 languages; Nebula is hardcoded English) | n/y/none |
| `g-edu-community-surfaces` | Education program + curated community/templates gallery + LLM-queryable docs | y/na/none |

**Clustering:** the four medium history items (`g-creative-history-branching`, `g-output-provenance-browser`, `g-queue-history-manager`, `g-asset-search`) are really **one "History / Provenance / Queue" surface** — a persistent, searchable record of every run with branch genealogy and a job queue. Build them together. `g-onboarding-firstrun` + `g-edu-community-surfaces` are the onboarding cluster.

**Cheap high-value wins** (small effort, real polish, mostly frontend-only): `g-command-palette`, `g-job-notifications`, `g-large-graph-perf` (one React Flow prop: `onlyRenderVisibleElements` + a MiniMap), `g-friendly-moderation-errors`. These weren't in the original 40 but are among the best effort-to-payoff items in the whole analysis — and `g-large-graph-perf` is a genuine *risk* fix (the canvas will jank on big graphs today). **Onboarding (high)** matters because Nebula's multi-surface power is invisible to a new user staring at an empty canvas.

> Note: these 14 are mostly canvas/global/Settings surfaces rather than the six creative Studios, so they extend §3's "Global / new surface" bucket more than the per-Studio sections.

---

## 2c. ComfyUI-only completeness sweep (11 new gaps) — 2026-06-22

> Generated 2026-06-22 by a dedicated **ComfyUI-only** audit workflow (7 facets → completeness critic → 6 supplementary probes → 387 capabilities classified against the live codebase + this doc → synthesis). The original §2 pass was **Flora-weighted** ("Flora is the closest structural analog"); this sweep re-checked ComfyUI's full surface from canonical sources (docs.comfy.org, github.com/comfyanonymous/ComfyUI, comfy.org blog).
>
> **Two structural blind spots** the earlier pass missed, both *below or beside* the consumer-feature altitude it worked at: **(1)** the developer-facing **extensibility & platform-packaging** layer; **(2)** daily-driver **node-editor interaction** primitives. Of 387 capabilities, most were already-captured, already-shipped, or correctly out-of-scope (see the out-of-scope note below); the net real additions consolidate to **11 gaps (0 high · 7 medium · 4 low)**.

### 🟡 Medium (7)
| id | Gap | bucket | Why it matters |
|---|---|---|---|
| `g-node-execution-states` | Node **bypass / mute / pin** (Ctrl+B / Ctrl+M / P) | ✅ | Highest-value missing graph interaction. **Bypass** = skip a node's compute but pass its input through so downstream still runs → A/B a style/upscale step without rewiring. Absent in code + doc. Quick-win candidate. |
| `g-widget-input-conversion` | **Widget ↔ input** conversion (promote a param to a connectable port) | ✅ | A defining ComfyUI interaction: params are fixed widgets that can't become input ports, so you can't drive a prompt/seed/strength from an upstream output. Limits parametric/composable graphs; needs data-model work. |
| `g-node-replacement-migration` | Node **migration API** (remap renamed/removed node ids in saved graphs) | ✅ | No migration layer → renamed/superseded node ids silently break saved `.nebula` graphs + shared zips. Forward-compat/durability risk that directly threatens `g-project-sharing`. |
| `g-app-feedback-layer` | In-app **toast + promise-based dialog/confirm/prompt** service | ✅ | Nebula has NO non-blocking notifications and falls back to blocking `window.alert/confirm/prompt`. The missing delivery channel for `g-friendly-moderation-errors` (cross-link). Distinct from the OS-level `g-job-notifications`. |
| `g-userdata-settings-store` | Server-side **userdata + workflow store + generic settings API** | ⚠️ | Single-user-viable on-disk store: today saved graphs are only OS-picked `.nebula.zip` (no app catalog), canvas persists to one `state.json`, `settings.py` is allowlist-bound + writes non-atomically (corruption risk), UI prefs scatter across localStorage. The backing for an in-app library; pairs with the §2b History/Provenance surface. |
| `g-desktop-packaging-cli-lifecycle` | **Packaged desktop app** + `nebula install/up/stop` lifecycle CLI (+ auto-update) | ⚠️ | Most strategically significant platform gap. Nebula is local-first/BYOK like ComfyUI Desktop but ships only raw dev servers (manual uvicorn + vite); the CLI is a graph client with no install/launch/stop verbs. The line between a developer-only repo and a consumer-installable local app — the whole packaging dimension was absent from the doc. |
| `g-in-canvas-node-docs` | In-canvas **node help** + pre-flight authoring validation (`VALIDATE_INPUTS`, aggregate missing-prereq warning) | ✅ | No embedded per-node help across 138+ nodes (discoverability gap, pairs with onboarding); no per-node validation hook (e.g. "width must be multiple of 8"); no run-button aggregate "graph can't run because X is missing". Distinct from `g-edu-community-surfaces` (external docs). |

### ⚪ Low (4)
| id | Gap | bucket | Why it matters |
|---|---|---|---|
| `g-cache-control-rerun` | Per-node **cache control**: always-rerun + clear/disable (`IS_CHANGED` / `NOT_IDEMPOTENT` / `--cache-none`) | ✅ | Change-detection ships (sha256 of type+params+inputs, 1h TTL), but no per-node "always re-run" opt-out → random-seed/live-clock/live-API nodes silently serve stale cached output within the TTL; no user-facing clear/disable. Folds near `g-lazy-eval-execution-blocker`. |
| `g-workflow-manager` | In-app **workflow manager**: Save As + searchable saved-workflows sidebar + multi-workflow tabs | ✅ | Save/Load exist via OS dialogs, but no named Save As, no in-app catalog/search, one graph open at a time (CanvasTabs is a view toggle). The UX layer on top of `g-userdata-settings-store`. |
| `g-canvas-interaction-polish` | Canvas/node-editor polish: reroute-on-link, node collapse, grid snap, hide-links toggle, connection-aware paste, node toolbox, focus mode, recents/MRU | ✅ | A cluster of mostly one-prop / React-Flow-primitive affordances. Individually trivial, collectively a real ergonomics gap. `snapToGrid` / reroute-on-link / hide-links are near-one-liners → quick-win batch. |
| `g-self-host-auth-note` | Self-host/remote-access **guidance + optional basic-auth toggle** | ⚠️ | The AGPL README anticipates self-hosting but ships zero guidance for safely exposing the app beyond loopback, and no optional basic-auth env toggle — ComfyUI's honest "use a reverse proxy, the UI has no password" has no Nebula equivalent. Single-file-doc fix. |

### 🛑 Out-of-scope by design (NOT gaps — local-inference + hosted-auth)
The sweep surfaced ~120 ComfyUI capabilities that the **BYOK / local-first thesis silently excludes** but this doc never explicitly enumerated. Stated once so they read as *"by design, not overlooked"*: the **entire local-diffusion pipeline exposed as nodes** — `KSampler`/`KSamplerAdvanced` + decomposed custom sampling (40+ samplers, 9 schedulers, SAMPLER/SIGMAS/guider/noise emitters), all loaders (checkpoint/UNet/CLIP/VAE/hypernetwork) + VAE encode/decode/tiled, the latent toolkit (empty/upscale/composite/arithmetic/crop/batch), model surgery (weighted + architecture-aware merging, ModelSampling patches, RescaleCFG, FreeU/PAG/deep-shrink, HyperTile/ToMe, TorchCompile, dtype/device placement), conditioning combine/average/concat/timestep, and the local-runtime/ops layer (smart/low-VRAM offload, device/multi-GPU selection, precision/attention flags, `extra_model_paths.yaml`, Manager model downloads, step caches, V3 stateless schema). Plus the genuinely hosted/account-bound items already bracketed against-thesis: **Comfy Cloud** (GA + MCP + pre-installed models + commercial licensing), prepaid API-node credits, and the full **multi-user/account/JWT/OAuth auth** system. None belong in the gap matrix — they're the cloud-API-vs-local-weights fork, which Nebula chose on purpose.

> **Honesty caveat on this sweep:** the ComfyUI **JS client-extension authoring API** (`app.registerExtension` + lifecycle hooks, programmatic toast/dialog/command/sidebar/settings registration, `WEB_DIRECTORY` web-extension serving, custom server routes) was assessed as built-in *features*, not as a third-party **authoring contract**. That axis is acknowledged-but-deprioritized (it's mostly for plugin authors, which a curated BYOK app may legitimately not want — overlaps `g-custom-node-ecosystem`), not silently dropped.

---

## 3. How to fold the gaps into the non-node views

This is the core deliverable: every recommendation is grounded in controls that already exist in each view's code. Effort: **S** (control reusing existing plumbing) · **M** (new component, existing data) · **L** (touches data model / new backend wiring) · **XL** (engine/infra re-architecture).

### CREATE — make it an iterative refine loop
> *The strongest single thesis: Variation Fan-Out + Compare slider + existing Use-as-input = generate N → compare → pick winner → feed back. "Better than Flora" built almost entirely from existing primitives.*

- **[HIGH/M] Variation Fan-Out** — promote the 1–4 quantity stepper into a true `Vary` mode (Seed / Style / Prompt) when a reference is attached; raise cap to 8 for cheap Seed mode; group fan-out results in the gallery with a `Pick` action that feeds the winner back via the existing `onUseAsInput`. *No new backend — reuses `authorGenerationCluster` + `executeClusterConcurrent`.*
- **[HIGH/L] Elements library** — extend the ReferenceTray + `+` attach into a docked Elements drawer + `@`-mention in the prompt; `Save to library` on result cards; back it with the shared global/project store so Character/Moodboard entities surface here too.
- **[HIGH/M] Cost visibility** — `Generate · ~$0.12 (×n)` on the button; confirm popover above a threshold (also the home for the unbuilt batch cost-confirm); per-card cost chip; topbar session-spend read-out.
- **[MED/S] Inline prompt improver** — Sparkles "Enhance" inside the prompt textarea; non-destructive accept/dismiss diff; also powers Prompt-mode fan-out.
- **[MED/M] Before/after compare** — `Compare` action on cards (input-ref vs output) + two-selected compare, via a clip-path slider mode inside the existing Lightbox.
- **[MED/L] Structural conditioning** — per-chip *role* dropdown on ReferenceTray (Style/Subject/Structure/Pose/Edges/Composition) + conditional strength pill. *Gated on backend control primitives.*
- **[LOW] External import** (attach-button menu → Unsplash/Drive), **Relight** (light-direction compass pill), **Multi-format export** (per-card format menu + Download-all ZIP), **App Mode** (preset flagged "App" → stripped run-state), **Lipsync** (model-gated audio reference slot).

### CINEMA STUDIO — per-shot loop
> *`g-cinema-per-shot-backend` is literally a half-built feature of this view: "Generate shot" currently re-runs the whole scene, and the variations strip is a stub.*

- **[HIGH/L] Per-shot generation + variations** — `executeShot(nodeId, shotId)` so only the selected shot regenerates (rail badge scoped to that row); turn the stubbed variations strip into a real fan-out with a 1–4 stepper and click-to-promote-canonical.
- **[MED/M] Per-shot Variation fan-out** (`Vary` on each thumbnail), **[MED/M] before/after slider** over the shot preview (for look/palette grading), **[MED/L] Elements drawer** as a drag-source into the character-refs/palette controls, **[MED/M] scene cost** (`Generate all (~$0.84, 6 shots)` + threshold confirm — most combinatorial action in the app), **[MED/M] Lipsync hand-off** (extend "Send to motion ▸" into a menu: Animate / Lipsync + audio picker), **[MED/L] Trained-LoRA toggle** (Reference / Trained per scene when the wired Character has a LoRA variant).

### CHARACTER STUDIO — v2 trained identity
> *Highest leverage: this view IS the home for trained identity, and the training backend already exists (`ideogram-train-model` returns `custom_model_uri`, consumed by `ideogram-character`).*

- **[HIGH/L] Trained-LoRA mode** — `Reference / Trained` segmented control; reuse the ≥3-views uploader as the training set; `Train identity` → existing Ideogram/FLUX-LoRA training backend; live `Training… 34%` state; store `loraUrl`/`triggerToken` on the Character; trained badge on the rail; canvas test passes `customModelUri` through.
- **[HIGH/M] Character palette** — make `CharacterLibraryRail` items draggable onto canvas, add search + "recently used", mount the same rail as a flyout in Create/Cinema.
- **[MED/M] Identity-QA compare slider** — after a test run, slider the generated image vs the cover reference ("did the identity hold?"). **[LOW] inline trait-string improver** (non-destructive — the trait string is re-emitted verbatim), **pose-pack reference sub-section**, **per-train cost confirm**, **per-character scope chip**.

### MOODBOARD STUDIO — from blind config form to feedback loop
- **[HIGH/M] Promote the rail to the cross-surface library** — per-item `Add to canvas` / `Copy @-handle` / `Duplicate`; draggable thumbnails; surface `fetchMoodboards` inside Create's Styles modal.
- **[HIGH/L] "Test this board"** — a Character-Studio-style test panel: test-prompt + model picker + `Generate preview` via `authorGenerationCluster`, results inline. *(mapped loosely to `g-image-relight` — treat name/how as authoritative over id)*
- **[MED/M] Editable + named palettes** (reuse Cinema's editable swatch control — palette is currently read-only), **[MED/M] representative-image picker + board-vs-board compare**, **[MED/S] inline brief/negative improver**, **[MED/M] Save as Style** (serialize analysis → Create preset), **[LOW/M] URL-paste / Unsplash import** into the dropzone.

### VIDEO EDITOR (ffmpeg) — fill the export hole
> *The view explicitly has "no in-view final export." Local ffmpeg render = effectively free, so no cost UI here.*

- **[HIGH/M] Multi-format export** — `Export…` popover (MP4 H.264 / MOV ProRes / WebM / GIF, resolution, CRF presets) → new `/api/video-edit/export` reusing `_build_filter_complex` at full quality.
- **[MED/M] Before/after wipe** in the preview pane (source vs edited, lockstep scrub via `outputTimeToSourceTime`) — directly addresses the VFR "render is source of truth" warning.
- **[MED/L] Deterministic action nodes** (reverse/boomerang, Ken Burns `zoompan`, crop/transform) as a second per-clip inspector row. **[LOW/XL] Multi-track / overlay** (second video lane + PiP + xfade transitions) — backend re-architecture; ship transitions first.

### REMOTION EDITOR — export + one-click motion presets
> *Biggest hole: no export (`remotion_node.py` is a no-op echo). Also the home for closing Justin's "no-animation-autopilot" gap.*

- **[HIGH/L] Export** — `Export ▸` modal (MP4/MOV/ProRes/GIF/WebM, resolution, fps, frame range) → new `/api/remotion-render` via `@remotion/renderer` serializing the same `manifest` the Player consumes. GIF answers Remotion's looping-motion-graphics strength.
- **[MED/M] One-click motion presets** — `Ken Burns / Boomerang / Fade / Slide` buttons in the properties panel that *author keyframes* via the existing `updateKeyframe` (the `EasingKind` spring/linear/clamp schema already exists but only raw number inputs are exposed). **This is the no-animation-autopilot fix.**
- **[MED/L] Template compositions** (lower-third, title card, logo sting → preset store), **[LOW] compare slider**, **[LOW] assets-rail consumer** (prefill `src` instead of typing URLs).

### GLOBAL / NEW SURFACES — the cross-cutting infrastructure
- **[HIGH/L] Unified Assets / Elements library** — *the flagship.* Collapse the 3 siloed palettes (`CharacterLibrary`, `MoodboardLibrary`, Create `PresetLibrary`) into one tabbed surface (new `viewMode 'assets'` + dock rail), backed by a new `/api/elements` store cloned from `preset_store.py`; drag-to-canvas via typed MIME; `@`-mention readable by Daedalus. Closes the "reference library both the agent and nodes can read" item parked in `00-CONTEXT`.
- **[HIGH/L] Cost + usage analytics** — `costEstimate` per node-def + `backend/services/cost.py` (seed pricing from `docs/api-guides/*.md`); inline badges; new `viewMode 'usage'` run-history table; extend `ExecutedEvent` with `estimated_cost`. Makes the BYOK pitch honest.
- **[MED/L] Project sharing + Community gallery** — Share modal (portable-zip export that bundles local assets — *also fixes the broken-path-on-reload edge case* — + Publish-to-Community) and a `viewMode 'gallery'` with `Clone to canvas` (reuse paste-UUID-remap). Role permissions surfaced as honestly-disabled "requires hosted mode" or dropped.
- **[MED/M] Techniques gallery** (library/publish half — collapse primitive stays on canvas), **[MED/M] App Mode** (per-node "expose param" toggle → `viewMode 'app'` reusing ParamPills/ReferenceTray/OutputRenderer), **[MED/M] MCP server** (Settings section + backend wrapping existing execution entrypoints; pairs with public-API), **[LOW/M] External import tabs**, **[LOW/XL] Real-time collab** (CRDT/Yjs + self-hosted relay + presence overlay + comment pins — infrastructure-led track, not a quick win).

---

## 4. Recommended build sequence (turn this into a workflow goal)

Ordered by leverage-per-effort, biased to ✅ "true to the product" and to things that compound:

0. **Quick-wins batch (do first — days, not weeks):** `g-large-graph-perf` (a real jank *risk* — add `onlyRenderVisibleElements` + MiniMap), `g-command-palette` (⌘K), `g-job-notifications`, `g-friendly-moderation-errors`, and `g-onboarding-firstrun` (seeded sample graph + tour — makes the multi-surface power visible to new users). Mostly frontend, best effort-to-payoff in the analysis.
1. **Unified Assets/Elements library** (global) — collapses 3 duplicate UIs, feeds Create/Cinema/Moodboard, agent-readable. The single highest-leverage structural add.
2. **Create iterative-refine loop** — Variation Fan-Out + Compare slider + inline prompt improver. Demoable "better-than-Flora" Create, mostly existing primitives.
3. **Cost + usage analytics** (global + inline) — greenfield, honest BYOK differentiator, spans every generate surface.
4. **Cinema per-shot generation + variations** — finishes a half-built core feature of the view.
5. **Character trained-LoRA mode** — training backend already exists; turns Character Studio into v2.
6. **Export everywhere** — Video Editor `/api/video-edit/export` + Remotion `/api/remotion-render`. Two documented holes; Remotion also unlocks GIF + one-click motion presets.
7. **Canvas power** — subgraphs, groups/color-tags/search, dependency-aware auto-layout, Techniques (collapse primitive + global gallery).
8. **History / Provenance / Queue surface** (global) — the clustered §2b medium items: persistent run history + non-destructive branching genealogy + a job queue (cancel/retry) + asset search. Pairs naturally with the Assets library and the cost meter (one global "studio chrome" layer).
9. **Then:** structural conditioning (ControlNet), MCP server + public API, action nodes, sharing/community gallery, app mode, audio-node UX (`g-audio-node-ux`), i18n.
10. **Infrastructure-led, separate track:** real-time collab (CRDT). **Out of scope:** cloud GPU, hosted accounts.

### Portfolio moments (Design Engineer track)
- The **before/after video wipe** and a **polished Export popover** — self-contained micro-interaction studies for a `/lab` demo on justinperea.com.
- **One-click Ken Burns / Boomerang motion presets** in Remotion — directly the "tuned, principled motion as the default" thesis (no-animation-autopilot).
- The **unified Assets library** (consolidating siloed UIs) and the **honest BYOK cost meter** — both genuinely interesting design-engineer write-ups.

---

## Appendix — provenance

- Flora strengths sourced from florafauna.ai + docs (June 2026: Veo 3.1, Kling 3.0/O3, Sora 2 Pro, Seedance 2.0, WAN 2.5–2.7, FLUX.2, Nano Banana 2/Pro, GPT-5.5, Gemini 3.1 Pro, Claude Opus 4.8). FAUNA agent, Techniques + Technique Builder (`flora.ai/technique/<name>`), Action Nodes, Batch Cross/Zip + Matrix view, Router node, dollar-transparent budgets, cross-workspace collab (collaborators spend own credits), API + MCP server.
- ComfyUI strengths sourced from docs.comfy.org + github.com/comfyanonymous/ComfyUI (GPL-3.0 core; Desktop multi-install; Comfy Cloud runs same workflow JSON; API/Partner nodes on prepaid credits; Registry w/ malware scanning + semver + immutable versions; subgraphs/blueprints; lazy-eval + ExecutionBlocker; node expansion for loops; partial re-execution; workflow-in-PNG/WebP/FLAC metadata; 43 samplers/9 schedulers; broadest open-weight checkpoint coverage).
- All 40 gaps adversarially verified against the Nebula codebase on 2026-06-21; full structured output retained in the workflow transcript.
