---
provider: krea
model: krea-image-*,krea-video-*
verified: 2026-10-09
stale_after_days: 14
sources:
  - https://api.krea.ai/openapi.json
  - https://www.krea.ai/docs/api-reference/introduction
  - https://www.krea.ai/docs/developers/api-keys-and-billing
  - https://www.krea.ai/docs/developers/job-lifecycle
  - https://www.krea.ai/docs/api-reference/general/get-a-job-by-id
  - https://www.krea.ai/docs/api-reference/assets/upload-an-asset
---

# Krea image, video and audio gateway

Gateway nodes persist `_kreaAuth`: `api-token` (also the behavior when absent)
or `mcp`. Account recipes use Krea's hosted MCP tools and share schema checking
and local output storage with API recipes. See [Krea MCP setup](../../KREA-MCP.md).
This control is Nebula recipe metadata, never a field sent inside Krea's model
inputs. Workspace reconnection changes the account cache identity; ordinary
credential refresh preserves it.

Nebula uses the direct Krea REST API at `https://api.krea.ai`. The catalog is generated from Krea's public [OpenAPI 3.1.0 document](https://api.krea.ai/openapi.json), checked **2026-10-09**, with one first-class node per image/video/audio generation route: **34 image, 41 video and 5 audio nodes**. These are static Nebula definitions, selected through its existing model pickers; there is no generic JSON model picker or automatic provider substitution.

The six legacy Krea 2/style/resource nodes retain their established contracts. The older [Krea 2 wrapper reference](krea-2.md) describes that wrapper's scope; use this document and the current OpenAPI for the new route-specific nodes. Enhancement, 3D, and Krea node-app execution are not included; their inputs and outputs need their own node shapes.

## Catalog and IDs

Include public OpenAPI operations whose paths start with `/generate/image/`, `/generate/video/` or `/generate/audio/`. Derive the Nebula ID by removing `/generate/`, replacing non-alphanumeric characters with hyphens, and prefixing `krea-`. Preserve the exact API path separately; a sanitized node ID must never be reconstructed into a request URL.

| API path | Nebula node ID |
|---|---|
| `/generate/image/krea/krea-2/medium` | `krea-image-krea-krea-2-medium` |
| `/generate/image/krea/krea-2/large` | `krea-image-krea-krea-2-large` |
| `/generate/image/krea/krea-2/medium-turbo` | `krea-image-krea-krea-2-medium-turbo` |
| `/generate/image/openai/gpt-image-2` | `krea-image-openai-gpt-image-2` |
| `/generate/image/google/nano-banana-2` | `krea-image-google-nano-banana-2` |
| `/generate/video/kling/kling-3.0` | `krea-video-kling-kling-3-0` |
| `/generate/video/google/veo-3.1` | `krea-video-google-veo-3-1` |
| `/generate/video/bytedance/seedance-2` | `krea-video-bytedance-seedance-2` |
| `/generate/audio/elevenlabs/music-v2.5` | `krea-audio-elevenlabs-music-v2-5` |

