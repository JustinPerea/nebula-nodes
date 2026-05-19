# QuiverAI Arrow Integration — PLAN

> **Status:** READY 2026-05-19. Drafted as the **Phase 4 candidate** for the catalog-hardening sprint (`docs/superpowers/plans/2026-05-16-node-input-api-contract-hardening.md`). Phase 4 was previously "UI quality pass" with unenumerated scope — this plan either replaces that scope or coexists as Phase 4a. See [Open: where this plan lives](#open-where-this-plan-actually-lives).
>
> Provider: **QuiverAI Arrow** — first model to break 1500 Elo on Design Arena (SVG track). Treats visuals as structured editable programs ("visual code generation"). API surface verified against canonical docs at https://docs.quiver.ai on 2026-05-19.
>
> Scope: **full API capability** — both POST endpoints, SSE streaming for both, dynamic model discovery via backend proxy, all three Arrow model variants, and forward-compat hooks for the `svg_edit` and `svg_animate` operations Quiver has surfaced in `supported_operations` but not yet shipped as endpoints.

## Goal

Make Nebula a first-class home for production-ready SVG generation AND raster-to-vector conversion. Add Arrow as the second SVG-producing provider alongside `recraft-v4-svg`, with two distinct nodes (creative generation + faithful vectorization), full streaming support, and dynamic model discovery so new Arrow variants surface in the UI without code changes.

Closes the "no native vector pipeline" gap and gives users a meaningful quality + workflow choice (Arrow's layered editable SVG vs Recraft's vector composition).

## Why this work

- **No new infrastructure required.** SVG data type, SVG port routing, `svg-rasterize` consumer, image-input preview pipeline (just landed 2026-05-19), and the proxy/dynamic-model pattern from OpenRouter Universal are all in place.
- **Quality bar is exceptional.** Arrow 1 holds #1 on SVG Arena at 1583 Elo — first model on any Design Arena leaderboard to break 1500. Output is layered, editable SVG markup, not traced raster.
- **Two distinct user workflows** map to two distinct API endpoints — splitting cleanly into two nodes is structurally correct, not over-engineered.
- **Portfolio surface.** "Generate an SVG from a prompt, or vectorize a raster, then route either through 5 different rasterize/animate/edit flows" is a sharper demo than another raster generator. Aligns with the Design Engineer thesis (`justinperea.com`).

## What it does (user-visible)

### `quiver-arrow-generate` (Text → SVG, with optional image references)

1. User drops a Quiver Arrow Generate node.
2. Connects Text → `prompt` (required), optionally Image+ → `references` (up to 16, URL or base64).
3. Picks `model` from dynamically loaded enum (`arrow-1`, `arrow-1.1`, `arrow-1.1-max` today).
4. Tweaks `n` (1–16 outputs), `instructions`, `temperature`, `top_p`, `presence_penalty`, `max_output_tokens`.
5. Executes. If `stream` is on (default), node shows progressive SVG preview during generation via the `draft` SSE events. Final `content` event replaces the draft.
6. Output port `svg` (typed SVG) emits the final SVG. File written to `OUTPUT_ROOT/<run>/<hash>.svg`, port carries `/api/outputs/<rel>.svg`.

### `quiver-arrow-vectorize` (Raster → SVG, faithful trace)

1. User drops a Quiver Arrow Vectorize node.
2. Connects Image → `image` (required, single).
3. Picks `model` from same dynamic enum.
4. Tweaks `auto_crop` (boolean), `target_size` (128–4096 square resize), `temperature`, `top_p`, `presence_penalty`, `max_output_tokens`.
5. Streams + emits SVG identically to the generate node.

Both nodes wire into the existing `svg-rasterize` consumer (and any future SVG-aware nodes — `svg-edit`, `svg-animate`) without rewiring.

## API contract (verified 2026-05-19)

Base URL: `https://api.quiver.ai`
Auth: `Authorization: Bearer ${QUIVER_API_KEY}` (header)
Rate limit: 20 req / 60s, applies across both POST endpoints (shared budget). Headers exposed: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
Error codes: 400 (bad params), 401 (auth), 402 (insufficient credits), 403 (account frozen), 404 (model not found), 429 (rate limit — honor `Retry-After`), 5xx (server).

### POST `/v1/svgs/generations`

Request:
```json
{
  "model": "arrow-1.1",
  "prompt": "minimalist line-art logo of a paper crane",
  "stream": true,
  "n": 1,
  "instructions": "thin uniform stroke, no fill",
  "temperature": 1.0,
  "top_p": 1.0,
  "presence_penalty": 0.0,
  "max_output_tokens": 16384,
  "references": ["https://...", "data:image/png;base64,..."]
}
```

Response (non-stream):
```json
{
  "id": "resp_...",
  "created": 1704067200,
  "credits": 1,
  "data": [{ "mime_type": "image/svg+xml", "svg": "<svg...>" }],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

### POST `/v1/svgs/vectorizations`

Request:
```json
{
  "model": "arrow-1.1",
  "image": { "url": "https://example.com/logo.png" },
  "stream": true,
  "auto_crop": false,
  "target_size": 1024,
  "temperature": 1.0,
  "top_p": 1.0,
  "presence_penalty": 0.0,
  "max_output_tokens": 16384
}
```

Image input is `{url}` OR `{base64}` (max 16,777,216 chars). No multipart upload — must be JSON.

Response shape identical to generations.

### SSE event stream (both endpoints)

```
event: generating
data: {"type":"generating","id":"...","index":0}

event: reasoning
data: {"type":"reasoning","id":"...","text":"...","index":0}

event: draft
data: {"type":"draft","id":"...","svg":"<svg>...partial...</svg>","index":0}

event: content
data: {"type":"content","id":"...","svg":"<svg>...complete...</svg>","credits":1,"index":0}

data: [DONE]
```

Common fields: `type` (discriminator), `id` (stable across events for one output), `svg` (partial in draft, complete in content), `credits` (only on `content`), `index` (zero-based for n>1).

### GET `/v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "arrow-1.1",
      "object": "model",
      "name": "...",
      "description": "...",
      "created": 1704067200,
      "owned_by": "quiver",
      "context_length": 131072,
      "max_output_length": 131072,
      "input_modalities": ["text", "image", "svg"],
      "output_modalities": ["text", "image", "svg"],
      "supported_operations": ["svg_generate", "svg_edit", "svg_animate", "svg_vectorize"],
      "supported_sampling_parameters": ["temperature", "top_p", "top_k", "repetition_penalty", "presence_penalty", "stop"],
      "pricing_credits": { "svg_generate": 20, "svg_vectorize": 15 }
    }
  ]
}
```

Models today (with credit costs):
- `arrow-1` — 30 generate / 30 vectorize (legacy)
- `arrow-1.1` — 20 generate / 15 vectorize (default)
- `arrow-1.1-max` — 25 generate / 20 vectorize (high-quality)

Operations `svg_edit` and `svg_animate` are advertised but **no endpoints exist for them yet** (verified 2026-05-19). Forward-compat: when those endpoints ship, we add `quiver-arrow-edit` and `quiver-arrow-animate` nodes — same client/proxy infra, no provider-level refactor.

## Where it sits in the codebase

| Surface | File | Change |
|---|---|---|
| Provider type | `frontend/src/types/index.ts` | Add `'quiver'` to `APIProvider` union; add `streamingSvg?: { draft: string \| null }` to `NodeData` |
| Env key | `.env.example` | Add `QUIVER_API_KEY=` placeholder + comment |
| Settings UI | `frontend/src/components/panels/Settings.tsx` | Add `{ key: 'QUIVER_API_KEY', label: 'QuiverAI', placeholder: 'qvr-...', url: 'https://app.quiver.ai/settings/api' }` |
| Provider client | `backend/services/quiver_client.py` | NEW — `QuiverClient` class: auth, base URL, retry on 429 with `Retry-After`, SSE parser, exposes rate-limit headers |
| Handler | `backend/handlers/quiver.py` | NEW — `handle_quiver_arrow_generate` + `handle_quiver_arrow_vectorize` (~250 lines combined) |
| Proxy route | `backend/routes/quiver_proxy.py` | NEW — `GET /api/providers/quiver/models` (mirrors `routes/openrouter_proxy.py` pattern) |
| Route registration | `backend/main.py` | Add `app.include_router(quiver_router)` next to existing proxy routers |
| Node defs (FE) | `frontend/src/constants/nodeDefinitions.ts` | Add `quiver-arrow-generate` + `quiver-arrow-vectorize` |
| Node defs (BE) | `backend/data/node_definitions.json` | Mirror both FE defs |
| Handler registry | `backend/execution/sync_runner.py` | Register both nodes |
| Dynamic-models fetch | `frontend/src/lib/api.ts` | Add `fetchQuiverModels()` matching `fetchOpenRouterModels` shape |
| Frontend node fetch | `frontend/src/store/graphStore.ts` | On Quiver node drop, fetch models, populate enum (mirror Replicate schema fetch precedent) |
| Streaming render | `frontend/src/components/nodes/ModelNode.tsx` | Render `streamingSvg.draft` as `<img src={data URI of inline SVG}>` while node is executing |
| Tests | `backend/tests/test_quiver_client.py` | NEW — SSE parsing, rate-limit-header surfacing, retry-on-429 with `Retry-After`, 402-credits-bubble |
| Tests | `backend/tests/test_quiver_handler.py` | NEW — body-shape for both endpoints, references-array shape, image-object-discriminator shape, streaming event handling |
| Audit notes | `docs/model-providers/quiver/_provider.md` | NEW — org-level facts (auth, rate limit, errors, base URL) |
| Audit notes | `docs/model-providers/quiver/arrow-generate.md` | NEW — endpoint-specific. `verified: 2026-05-19`, `stale_after_days: 14` |
| Audit notes | `docs/model-providers/quiver/arrow-vectorize.md` | NEW — endpoint-specific. Same frontmatter |
| MODEL_REFERENCE | (generated) | Auto-picked up by `scripts/generate-model-reference.mjs` |

Frontend rendering is automatic via `ModelNode.tsx`. Streaming SVG preview is the only new render path; everything else uses existing component machinery.

## Decisions (locked)

These were ambiguous in the v1 draft (2026-05-19 morning); the full API research locked them by mid-day.

### D1. One node or two?

**LOCKED: Two — `quiver-arrow-generate` + `quiver-arrow-vectorize`.**

Different endpoints, different request shapes (references array vs image object discriminator), different params (auto_crop/target_size on vectorize only; references/instructions on generate only), different mental models for users. Conflating them would force one node's params to diverge across operations. The v1 draft's recommendation of a single node was based on a wrong assumption that both ops shared `/v1/svgs/generations`. Reversed.

### D2. Streaming?

**LOCKED: Yes, for both endpoints.**

User asked for full API capability. Both POST endpoints support SSE. We already have streaming infra (`streamingPartials` for image partials, `streamingText` for text). SVG streaming is a new variant — partial SVG markup rendered progressively as an inline-SVG data URI during the `draft` events, replaced by the `content` event's final SVG.

New `NodeData.streamingSvg` field carries the latest draft. Cleaner than overloading `streamingPartials` because the data shape (raw SVG markup vs base64 PNG) is meaningfully different.

### D3. Model variant exposure: static or dynamic?

**LOCKED: Dynamic via backend proxy, with hardcoded fallback.**

Matches the OpenRouter / Replicate / FAL universal precedent. Backend proxy at `GET /api/providers/quiver/models` returns the `/v1/models` payload. Frontend fetches on node drop, populates the enum, caches in store for the session. If proxy errors (offline, no key), dropdown falls back to hardcoded `arrow-1` / `arrow-1.1` / `arrow-1.1-max`. So node still works without an active connection to Quiver's model registry.

### D4. Replace or coexist with current Phase 4?

**RECOMMENDED: Replace.**

Master plan's existing Phase 4 ("UI quality pass") has 4 bullets (param grouping, missing-key states, SVG affordances, cost hints). This integration exercises three of them in the process — SVG affordances land for free, missing-key states are exercised by `QUIVER_API_KEY`, cost hints can surface via the `credits` field in responses. Param grouping is the only orphaned bullet; carry it as a parallel small task or drop it to a polish phase.

Pending user sign-off — see [Open: where this plan lives](#open-where-this-plan-actually-lives).

### D5. Forward-compat for `svg_edit` and `svg_animate`?

**LOCKED: Scaffold for it, don't ship.**

`supported_operations` in `/v1/models` surfaces those two operations but they have no endpoints today. The client module's request method takes an `operation` argument (`"svg_generate" | "svg_vectorize"`) — easy to add `"svg_edit"` and `"svg_animate"` later. When the endpoints ship, we add `quiver-arrow-edit` + `quiver-arrow-animate` nodes; the client, proxy, and audit-note structure are already in place. No provider-level refactor.

## Step-by-step tasks

Atomic-commit cadence. Step numbers indicate task ordering, not days.

### Provider infrastructure

1. **Add `'quiver'` to `APIProvider` union + `QUIVER_API_KEY` to `.env.example` and Settings.** Frontend should display the unconfigured-key warning chip for any Quiver node.
2. **Build `backend/services/quiver_client.py`.** `QuiverClient(api_key, base_url)` class with:
   - `async def generate(*, model, prompt, references=None, stream=True, ...) -> AsyncIterator[QuiverEvent]`
   - `async def vectorize(*, model, image_url=None, image_base64=None, stream=True, ...) -> AsyncIterator[QuiverEvent]`
   - `async def list_models() -> list[QuiverModel]`
   - SSE parser that decodes the 4 event types into `QuiverEvent` dataclasses with `.type`, `.svg`, `.credits`, `.index`, `.id`.
   - Surfaces `X-RateLimit-*` headers in response metadata.
   - Retry on 429 honoring `Retry-After` (single retry, then bubble).
   - 402 bubbles as `QuiverInsufficientCreditsError`.
3. **Build `backend/routes/quiver_proxy.py`.** Single `GET /api/providers/quiver/models` endpoint, deduplicates and returns `/v1/models` payload. Reads `QUIVER_API_KEY` from settings.

### Handlers

4. **Build `backend/handlers/quiver.py` — generate.** `handle_quiver_arrow_generate(node, inputs, api_keys, emit)`:
   - Pulls `prompt` from inputs, `references` (array, optional) from inputs.
   - Calls `client.generate(...)` with `stream=True`.
   - For each event: emit `StreamPartialSvgEvent` on `draft`, write final SVG bytes to disk on `content`, return `{"svg": {"type": "SVG", "value": str(out_path)}}`.
   - Out path: `get_run_dir() / f"{uuid4().hex[:12]}.svg"`. Engine's `_normalize_outputs_for_storage` converts to `/api/outputs/<rel>.svg`.
5. **Add `handle_quiver_arrow_vectorize` to the same file.** Same shape but reads `image` input and routes URL vs base64 through the client.
6. **Add a new `StreamPartialSvgEvent` to `models/events.py`.** Shape: `{type: "streamPartialSvg", nodeId, partialIndex, svg: str}`. Mirrors `StreamPartialImageEvent`.
7. **Register both handlers in `backend/execution/sync_runner.py`.**

### Node definitions

8. **Add `quiver-arrow-generate` to `nodeDefinitions.ts` + `node_definitions.json`.**
   - Category `image-gen`, executionPattern `stream` (since we always stream).
   - Inputs: `prompt: Text` (required), `references: Image+` (optional, multiple, max 16).
   - Output: `svg: SVG`.
   - Params: `model` (enum, populated dynamically), `n` (integer 1–16, default 1), `instructions` (textarea), `temperature` (float 0–2, default 1), `top_p` (float 0–1, default 1), `presence_penalty` (float -2–2, default 0), `max_output_tokens` (integer 1–131072, default 16384), `stream` (boolean, default true — hide from UI unless debugging).
9. **Add `quiver-arrow-vectorize` to the same files.**
   - Category `image-gen`, executionPattern `stream`.
   - Inputs: `image: Image` (required, single).
   - Output: `svg: SVG`.
   - Params: `model` (enum dynamic), `auto_crop` (boolean, default false), `target_size` (integer 128–4096), `temperature`, `top_p`, `presence_penalty`, `max_output_tokens`, `stream`.

### Frontend dynamic models + streaming preview

10. **Add `fetchQuiverModels()` to `frontend/src/lib/api.ts`.** Hits `/api/providers/quiver/models`. Returns `{ id, name, pricing_credits, supported_operations }[]`.
11. **Wire dynamic enum population in `graphStore.ts`.** On Quiver node drop, fetch models, filter by `supported_operations` (`svg_generate` for generate node, `svg_vectorize` for vectorize node), populate the `model` enum's options. Cache in session; fall back to hardcoded `arrow-1` / `arrow-1.1` / `arrow-1.1-max` on error.
12. **Extend `NodeData.streamingSvg` and `handleExecutionEvent` in `graphStore.ts`.** Handle the new `streamPartialSvg` event — store the latest draft SVG markup on `NodeData.streamingSvg.draft`.
13. **Render the streaming SVG preview in `ModelNode.tsx`.** While `state === 'executing'` and `streamingSvg.draft` is set, render `<img src={data URI of streamingSvg.draft}>` as the preview surface. Replace with the final `outputs.svg.value` once `state === 'complete'`.

### Tests

14. **`backend/tests/test_quiver_client.py`** — SSE parsing (decode `generating`/`reasoning`/`draft`/`content` events; handle `[DONE]`), 429 retry honoring `Retry-After`, 402 bubbling, rate-limit-header surfacing.
15. **`backend/tests/test_quiver_handler.py`** — body shape for both endpoints (prompt + references for generate, image object discriminator for vectorize), missing-API-key path, malformed-response path. ~6–8 tests.
16. **`backend/tests/test_quiver_proxy.py`** — `/api/providers/quiver/models` returns the expected shape; gracefully degrades if `QUIVER_API_KEY` not set.

### Documentation

17. **Audit notes.** `docs/model-providers/quiver/_provider.md` (org-level: auth, rate limit, error codes, base URL), `arrow-generate.md`, `arrow-vectorize.md`. All with `verified: 2026-05-19`, `stale_after_days: 14` (Arrow API still in "public beta" per docs.quiver.ai branding).
18. **Regenerate `MODEL_REFERENCE.md`** via `node scripts/generate-model-reference.mjs`.

### Live verification (the Phase 2 lesson)

19. **Live smoke test (manual).** With a real `QUIVER_API_KEY`:
    - Generate node: connect Text "a green triangle, minimal" → execute → verify SSE drafts arrive, final SVG renders, file written under OUTPUT_ROOT.
    - Vectorize node: connect an Image (e.g., a small PNG logo) → execute → verify the vectorized SVG renders.
    - Wire generate → svg-rasterize → confirm raster roundtrip works.
    - Burn rate test: trigger 25 generates in 60s, verify the 21st returns 429 with `Retry-After`, client retries once.
20. **Commit + push** atomically. Each step above is a commit candidate; consolidate into ~5 commits per branch-per-concern: `feat(quiver): client + proxy`, `feat(quiver): handlers`, `feat(quiver): node defs`, `feat(quiver): streaming preview`, `docs(quiver): audit notes`.

## Verification

```bash
# Backend tests
cd backend
./.venv/bin/python -m pytest tests/test_node_contracts.py tests/test_quiver_client.py tests/test_quiver_handler.py tests/test_quiver_proxy.py

