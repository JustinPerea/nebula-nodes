---
id: nebula-quiver-arrow-generate
kind: project-model-integration
project: nebula_nodes
provider: quiver
model: arrow-1 / arrow-1.1 / arrow-1.1-max (svg_generate)
status: active
verified: 2026-06-03
stale_after_days: 14
---

# Quiver Arrow Generate — Audit Note

Endpoint-specific contract for `quiver-arrow-generate`. For org-level
facts (auth, rate limits, error codes, model catalog) see
[`_provider.md`](./_provider.md).

## Sources

- `https://docs.quiver.ai/api-reference/create-svgs/text-to-svg` — fetched 2026-05-19 + re-verified 2026-06-03
- `https://docs.quiver.ai/models/text-to-svg` — fetched 2026-05-19 + re-verified 2026-06-03

## Endpoint

- **HTTP:** `POST /v1/svgs/generations`
- **Streaming:** Yes, SSE via `stream: true` (handler always streams).
- **Auth:** Bearer (see `_provider.md`).

## Request body

| Field | Required | Type | Default | Notes |
|---|---|---|---|---|
| `model` | yes | string | (UI default `arrow-1.1`) | Enum populated dynamically from `/api/quiver/models` with hardcoded fallback. |
| `prompt` | yes | string | — | From the `prompt` input port (Text). |
| `references` | no | array | — | Array of image inputs; max 16 items absolute. **Per-model runtime limit: 4 for `arrow-1`/`arrow-1.1`, 16 for `arrow-1.1-max`.** Each item is an `anyOf` union: `{"url": "https://..."}` (URL object), `{"base64": "..."}` (raw base64, not a data URI), or a plain URL string shorthand. Data URIs (`data:...;base64,...`) are NOT a valid variant of the plain-string shorthand — they must be sent as `{"base64": "..."}` objects (prefix stripped). |
| `n` | no | int 1–16 | 1 | Number of outputs. |
| `instructions` | no | string | — | Free-form style/formatting guidance. |
| `temperature` | no | float 0–2 | 1.0 | |
| `top_p` | no | float 0–1 | 1.0 | |
| `presence_penalty` | no | float -2–2 | 0.0 | |
| `max_output_tokens` | no | int 1–131072 | 16384 | |
| `stream` | no | bool | true (handler always streams) | |

## Reference image conversion

✅ RESOLVED (2026-06-03): base64-reference fix shipped (commit 381e31a — refs now sent as `{base64}` objects, not plain data-URI strings); per-model ref cap documented on the node-def references port (backend enforces the 4-ref limit for arrow-1/1.1 via 400). Original finding retained below for provenance.

⚠️ Original finding (drift at audit time): The canonical API schema (fetched 2026-06-03)
defines `references` items as `anyOf[{url}, {base64}, string(uri)]`.
The plain-string variant is `format: uri` — meaning only plain HTTPS
URLs are valid as bare strings. **Data URIs (`data:...;base64,...`) are
not valid as plain strings** — they must be sent as `{"base64": "..."}`
objects with the prefix stripped. Our handler currently passes data URIs
as plain strings via `_ref_to_quiver_string`. Whether Quiver silently
accepts or rejects them is untested; the API spec does not permit it.

**Code fix needed:** `_ref_to_quiver_string` in `backend/handlers/quiver.py`
should return `{"base64": b64}` (a dict) for local/data-URI inputs, and
`_coerce_references` should build the list accordingly, so the
`references` array contains mixed objects/strings rather than all plain
strings. The client's `build_generate_body` would accept
`list[str | dict]`. Do NOT apply this fix here — flag for a code
change.

Also: the per-model runtime limit (4 for `arrow-1`/`arrow-1.1`, 16 for
`arrow-1.1-max`) is not enforced client-side. Exceeding 4 references on
`arrow-1.1` will produce a 400 from Quiver. The node def currently
shows `maxConnections: 16` unconditionally — consider a UI warning or
per-model cap enforcement.

Nebula's `references` input may carry external HTTPS URLs (e.g. FAL
hosted), data URIs, internal `/api/outputs/...` URLs, or local
filesystem paths. Current handler normalizes (see drift note above):

- `http(s)://...` -> passed through verbatim as a plain string (valid per spec).
- `data:...;base64,...` -> passed through verbatim as a plain string (NOT valid per spec — should be `{"base64": "..."}` with prefix stripped).
- `/api/outputs/<rel>` or absolute local path -> read from disk, base64-
  encoded, packaged as a `data:<mime>;base64,...` data URI string (NOT valid per spec — should be `{"base64": "..."}` with prefix stripped).

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

Re-verified 2026-06-03. Two drifts found:

1. **`references` item format** — Canonical schema requires data URIs and
   local-path base64 blobs be sent as `{"base64": "..."}` objects (raw
   base64, no `data:` prefix). Our handler sends them as plain data URI
   strings, which are not a valid variant of the plain-string shorthand
   (`format: uri` = HTTPS URLs only). **Code fix needed** in
   `backend/handlers/quiver.py` → `_ref_to_quiver_string` +
   `_coerce_references`. See "Reference image conversion" section above.

2. **Per-model reference limit** — `arrow-1` and `arrow-1.1` allow only
   4 references at runtime; 16 is only valid for `arrow-1.1-max`. Our
   node def shows `maxConnections: 16` unconditionally. No code fix
   strictly required (excess refs produce a Quiver 400), but a UI-level
   per-model cap or warning would improve UX.

Endpoint path, streaming event sequence, sampling params, response
shape, and credit costs are all clean — no drift.

## Operational notes

- Handler always passes `stream: true` to Quiver. There is no
  user-facing toggle today.
- Empty `references` -> field omitted from the request body (rather
  than sent as `[]`) so the wire matches the text-only example from
  Quiver docs verbatim.
