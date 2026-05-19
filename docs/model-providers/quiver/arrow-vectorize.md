---
id: nebula-quiver-arrow-vectorize
kind: project-model-integration
project: nebula_nodes
provider: quiver
model: arrow-1 / arrow-1.1 / arrow-1.1-max (svg_vectorize)
status: active
verified: 2026-05-19
stale_after_days: 14
---

# Quiver Arrow Vectorize — Audit Note

Endpoint-specific contract for `quiver-arrow-vectorize`. For org-level
facts (auth, rate limits, error codes, model catalog) see
[`_provider.md`](./_provider.md).

## Sources

- `https://docs.quiver.ai/api-reference/vectorize-svg/image-to-svg` — fetched 2026-05-19
- `https://docs.quiver.ai/models/image-to-svg` — fetched 2026-05-19

## Endpoint

- **HTTP:** `POST /v1/svgs/vectorizations`
- **Streaming:** Yes, SSE via `stream: true` (handler always streams).
- **Auth:** Bearer (see `_provider.md`).

## Request body

| Field | Required | Type | Default | Notes |
|---|---|---|---|---|
| `model` | yes | string | (UI default `arrow-1.1`) | Enum populated dynamically from `/api/quiver/models` with hardcoded fallback. |
| `image` | yes | object | — | Discriminated `{url}` OR `{base64}`. NOT a string. |
| `auto_crop` | no | bool | false | Auto-crop to dominant subject before tracing. |
| `target_size` | no | int 128–4096 | (UI default 1024) | Square resize dimension in px applied before tracing. |
| `temperature` | no | float 0–2 | 1.0 | |
| `top_p` | no | float 0–1 | 1.0 | |
| `presence_penalty` | no | float -2–2 | 0.0 | |
| `max_output_tokens` | no | int 1–131072 | 16384 | |
| `stream` | no | bool | true (handler always streams) | |

## Image input conversion

The `image` input port (Image, required, single) may carry external
HTTPS URLs, data URIs, internal `/api/outputs/...` URLs, or local
filesystem paths. The handler converts to the API's object
discriminator:

- `http(s)://...` -> `{"image": {"url": "..."}}` (Quiver fetches it directly).
- `data:...;base64,...` -> stripped to base64, sent as `{"image": {"base64": "..."}}`.
- `/api/outputs/<rel>` or absolute local path -> read from disk, base64-
  encoded, sent as `{"image": {"base64": "..."}}`. Required because
  Quiver cannot fetch from localhost.

`base64` max length is 16,777,216 chars per the API spec. The Nebula
handler does not enforce this client-side; oversize inputs surface as
a 400 from Quiver.

## Response

Same shape across both `/v1/svgs/*` endpoints:

```json
{
  "id": "resp_...",
  "created": 1704067200,
  "credits": 1,
  "data": [{ "mime_type": "image/svg+xml", "svg": "<svg .../>" }],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

The `usage` token counts are documented as deprecated (always zero);
use `credits` for cost accounting.

## Streaming events

Identical to `arrow-generate` — `generating` -> `reasoning` -> `draft`
(N partials) -> `content` (final), then `data: [DONE]`. Handler emits
`StreamPartialSvgEvent` on drafts + the final content event.

## Outputs

| Port | Type | Value |
|---|---|---|
| `svg` | SVG | Server-relative URL `/api/outputs/<rel>.svg` after the engine's `_normalize_outputs_for_storage` rewrite. |

## Findings

None. Endpoint matches documented shape; image object discriminator
behaves as expected.

## Operational notes

- Pricing is cheaper than `generate` on every model variant
  (`arrow-1.1` is 15 credits per vectorize vs 20 per generate). The
  per-model dropdown labels reflect this (Step 13: enum extension).
- Vectorize doesn't take a prompt — output is fully determined by the
  input image + sampling knobs. Best for converting clean logos and
  flat illustrations; messy raster will produce noisy SVG paths.
