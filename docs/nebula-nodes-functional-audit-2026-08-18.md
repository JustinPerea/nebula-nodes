# Nebula Nodes Functional Audit — 2026-08-18

Status: complete for the targeted reliability, UI, credential, and release-readiness defects; refreshed after final unrestricted validation

This document is the continuation surface for a systematic product audit. It records what Nebula Nodes is, how a user and an agent are expected to operate it, what was actually exercised, and the proof ceiling for anything not yet exercised. Existing user graph state, saved assets, API keys, and pre-existing dirty worktree changes were not modified.

The exhaustive definition-by-definition ledger is in `docs/nebula-nodes-node-verification-matrix-2026-08-18.md`.

## Current refresh summary

The seven reliability defects identified in the first audit are fixed and regression-covered: run-scoped output directories, manifest redaction/bounding, stale local-artifact cache eviction, atomic validated graph ingress, backend graph cancellation, and opt-in/output-root-aware zoom telemetry. The four frontend defects found by the live rendered review are now fixed too:

1. **Run History is visible and recoverable.** It opens inside the viewport, clamps during drag/resize, and the toolbar reset restores all panel geometry while preserving visibility.
2. **Nodes and Assets form one exclusive left rail.** Opening either panel closes the other instead of stacking them at the same coordinates.
3. **Create selects one provider route.** Provider-aware parameter resolution chooses direct controls only when the matching direct key is configured, otherwise FAL controls, and defensively de-duplicates keys.
4. **The node library is keyboard/click authorable.** Definitions are focusable draggable buttons; activation adds at the current viewport center, and a legacy double-click cannot create an accidental duplicate.

The unrestricted final checkout passed **1,544/1,544 backend tests**. A clean release-candidate simulation also passed **1,526/1,526 backend tests**; the count difference is 18 tests from four ignored Finder duplicate files that exist only in the live workspace. All **447 frontend tests across 56 files**, the production build, lint guards, and the **172-definition** node contract passed. The corrected behavior was also re-exercised in the rendered UI: Run History measured `x=988`, width `276`, right edge `1264` in a `1280`-pixel viewport; Reset preserved that placement; Assets opened with Nodes absent; click-to-add produced one Text Input node; and Veo 3.1 exposed exactly one Seed input with zero duplicate-key console errors. Fresh screenshots accompany the final handoff.

## Audit vocabulary

- **Confirmed working** — exercised during this audit with an observable result.
- **Confirmed failing** — exercised during this audit and failed for a product or workspace reason.
- **Environment-gated** — the check could not run because this Codex sandbox denied a required capability. This is not classified as a Nebula product failure.
- **Credential/cost-gated** — the path needs a provider credential and may consume paid credits. It remains unverified until explicitly exercised.
- **Structurally covered** — registry, contract, mocked request, or unit coverage exists, but no live provider result was produced in this audit.

## Product model

Nebula Nodes is a local-first, BYOK creative studio. Seven authoring surfaces operate over one graph and one backend rather than seven separate projects:

1. **Canvas** — the canonical React Flow node graph.
2. **Create** — a prompt-first generation and results-gallery view that authors real graph nodes.
3. **Cinema Studio** — shot and variation authoring over graph-backed cinema nodes.
4. **Character Studio** — reusable identity assets and Character bundles.
5. **Moodboard Studio** — reusable visual-direction assets and Moodboard bundles.
6. **Video Editor** — an ffmpeg-backed editing surface opened from a completed video path.
7. **Remotion Editor** — programmatic composition and render-job authoring.

The core runtime path is:

```text
React/Vite surface
  -> Zustand graph and UI stores
  -> FastAPI REST commands + execution WebSocket
  -> graph validation and topological scheduling
  -> local utility path or registered provider handler
  -> output files + manifest metadata
  -> streamed node events and persisted graph state
```

Specialized studios are alternate authoring views over the shared graph. A Create result, Cinema shot, Character, Moodboard, Video Edit, or Remotion composition ultimately becomes graph state that the same execution and persistence systems understand.

