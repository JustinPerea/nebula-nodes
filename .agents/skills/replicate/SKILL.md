---
name: replicate
description: Replicate universal gateway — run any Replicate-hosted model (image, video, audio, 3D, or text) by typing its owner/name slug into one node, with one API token. Capabilities: text-to-image, image editing/upscaling, text/image-to-video, music/TTS/transcription, image/text-to-3D, and open LLM text — all via a single passthrough node that resolves the model version, creates an async prediction, and polls to completion. Activate when the user configures the `replicate-universal` node (display name "Replicate") or asks about Replicate in Nebula. Sourced from the official Replicate HTTP API reference (replicate.com/docs/reference/http) and the Nebula audit guide docs/api-guides/replicate.md on 2026-06-04 — node id, the single model_id param, async-poll execution, and output-type inference are cross-checked against backend/data/node_definitions.json and backend/handlers/replicate_universal.py.
---

# Replicate Skill

## When to use

- User configures the `replicate-universal` node (shown as "Replicate" on the canvas, under the **universal** category).
- User wants to run a specific Replicate model by slug (e.g. `black-forest-labs/flux-schnell`, `stability-ai/sdxl`) for an image, video, audio, 3D, or text result.
- User asks "how do I use Replicate in Nebula", how to wire a model's inputs, or which model slug to pick for a media type.
- User asks why a Replicate model input isn't showing as a port (answer: there are no fixed ports — see the contract below).
- User asks about Replicate auth/setup (`REPLICATE_API_TOKEN`) or about features Replicate has that Nebula doesn't expose (streaming, fine-tuning, deployments, model search).

This is the ONLY Replicate node. There is no per-model node, no image/video/audio split — every Replicate run goes through `replicate-universal`.

## Universal rules

1. **Auth — bearer token from one env var.** The handler reads `REPLICATE_API_TOKEN` and refuses to run without it (`raise ValueError("REPLICATE_API_TOKEN is required")`). Every HTTP call sends `Authorization: Bearer <REPLICATE_API_TOKEN>`. Get a token at <https://replicate.com/account/api-tokens> (format `r8_...`), set `REPLICATE_API_TOKEN=r8_...` in the backend's `.env` / shell env, then restart the backend so it loads the variable.
2. **Base URL.** `https://api.replicate.com/v1`. Three routes are used: `GET /v1/models/{owner}/{name}` (resolve the version), `POST /v1/predictions` (create), `GET /v1/predictions/{id}` (poll).
3. **Execution pattern — async-poll for media, SSE for text (confirmed from the handler).** No sync `Prefer: wait`, no webhooks. Text/LLM models that return `urls.stream` now stream token deltas live (auto-detected — see gotcha 6); everything else async-polls. The poll flow is:
   1. Split `model_id` on `/` into `owner` and `name`.
   2. `GET /v1/models/{owner}/{name}` → read `latest_version.id`. This becomes the `version` hash the create call requires. (If a private `_version_id` param is already set on the node, that is used instead and the lookup is skipped.)
   3. `POST /v1/predictions` with body `{"version": <id>, "input": <merged inputs>}`.
   4. Poll `GET /v1/predictions/{id}` every **2 s**, up to **300 times** (~**600 s / 10 min** ceiling). Statuses `starting`/`processing` keep polling; terminal success is `succeeded`, terminal failure is `failed` or `canceled`.
   5. Read `output` from the succeeded prediction and infer its port type (rules below).
