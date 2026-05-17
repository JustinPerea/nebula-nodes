---
audited: 2026-05-17
nodes: [replicate-universal, openrouter-universal, nous-portal-universal]
status: clean
fixes: 3
---

# Universal Nodes Audit: Replicate, OpenRouter, Nous Portal

Audited 2026-05-17. These three nodes differ from fixed-endpoint wrappers: the
user supplies `model_id` / `model` at runtime. The audit focuses on handler
request body shape, auth header format, response parsing, and the Nous
`envKeyName: []` question.

---

## replicate-universal

**Handler:** `backend/handlers/replicate_universal.py`
**Execution pattern:** `async-poll`
**Endpoint:** `https://api.replicate.com/v1/predictions`
**Source:** https://replicate.com/docs/reference/http (accessed 2026-05-17)

### Auth fix (Bug #1)

The handler previously sent `Authorization: Token {api_key}`. The current
Replicate docs state:

> "The token must be prefixed by 'Bearer', followed by a space and the token
> value."  — https://replicate.com/docs/reference/http

The `Token` prefix is a legacy alias still accepted by the API, but `Bearer` is
the documented standard. Both `_resolve_version` and `AsyncPollConfig.headers`
were updated.

**Fix:** `Token {api_key}` → `Bearer {api_key}` in both callsites.

### Request body shape

Verified correct: `{"version": "<64-char-id>", "input": {...}}`. The handler
resolves the version from `GET /v1/models/{owner}/{name}` (reading
`latest_version.id`) when `_version_id` is not cached. This is the correct
approach — Replicate's API requires a specific version hash for non-official
models.

**Alternative:** For official Replicate models, the `version` field also accepts
`owner/name` or `owner/name:version_id` slugs. The handler always resolves to a
bare version ID first, which works for all model types.

### Response parsing

Correct. Output lives at `result["output"]`. The `_infer_output_type` helper
correctly handles: single URL string (image/video/audio by extension), list of
URL strings (returns first), plain string (Text), and dict (stringified Text).

### Poll config

- `terminal_success`: `{"succeeded"}` — correct
- `terminal_failure`: `{"failed", "canceled"}` — correct
- Non-terminal statuses `starting` / `processing` correctly not listed (handler
  continues polling)
- `max_polls=300` × `poll_interval=2.0s` = 10 min max — reasonable for long
  video/3D jobs

### Tests added

- `test_auth_header_uses_bearer` — pins Bearer prefix
- `test_submit_body_uses_version_field` — pins `version` key in submit body

---

## openrouter-universal

**Handler:** `backend/handlers/openrouter.py`
**Execution pattern:** `stream` (text) / non-streaming (image generation)
**Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
**Sources:**
- https://openrouter.ai/docs/quickstart (accessed 2026-05-17)
- https://openrouter.ai/docs/api/reference/authentication (accessed 2026-05-17)
- https://openrouter.ai/docs/api/reference/parameters (accessed 2026-05-17)
- https://openrouter.ai/docs/guides/overview/multimodal/image-generation (accessed 2026-05-17)

### Auth header

Auth header format `Authorization: Bearer {api_key}` is correct and unchanged.

### Attribution header fix (Bug #2)

The handler sent `X-Title: Nebula Nodes`. The current OpenRouter docs specify
`X-OpenRouter-Title` as the correct header name for app attribution.

**Fix:** `X-Title` → `X-OpenRouter-Title` in both `_handle_text_streaming` and
`_handle_image_generation`.

Note: `HTTP-Referer` is unchanged — this header is confirmed correct by the docs.

### Image generation response parsing fix (Bug #3)

