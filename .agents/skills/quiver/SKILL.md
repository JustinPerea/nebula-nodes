---
name: quiver
description: QuiverAI (Arrow) SVG API — text-to-SVG generation (icons, logos, flat illustrations) and raster-to-SVG vectorization, with reference-image guidance (up to 16), multi-output, sampling controls, and live SSE streaming of draft SVGs. Activate when the user configures a `quiver-arrow-generate` or `quiver-arrow-vectorize` node, or asks about QuiverAI / Arrow / "vectorize" / "text to SVG" / "generate an SVG logo" in Nebula. Sourced 2026-06-04 from the official QuiverAI API docs (docs.quiver.ai) and the Nebula audit guide docs/api-guides/quiver.md, cross-checked against backend/data/node_definitions.json, backend/handlers/quiver.py, and backend/services/quiver_client.py.
---

# QuiverAI (Arrow) Skill

QuiverAI's **Arrow** models turn a text prompt — or any raster image — into clean, editable **SVG vector markup**. Two Nebula nodes wrap the two user-facing endpoints. Both **stream** their output: draft SVGs render progressively on the canvas, and the final SVG is written to disk and served back as a downloadable file.

## When to use

- User wants a brand-new **icon, logo, mark, or flat illustration as SVG** from a text description → `quiver-arrow-generate`.
- User wants to **convert an existing raster image (PNG/JPG logo, screenshot, flat art) into editable SVG** → `quiver-arrow-vectorize`.
- User wants **style-guided / on-brand variations** steered by reference images (up to 16) and/or free-form instructions, possibly several candidates at once.
- User configures any `quiver-arrow-*` node, or asks which Arrow model to pick, the per-model reference cap, credit costs, or why an SVG render is streaming in live.
- User mentions "vectorize", "trace this to SVG", "make this scalable", or "resolution-independent vector".

Do **not** reach here for raster image generation (use `gpt-image-2`, `gemini`, `runway`, `fal`, `meshy`) — Arrow only emits SVG.

## Universal rules

1. **Auth + Settings.** `Authorization: Bearer <QUIVER_API_KEY>` plus `Content-Type: application/json`. Enter the key in Nebula **Settings → Quiver** and save; it is persisted under `apiKeys.QUIVER_API_KEY` in project-root `settings.json` and takes effect without a restart. Missing key → the handler fails fast with **`QUIVER_API_KEY is required`**.
2. **Base URL.** `https://api.quiver.ai` (set in `quiver_client.py` as `DEFAULT_BASE_URL`). Generate hits `POST /v1/svgs/generations`; vectorize hits `POST /v1/svgs/vectorizations`.
3. **Execution pattern = stream (always).** Both node defs are `executionPattern: "stream"`, and both handlers call the `*_stream` client methods with `stream=True` — **there is no sync/poll path used in Nebula** (the client *has* non-streaming `generate()`/`vectorize()`, but the handlers never call them). The SSE stream emits four event types: `generating` → `reasoning` → `draft` (one or more partial SVGs) → `content` (the final SVG). Terminator is `data: [DONE]`. The handler surfaces each `draft` as a `StreamPartialSvgEvent` (rendered live) and treats the **`content`** event's SVG as the final result. If the stream ends with no `content` event, the node errors: **`Quiver stream ended without a final content event`**.
4. **Status / error codes** (mapped to typed exceptions in `quiver_client.py`, then to user-facing `ValueError` strings the UI shows):
   - `401` / `403` → `QuiverAuthError` → **"QuiverAI auth failed — check QUIVER_API_KEY"**
   - `402` → `QuiverInsufficientCreditsError` → **"Insufficient QuiverAI credits — top up or upgrade plan"**
   - `429` → `QuiverRateLimitError` → **"QuiverAI rate limit exceeded — retry in a moment"** (the client auto-retries **once** honoring `Retry-After`, then bubbles)
   - `5xx` → `QuiverServerError` → **"QuiverAI server error: …"**
   - any other non-2xx → **"QuiverAI request failed: …"**
   - **Rate limit:** 20 requests / 60s, **shared across both POST endpoints**.