4. **Status / error codes.** Submit must return **200 or 201** (else `RuntimeError("Async submit failed (<code>): <body>")`). Each poll must return **200** (else `RuntimeError("Poll request failed ...")`). On a `failed`/`canceled` prediction the handler raises `Async job failed: <prediction.error>`. On hitting the 300-poll cap it raises `Async job timed out after 300 polls (600s)`. A missing `output` on success raises `RuntimeError("Replicate returned no output")`. The version lookup raises if the model 404s or has no version. Common HTTP causes: `401` bad/missing token, `402` insufficient credit / spend limit, `404` wrong slug, `422` invalid `input` for that model's schema, `429` rate-limited.
5. **Input-URI rules.** Nebula does **not** use Replicate's Files API. File-type model inputs (an `image`, `audio`, `video`, `mask` field, etc.) must be passed as **public HTTPS URLs or data URLs** — the handler forwards input values verbatim into the prediction's `input` object with no upload step. When chaining from an upstream Nebula node, the upstream output is a served URL that you map straight into the downstream model's file-input field by its exact name (e.g. an Image output → a model's `image` or `input_image` field).
6. **Key gotchas.**
   - **No fixed ports + no baked schema.** `inputPorts` and `outputPorts` are both `[]`. The node has no idea what fields the chosen model wants. You must know the model's input field names (from its replicate.com page → **Inputs**, or `GET /v1/models/{owner}/{name}`) and name your connected ports / extra params to match exactly. Misspelled or missing required fields surface as a `422`/`failed` from Replicate, not a Nebula validation error.
   - **`model_id` must contain a `/`.** `owner/name` only. A bare name like `sdxl` raises `ValueError("Model ID is required (format: owner/name ...)")`. Do not append a `:version` — versioning is resolved automatically to the model's latest version.
   - **Latest version only.** The handler always resolves `latest_version`; there's no version picker. If you need a pinned older version, that's not exposed (the private `_version_id` is an implementation detail, not a user control).
   - **Empty params are dropped.** Params that are `None` or `""` are not sent. To pass a value you must give it a non-empty value.
   - **Progress is fake.** The progress bar is just `poll_number / 300`, not real model progress — Replicate's prediction progress/logs are not surfaced. Don't promise a live percentage.
   - **Token streaming (text/LLM), auto-detected (2026-06-08).** When the created prediction returns `urls.stream`, the handler consumes the SSE stream and emits live token deltas (rendered as `streamingText`) — no param, no node change. Replicate's `output` SSE data is RAW TEXT (not JSON, unlike the chat providers). Non-text models (image/video/audio/mesh) have no token stream and poll as before. The 30 s idle-reconnect (`Last-Event-ID`) is not implemented, so a very long idle gap could truncate.

## Pick the right node

| Node (in app) | Node ID | Endpoint(s) | Required param | How other inputs work |
|---|---|---|---|---|
| Replicate | `replicate-universal` | `GET /v1/models/{owner}/{name}` (version resolve) → `POST /v1/predictions` → `GET /v1/predictions/{id}` (poll) | `model_id` — string, `owner/name` (e.g. `stability-ai/sdxl`) | None pre-defined. Every connected input port and every extra param (except the internal keys `model_id`, `_version_id`, `_schema_fetched`) is merged into the prediction's `input` object using the port/param **name** as the model input field. |

One node covers all media types. The media type of the result is **inferred from the output**, not declared — see "Param reference" and the inference rules.

### Recommended default model slugs (per media type)

The node can't list models, so seed sensible defaults and tell the user to confirm field names on the model page. These are stable, popular slugs as of 2026-06-04 — verify availability on replicate.com before quoting cost/behavior:

| Want | Good default `model_id` | Typical key inputs |
|---|---|---|
| Fast text-to-image | `black-forest-labs/flux-schnell` | `prompt`, `aspect_ratio`, `seed`, `num_outputs` |
| Higher-quality text-to-image | `black-forest-labs/flux-dev` or `stability-ai/sdxl` | `prompt`, `negative_prompt` (sdxl), `width`, `height`, `seed` |
| Image-to-video | a Stable-Video-Diffusion-style i2v model | `input_image` (or `image`), `motion`/`fps`/`frames` per model |
| Transcription (speech→text) | a Whisper-family model | `audio` (URL/data URL), `language`, `task` |
| Text-to-speech | a TTS model | `text`, `voice`/`speaker` per model |
| Image/text-to-3D | an image-to-3D mesh model | `image` (URL) or `prompt` |
| Open LLM text | an instruct LLM slug | `prompt`, `system_prompt`, `max_tokens`, `temperature` |

