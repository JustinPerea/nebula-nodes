---
id: nebula-fal-universal
kind: project-model-integration
project: nebula_nodes
provider: fal
model: fal-universal (infrastructure audit)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Universal Handler — Infrastructure Audit

Nebula-specific integration notes covering the `fal-universal` node and the
shared `handle_fal_universal` infrastructure that all 39 FAL-backed wrapper
nodes route through.

## Sources

- `https://docs.fal.ai/` — FAL API reference
- `https://fal.ai/models` — FAL model catalog
- `https://github.com/fal-ai/fal/tree/main/projects/fal_client` — official Python client

No live API calls were made during this audit. Endpoint IDs spot-checked
against the FAL model catalog.

---

## Node Matrix

| ID | Display Name | Output Port | Category | Default Endpoint |
|----|-------------|-------------|----------|-----------------|
| `fal-universal` | FAL | image / video / audio / mesh | universal | `fal-ai/flux-pro/v1.1-ultra` |

The `fal-universal` node is the only user-facing FAL node that exposes
`endpoint_id` as a free-text param. All other FAL nodes are wrapper nodes that
inject a pinned endpoint and are invisible to the user as raw FAL config.

### Port shape (`fal-universal`)

**Input ports:**
- `prompt` (Text, required) — forwarded as `"prompt"` in the request body
- `image` (Image, optional) — forwarded as `"image_url"`

**Output ports (all optional, mutually exclusive at runtime):**
- `image` (Image)
- `video` (Video)
- `audio` (Audio)
- `mesh` (Mesh)

**Params:**
- `endpoint_id` (string, required, default `fal-ai/flux-pro/v1.1-ultra`) — the
  full FAL queue path, e.g. `fal-ai/flux-pro/v1.1-ultra`

No `output_type` enum param exists. Output type is inferred from the response
shape at runtime by `_parse_fal_output`. See Output-Type Detection below.

---

## The `handle_fal_universal` Contract

File: `backend/handlers/fal_universal.py`

### Execution path

1. Read `endpoint_id` from `node.params` (raises `ValueError` if missing)
2. Route `openai/gpt-image-2` and `openai/gpt-image-2/edit` through the SSE
   streaming path (`stream_runner.stream_execute_image`) — these are the only
   endpoints that bypass the queue/poll loop
3. Build `fal_input` dict from connected input ports (see Param-Key Conventions)
4. Merge `node.params` into `fal_input`, excluding `endpoint_id` and any param
   that is `None` or `""`
5. POST to `https://queue.fal.run/{endpoint_id}`
6. If response includes `request_id`, enter the poll loop; otherwise parse the
   direct response as the result
7. Poll `status_url` (from response or constructed) up to 300× with 2s interval
8. Fetch `response_url` (from response or constructed) on `COMPLETED`
9. Parse response through `_parse_fal_output`

### Timeout

`httpx.AsyncClient` is configured with `timeout=30.0`. The poll loop runs up
to 300 iterations × 2s = up to 10 minutes of wall time.

---

## Endpoint-ID Injection Pattern (Wrapper Nodes)

Wrapper nodes never store `endpoint_id` in their node definition's `params`
list. Instead, `sync_runner.py` injects it at dispatch time using
`node.params.setdefault(...)` before calling `handle_fal_universal`:

```python
# Example: _flux_ultra_handler in sync_runner.py
async def _flux_ultra_handler(node, inputs, api_keys):
    node.params.setdefault("endpoint_id", "fal-ai/flux-pro/v1.1-ultra")
    return await handle_fal_universal(node, inputs, api_keys, emit=emit)
```

`setdefault` is intentional: it will not overwrite an `endpoint_id` if one was
somehow already set (e.g. from a saved graph that included it). The handler
then reads `endpoint_id` from `node.params` exactly as it would for the
`fal-universal` node — there is no separate code path.

### Wrapper nodes with conditional endpoint selection

Some wrappers choose the endpoint based on a param value:

- `sora-2`: pops `model` param, selects `fal-ai/sora-2/text-to-video/pro` or
  `fal-ai/sora-2/text-to-video` based on its value
- `veo-3`: uses Google's direct API if `GOOGLE_API_KEY` is present; falls back
  to `fal-ai/veo3` if only `FAL_KEY` is set

### Wrappers with JSON-array param pre-processing

Some wrapper handlers parse JSON-stringified array params before calling the
universal handler, because the frontend stores complex params as textarea
strings:

- `fast-sdxl`: parses `loras` and `embeddings` from JSON strings; drops them
  if empty or unparseable
- `kling-v3`: parses `multi_prompt` from JSON string; drops if empty

This pre-processing lives in the wrapper handler in `sync_runner.py`, not in
`handle_fal_universal` itself. The universal handler does not JSON-parse
params — it forwards them as-is after the `None`/`""` filter.

---

## Param-Key Conventions

### Input port → FAL request key mapping

| Input port ID | FAL request key | Notes |
|--------------|----------------|-------|
| `prompt` | `prompt` | |
| `image` | `image_url` | converted via `_to_fal_url` |
| `images` | `image_urls` | list; multi-image port (gpt-image-1-5-edit, seedance-2-r2v) |
| `video` | `video_url` | converted via `_to_fal_url` (luma-ray2-flash-modify) |
| `audio` | `audio_url` | converted via `_to_fal_url` (ltx-2-3) |
| `texture_image` | `texture_image_url` | |
| `end_image` | `end_image_url` | |
| `tail_image` | `tail_image_url` | |
| `front_image` | `input_image_url` | Hunyuan3D primary |
| `back_image` | `back_image_url` | Hunyuan3D |
| `left_image` | `left_image_url` | Hunyuan3D |
| `right_image` | `right_image_url` | Hunyuan3D |

