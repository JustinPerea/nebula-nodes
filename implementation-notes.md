# Implementation Notes

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