The handler treated `choices[0].message.images[0]` as a raw base64 string and
passed it directly to `save_base64_image`. The actual response shape (verified
from https://openrouter.ai/docs/guides/overview/multimodal/image-generation) is:

```json
{
  "choices": [{
    "message": {
      "images": [{
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,<b64>"}
      }]
    }
  }]
}
```

The `images[0]` entry is an object, not a raw string. The base64 data is in
`images[0].image_url.url` as a data URI prefixed with `data:image/png;base64,`.

**Fix:** Handler now:
1. Checks if `images[0]` is a dict and extracts `.image_url.url`
2. Strips the `data:<mime>;base64,` prefix before calling `save_base64_image`
3. Retains a fallback for any raw-string shape (unknown future format)

### `modalities` field

The `modalities: ["text", "image"]` field used for image generation is confirmed
valid by the docs. Order does not matter per the spec.

### Request body shape

Confirmed correct for text generation:
- `model`, `messages`, `stream: true`
- Optional: `max_tokens`, `temperature`
- OpenAI-compatible message format with `image_url` content blocks for vision

### Tests added / updated

- `test_image_generation_mode` — mock updated to use correct object response shape
  and now asserts the correct base64 string is extracted from the data URI
- `test_streaming_uses_bearer_and_openrouter_title_header` — pins Bearer auth and
  `X-OpenRouter-Title` presence; asserts `X-Title` is absent
- `test_image_generation_uses_bearer_header` — pins Bearer auth and
  `X-OpenRouter-Title` in image generation path

---

## nous-portal-universal

**Handler:** `backend/handlers/nous_portal.py`
**Auth service:** `backend/services/nous_auth.py`
**Execution pattern:** `stream`
**Endpoint:** `https://inference-api.nousresearch.com/v1/chat/completions`
  (resolved dynamically from Hermes credential `base_url`)

### envKeyName: [] — intentional, not a bug

`envKeyName: []` (empty array) is correct. The Nous Portal API uses Hermes
OAuth authentication, not a user-supplied API key. No env variable is required.

**Why:** The Nous inference API at `https://inference-api.nousresearch.com/v1`
uses an x402 micropayment / OAuth gating model. Verified 2026-05-17:

```
POST https://inference-api.nousresearch.com/v1/chat/completions
HTTP/2 402
{"x402Version":1,"accepts":[{"scheme":"exact","network":"solana",...}],
 "error":"Payment required. Please provide either a valid Authorization
          header or x402 payment."}
```

The `Authorization: Bearer <agent_key>` credential is managed by Hermes:
- User authenticates once via `hermes-daedalus model` (browser OAuth flow)
- Hermes writes credentials to `~/.hermes/profiles/daedalus/auth.json`
- The `agent_key` field is a short-lived key (~24h) that Hermes refreshes
- `load_nous_credential()` in `nous_auth.py` reads this file with profile
  fallback logic: daedalus profile → active profile → global auth.json

The `apiEndpoint` in `node_definitions.json` is documentation-only. The handler
constructs the actual URL from `cred.base_url` at runtime, which allows Hermes
to point at staging, enterprise, or other inference endpoints as configured.

### Handler correctness

No bugs found. The handler:
- Correctly raises `RuntimeError` (wrapping `NousNotAuthenticatedError`) when no
  Hermes credential exists, with a message directing users to run
  `hermes-daedalus model`
- Uses `Bearer {cred.access_token}` where `access_token` is the `agent_key`
- Sets `delta_path="choices.0.delta.content"` — correct for OpenAI-compatible SSE
- Handles multimodal image inputs via `_image_to_content_block` (URL, data URI,
  local file path all supported)
- Timeout is 60s (vs OpenRouter's 30s) — appropriate given Hermes model latency

### Tests added (new file)

`backend/tests/test_nous_portal_handler.py` — 9 tests:
- Auth error surfaced as RuntimeError
- Missing model / messages validation
- Text streaming happy path
- Bearer auth header with agent_key
- Request body shape (model, stream, max_tokens, temperature, messages)
- delta_path pinned to `choices.0.delta.content`
- Endpoint URL built from credential base_url (not hardcoded)
- Image input → image_url content block conversion

---

## Summary

| Node | Bugs | Fix |
|------|------|-----|
| `replicate-universal` | 1 — `Token` auth prefix is legacy | Changed to `Bearer` in both callsites |
| `openrouter-universal` | 2 — `X-Title` header renamed; image response object not unwrapped | Updated header name; fixed data URI extraction |
| `nous-portal-universal` | 0 — `envKeyName: []` is intentional | Documented; no code change needed |

**Handler correctness:** All three handlers verified against canonical docs.
No endpoint URL drift. Request body shapes match API specs.
Response parsing correct after fixes above.