5. **Input-URI rules.** Both `references` (generate) and `image` (vectorize) accept four input forms, normalized by the handler:
   - external `http(s)://…` URL → passed straight through (Quiver fetches it),
   - `data:<mime>;base64,<b64>` data URI → prefix stripped, sent as base64,
   - Nebula-served `/api/outputs/<rel>` path → read from disk, sent as base64,
   - absolute local filesystem path under the output root → read, sent as base64.
   Anything else that can't be resolved raises **"Cannot resolve …"** and the node fails. For **references**, base64/data-URI items are wrapped as `{"base64": "<raw b64, no data: prefix>"}`; only an `http(s)` URL may be sent as a bare string (Quiver's schema requires this).
6. **Key gotchas.**
   - **Per-model reference cap is enforced by QuiverAI, not the node UI.** The `references` port allows up to **16** connections (the `arrow-1.1-max` ceiling), but `arrow-1` and `arrow-1.1` accept only **4** references at runtime — attaching more returns a server-side **400**. Match references to the chosen model.
   - **Output is true SVG markup**, not a raster preview. The final file is written to `OUTPUT_ROOT/<run>/<uuid>.svg` and rewritten to a `/api/outputs/<rel>.svg` URL on the `svg` output port.
   - **Vectorize input is single** (one `image`); **generate references are multiple**. Don't try to fan multiple images into vectorize.
   - **Photos vectorize badly.** Vectorize is built for clean logos / flat art; busy photographic input produces noisy, heavy paths.
   - **`svg_edit` is unshipped.** It appears in QuiverAI's `supported_operations` schema enum but no model advertises it and there is no `/v1/svgs/edits` endpoint. There is no Nebula edit node — do not promise SVG editing.

## Pick the right node

| Nebula node (id → display name) | Endpoint | Required input | Key params | Use it for |
|---|---|---|---|---|
| `quiver-arrow-generate` → **Quiver Arrow Generate** | `POST /v1/svgs/generations` (stream) | `prompt` (Text) | `model`, `n` (1–16), `instructions`, `temperature`, `top_p`, `presence_penalty`, `max_output_tokens`; optional `references` input (Image, up to 16) | Net-new icon / logo / mark / flat illustration as SVG from a written description, optionally steered by reference images. |
| `quiver-arrow-vectorize` → **Quiver Arrow Vectorize** | `POST /v1/svgs/vectorizations` (stream) | `image` (Image, single) | `model`, `auto_crop`, `target_size` (128–4096 px), `temperature`, `top_p`, `presence_penalty`, `max_output_tokens` | Converting an existing raster (logo, screenshot, flat art) into a clean, editable SVG trace. |

Both nodes are in the **Image Generation** palette category (`category: image-gen`); search "Quiver" or "Arrow". Both emit a single **`svg`** output port (data type `SVG`).

### Models (shared by both nodes)

The `model` enum is identical on both nodes; only the credit cost differs by operation. Defaults to **`arrow-1.1`**.

| Model value | Label / tier | Generate cost | Vectorize cost | Max references |
|---|---|---|---|---|
| `arrow-1.1` | Arrow 1.1 (default) | 20 credits | 15 credits | **4** |
| `arrow-1.1-max` | Arrow 1.1 max (higher quality) | 25 credits | 20 credits | **16** |
| `arrow-1` | Arrow 1 (legacy) | 30 credits | 30 credits | **4** |

