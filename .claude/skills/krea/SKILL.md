---
name: krea
description: Krea API in Nebula — generate images with Krea's own Krea 2 model steered by reference images, moodboards, and custom-trained LoRA styles, plus search and train Krea styles. Activate when the user configures any krea-2-generate, krea-style-search, or krea-style-train node, or asks about Krea in Nebula. Sourced from docs.krea.ai and cross-checked against backend/handlers/krea.py + backend/data/node_definitions.json on 2026-06-04; see the Nebula audit guide at docs/api-guides/krea.md.
---

# Krea Skill

## When to use

- User configures any `krea-2-generate`, `krea-style-search`, or `krea-style-train` node.
- User wants a **Krea 2** image (text-to-image), optionally steered by reference images, a moodboard, or a trained style.
- User wants to **train a custom LoRA style/object/character** on Krea and reuse its `style_id`.
- User wants to **search the Krea style library** to find a `style_id` to plug into a generation.
- User asks which Krea model/param to pick, about `KREA_API_TOKEN`, or about chaining styles into a generation.
- **Boundary check:** if the user asks for Krea *video*, *image editing / image-to-image*, *upscaling*, *Krea 2 Turbo*, or any third-party model behind Krea's gateway (Flux, Imagen, Ideogram, Nano Banana, etc.), this provider does **not** expose them — see Capability boundaries and route elsewhere.

## Universal rules

1. **Auth.** Single bearer token sent as `Authorization: Bearer <token>`. Env var is `KREA_API_TOKEN`. (The handler also accepts a legacy `KREA_API_KEY` fallback, but `KREA_API_TOKEN` is the documented name — use it.) Missing key raises `KREA_API_TOKEN is required`. Get the key from the Krea dashboard → Developers → API Keys & Billing.
2. **Base URL.** `https://api.krea.ai` (hard-coded as `KREA_BASE_URL` in the handler). No version segment in the path.
3. **Execution pattern (confirmed from the handler):**
   - `krea-2-generate` → **async-poll**. `POST /generate/image/krea/krea-2/{variant}` returns `{job_id, status}`; the handler polls `GET /jobs/{job_id}` every **2 s** (cap 300 polls = ~10 min) until terminal. If the submit response already reports `status: completed`, it skips polling.
   - `krea-style-train` → **async-poll**. `POST /styles/train` returns `{job_id}`; polled `GET /jobs/{job_id}` every **5 s** (cap 300 polls).
   - `krea-style-search` → **sync**. `GET /styles` returns the list in one round-trip; no job.
4. **Job lifecycle / status.** Pending set: `backlogged, queued, scheduled, processing, sampling, intermediate-complete`. Terminal: `completed, failed, cancelled`. A `failed`/`cancelled` job raises with the job's `error`/`message`. An unrecognized status also raises (the handler is strict). Completed generate jobs expose result image URLs at `job.result.urls`; completed train jobs expose `job.result.style_id`.
5. **Error / status codes.** Non-2xx responses raise `Krea <action> failed (<code>): <detail>`, where `detail` is pulled from the JSON `error`/`message`. Known: **401/403** bad or missing token; **402** Krea balance depleted (the handler substitutes the message "Krea API balance is depleted" if the body is empty). Validation errors surface client-side before any call: missing `prompt` → `Prompt input is required`; missing training `name` → `Krea style training requires a name`; no training images → `Krea style training requires at least one training image`.
6. **Input-URI rules (images).** `style_images` / `image_style_references` / training `images` accept: public `http(s)://` URLs (passed straight through), `data:` URIs, `/api/outputs/…` paths from upstream nodes, and local file paths under the Nebula output root. Anything that is **not** already an `http(s)` URL is auto-uploaded to Krea via `POST /assets`, and the returned `image_url` is used. Paths outside the output root are rejected. So you can wire any upstream generator's `image` output directly into `style_images` — Nebula handles the upload.
7. **Key gotchas.**
   - **`resolution` is `1K`-only.** It is an enum with a single option; any other value raises `Krea 2 currently supports only resolution=1K`.
   - **`variant` has exactly two values:** `medium` (default) and `large`. Krea 2 Medium **Turbo** is *not* exposed.
   - **At most 10 image style references total** across `style_images` + `image_style_references` + native-moodboard-derived refs combined; exceeding raises an error. Native-moodboard refs only fill the *remaining* slots after explicit refs.
   - **At most one moodboard.** Connecting more than one moodboard ID raises `Krea 2 currently accepts at most one moodboard`.
   - **Style-training `visibleWhen` quirk:** `learning_rate` and `batch_size` are only shown (and only sent) for `flux_dev`, `flux_schnell`, `wan`, `wan22`. They are **hidden for `qwen` and `z-image`** — don't set them for those models; they're ignored. Additionally, for `qwen`/`z-image` the handler coerces `training_type: Default` → `Style`.
   - The handler **downloads the first result image** to the run dir and returns a local path on the `image` port; the raw Krea `job` object is returned on the `job` port (useful for seeds/debugging and additional URLs).