## Sources of truth

| Concern | Source of truth |
|---|---|
| Node catalog | `backend/data/node_definitions.json` |
| Generated catalog documentation | `docs/MODEL_REFERENCE.md` via `node scripts/generate-model-reference.mjs` |
| Frontend node mirror | `frontend/src/constants/nodeDefinitions.ts` |
| Provider and special-node routing | `backend/execution/sync_runner.py` |
| Local graph execution | `backend/execution/engine.py` |
| Frontend graph state and execution orchestration | `frontend/src/store/graphStore.ts` |
| API, graph, upload, settings, asset, and execution routes | `backend/main.py` |
| User graph persistence | `~/.nebula/state.json`, overridable with `NEBULA_STATE_DIR` |
| Outputs | configured `outputPath` / `NEBULA_OUTPUT_ROOT` |
| Characters, moodboards, presets | `~/.nebula/*`, each with a `NEBULA_*_ROOT` test override |
| API keys | project-root `settings.json` under `apiKeys` |
| Run history | browser local storage, capped at 100 records |

`backend/data/node_definitions.json` currently contains 172 nodes in 12 categories:

| Category | Count |
|---|---:|
| Video generation | 42 |
| Image generation | 39 |
| Utility | 25 |
| Audio generation | 20 |
| Transform | 15 |
| 3D generation | 10 |
| Analyzer | 8 |
| Text generation | 4 |
| Universal | 4 |
| Cinematic | 3 |
| Character | 1 |
| Moodboard | 1 |

All 172 definitions currently have an execution destination: 154 resolve through the handler registry and 18 use the engine's built-in local execution paths. The node-contract check also confirms backend/frontend ID parity, generated-reference parity, declared ports and params, environment-key declarations, and local utility coverage.

## How to operate Nebula Nodes

### Start the app

