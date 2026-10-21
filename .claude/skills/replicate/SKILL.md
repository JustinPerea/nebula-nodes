---
name: replicate
description: "Replicate in Nebula: the replicate-universal gateway for running image, video, audio, 3D, or text models by owner/name slug, and the Replicate route of the FLUX 3 route-table nodes (flux-3-image, flux-3-video, flux-video-upscale). Use when configuring the universal node, mapping a model's dynamic inputs and outputs, choosing Replicate in a FLUX 3 node's provider switcher, or debugging Replicate authentication, version resolution, streaming, async prediction polling, file upload, and cancellation."
---

# Replicate Skill

## When to use

- User configures the `replicate-universal` node (shown as "Replicate" on the canvas, under the **universal** category).
- User wants to run a specific Replicate model by slug (e.g. `black-forest-labs/flux-schnell`, `stability-ai/sdxl`) for an image, video, audio, 3D, or text result.
- User asks "how do I use Replicate in Nebula", how to wire a model's inputs, or which model slug to pick for a media type.
- User asks why a Replicate model input isn't showing as a port (answer: there are no fixed ports — see the contract below).
- User asks about Replicate auth/setup (`REPLICATE_API_TOKEN`) or about features Replicate has that Nebula doesn't expose (streaming, fine-tuning, deployments, model search).

`replicate-universal` is the only node whose provider is Replicate, and the only way to run an arbitrary Replicate model. Since 2026-10-15 Replicate is also one route of three route-table nodes (one node per model with a provider switcher; see **Replicate as a route** below). Those runs go through a different client and don't follow the universal node's rules.

## Universal rules

1. **Auth — bearer token from Settings.** The handler reads `REPLICATE_API_TOKEN` and refuses to run without it (`raise ValueError("REPLICATE_API_TOKEN is required")`). Every HTTP call sends `Authorization: Bearer <REPLICATE_API_TOKEN>`. Get a token at <https://replicate.com/account/api-tokens> (format `r8_...`), enter it in Nebula **Settings → Replicate**, and save. It is persisted under `apiKeys.REPLICATE_API_TOKEN` in project-root `settings.json` and takes effect without a restart.
2. **Base URL.** `https://api.replicate.com/v1`. Three routes are used: `GET /v1/models/{owner}/{name}` (resolve the version), `POST /v1/predictions` (create), `GET /v1/predictions/{id}` (poll).
3. **Execution pattern — SSE when advertised, otherwise async-poll.** No sync `Prefer: wait`, no webhooks. Any prediction that returns `urls.stream` is consumed as SSE; Replicate can advertise that URL for media models as well as text models. Streamed text remains Text, while a complete streamed media data URI is inferred and materialized like a polled result. Predictions without `urls.stream` async-poll. The poll flow is:
   1. Split `model_id` on `/` into `owner` and `name`.
   2. `GET /v1/models/{owner}/{name}` → read `latest_version.id`. This becomes the `version` hash the create call requires. (If a private `_version_id` param is already set on the node, that is used instead and the lookup is skipped.)
   3. `POST /v1/predictions` with body `{"version": <id>, "input": <merged inputs>}`.
   4. Poll `GET /v1/predictions/{id}` every **2 s**, up to **300 times** (~**600 s / 10 min** ceiling). Statuses `starting`/`processing` keep polling; terminal success is `succeeded`, terminal failure is `failed` or `canceled`.
   5. Read `output` from the succeeded prediction and infer its port type (rules below).