## Pick the right node

| Nebula node (display name) | Node ID | Endpoint / model | Key params |
|---|---|---|---|
| **Krea 2** | `krea-2-generate` | `POST /generate/image/krea/krea-2/{variant}` (Krea 2, medium/large) — async-poll | `variant` (medium/large), `aspect_ratio` (8 ratios), `resolution` (1K only), `creativity` (raw/low/medium/high), `seed`, `style_reference_strength`, `style_id`, `style_strength`, `moodboard_id`, `moodboard_strength` |
| **Krea Style Search** | `krea-style-search` | `GET /styles` — sync | `filter` (all/user/community/krea/shared/public/gallery), `model`, `ids`, `user`, `liked`, `limit`, `cursor` |
| **Krea Style Train** | `krea-style-train` | `POST /styles/train` (+ optional `POST /styles/{id}/share/workspace`) — async-poll | `name` (required), `model` (6 base models), `training_type`, `trigger_word`, `max_train_steps`, `learning_rate`*, `batch_size`*, `generation_strength`, `share_with_workspace` |

\* `learning_rate` / `batch_size` shown only for `flux_dev`/`flux_schnell`/`wan`/`wan22`.

## Param reference

### `krea-2-generate` (Krea 2)

**Input ports:** `prompt` (Text, **required**) · `style_images` (Image, up to 10) · `image_style_references` (Any, up to 10) · `styles` (Any, multiple) · `moodboard` (Any, max 1).
**Output ports:** `image` (Image — local file path) · `job` (Any — raw Krea job object).