Always send the user to the model's **Inputs** section to confirm exact field names — they vary per model and Nebula passes them through literally.

## Param reference

### `replicate-universal`

Declared params (from `backend/data/node_definitions.json`):

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `model_id` | string | **yes** | `""` | Format `owner/name`. Placeholder: `owner/name (e.g. stability-ai/sdxl)`. Must contain a `/`. Do not include a `:version`. |

There are **no other declared params and no input ports**. Everything else a model needs is supplied dynamically:

- **Connected input ports** — created by you when wiring the graph; the port name must equal the model's input field name. The handler maps `inputs[port_name].value → input[port_name]` (skipping `None` values).
- **Extra params** — any ad-hoc param you add to the node (e.g. `prompt`, `width`, `seed`, `negative_prompt`). The handler maps `params[key] → input[key]` for every key except the internal set `{model_id, _version_id, _schema_fetched}`, dropping `None`/`""`.

Internal-only keys (not user-facing controls): `_version_id` (a pinned version hash, normally unset so the latest is resolved) and `_schema_fetched` (a caching flag). Don't set these manually.

**Output-type inference** (from `_infer_output_type` in the handler) — the result's shape decides the port:

| Prediction `output` | Inferred Nebula port |
|---|---|
| String URL ending `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` | **Image** (`image`) |
| String URL ending `.mp4` / `.mov` / `.webm` | **Video** (`video`) |
| String URL ending `.mp3` / `.wav` / `.flac` | **Audio** (`audio`) |
| Any other string URL (unknown extension) | **Image** (`image`) — fallback |
| Plain non-URL string | **Text** (`text`) |
| List whose first item is a URL string | **Image** (`image`), using `output[0]` (first item only) |
| List of non-URLs, dict, or anything else | **Text** (`text`), stringified |

Implications to tell the user:
- A model that returns a **list of images** only yields its **first** image downstream. If they need all of them, that's a current limitation.
- A model that returns a **dict** (structured output) is flattened to a Text port (stringified) — not parsed into typed fields.
- A file with an unusual extension (e.g. a `.glb`/`.obj` 3D mesh, or a query-string-laden signed URL) may be mislabeled as **Image** because only the listed extensions are special-cased. Chain it where the URL itself is what matters, or be aware the port type is a best-guess.

## Recipes

All recipes use the real node id `replicate-universal`.

1. **Text-to-image (single node).** Drop a `replicate-universal`, set `model_id = black-forest-labs/flux-schnell`, add a `prompt` param ("a neon crab on a beach at dusk"). Run → the output URL ends in an image extension → an **Image** port you can preview or download.

2. **Image-to-video chain (two Replicate nodes).** Node A: `model_id` = a text-to-image model with a `prompt` → Image output. Node B: `model_id` = an image-to-video model; wire A's Image output into B's `input_image` (or `image`) field — match the model's real field name — and add motion params as needed. B's output URL ends in `.mp4` → **Video** port. Nebula passes A's served image URL straight into B's `input`.