# Frontend / docs drift check
node scripts/check-node-contracts.mjs

# MODEL_REFERENCE drift check (CI runs this)
node scripts/check-node-contracts.mjs --check-model-reference

# Live smoke (manual, after setting QUIVER_API_KEY)
curl -X POST http://localhost:8000/api/execute-node \
  -H 'content-type: application/json' \
  -d '{"node": {"id":"n1","definitionId":"quiver-arrow-generate","params":{"model":"arrow-1.1","prompt":"a green triangle","stream":false}}}'
```

Acceptance criteria:
- Both Quiver nodes appear in Nodes library under `image-gen` category.
- Dropping either shows the unconfigured-key warning chip until `QUIVER_API_KEY` is set.
- Model dropdown populates from `/api/providers/quiver/models` (3 models today); falls back to hardcoded set if proxy errors.
- Executing generate with a text prompt streams progressive SVG previews, then resolves to a final SVG file under `OUTPUT_ROOT/<run>/`.
- Executing vectorize with an image input traces and emits SVG identically.
- `svg-rasterize` downstream works for both.
- 429 → `Retry-After` → single retry → success or surfaced error.
- 402 → user sees "Insufficient Quiver credits" error in the node, not a generic 500.
- All structural tests pass; `node scripts/check-node-contracts.mjs` passes.
- Both audit notes exist with `verified: 2026-05-19` frontmatter; `MODEL_REFERENCE.md` includes both nodes.
- Live smoke roundtrip works end-to-end on both endpoints.

## Risks and open threads

- **Shared 20/min rate limit across both endpoints.** A graph fanning out to many parallel Quiver calls will throttle. Client retry handles it gracefully; users should know via a "Rate limit hit, retrying" emit during executing state. Out of scope to add UI for this in v1; if it becomes painful, add a "Quiver rate limit indicator" in the canvas toolbar later.
- **Credits cost is real money.** Free tier is 20 SVGs/week (any combination of generate + vectorize). Burn through 25 generates fast. Surface `credits` in response → eventual UI cost-hint. Audit notes should warn about pricing tiers.
- **Streaming reconnect not handled.** If SSE drops mid-stream, current plan is to error the node and let the user re-run. Reconnect-with-resume is a v2 polish.
- **`max` model variant cost premium.** `arrow-1.1-max` is 25% more expensive on generate. Dropdown should make this visible (e.g., "Arrow 1.1 max (25 credits)" in the option label) — easy via the dynamic enum's `pricing_credits` field.
- **Public beta API risk.** Arrow API is still in `public beta` per docs.quiver.ai branding. `stale_after_days: 14` ensures we re-verify regularly. If response shape changes, structural tests catch it.
- **SVG sanitization not in v1.** Arrow returns SVG markup we write to disk and serve via `/api/outputs/`. Rendering happens in `<img>` tags only (no script execution path). If we ever inline-render SVGs as raw DOM (the unsafe React HTML-injection prop), we need DOMPurify first. Out of scope unless inline DOM rendering becomes a requirement.
- **The two unused operations.** `svg_edit` and `svg_animate` surface in `supported_operations` but have no endpoints. Client is structured so adding them later is a single new method + new handler. Plan files for these operations are out of scope; revisit when Quiver ships.

## Open: where this plan actually lives

Three legitimate homes — pick one:

- **(i) Insert as the active Phase 4 of the master plan.** Modify `docs/superpowers/plans/2026-05-16-node-input-api-contract-hardening.md` to replace the "UI quality pass" bullets with this plan's tasks. Master plan stays the single source of truth.
- **(ii) Adjacent plan referenced from the master.** Keep this file in `.planning/backlog/`, link from the master plan's Phase 4 section. Master plan's Phase 4 becomes a pointer. **(Recommended — smallest blast radius.)**
- **(iii) Promote to a new top-level plan in `docs/superpowers/plans/`.** Treats this as a self-contained sprint rather than a phase of catalog-hardening. Justified if Quiver integration is the most important thing for the next two weeks.

If we ship this AND want to surface it as a portfolio moment on `justinperea.com`, (iii) is the cleanest — gives the plan a stable URL and treats it as its own milestone with its own Begin/End markers.