The public REST spec does not expose a model-list endpoint. Krea separately documents MCP `list_models` and `get_model_schema`; Nebula's direct REST catalog does not require an MCP connection. Do not infer API availability from Krea's web-app model list or marketing examples. See [MCP discovery](https://www.krea.ai/docs/developers/mcp) and the generated [Nebula model reference](../../MODEL_REFERENCE.md).

Catalog refresh is a source/code update, not a generation request. Saved graphs retain their specific node/model identity. On future catalog updates, inspect deprecated operations and verify node-ID uniqueness. [Krea deprecations](https://www.krea.ai/docs/developers/deprecations) also document deprecation response headers and terminal HTTP 410 after sunset.

The pinned catalog lives in [`backend/data/krea_gateway_models.json`](../../../backend/data/krea_gateway_models.json). It records `sourceUrl`, `fetchedAt`, `openapiSha256`, and the per-node endpoint, request schema, media type, input ports, and JSON parameter names. [`scripts/sync-krea-catalog.py`](../../../scripts/sync-krea-catalog.py) generates the backend registry and frontend definitions from this catalog:

```bash
python3 scripts/sync-krea-catalog.py --check  # Offline consistency check
python3 scripts/sync-krea-catalog.py          # Offline regeneration
python3 scripts/sync-krea-catalog.py --refresh # Fetch the public OpenAPI and regenerate
```

`--openapi /path/to/openapi.json` refreshes from a supplied local document. None of these commands submits a provider job or uses a token. Regenerate `docs/MODEL_REFERENCE.md` through its existing script after changing the node registry.

## Model-specific inputs

Use each operation's exact JSON request schema for its parameter names, enums, defaults, bounds, required fields, and media ports. Do not send arbitrary generic parameters: these schemas reject additional properties. The same purpose can have different field names, such as `image_url`, `image_urls`, `start_image`, or `reference_images`.

- Prompt and media fields can be supplied through graph ports or their controls. Gateway ports do not require connections when the same request field has been filled in a control; the canonical request schema and parameter metadata still enforce required fields before submission.
- Scalar and enum parameters become ordinary controls.
- Complex parameters use JSON fields with canonical object/array shapes. Empty optional fields are omitted; invalid JSON must fail before paid submission.
- Complex object/array inputs also expose `Any` ports for structured graph bindings. Media URL arrays expose their Image, Video, or Audio type with the schema's connection limit.
- Preserve schema-defined units and spelling. For example, resolution enums can distinguish `4k` from `4K`.
- Local files in connected media inputs must be uploaded before submission. Advanced JSON values should use valid provider/public URLs for their media fields; do not paste unresolved local paths.

New Krea 2 route nodes include `image_url` and denoising `strength`, a `3:4` aspect ratio, and `intensity`, `complexity`, and `movement` sliders from `-100` to `100`. Creativity defaults to `low` in the canonical route schema. These controls do not change the preserved `krea-2-generate` wrapper's defaults or ports. [Krea 2 Turbo reference](https://www.krea.ai/docs/api-reference/krea/krea-2-turbo)

For Krea 2 raw JSON, `styles` contains `{ "id": "...", "strength": 0.8 }` objects; `image_style_references` contains `{ "url": "https://...", "strength": 0.5 }` objects. Legacy Nebula wrapper objects carry additional `kind` fields and have a separate adaptation path through `krea-2-generate`.

Image nodes emit `image` (Image), `images` (Array), and `job` (Any). Video nodes emit `video` (Video), `videos` (Array), and `job` (Any). The primary media port is for a single downstream value; the array preserves all returned primary media. Both also emit `artifacts` (Array) with typed local artifact records, including previews when present.

## Authentication and media

API-token recipes use `KREA_API_TOKEN`; `KREA_API_KEY` remains a backward-compatible alias. Account/MCP recipes use the connected workspace's compute units. Send bearer credentials only to Krea's API. Never select a different connection or provider based on other configured keys.

Workspace API access must be enabled. Token-authenticated API requests use a separate USD balance from web-app compute units, and HTTP 402 can occur despite valid authentication. There is no public API-balance endpoint. Failed/cancelled jobs are not billed according to Krea's current documentation. [Keys and billing](https://www.krea.ai/docs/developers/api-keys-and-billing)

Media input fields accept public HTTPS URLs, base64 data URIs, or uploaded asset URLs. The current schema also declares a 1,024-character maximum for `AssetURL` strings, so uploading local media avoids relying on large data URIs. [Media input forms](https://www.krea.ai/docs/api-reference/introduction)

`POST /assets` accepts multipart `file` and optional `description`, with a 75 MB limit. Documented formats include JPEG, PNG, WebP, HEIC, MP4, MOV, WebM, GLB, WAV, and MP3. Its response uses `image_url` as the asset URL field even for non-image media, plus ID, MIME type, byte size, and dimensions where applicable. [Upload schema](https://www.krea.ai/docs/api-reference/assets/upload-an-asset)

## Submit, poll, cancel, materialize

1. Resolve/upload connected inputs and validate the chosen model's payload.
2. `POST` JSON to its exact `/generate/image/...` or `/generate/video/...` path with bearer authentication. Retain the returned `job_id`.
3. Poll `GET /jobs/{id}` while status is `backlogged`, `queued`, `scheduled`, `processing`, `sampling`, or `intermediate-complete`. Krea recommends a 2–5 second polling interval with backoff for long jobs.
4. Stop at `completed`, `failed`, or `cancelled`. Preserve the raw job alongside normalized media outputs.
5. Materialize completed image/video/audio bytes into the bound local run directory before exposing successful outputs, so later graph steps and history do not depend solely on provider URLs.

The canonical job schema puts failure details in top-level `error: { code, message? }`; narrative lifecycle documentation has older `result.error` wording. Normalize both where needed. `result.urls` can be a string array, an array of `{ type: "model" | "preview", url }`, or a dictionary of URLs. Preserve media identity while selecting the relevant output. [Job response schema](https://www.krea.ai/docs/api-reference/general/get-a-job-by-id)

`DELETE /jobs/{id}` requests deletion/cancellation. Krea's lifecycle documentation limits cancellation to queued or processing jobs, so cancellation may race completion and is not a guarantee that remote work stopped. Cancellation should unwind local polling and retain completed earlier runs. [Job lifecycle](https://www.krea.ai/docs/developers/job-lifecycle)

Krea also supports a generation `X-Webhook-URL` header. Nebula uses polling; no public callback server is required for these nodes. Backlog is a normal pending state. Handle HTTP 429 without treating backlog or polling as a failed completed run. [Webhooks](https://www.krea.ai/docs/developers/webhooks), [rate limits](https://www.krea.ai/docs/developers/rate-limits)

## Minimal REST examples

These request bodies show canonical schemas. They are documentation examples, not receipts of paid runs. Use the bearer header and poll the returned job ID for results.

`POST /generate/image/openai/gpt-image-2`:

```json
{"prompt":"A ceramic bird on a studio table","quality":"high","resolution":"1K"}
```

For editing, that route accepts `image_urls` with up to ten media URLs. Krea labels this API model **ChatGPT 2**. [Image reference](https://www.krea.ai/docs/api-reference/image/chatgpt-2)

`POST /generate/video/kling/kling-3.0`:

```json
{"prompt":"Slow camera orbit around a ceramic bird","duration":5,"mode":"std","aspect_ratio":"16:9"}
```

Kling 3.0 optionally accepts `start_image`, `end_image`, `generate_audio`, and multi-shot `multi_prompt`. [Kling reference](https://www.krea.ai/docs/api-reference/video/kling-30)

`POST /generate/video/bytedance/seedance-2`:

```json
{"prompt":"Slow camera orbit around a ceramic bird","duration":5,"resolution":"720p","aspect_ratio":"16:9"}
```

Seedance reference limits and resolution choices come from its own schema, not Kling's. [Seedance reference](https://www.krea.ai/docs/api-reference/video/seedance-20%2A)

## Verification boundary

The catalog and schema statements above were checked against public official Krea sources on **2026-10-09**. They do not establish workspace permissions, remaining balance, every model's runtime availability, or a successful paid generation. Deterministic handler/media tests and any separately recorded live receipts are distinct evidence. Do not publish credentials, user outputs, or unverified price/availability estimates in this reference.