3. **Transcribe then summarize (two Replicate nodes).** Node A: `model_id` = a Whisper-family model, with an `audio` field set to a public URL/data URL → returns a plain string → **Text** port. Node B: `model_id` = an instruct LLM slug, with `prompt` set to "Summarize:\n" + the upstream text (mapped from A's Text output) → **Text** port. Two gateway nodes, no custom node code.

## In the nebula_nodes context

- **Node id:** `replicate-universal` (display "Replicate"), category `universal`, `apiProvider: replicate`, `executionPattern: async-poll`, `envKeyName: REPLICATE_API_TOKEN`, `apiEndpoint: https://api.replicate.com/v1/predictions`.
- **Handler:** `backend/handlers/replicate_universal.py` (`handle_replicate_universal`). Version resolve helper `_resolve_version`; output typing `_infer_output_type`. Async polling runs through `backend/execution/async_poll_runner.py` (`async_poll_execute` / `AsyncPollConfig`) — submit accepts 200/201, polls require 200, 2 s interval, 300-poll cap, failure reads the prediction's `error` field.
- **Input ports:** none declared. You add ports at graph-build time and **name them to the model's input fields**. Each connected port's value is forwarded into the prediction `input` under that exact name.
- **Output ports:** none declared; a single port is produced at runtime, typed `image` / `video` / `audio` / `text` per the inference table. There is no `task_id` output port (unlike Meshy) — chaining is by the inferred media port only.
- **Chaining rules:** map an upstream media output into the downstream model's file-input field by name (Image → `image`/`input_image`, Audio → `audio`, Text → `prompt`/`system_prompt`). Upstream outputs are served URLs that Replicate fetches directly — no re-upload.
- **How outputs render:** Image/Video/Audio ports render in the canvas's standard media previews; Text ports show as text. Mislabeled ports (see inference caveats) still carry the raw URL/string.

### Capability boundaries (what Replicate's API can do that Nebula does NOT expose)

Never promise these through the `replicate-universal` node — they're in the API but unwired (per the audit gap table in `docs/api-guides/replicate.md`):

- **No Files API upload** (`POST /v1/files`). File inputs must be public URLs or data URLs the user supplies; Nebula won't host a local file for them.
- **No streaming** (SSE via `urls.stream`). Token-by-token LLM/text output is not surfaced — results arrive whole at completion.
- **No synchronous mode** (`Prefer: wait` header). Always polls at 2 s; fast models can't return faster via a held request.
- **No webhooks** (`webhook_events_filter`). Completion is detected by polling only; no callbacks.
- **Cancellation IS wired** (2026-06-05, best-effort): on node cancellation the shared async-poll runner POSTs `/v1/predictions/{id}/cancel` so the run stops upstream instead of running to the 10-min ceiling. (No **`Cancel-After`** runtime cap, though.)
- **No prediction history / listing** (`GET /v1/predictions`).
- **No deployments** (`/v1/deployments…`) — private/auto-scaling endpoints aren't reachable.
- **No trainings / fine-tuning** (`/v1/…/trainings`, `GET /v1/trainings/{id}`).
- **No in-app model search / collections** (`QUERY /v1/models`, `GET /v1/models`, `/v1/collections`, `GET /v1/search`). The user must already know the `owner/name` slug.
- **No version picker / examples / readme** — only the model's **latest** version is used; no pinning to an older version, and no examples/readme surfaced.
- **No official-model convenience route** (`POST /v1/models/{owner}/{name}/predictions`), **no hardware list** (`GET /v1/hardware`), **no account info** (`GET /v1/account`). Roughly ~20% of the Replicate API surface (create + poll + version-resolve) is wired — the full run-a-model happy path, none of the management/streaming/async-callback surface.

## Sources

- Replicate HTTP API reference — <https://replicate.com/docs/reference/http>
- Predictions (create / get / streaming) — <https://replicate.com/docs/topics/predictions>, <https://replicate.com/docs/topics/predictions/create-a-prediction>, <https://replicate.com/docs/topics/predictions/streaming>
- Input files (URL / data-URL guidance) — <https://replicate.com/docs/topics/predictions/input-files>
- Files API (`POST /v1/files`) — <https://sdks.replicate.com/python/resources/files/>
- API tokens — <https://replicate.com/account/api-tokens>
- Nebula audit guide — `docs/api-guides/replicate.md` (node table, params, full API capability surface, gap table, cited sources)
- Ground truth — `backend/data/node_definitions.json` (`replicate-universal`), `backend/handlers/replicate_universal.py`, `backend/execution/async_poll_runner.py`
