---
id: nebula-quiver-arrow-generate
kind: project-model-integration
project: nebula_nodes
provider: quiver
model: arrow-1 / arrow-1.1 / arrow-1.1-max (svg_generate)
status: active
verified: 2026-05-19
stale_after_days: 14
---

# Quiver Arrow Generate — Audit Note

Endpoint-specific contract for `quiver-arrow-generate`. For org-level
facts (auth, rate limits, error codes, model catalog) see
[`_provider.md`](./_provider.md).

## Sources

- `https://docs.quiver.ai/api-reference/create-svgs/text-to-svg` — fetched 2026-05-19
- `https://docs.quiver.ai/models/text-to-svg` — fetched 2026-05-19

## Endpoint

- **HTTP:** `POST /v1/svgs/generations`
- **Streaming:** Yes, SSE via `stream: true` (handler always streams).
- **Auth:** Bearer (see `_provider.md`).

## Request body

| Field | Required | Type | Default | Notes |
|---|---|---|---|---|
| `model` | yes | string | (UI default `arrow-1.1`) | Enum populated dynamically from `/api/quiver/models` with hardcoded fallback. |
| `prompt` | yes | string | — | From the `prompt` input port (Text). |
| `references` | no | array | — | Array of strings; URL or `data:...;base64,...`. Max 16. From the `references` input port (Image+, multiple). |
| `n` | no | int 1–16 | 1 | Number of outputs. |
| `instructions` | no | string | — | Free-form style/formatting guidance. |
| `temperature` | no | float 0–2 | 1.0 | |
| `top_p` | no | float 0–1 | 1.0 | |
| `presence_penalty` | no | float -2–2 | 0.0 | |
| `max_output_tokens` | no | int 1–131072 | 16384 | |
| `stream` | no | bool | true (handler always streams) | |

## Reference image conversion

Nebula's `references` input may carry external HTTPS URLs (e.g. FAL
hosted), data URIs, internal `/api/outputs/...` URLs, or local
filesystem paths. The handler normalizes:

- `http(s)://...` -> passed through verbatim.
- `data:...;base64,...` -> passed through verbatim.
- `/api/outputs/<rel>` or absolute local path -> read from disk, base64-
  encoded, packaged as a `data:<mime>;base64,...` data URI. Required
  because Quiver cannot fetch from localhost.

## Response (non-stream)

Same shape as `arrow-vectorize` — see [`arrow-vectorize.md`](./arrow-vectorize.md).
`data[].svg` is the raw SVG markup (not a URL). `credits` is the per-call
cost (20 for `arrow-1.1`, etc. — see provider note).

## Streaming events

Four event types: `generating` -> `reasoning` -> `draft` (one per partial)
-> `content` (one, final). Terminator `data: [DONE]`. Each event payload
JSON has `type`, optional `id`, optional `svg`, etc.

Handler behavior:

- Skips `generating` and `reasoning` events (purely advisory).
- Emits `StreamPartialSvgEvent` on each `draft` (the frontend renders
  the latest as an inline-SVG data URI preview during executing state).
- On `content`: writes SVG markup to `OUTPUT_ROOT/<run>/<uuid>.svg`,
  also emits a final `StreamPartialSvgEvent` with `is_final=true`,
  returns `{"svg": {"type": "SVG", "value": str(out_path)}}`.
- If stream ends without a `content` event: raises `ValueError("Quiver
  stream ended without a final \`content\` event")`.

## Outputs

| Port | Type | Value |
|---|---|---|
| `svg` | SVG | Server-relative URL `/api/outputs/<rel>.svg` after the engine's `_normalize_outputs_for_storage` rewrite. |

## Findings

None. Endpoint matches documented shape; no observed drift.

## Operational notes

- Handler always passes `stream: true` to Quiver. There is no
  user-facing toggle today.
- Empty `references` -> field omitted from the request body (rather
  than sent as `[]`) so the wire matches the text-only example from
  Quiver docs verbatim.