From two terminals:

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`. The frontend discovers a backend on localhost ports 8000 through 8010 unless a Vite override is configured.

### Configure providers

The working application path reads provider keys from the project-root `settings.json`, normally written through the Settings panel. `GET /api/settings` masks stored values; `PUT /api/settings` preserves masked round trips.

Important: several provider guides currently tell the user to put keys in `.env`, but ordinary `uvicorn main:app` startup does not load `.env` and graph execution passes `settings.json` keys to handlers. Treat the Settings panel or `settings.json` as the current reliable setup path. The `.env` guidance needs a documentation correction unless startup is intentionally changed to load it.

### Build manually on Canvas

1. Add source/input nodes.
2. Add model, transform, analyzer, or utility nodes.
3. Connect compatible typed handles.
4. Set node parameters in the Inspector.
5. Run the entire graph or run a target node and its ancestors.
6. Watch lifecycle/progress/output events update the graph.
7. Save a `.nebula.zip` graph bundle when the graph must travel with referenced assets.

The engine validates required inputs and keys, rejects invalid handles and cycles, topologically sorts the graph, runs independent branches concurrently (up to four), and reuses cached unchanged subgraphs for one hour.

### Use Create

Create is the quickest prompt-first path: choose a model, enter a prompt, optionally add reference images, parameters, a preset, and a quantity from one to four, then generate. Results can be viewed by current session or canvas provenance and can be opened on Canvas, used as a new input, downloaded/exported, revealed in Finder, or deleted.

Create does not bypass the graph. It creates and persists graph nodes so later Canvas work and provenance remain available.

### Use assets and studios

- Create Characters from at least three reference views, a frozen trait string, seed, and consistency strength. Character records can be global or project-scoped.
- Create Moodboards from weighted images, notes, a mode, and strength. The local analyzer derives a reusable direction brief.
- Create Presets for reusable prompt fragments, params, model choice, references, and thumbnails.
- Open Cinema, Character, and Moodboard studios from their matching nodes/assets.
- Open Video Editor only from a completed video source with usable metadata.
- Open Remotion Editor from a Remotion composition node and use asynchronous render jobs for exports.

### Use the CLI or an agent

The Python CLI exposes:

```text
context, nodes, info, keys, create, connect, set, graph, save, load,
clear, path, run, run-all, status, quick
```

It talks to the same FastAPI graph, so CLI and Canvas edits converge. The optional chat panel can drive the graph through Daedalus/Hermes, Claude, or Codex. Canvas and all studios remain usable when chat is offline.

## Verification results

### User-flow proof ledger

| Surface | Strongest current proof | Remaining ceiling |
|---|---|---|
| Canvas | Live launch, node catalog, settings, panels, toolbar state, Canvas/Create navigation, and chat shell were rendered and inspected. Store/connection/layout tests pass; graph CRUD, validated import/cluster ingress, full/target REST execution, cancellation, WebSocket lifecycle, persistence, and all built-in nodes ran through isolated backend state. | The browser automation layer could not carry Nebula's custom HTML drag payload, so pointer node-drop/connect, Inspector editing, keyboard shortcuts, and visual reload remain for an unrestricted manual browser pass. |
| Create | A real browser Create session rendered the prompt composer, reference attach, presets, quantity, full model picker, Nano Banana controls, and corrected Veo controls. Provider-route selection, model/params/preset/reference/upload/gallery libraries, and cluster authoring are test-covered. | No paid generation was submitted. Direct-route rendering is unit-covered but was not live-rendered because this sandbox could not load configured settings without a backend listener. |
| Cinema Studio | Cinema Color and Cinema Look produced real transformed images; Camera Rig and typed Character/Reference inputs produced expected bundles. | `cinema-scene` ultimately calls a paid base image model; shot generation, variations, promotion, and live visual editing were not submitted. |
| Character Studio | Isolated create/get/list/update/version/delete plus the Character node handler passed. | Browser reference-view editing and a paid downstream identity generation remain unverified. |
| Moodboard Studio | Isolated CRUD, real served-image analysis, four-color palette extraction, and Moodboard/Krea resource handlers passed. | Browser weighting/exclusion/reorder UX and provider consumption remain unverified. |
| Video Editor | Real preview, handler render, async final export, serving, progress completion, and real cancellation/partial-file cleanup passed. Frontend timing/playback math tests pass. | Pointer timeline editing and virtual-vs-rendered visual comparison need browser QA. |
| Remotion Editor | Manifest/state/keyframe/spatial/rendering UI tests pass and a real render attempt reached bundling/progress. | Remotion could not allocate a required local port in this sandbox, so no actual composition MP4 was produced. |
| Settings | All 15 catalog credentials match Settings fields and health coverage; masked read/merge behavior is backend-tested, with Higgsfield truthfully configuration-only. | Panel interaction and output-path restart behavior still need live browser/restart QA. |
| Chat/agents | Claude/Codex status endpoints work; Codex reports ChatGPT auth, Claude reports logged out, and Nous credentials are discoverable without exposing tokens. Shared chat normalization/cancellation is test-covered. | No account-consuming agent turn or graph mutation was submitted. |
| Save/load toolbar | Backend ZIP restore preserved bytes and blocked traversal; restart persistence and atomic graph import behavior were exercised. Invalid ingress preserves the live graph. | The browser used the native File System Access picker, which this automation surface could not populate; download packaging remains browser-gated. |

### Confirmed working

| Area | Evidence |
|---|---|
| Frontend unit/component baseline | 56 files, 447 tests passed. |
| Frontend production build | TypeScript and Vite production build completed. |
| Frontend lint guards | Inline-style and Slava-scope guards passed; ESLint completed with no errors or warnings. |
| Node contracts | Passed for all 172 definitions. |
| Registry reachability | 154 registered handler destinations + 18 built-in local destinations; zero missing definitions. |
| Backend full suite | The repaired project venv passes 1,544/1,544 live-workspace tests with no warnings. A clean candidate excluding four ignored Finder duplicate files passes 1,526/1,526 tests. |
| Core API health and catalog | `/api/health` returned 200; `/api/nodes` returned 172 nodes and 12 categories. |
| Graph CRUD | Created, updated, exported, deleted, and cleared nodes in an isolated state root. |
| Typed connection validation | Valid handles connected; a bogus source handle was rejected with HTTP 400. |
| Local graph execution | Two Text Input nodes feeding Combine Text executed three nodes and produced `hello nebula`. |
| REST-to-WebSocket execution lifecycle | A three-node `Alpha + Beta` graph started through `/api/execute` while `/ws` emitted queued, executing, executed, and graphComplete events. Every event retained `runId=ws-full`. `/api/execute-node` repeated the target-plus-ancestors path with three nodes and `runId=ws-target`. |
| Character asset CRUD | Create, project list, update/version bump, delete, and post-delete 404 passed in an isolated root. |
| Moodboard asset CRUD and local analysis | Create, analyze, update/version bump, project list, and delete passed in an isolated root. |
| Preset CRUD | Create, list, update/version bump, and delete passed in an isolated root. |
| Image upload | A real 1x1 PNG passed magic-byte validation, was content-addressed, created an `image-input` node when requested, and resolved to a readable local path. |
| Video and document upload routing | A real 127.338-second MP4 created a `video-input` node with duration/FPS/VFR metadata; the README created a `document-input` node. Both assets were served, while unsupported bytes returned HTTP 415. |
| Frontend catalog render | The isolated frontend rendered the Canvas shell and full node library in the in-app browser. |
| CLI entry point | CLI help loaded and exposed all documented graph, discovery, key, execution, and quick commands. |
| All built-in execution paths | One 22-node graph exercised all 18 engine-local definitions: text/image/document/video/audio inputs, sticky note, frame extraction, array build/select, image compare, SVG rasterize, mask paint, image/text iterators, preview, combine, router, and reroute. It completed without node errors and produced real PNG, document, audio, and video results. |
| Local registered handlers | Cinema Color, Cinema Look, Camera Rig, Reference Set, all three Krea reference-resource nodes, Character, Moodboard, Video Duration Check, Video Edit, and all four Video QC handlers completed with typed or real-media outputs. Color/look produced real PNGs; Video Edit produced a real MP4. |
| Upload deduplication and serving | Uploading the same real PNG twice returned the same content-addressed URL; the served bytes remained readable. |
| Moodboard analysis with a served asset | A moodboard referencing the uploaded `/api/outputs/...` URL analyzed successfully with four palette colors, an `analyzed` image status, and no warnings. |
| Image transcode | A real PNG transcoded to WebP and returned a downloadable `image/webp` response. |
| Output export | Two exports with the same requested filename succeeded, preserved bytes, and used `name.png` then `name -1.png` without clobbering. |
| Bundle asset restore | A real ZIP restored an embedded PNG, returned a rewritten served URL, preserved the bytes, and omitted a `../` traversal entry. |
| Recoverable output archive | An explicitly backdated timestamp directory moved under `.archive`; its content remained intact while `chat-uploads` stayed in place. |
| Video-editor preview | A real one-second, 640px ffmpeg preview rendered and was served through `/api/outputs`. |
| Asynchronous final video export | A real one-second 480p MP4 job progressed to `complete`, reported progress 1.0, and returned a served output URL. |
| Real render-job cancellation | A 120-second 1080p export was started and cancelled through the job API. Status became `cancelled`, no output URL was published, ffmpeg terminated, and its 48-byte partial file was removed within 0.5 seconds. |
| 3D preview conversion | A three-vertex OBJ converted to a valid `glTF`-magic GLB, returned `model/gltf-binary`, reused its `.preview.glb` cache on the second request, and rejected traversal with 404. |
| Restart persistence | Two nodes and one edge written through the API were restored by a fresh backend process from the isolated `state.json`. |
| Corrupt-state startup recovery | A deliberately malformed isolated `state.json` produced a diagnostic, then the backend started healthy with an empty graph. |
| Settings/catalog credential parity | All 15 credential names referenced by node definitions are present in the Settings UI, with no catalog credential missing and no unused Settings credential. |
| Missing-key preflight | All 136 keyed nodes produced a missing-API-key validation error before handler/network execution when checked with an empty key set. |
| Run History placement and reset | The rendered panel opened fully on-screen with a 16px right margin; Reset retained that recovered geometry. Narrow-viewport, drag-clamp, resize-repair, and visibility-preserving reset behavior is regression-covered. |
| Nodes/Assets rail coordination | The rendered Assets panel opened while Nodes was absent and the launcher states agreed. Store tests pin mutual exclusion in both directions. |
| Provider-aware Create controls | Rendered Veo 3.1 exposed one Seed control and no duplicate-key console error. Pure tests pin FAL and direct route selection plus route-specific defaults. |
| Accessible node authoring | Node definitions render as focusable draggable buttons. Click activation created one Text Input node in the live Canvas; component tests pin keyboard-native activation semantics, centered placement, and double-click de-duplication. |
| Worktree integrity | `git diff --check` passed; pre-existing user changes were preserved. |

### Confirmed failures or actionable defects

No actionable repository defect remains from the targeted reliability, rendered-UI, credential, build, or canonical-skill batch. The remaining items below are proof ceilings or future coverage work rather than known regressions.

### Follow-up defects verified fixed

| Finding | Current proof |
|---|---|
| Provider setup documentation disagreed with runtime | The README, `settings.example.json`, all 15 non-OAuth provider guides, and all writable provider skills now use Settings → `settings.json`. `.env` loads only optional process/path overrides, and even the narrator now resolves OpenRouter through Settings or Hermes auth. Contract tests prove the 15 catalog keys exactly match both the Settings UI and settings example and do not fall back to process environment. |
| Provider health covered nine named providers | `/api/health/providers` now reports all 15 catalog credential families plus Nous OAuth. Safe authenticated reads are defined for 15 providers; Higgsfield truthfully reports `configured_unverified` because no non-billable probe was found. Statuses distinguish rejected, unauthorized, insufficient-credit, rate-limited, and network/provider errors. |
| Project-local venv lacked declared QC libraries | Exact OpenCV 4.13.0.92 and scikit-image 0.26.0 plus their missing dependencies were reconstructed from complete local Python 3.12 distribution metadata and installed into `backend/.venv` without a global-site-path shortcut. Both imports resolve inside the venv, `pip check` reports no broken requirements, and all 25 QC tests pass. |
| `ReferenceSetNode` hook dependency warning | The transient fallback object now lives inside the memo and the memo depends on stable node data. Full frontend lint reports no hook warning. |
| Production entry was about 3.53 MB / 912 KB gzip | Alternate studios are lazy-loaded and Remotion/timeline/React Three dependencies are split into deferred chunks. The initial entry is 472,049 bytes raw / 138,242 bytes gzip, enforced by `check-build-budget.mjs`; Vite emits no chunk-size warning. |
| `lottie-web` bundled direct `eval` | Browser and Remotion bundlers alias the SVG-only light player. The production gate scans every emitted JavaScript asset for `eval(` and `new Function(`; all 21 assets pass. Expression-authored Lottie files are intentionally unsupported. |

The remediation verification ceiling is explicit: frontend lint/build and all 447 tests pass. The repaired project-local venv passes all 1,544 live-workspace backend tests, including strict canonical-skill parity, with no warnings. A production preview listener was denied by the earlier managed sandbox (`listen EPERM`), so the new lazy chunks have build/test proof but not a new browser screenshot in that follow-up.

### Reliability defects verified fixed

| Original defect | Current proof |
|---|---|
| Same-second/split output directories | The engine binds one collision-proof run directory through a `ContextVar`; suffix/archive edge cases have regressions. |
| Complete/base64 params in manifests | Manifests omit private keys, redact credential-like fields, replace embedded binary/data payloads, and bound depth/collections/strings. |
| Cache hits for missing local files | Nebula-owned output URLs and paths beneath the configured output root are existence-gated and evicted when missing. |
| Invalid cluster/import handles | Ingress stages into a persistence-free candidate and validates definitions, params, references, handles, duplicates, and cycles before one swap. |
| Malformed import erases the graph | Import is atomic; invalid requests neither broadcast nor mutate the live graph, and the frontend waits for backend success before replacing Canvas state. |
| Canvas Stop is frontend-only | Frontend run IDs map to retained backend tasks; `DELETE /api/executions/{runId}` cancels and awaits work, emits `graphCancelled`, and suppresses late events. |
| Always-on, hard-coded zoom telemetry | Telemetry is explicit opt-in, backend-enforced, and writes unique archive-eligible sessions beneath configured `OUTPUT_ROOT`. |

### Environment-gated in this audit

| Check | Why it is gated | What was still proven |
|---|---|---|
| Full frontend-to-backend browser integration | This managed sandbox denied Python/uvicorn TCP binding. A temporary in-process ASGI bridge rendered the real frontend and backend for shell/panel/Create inspection, but the sandbox would not rebind the listener after restart. | Live UI screenshots exist for launch, Settings, Assets, History, Chat, and Create; backend behavior is independently covered through the full ASGI/test suite. |
| Utility-node browser smoke script | It requires both live Vite and FastAPI URLs plus headless Chrome. The backend bind restriction stopped it at reachability. | Its manifest coverage step passed before reachability failed; local utility execution is covered by backend tests and the direct text graph run. |
| Provider key validation | Outbound provider requests were denied with `ConnectError`. | The endpoint returned a safe structured 200 response and correctly distinguished configured from not-configured entries without exposing keys. Credential validity was not established. |
| Remotion render | The renderer attempted to bundle a valid empty composition but failed with `No available ports found`. This sandbox also denied local Python ports across 8000-8010. | Manifest validation and render progress dispatch ran; the actual Remotion bundle/render result is not classified as a product failure until repeated where localhost port allocation is permitted. |
| Agent chat turns | Claude Code is installed but its status endpoint reports logged out. Codex is installed and reports ChatGPT-account auth; a Nous/Hermes credential is locally present. | No Claude, Codex, or Daedalus chat turn was submitted: Claude cannot run logged out, while Codex/Daedalus would consume account usage and can mutate the graph. Status detection and the shared WebSocket/normalization/cancellation code are test-covered, not live-turn verified here. |

### Credential/cost-gated

No paid generation was submitted during this audit. Provider-backed image, video, audio, 3D, text, transform, and universal-node paths are structurally covered by the passing mocked/contract tests, but are not classified as live-working. A live matrix should use one deliberately chosen low-cost probe per provider family, record model, endpoint, cost, response shape, output validation, and artifact metadata, and avoid extrapolating one provider success to all 172 nodes.

The per-node evidence split is currently:

| Evidence state | Nodes |
|---|---:|
| Confirmed through engine-local execution | 18 |
| Confirmed through registered local handlers | 15 |
| Environment-gated Remotion render | 1 |
| Structurally covered but live-provider/unrestricted-workflow unverified | 138 |
| **Total** | **172** |

`cinema-scene` is included in the last group: its orchestration handler is registered and tested, but a real scene calls a provider-backed base image model and was not submitted without an explicit credit budget.

## Provider and credential coverage

The catalog exposes 16 named provider families plus the local `utility` family. FAL owns 77 definitions and is also an alternate credential on several Google, Meshy, and Ideogram definitions. Settings exposes exactly the 15 credential names referenced by the catalog.

| Provider family | Definitions | Credential | Health endpoint |
|---|---:|---|---|
| Anthropic | 1 | `ANTHROPIC_API_KEY` | Covered |
| ElevenLabs | 6 | `ELEVENLABS_API_KEY` | Covered |
| FAL | 77 | `FAL_KEY` (some alternate direct credentials) | Covered |
| Google | 9 | `GOOGLE_API_KEY` (one also accepts FAL) | Covered |
| Higgsfield | 1 | `HIGGSFIELD_API_KEY` | Configured-only (no safe probe) |
| Ideogram | 7 direct; also 7 FAL-routed definitions | `IDEOGRAM_API_KEY` | Covered |
| Krea | 3 | `KREA_API_TOKEN` | Covered |
| Meshy | 8 direct; also 2 FAL-routed definitions | `MESHY_API_KEY` | Covered |
| MiniMax | 3 | `MINIMAX_API_KEY` | Covered |
| Nous | 1 | Hermes OAuth, no Settings key | Covered |
| OpenAI | 8 | `OPENAI_API_KEY` | Covered |
| OpenRouter | 1 | `OPENROUTER_API_KEY` | Covered |
| Quiver | 2 | `QUIVER_API_KEY` | Covered |
| Replicate | 1 | `REPLICATE_API_TOKEN` | Covered |
| Runway | 8 | `RUNWAY_API_KEY` | Covered |
| xAI | 1 | `XAI_API_KEY` | Covered |

Health now reports all 15 Settings credentials plus Nous OAuth. Fourteen Settings credentials and Nous use authenticated, non-billable reads; Higgsfield reports `configured_unverified` because no safe validation read was identified.

The README, settings example, all provider API guides, and both `.claude/skills` and canonical `.agents/skills` sets consistently document Settings → `settings.json`. The normal FastAPI path loads `.env` only for process-level path/runtime overrides; provider handlers and the narrator do not use it as a credential fallback.

## Persistence and safety observations

- The user's existing `~/.nebula/state.json` contains 8 nodes and 5 edges. This audit did not mutate it.
- Character, moodboard, preset, graph, upload, and output checks used isolated `/private/tmp/nebula-audit.*` roots.
- `settings.json` was read only for masked/configured-state checks; no key was printed or rewritten.
- Graph bundles are ZIP-based and restore embedded assets through `/api/outputs/restore` before importing the graph. The backend restore half was exercised with real bytes and traversal input; the browser file-picker/save half remains browser-gated and has no focused unit test.
- Run history is frontend-local and is not the same thing as the durable backend graph.
- User API keys are plaintext on disk by design, masked only across the read API.

## Next verification waves

1. **Complete unrestricted browser interaction** — exercise pointer drag/drop, connect, Inspector edits, Run/Stop, history rerun, native save/load bundle, Clear, skins, and reload persistence against a normal Vite+FastAPI pair.
2. **Workspace flows** — execute Cinema, Character, Moodboard, Video Editor, and Remotion user journeys with visible artifacts and reload checks. Create's non-paid shell is now live-verified; paid result generation remains gated.
3. **Live provider matrix** — agree on a credit budget, choose the cheapest representative path per provider family, and record valid/invalid/gated status separately from mocked contract status.
4. **Agent paths** — verify Codex, Claude, Daedalus/Hermes, model selection, login status, streaming chat, graph actions, cancellation, and offline fallback.
5. **Cross-browser and recovery** — Chrome-family baseline, Safari drag behavior, interrupted execution recovery, stale run-history recovery, missing assets, moved output-root behavior, browser graph-bundle save/load, and render-job cancellation.

## Current audit conclusion

The shared architecture is coherent and the non-provider core is substantially exercised rather than inferred: every built-in execution path ran, fifteen registered local handlers—including all four Video QC nodes—produced typed or real-media results, persistence survived a process restart, corrupt state failed open safely, and upload/output/editor/archive/restore flows worked with real artifacts. The seven reliability defects from the first audit are fixed and protected by focused regressions.

The eleven confirmed defects handled by this continuous audit goal—seven reliability defects and four rendered-UI defects—are fixed and protected by focused regressions. The venv, provider-health, canonical documentation, React hook, bundle-size, and Lottie follow-ups are also fixed. No actionable repository defect remains from this batch. Remaining proof gaps are paid provider behavior, unrestricted pointer/file-picker interaction, agent integrations, full live studio journeys, and Remotion in an environment that permits its local render port.