4. **Status / error codes.** Submit must return **200 or 201** (else `RuntimeError("Async submit failed (<code>): <body>")`). Each poll must return **200** (else `RuntimeError("Poll request failed ...")`). On a `failed`/`canceled` prediction the handler raises `Async job failed: <prediction.error>`. On hitting the 300-poll cap it raises `Async job timed out after 300 polls (600s)`. A missing `output` on success raises `RuntimeError("Replicate returned no output")`. The version lookup raises if the model 404s or has no version. Common HTTP causes: `401` bad/missing token, `402` insufficient credit / spend limit, `404` wrong slug, `422` invalid `input` for that model's schema, `429` rate-limited.
5. **Input-URI rules.** The universal node does **not** use Replicate's Files API (the FLUX 3 route client does; see below). File-type model inputs (an `image`, `audio`, `video`, `mask` field, etc.) must be passed as **public HTTPS URLs or data URLs** — the handler forwards input values verbatim into the prediction's `input` object with no upload step. When chaining from an upstream Nebula node, the upstream output is a served URL that you map straight into the downstream model's file-input field by its exact name (e.g. an Image output → a model's `image` or `input_image` field).
6. **Key gotchas.**
   - **No fixed ports + no baked schema.** `inputPorts` and `outputPorts` are both `[]`. The node has no idea what fields the chosen model wants. You must know the model's input field names (from its replicate.com page → **Inputs**, or `GET /v1/models/{owner}/{name}`) and name your connected ports / extra params to match exactly. Misspelled or missing required fields surface as a `422`/`failed` from Replicate, not a Nebula validation error.
   - **`model_id` must contain a `/`.** `owner/name` only. A bare name like `sdxl` raises `ValueError("Model ID is required (format: owner/name ...)")`. Do not append a `:version` — versioning is resolved automatically to the model's latest version.
   - **Latest version only.** The handler always resolves `latest_version`; there's no version picker. If you need a pinned older version, that's not exposed (the private `_version_id` is an implementation detail, not a user control).
   - **Empty params are dropped.** Params that are `None` or `""` are not sent. To pass a value you must give it a non-empty value.
   - **Progress is fake.** The progress bar is just `poll_number / 300`, not real model progress — Replicate's prediction progress/logs are not surfaced. Don't promise a live percentage.
   - **SSE is output-shape driven, not text-only.** When a prediction returns `urls.stream`, the handler consumes its RAW TEXT `output` events. Ordinary text emits live deltas. A possible media data-URI prefix is held privately until the header is classified; recognized `data:image/*`, `data:video/*`, `data:audio/*`, SVG, or GLTF output is buffered without text-delta telemetry, then retyped so the engine persists it to the run directory. Models without a stream URL poll as before. The 30 s idle-reconnect (`Last-Event-ID`) is not implemented, so a very long idle gap could truncate.

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
| Media data URI (`data:image/*`, `data:video/*`, `data:audio/*`, SVG, or GLTF) | Matching **Image / Video / Audio / SVG / Mesh** port; bytes are materialized into the run directory |
| List whose first item is a URL string | **Image** (`image`), using `output[0]` (first item only) |
| List whose first item is a media data URI | Matching media port, using `output[0]` |
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

## Replicate as a route (FLUX 3, 2026-10-15)

Three nodes made by Black Forest Labs list Replicate as one route of several (`docs/PROVIDER-ROUTES.md`, the `bfl` skill). The person picks it in the node's provider switcher (`_provider: "replicate"`), or Auto lands on it when no BFL or fal key is set (Auto order: BFL, fal, Replicate, then the rest).

| Node | Replicate model | What the route takes |
|---|---|---|
| `flux-3-image` | `black-forest-labs/flux-3-image` | every shared setting, plus `grounding`; up to 10 `images` |
| `flux-3-video` | `black-forest-labs/flux-3` | `hd` and `fhd` only, no 9:21, `duration` sent as the strings "5" to "20", `draft` (720p only) |
| `flux-video-upscale` | `black-forest-labs/flux-video-upscale` | `creativity`, `upscale_factor`, the source `video` |

No Replicate route for FLUX 3 Image Klein, Klein Base or FLUX Video Edit [fast]: Replicate has no such model (404, checked 2026-10-15). Krea 3 isn't on Replicate either, though Krea's blog says it is.

The route client is `backend/handlers/replicate_model.py` `run_model`, not the universal handler:

- `POST /v1/models/{owner}/{name}/predictions` (Replicate's official-model route): no version lookup.
- A local Nebula output goes up through `POST /v1/files` first, and its `urls.get` is sent as the input. URLs pass through.
- Polls every 3 s, up to 300 polls (15 minutes). Stop cancels with `POST /v1/predictions/{id}/cancel`.
- The output is saved as the node's port type (`image` or `video`), fetched with the token only from `replicate.delivery`.
- A setting the route can't take (4K video) stops the run before any request and names the routes that could take it. Auto never moves to another provider by itself. A FLUX 3 Video draft hides Resolution and sends none, so a draft saved at any resolution runs as the 720p draft at the draft price.

Prices are per route in `backend/data/model_pricing.json`: FLUX 3 Image $0.0205 / 0.024 / 0.035 / 0.05 / 0.3035 per image (768sq to 4k); FLUX 3 Video $0.17 (720p) / $0.29 (1080p) per second, continuation $0.41 / $0.53; Video Upscale $0.07 / $0.10 per output megapixel-second (unconfirmed: Replicate doesn't define its megapixel).

## In the nebula_nodes context

- **Node id:** `replicate-universal` (display "Replicate"), category `universal`, `apiProvider: replicate`, `executionPattern: async-poll`, `envKeyName: REPLICATE_API_TOKEN`, `apiEndpoint: https://api.replicate.com/v1/predictions`.
- **Handler:** `backend/handlers/replicate_universal.py` (`handle_replicate_universal`). Version resolve helper `_resolve_version`; output typing `_infer_output_type`. Async polling runs through `backend/execution/async_poll_runner.py` (`async_poll_execute` / `AsyncPollConfig`) — submit accepts 200/201, polls require 200, 2 s interval, 300-poll cap, failure reads the prediction's `error` field.
- **Input ports:** set from the model once `model_id` is set (`services/universal_ports.replicate_inputs`): one Image port per file input (`x-uploadable` or a `uri` string), named after the input field. Every other input (`prompt`, seeds, enums) is a param of the same name: set it in `params`, don't wire it. Read the ports with `model_schema("replicate", "<owner/name>")` (`ports.inputs`). `edit_canvas` refuses a wire to any other handle.
- **Output ports:** exactly one (`universal_ports.replicate_output`): `image` when the output schema is a file URL or a list of them, otherwise `text`. There is no `video`, `audio` or `task_id` port. Open issue: a video or audio model also shows `image`, while its run names the output `video`/`audio` (`_infer_output_type`), so a wire from `image` gets nothing on those runs. Don't rely on chaining from video/audio Replicate models yet.
- **Chaining rules:** wire an upstream media output into one of the model's file-input ports by name (Image → `image`/`input_image`). Text goes into the `prompt`/`system_prompt` params, not a wire. Upstream outputs are served URLs that Replicate fetches directly, with no re-upload.
- **How outputs render:** Image/Video/Audio ports render in the canvas's standard media previews; Text ports show as text. Mislabeled ports (see inference caveats) still carry the raw URL/string.

### Capability boundaries (what Replicate's API can do that Nebula does NOT expose)

Never promise these through the `replicate-universal` node — they're in the API but unwired there (per the audit gap table in `docs/api-guides/replicate.md`). The FLUX 3 route client above does use the Files API and the official-model route:

- **No Files API upload on the universal node** (`POST /v1/files`). File inputs must be public URLs or data URLs the user supplies; the universal node won't host a local file for them. (The FLUX 3 Replicate route does upload local outputs.)
- **Streaming is wired when Replicate advertises `urls.stream`.** There is no user control to force it, media data URIs are intentionally buffered rather than exposed as text telemetry, and idle reconnect via `Last-Event-ID` is not implemented.
- **No synchronous mode** (`Prefer: wait` header). Always polls at 2 s; fast models can't return faster via a held request.
- **No webhooks** (`webhook_events_filter`). Completion is detected by polling only; no callbacks.
- **Cancellation IS wired** (2026-06-05, best-effort): on node cancellation the shared async-poll runner POSTs `/v1/predictions/{id}/cancel` so the run stops upstream instead of running to the 10-min ceiling. (No **`Cancel-After`** runtime cap, though.)
- **No prediction history / listing** (`GET /v1/predictions`).
- **No deployments** (`/v1/deployments…`) — private/auto-scaling endpoints aren't reachable.
- **No trainings / fine-tuning** (`/v1/…/trainings`, `GET /v1/trainings/{id}`).
- **No in-app model search / collections** (`QUERY /v1/models`, `GET /v1/models`, `/v1/collections`, `GET /v1/search`). The user must already know the `owner/name` slug.
- **No version picker / examples / readme** — only the model's **latest** version is used; no pinning to an older version, and no examples/readme surfaced.
- **No official-model convenience route on the universal node** (`POST /v1/models/{owner}/{name}/predictions`; the FLUX 3 Replicate route uses it), **no hardware list** (`GET /v1/hardware`), **no account info** (`GET /v1/account`). Roughly ~30% of the Replicate API surface (create + poll + version-resolve + advertised streaming + cancellation) is wired — the run-a-model happy path and live text streaming are covered, but the management and async-callback surfaces are not.

## Sources

- Replicate HTTP API reference — <https://replicate.com/docs/reference/http>
- Predictions (create / get / streaming) — <https://replicate.com/docs/topics/predictions>, <https://replicate.com/docs/topics/predictions/create-a-prediction>, <https://replicate.com/docs/topics/predictions/streaming>
- Input files (URL / data-URL guidance) — <https://replicate.com/docs/topics/predictions/input-files>
- Files API (`POST /v1/files`) — <https://sdks.replicate.com/python/resources/files/>
- API tokens — <https://replicate.com/account/api-tokens>
- Nebula audit guide — `docs/api-guides/replicate.md` (node table, params, full API capability surface, gap table, cited sources)
- Ground truth — `backend/data/node_definitions.json` (`replicate-universal`), `backend/handlers/replicate_universal.py`, `backend/execution/async_poll_runner.py`