| Param | Type | Range / enum | Default | Notes |
|---|---|---|---|---|
| `variant` | enum | `medium`, `large` | `medium` | Picks the path segment; `large` is higher quality / cost. |
| `aspect_ratio` | enum | `1:1`, `4:3`, `3:2`, `16:9`, `2.35:1`, `4:5`, `2:3`, `9:16` | `1:1` | Validated against the exact set; anything else raises. |
| `resolution` | enum | `1K` | `1K` | Only value accepted. |
| `creativity` | enum | `raw`, `low`, `medium`, `high` | `medium` | How far Krea may deviate from the prompt/refs. |
| `seed` | integer | 0 – 2147483647 | random | Omit for random; set for repeatability. |
| `style_reference_strength` | float | 0 – 1 | `0.5` | Default strength applied to each connected `style_images` reference (per-ref override possible via `image_style_references` items). |
| `style_id` | string | — | — | Paste an existing Krea style ID directly (in addition to / instead of wiring the `styles` port). |
| `style_strength` | float | -2 – 2 | `1` | Default strength for connected styles + the pasted `style_id`. Negative pushes *away* from the style. |
| `moodboard_id` | string | — | — | Reference an existing **Krea** moodboard by ID. |
| `moodboard_strength` | float | 0 – 1 | **`0.23`** | Strength for the Krea `moodboard_id`. (Note: this is the node default; a Nebula *native* moodboard's reference images default to 0.7 strength — separate path, see chaining.) |

How the request body is assembled (from the handler): `prompt`, `aspect_ratio`, `resolution`, `creativity` are always sent; `seed` if set; `image_style_references` is the merged list of `{url, strength}` from `style_images` + `image_style_references` + native-moodboard refs; `styles` is a list of `{id, strength}`; `moodboards` is a list of `{id, strength}` (≤1). A Nebula native moodboard also appends a `Nebula moodboard direction: <styleBrief>` suffix to the prompt.

### `krea-style-search` (Krea Style Search)

**Input ports:** none. **Output ports:** `styles` (Array — raw style objects) · `text` (Text — a summary listing up to 10 `title — id [models]` lines).

| Param | Type | Range / enum | Default | Notes |
|---|---|---|---|---|
| `filter` | enum | `all`, `user`, `community`, `krea`, `shared`, `public`, `gallery` | `all` | Scope of the library to search. |
| `model` | string | e.g. `flux_dev`, `qwen`, `z-image`, `wan` | — | Filter by the model a style was trained on. |
| `ids` | string | comma-separated style IDs | — | Fetch specific styles by ID. |
| `user` | string | — | — | Filter by owner. |
| `liked` | boolean | — | `false` | Only styles you've liked. |
| `limit` | integer | 1 – 1000 | `25` | Page size. |
| `cursor` | string | — | — | Pagination cursor from a prior page. |

Only non-empty params are sent as query params. The `styles` array (the API's `items`) feeds directly into a `krea-2-generate` `styles` port.

### `krea-style-train` (Krea Style Train)

**Input ports:** `images` (Image, **required**, multiple — the training set).
**Output ports:** `style` (Any — `{kind: "krea_style", id, strength}`) · `style_id` (Text) · `job` (Any — raw job).

| Param | Type | Range / enum | Default | Notes |
|---|---|---|---|---|
| `name` | string | — | — | **Required.** Style name. |
| `model` | enum | `flux_dev`, `flux_schnell`, `wan`, `wan22`, `qwen`, `z-image` | `flux_dev` | Base model the LoRA trains on. |
| `training_type` | enum | `Style`, `Object`, `Character`, `Default` | `Style` | For `qwen`/`z-image`, `Default` is coerced to `Style`. |
| `trigger_word` | string | — | — | Optional activation token to invoke the style in prompts. |
| `max_train_steps` | integer | 1 – 2000 | (API default ~1000) | Training step cap. |
| `learning_rate` | float | — | — | **Shown only for** `flux_dev`/`flux_schnell`/`wan`/`wan22`. Hidden + ignored for `qwen`/`z-image`. |
| `batch_size` | integer | ≥ 1 | — | **Shown only for** `flux_dev`/`flux_schnell`/`wan`/`wan22`. Hidden + ignored for `qwen`/`z-image`. |
| `generation_strength` | float | -2 – 2 | `1` | Strength baked into the emitted `style` object (used downstream when this style feeds a generation). |
| `share_with_workspace` | boolean | — | `false` | If true, after training the handler calls `POST /styles/{id}/share/workspace`. |

The submit body is `{model, type, name, urls}` plus optional `trigger_word`, `max_train_steps`, and (full-knob models only) `learning_rate`/`batch_size`. `urls` are produced by uploading every connected training image to `/assets` first.

## Recipes

### Recipe 1 — Straight Krea 2 text-to-image
1. Drop a **`krea-2-generate`** node.
2. Wire a text/prompt source into its `prompt` port (required).
3. Set `aspect_ratio` (e.g. `16:9`), keep `creativity: medium`, optionally set a `seed` for repeatability. Leave `variant: medium` (or pick `large` for higher quality).
4. Run. The generated image lands on the `image` port; the raw `job` (with seed + all URLs) on `job`.

### Recipe 2 — Style-referenced generation (look transfer)
1. Bring in one or more reference images — uploads, or the `image` output of any upstream generator node — and connect them into the `krea-2-generate` `style_images` port (up to 10).
2. Tune `style_reference_strength` (0–1, default 0.5) to control how hard the references bias the result.
3. Connect your `prompt` and run. Nebula auto-uploads any local/generated images to `/assets` and sends them as `image_style_references`. (A Nebula moodboard wired into the `moodboard` port additionally injects its representative images as references *and* appends a style-brief suffix to the prompt.)

### Recipe 3 — Discover a style, then generate with it
1. Drop a **`krea-style-search`** node. Set `filter: krea` (or `community`), optionally `model: flux_dev` and `limit`. Run — read the `text` summary to pick a style, or pass the whole `styles` array onward.
2. Wire the `styles` array output into the `krea-2-generate` `styles` port (or copy a single style ID into the node's `style_id` param).
3. Set `style_strength` (-2–2, default 1), add your `prompt`, and generate on-brand images.

### Recipe 4 — Train a custom LoRA style, then generate with it
1. Drop a **`krea-style-train`** node. Connect a set of training images into `images` and give it a `name` (required). Pick `model: flux_dev` and `training_type: Style`; optionally set a `trigger_word`. (Leave `learning_rate`/`batch_size` alone unless you've chosen a FLUX/Wan model and know the values; they're hidden for Qwen/Z-Image.)
2. Run it. When training completes it emits `style_id` (Text) and a `style` object on `style`.
3. Wire the `style` output into a `krea-2-generate` node's `styles` port (or paste the `style_id` into the `style_id` param), set `style_strength`, add a `prompt`, and generate. Optionally toggle `share_with_workspace` on the train node to make the style available to your whole API workspace.

## In the nebula_nodes context

- **Node IDs (provider `krea`):** `krea-2-generate`, `krea-style-search`, `krea-style-train`. All three set `envKeyName: KREA_API_TOKEN`. In the palette, **Krea 2** and **Krea Style Train** sit under image-gen; **Krea Style Search** is an analyzer node.
- **Handler:** `backend/handlers/krea.py`. Entry points: `handle_krea_generate`, `handle_krea_style_search`, `handle_krea_style_train`. Shared helpers: `_poll_krea_job` (polls `/jobs/{id}`), `_upload_asset` / `_image_value_to_url` (the `/assets` upload path), `_collect_image_style_references`, `_collect_styles`, `_collect_moodboards`.
- **Node defs:** `backend/data/node_definitions.json` (keys `krea-2-generate`, `krea-style-search`, `krea-style-train`). The `visibleWhen` block on `learning_rate`/`batch_size` is what drives the hide-for-Qwen/Z-Image UI behavior.
- **Ports & chaining:**
  - `krea-2-generate` consumes `prompt` (Text, required), `style_images` (Image ×10), `image_style_references` (Any ×10), `styles` (Any), `moodboard` (Any ×1); emits `image` + `job`.
  - `krea-style-search` consumes nothing; emits `styles` (Array) + `text` (Text). The `styles` array plugs straight into `krea-2-generate.styles`.
  - `krea-style-train` consumes `images` (Image, required); emits `style` + `style_id` (Text) + `job`. The `style` output (a `{kind:"krea_style", id, strength}` object) plugs into `krea-2-generate.styles`; or route the `style_id` Text into the `style_id` param.
  - **Internal resource shapes** the handler recognizes on input ports (not user-facing nodes, but useful to know when an agent emits them): `krea_image_style_reference` (`{kind, image, strength}`) on `image_style_references`; `krea_style` (`{kind, id, strength}`) on `styles`; `nebula_moodboard` on `moodboard`. A `nebula_moodboard` is treated specially — its representative images become style references (default strength 0.7, filling only remaining slots) and its `styleBrief` is appended to the prompt — whereas a raw `moodboard_id` string/object goes into the `moodboards` body field for Krea-side lookup.
- **How outputs render:** the `image` port is a downloaded local file served via `/api/outputs/…`; the canvas image preview renders it. The `job` port carries the raw Krea job JSON (seeds, all result URLs, status) for debugging or fan-out.

### Capability boundaries — what Krea's API can do that Nebula does NOT expose

Nebula deliberately scopes this provider to **Krea's own Krea 2 model + the style system**. Do not promise the following through a Krea node; route the user to the appropriate other Nebula provider (or tell them it's out of scope here):

- **Krea 2 Medium Turbo** (`/generate/image/krea/krea-2-medium-turbo`) — not exposed; only `medium` + `large` variants.
- **Image-to-image / editing** — Flux Kontext, SeedEdit, Seedream 4, etc. (`/generate/image/bfl/flux-1-kontext-dev`, …) — not exposed.
- **Video generation** — Veo 2/3/3.1, Kling, Runway Gen-3/4/4.5/Aleph, Hailuo, Seedance, Wan, Ray 2, LTX, Grok Imagine (`/generate/video/{provider}/{model}`) — not exposed. (Use Nebula's Runway / FAL / Replicate providers for video.)
- **Upscaling / enhancement** — Topaz, Topaz Bloom, Topaz Generative (`/generate/enhance/topaz/…`) — not exposed.
- **Krea's third-party image-model gateway** — Flux, Flux 1.1 Pro/Ultra, Imagen 3/4, Ideogram 2/3, Nano Banana / 2 / Pro, Qwen 2512, Z-Image, ChatGPT Image, Luma, Runway Gen-4, Seedream — not exposed *through Krea*. (Many of these have their own Nebula nodes; use those.)
- **Node apps** (saved Krea workflows, `POST /node-apps/{id}/execute`) — not exposed.
- **Style CRUD beyond train + share:** get a single style (`GET /styles/{id}`), update (`PATCH /styles/{id}`), shareable link, remove-from-workspace — not exposed. Sharing exists **only** as the `share_with_workspace` toggle inside `krea-style-train`, not as a standalone node.
- **Asset management** — list/get/delete assets — not exposed (upload is used internally only, no user-facing asset node).
- **Job management** — list jobs (`GET /jobs`), delete (`DELETE /jobs/{id}`) — not exposed as nodes (polling-by-id only). As of 2026-06-05, a poll cancellation fires a best-effort `DELETE /jobs/{id}` so the in-flight Krea job stops upstream instead of running to completion.
- **Moodboard creation/listing** — Krea has no public create/list moodboard endpoint; `krea-2-generate` can only *reference* an existing Krea `moodboard_id`, or consume a Nebula-native moodboard object.
- **Webhooks** — job-completion callbacks exist in the API but Nebula uses polling instead.
- **3D generation** — Krea has a user-facing 3D feature but no documented public API endpoint; not available here.

Overall Nebula exposes roughly ~10% of the Krea API surface — by design, this provider is "Krea 2 + styles," not Krea's full multi-model gateway.

## Sources

- Nebula audit guide: `docs/api-guides/krea.md` (node table, params, gap table, sourcing).
- Ground truth: `backend/handlers/krea.py`, `backend/data/node_definitions.json` (keys `krea-2-generate`, `krea-style-search`, `krea-style-train`).
- Official docs:
  - https://docs.krea.ai/llms.txt — full documentation / endpoint index
  - https://docs.krea.ai/api-reference/introduction.md — base URL, async job model
  - https://docs.krea.ai/api-reference/krea/krea-2-medium.md / krea-2-large.md / krea-2-medium-turbo.md — Krea 2 generation endpoints
  - https://docs.krea.ai/api-reference/styles/search-styles.md, train-a-custom-style-lora.md, share-a-style-with-your-workspace.md — styles & training
  - https://docs.krea.ai/api-reference/assets/upload-an-asset.md — asset upload
  - https://docs.krea.ai/api-reference/general/get-a-job-by-id.md — job lifecycle / polling