`_to_fal_url` passes through `http://`, `https://`, and `data:` values
unchanged. Local file paths are base64-encoded to a data URI.

### Node params → FAL request body

All `node.params` keys except `endpoint_id` are forwarded to `fal_input`,
**unless the value is `None` or `""`**. This means empty optional params are
silently omitted, which is the correct behavior — FAL's API rejects empty
string values for typed params.

---

## Output-Type Detection Rules (`_parse_fal_output`)

Detection runs in priority order. First match wins and returns immediately.

1. **Mesh** — checked first because some 3D endpoints also return preview images
   - `model_urls.glb` present → `{"mesh": {"type": "Mesh", "value": glb_url}}`
   - `glb` key present (dict with `url` or bare string) → Mesh
   - `model_glb` key present (dict or string) → Mesh
   - `model_mesh` key present (dict or string) → Mesh

2. **Image or SVG** — from `images` array
   - `images[0].content_type` contains `"svg"` → `{"svg": {"type": "SVG", "value": url}}`
   - Otherwise → `{"image": {"type": "Image", "value": url}}`
   - Recraft V4 `text-to-vector` returns `content_type: "image/svg+xml"` — this
     is the only known SVG path through this handler

3. **Image** — single image dict
   - `image.url` present → Image
   - `image` bare string → Image

4. **Audio**
   - `audio_url` present → Audio
   - `audio.url` present → Audio

5. **Video**
   - `video.url` present → Video
   - `video_url` present → Video

6. **Text**
   - `text` key → Text
   - `output` key → Text

7. **Last resort**
   - Raw JSON serialized as Text string

---

## Polling and Status Values

The handler recognizes these FAL status strings:

| Status | Handler action |
|--------|---------------|
| `COMPLETED` | Break poll loop, fetch result |
| `FAILED` | Raise `RuntimeError` with `error` field from status response |
| `CANCELLED` | Raise `RuntimeError` |
| `IN_QUEUE` | Continue polling |
| `IN_PROGRESS` | Continue polling |

No other terminal statuses are known from FAL's queue API at this time. The
handler uses a broad `else` fallthrough for unknown statuses (continues
polling), which is safe.

---

## Open Questions for Subsequent FAL Family Audits

These questions apply to the wrapper family audits that follow this
infrastructure audit:

1. **Wrapper endpoint IDs** — each wrapper should have its injected endpoint
   verified against `fal.ai/models`. The audit found no obviously wrong
   endpoint IDs in the infrastructure itself, but per-family verification is
   needed (Kling, Luma, Seedance, WAN, Pixverse, Flux variants, etc.). The
   `moonvalley` wrapper was deprecated 2026-05-19 after its endpoint started
   returning 404 — see `misc.md`.

2. **Recraft SVG param `colors`** — the `colors` param takes a comma-separated
   hex string in the node definition placeholder, but FAL's API likely expects
   an array of `{r, g, b}` objects. This conversion is not handled anywhere
   (neither in the node definition nor in the wrapper). Follow-up audit needed.

3. **`fast-sdxl` executionPattern is `sync`** — but `sync` pattern nodes do not
   get the `emit` closure, which means `handle_fal_universal` receives
   `emit=None` and uses the no-op emitter. Progress events are silently
   dropped. This is currently by design (sync pattern) but worth verifying
   against actual FAL behavior.

4. **`remove-background` has no `prompt` input** — the handler will send an
   empty prompt field only if the node had one wired. In practice no prompt is
   sent, which is correct for `fal-ai/imageutils/rembg`. No issue here, but
   verify the endpoint accepts prompt-free requests.

5. **`gpt-image-1-5-edit` `images` port** — the edit endpoint's `image_urls`
   field was added to the universal handler in this audit. The endpoint
   also presumably requires at least one image (like `gpt-image-2/edit`). A
   guard similar to the streaming gpt-image-2 edit validation may be needed.

6. **Per-wrapper `model_glb` vs `glb` vs `model_urls`** — output parsing
   depends on what each specific 3D endpoint actually returns. The current
   fallback chain covers all known patterns, but new 3D endpoints should be
   validated against actual responses.

---

## Bugs Fixed in This Audit

| # | Severity | Description | Fix |
|---|----------|-------------|-----|
| 1 | High | `_parse_fal_output` had no SVG case — Recraft V4 `text-to-vector` would return wrong port type (`Image` instead of `SVG`) | Added `content_type` check in `images[0]` branch; routes `image/svg+xml` to `{"svg": {"type": "SVG"}}` |
| 2 | High | No `video` input port handling — `luma-ray2-flash-modify` video input was silently dropped | Added `video_input → video_url` mapping |
| 3 | High | No `audio` input port handling — `ltx-2-3` audio input was silently dropped | Added `audio_input → audio_url` mapping |
| 4 | High | No `images` multi-port handling — `gpt-image-1-5-edit` and `seedance-2-r2v` reference images were silently dropped | Added `images_input → image_urls` list mapping |

All four bugs caused silent data loss: the node would run successfully but
submit an incomplete request body, resulting in either an API error or a
generation that ignored the user's input media.