Selection guidance:
- **Default to `arrow-1.1`** — cheapest, good quality, fine for ≤4 references.
- Switch to **`arrow-1.1-max`** when you need **more than 4 reference images** (it's the only model that allows up to 16) or want the higher-quality variant.
- **`arrow-1`** is legacy and the most expensive — only use it if a result specifically requires the older model's behavior.
- Credit cost is shown in the model dropdown label so the price is visible before picking.

## Param reference

Both nodes share four sampling params with identical ranges. All params are optional (the handler omits any left blank, so QuiverAI's own defaults apply for blanks; the listed defaults are the node-def defaults shown in the UI).

### `quiver-arrow-generate`

| Param | Type | Range / options | Default | Notes |
|---|---|---|---|---|
| `model` | enum | `arrow-1.1` · `arrow-1.1-max` · `arrow-1` | `arrow-1.1` | See model table. Governs the reference cap. |
| `n` | integer | 1–16 | 1 | Number of SVG candidates to generate in one run. |
| `instructions` | textarea | free text | — | Style/formatting guidance applied **separately** from `prompt` (e.g. "thin uniform stroke, no fill, transparent background"). Sent only when non-empty. |
| `temperature` | float | 0–2 (step 0.1) | 1 | Higher = more variation. |
| `top_p` | float | 0–1 (step 0.05) | 1 | Nucleus sampling. |
| `presence_penalty` | float | -2–2 (step 0.1) | 0 | |
| `max_output_tokens` | integer | 1–131072 | 16384 | SVG markup budget; raise for very detailed art. |

**Input ports:** `prompt` (Text, **required**); `references` (Image, optional, **multiple**, `maxConnections: 16`).

### `quiver-arrow-vectorize`

| Param | Type | Range / options | Default | Notes |
|---|---|---|---|---|
| `model` | enum | `arrow-1.1` · `arrow-1.1-max` · `arrow-1` | `arrow-1.1` | Vectorize credit costs differ (15 / 20 / 30). |
| `auto_crop` | boolean | true / false | false | Trim to the main subject before tracing. |
| `target_size` | integer | 128–4096 (px) | 1024 | Working resolution the raster is normalized to before tracing. |
| `temperature` | float | 0–2 (step 0.1) | 1 | |
| `top_p` | float | 0–1 (step 0.05) | 1 | |
| `presence_penalty` | float | -2–2 (step 0.1) | 0 | |
| `max_output_tokens` | integer | 1–131072 | 16384 | |

**Input ports:** `image` (Image, **required**, single).

### SVG prompt & instructions craft

Arrow responds to `prompt` (what to draw) and `instructions` (how to render it) as distinct fields. Lean on `instructions` for SVG-specific structure:
- **Stroke vs fill:** say it explicitly — "single continuous thin stroke, no fill" vs "solid filled shapes, no outline".
- **Stroke weight:** "uniform 2px stroke" keeps line widths consistent.
- **Background:** "transparent background" (default for icons) or name a fill color.
- **Complexity:** "minimal, geometric, few anchor points" yields cleaner editable paths than ornate descriptions.
- **Palette:** for multi-color flat art, list the colors or the mood ("two-tone, navy + warm orange").
- Keep `prompt` a concrete noun-phrase subject ("a minimalist origami crane", "a mountain-range logo") and push styling into `instructions`.

## Recipes

**Recipe 1 — Text → icon (the basic move).**
1. Drop `quiver-arrow-generate`.
2. Feed `prompt` a subject: *"a minimalist mountain-range logo, single continuous line."* (type into the port or wire a Text node).
3. In `instructions`: *"uniform 2px stroke, no fill, transparent background."*
4. Leave `model = arrow-1.1`, `n = 1`. Run. Watch the SVG draw in progressively; the finished vector lands on the `svg` output.

**Recipe 2 — Raster logo → clean SVG.**
1. Drop `quiver-arrow-vectorize`.
2. Wire its `image` input to a raster source — an upload, an external image URL, or an upstream image node's output (`/api/outputs/...`).
3. Enable `auto_crop` to trim to the subject; set `target_size` (e.g. 1024).
4. Run to get an editable SVG trace. Best on clean logos / flat art; skip busy photos.

**Recipe 3 — On-brand variations from references.**
1. Drop `quiver-arrow-generate` and set `model = arrow-1.1-max` (the only model that allows >4 refs).
2. Wire 2–4 existing brand marks into the `references` input (it accepts multiple connections).
3. Set `n = 4` for four candidates in one run, nudge `temperature` to ~1.2 for variety, and describe the new asset in `prompt`.
4. Pick the SVG you like best from the outputs.

**Recipe 4 — Generate, then re-trace (cleanup pass).**
1. `quiver-arrow-generate` → produce an SVG concept.
2. If you want a tighter/cleaner version, rasterize it downstream and feed that into `quiver-arrow-vectorize` with `auto_crop` on. (Note: chaining the `svg` port straight into vectorize's `image` works only if the SVG is served as a fetchable raster — vectorize expects a raster image, so route through an image node, not the raw SVG.)

## In the nebula_nodes context

- **Node ids:** `quiver-arrow-generate`, `quiver-arrow-vectorize` (defined in `backend/data/node_definitions.json`, both `apiProvider: "quiver"`, `category: "image-gen"`, `executionPattern: "stream"`, `envKeyName: "QUIVER_API_KEY"`).
- **Handlers:** `backend/handlers/quiver.py` — `handle_quiver_arrow_generate` and `handle_quiver_arrow_vectorize`. Both delegate to `backend/services/quiver_client.py` (`QuiverClient.generate_stream` / `vectorize_stream`) and share `_consume_quiver_stream` (emits drafts, returns the final `content` SVG) and `_write_svg_to_output`.
- **Registration:** `backend/execution/sync_runner.py` maps `registry["quiver-arrow-generate"]` and `registry["quiver-arrow-vectorize"]` to those handlers.
- **Model dropdown source:** `backend/routes/quiver_proxy.py` exposes `GET /api/quiver/models` (prefix `/api/quiver`), a cached proxy over QuiverAI's `GET /v1/models`, hit by the frontend on node drop to populate the model list. It is **not** a user-facing node.
- **Input ports:** `quiver-arrow-generate` → `prompt` (Text, required) + `references` (Image, multiple, ≤16); `quiver-arrow-vectorize` → `image` (Image, single, required).
- **Output port:** both → `svg` (data type `SVG`). The handler writes `OUTPUT_ROOT/<run>/<uuid>.svg` and the graph store rewrites the absolute path to `/api/outputs/<rel>.svg`.
- **Chaining rules:** the `svg` port carries an SVG file URL. It can feed any downstream input that accepts an SVG/image URL. To vectorize a generated SVG, route it through an image/raster step first — `quiver-arrow-vectorize` expects a **raster** `image`, not SVG markup.
- **How outputs render:** during execution, each `draft` event arrives as a `StreamPartialSvgEvent` over the WebSocket (`streamPartialSvg` in `frontend/src/lib/wsClient.ts`), is stored as `streamingSvg` in `graphStore.ts`, and `ModelNode.tsx` shows it live as a `data:image/svg+xml;utf8,…` `<img>` preview. On completion, the final `svg` output (served via `/api/outputs/...`) takes over as the rendered image, with a "Download SVG" affordance.

### Capability boundaries — what QuiverAI offers but Nebula does NOT expose

(So an agent never over-promises. From the audit gap table in `docs/api-guides/quiver.md`.)

- **Non-streaming responses** — the client implements `generate()` / `vectorize()` (sync) but **the handlers only ever stream**. There is no non-streaming code path in Nebula.
- **`GET /v1/models/{id}` (single-model detail)** — implemented as `QuiverClient.get_model` but **not surfaced anywhere** in the UI. No model-detail browser node.
- **`GET /v1/models` (list models)** — used **only internally** to populate the model dropdown via the `/api/quiver/models` proxy; not exposed as a user-facing model-list/browser node.
- **`svg_edit` operation** — present in QuiverAI's `supported_operations` schema enum but **unshipped**: no model advertises it, no `/v1/svgs/edits` endpoint exists, and there is **no Nebula edit node**. Any future `svg_animate` is likewise not live. Do not offer SVG editing/animation.
- **Per-model reference-cap pre-validation** — the node UI lets you attach up to 16 references regardless of model; the 4-ref cap for `arrow-1`/`arrow-1.1` is enforced server-side (400), not pre-checked in the node.

Coverage: both core SVG-creation endpoints (generate + vectorize) are fully wired in Nebula — including streaming, references, multi-output, and all sampling params — which is the entire user-facing surface of the API (~85% of the total surface; the rest is the read-only model-list/detail calls and the unshipped `svg_edit`).

## Sources

- https://docs.quiver.ai — landing / overview (capabilities: generate + vectorize SVG)
- https://docs.quiver.ai/api-reference/introduction.md — base URL, auth, endpoint list, rate limits, error codes
- https://docs.quiver.ai/api-reference/models/list-models.md — model fields and `supported_operations` enum (svg_generate, svg_edit, svg_vectorize)
- https://api.quiver.ai/v1/openapi.json — canonical machine-readable OpenAPI spec
- Nebula audit guide: `docs/api-guides/quiver.md`
- Ground truth: `backend/data/node_definitions.json`, `backend/handlers/quiver.py`, `backend/services/quiver_client.py`, `backend/routes/quiver_proxy.py`, `backend/execution/sync_runner.py`, `frontend/src/components/nodes/ModelNode.tsx`
