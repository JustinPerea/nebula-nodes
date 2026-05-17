---
id: nebula-fal-openai-passthroughs
kind: project-model-integration
project: nebula_nodes
provider: fal
model: openai-passthroughs (gpt-image-2-fal-*, gpt-image-1-5*, seedream-4-5)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL OpenAI Passthrough Nodes — Audit Note

Five nodes route OpenAI or Bytedance image models through FAL's proxy layer
instead of calling the upstream provider directly. This doc records the
2026-05-17 audit against FAL's canonical OpenAPI schemas.

## Related docs

- Infrastructure: `docs/model-providers/fal/fal-universal.md`
- OpenAI direct equivalents: `docs/model-providers/openai/gpt-image-2.md`,
  `docs/model-providers/openai/gpt-image-1.md`

## Sources (accessed 2026-05-17)

| Source | URL |
|--------|-----|
| FAL OpenAPI — openai/gpt-image-2 | `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2` |
| FAL OpenAPI — openai/gpt-image-2/edit | `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2/edit` |
| FAL OpenAPI — fal-ai/gpt-image-1.5 | `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-1.5` |
| FAL OpenAPI — fal-ai/gpt-image-1.5/edit | `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-1.5/edit` |
| FAL OpenAPI — seedream-4-5 | `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/bytedance/seedream/v4.5/text-to-image` |
| FAL model catalog search | `https://fal.ai/models?keywords=gpt-image`, `?keywords=seedream` |

---

## Node Matrix

| Node ID | Endpoint | Route | Execution |
|---------|----------|-------|-----------|
| `gpt-image-2-fal-generate` | `openai/gpt-image-2` | FAL SSE stream | `stream` |
| `gpt-image-2-fal-edit` | `openai/gpt-image-2/edit` | FAL SSE stream | `stream` |
| `gpt-image-1-5` | `fal-ai/gpt-image-1.5` | FAL async-poll | `async-poll` |
| `gpt-image-1-5-edit` | `fal-ai/gpt-image-1.5/edit` | FAL async-poll | `async-poll` |
| `seedream-4-5` | `fal-ai/bytedance/seedream/v4.5/text-to-image` | FAL async-poll | `async-poll` |

---

## Key FAL vs OpenAI-Direct Differences

FAL routing uses different parameter names than OpenAI's direct API. Never copy
OpenAI-direct params into FAL requests.

| Concept | OpenAI direct | FAL passthrough |
|---------|--------------|-----------------|
| Image size | `size` (WxH string) | `image_size` (preset name or WxH for 1.5) |
| Image count | `n` | `num_images` |
| Streaming frames | `partial_images` (gpt-image-2 only) | `partial_images` (forwarded as-is) |
| Background | `background` | `background` (gpt-image-1.5 only) |
| Input fidelity | not supported | `input_fidelity` (gpt-image-1.5/edit only) |

---

## Per-Node Verified Schema

### gpt-image-2-fal-generate (`openai/gpt-image-2`)

FAL schema uses preset enum strings for `image_size`, not WxH strings. The
`openai/gpt-image-2` endpoint also supports custom `{width, height}` objects
but the UI exposes named presets only.

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `image_size` | enum | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` |
| `quality` | enum | `high` | `auto`, `low`, `medium`, `high` |
| `num_images` | integer | 1 | 1–4 |
| `output_format` | enum | `png` | `jpeg`, `png`, `webp` |
| `partial_images` | integer | 2 | 0–3 |

**Execution:** SSE streaming via `handle_fal_universal` → `stream_execute_image`.
URL: `https://queue.fal.run/openai/gpt-image-2/stream`.

**Port:** single `image` output (Image). No `images` input port (generate only).

### gpt-image-2-fal-edit (`openai/gpt-image-2/edit`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `image_size` | enum | `auto` | `auto`, `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` |
| `quality` | enum | `high` | `auto`, `low`, `medium`, `high` |
| `num_images` | integer | 1 | 1–4 |
| `output_format` | enum | `png` | `jpeg`, `png`, `webp` |
| `partial_images` | integer | 2 | 0–3 |

**Input port:** `images` (multi, Image, required). The `_build_fal_stream_body`
function maps this to `image_urls` list in the FAL request body. A guard raises
`ValueError` if no images are supplied.

FAL schema also accepts an optional `mask_url` for inpainting but Nebula does
not expose it (the OpenAI-direct node uses `mask` instead). Out of scope for
this audit.

### gpt-image-1-5 (`fal-ai/gpt-image-1.5`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `image_size` | enum | `1024x1024` | `1024x1024`, `1536x1024`, `1024x1536` |
| `quality` | enum | `high` | `low`, `medium`, `high` |
| `background` | enum | `auto` | `auto`, `transparent`, `opaque` |
| `num_images` | integer | 1 | 1–4 |
| `output_format` | enum | `png` | `jpeg`, `png`, `webp` |

Note: `gpt-image-1.5` uses WxH strings for `image_size` (not preset names),
unlike `openai/gpt-image-2`. FAL's OpenAPI confirms `"1024x1024"` etc. as the
valid enum values for this endpoint.

**Output shape:** `{"images": [{"url": "...", "content_type": "image/png"}]}`.
`_parse_fal_output` routes this to the `image` output port via the `images`
array branch.

### gpt-image-1-5-edit (`fal-ai/gpt-image-1.5/edit`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `image_size` | enum | `auto` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` |
| `quality` | enum | `high` | `low`, `medium`, `high` |
| `input_fidelity` | enum | `high` | `low`, `high` |
| `background` | enum | `auto` | `auto`, `transparent`, `opaque` |
| `num_images` | integer | 1 | 1–4 |
| `output_format` | enum | `png` | `jpeg`, `png`, `webp` |

**Input port:** `images` (multi, Image, required). Maps to `image_urls` in the
FAL request body via `handle_fal_universal`'s `images` port handler. A guard
raises `ValueError` if no images are supplied (added in fal-universal audit,
commit 231c3a5).

FAL schema also accepts `mask_image_url` (optional); not exposed in Nebula.

### seedream-4-5 (`fal-ai/bytedance/seedream/v4.5/text-to-image`)

Bytedance's v4.5 generation model. New territory as of this audit.

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `image_size` | enum | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto_2K`, `auto_4K` |
| `num_images` | integer | 1 | 1–6 (separate generation runs) |
| `max_images` | integer | 1 | 1–6 (images per generation run; total output = num_images × max_images) |
| `enable_safety_checker` | boolean | `true` | — |
| `seed` | integer | null | any integer; null → random |

`square_hd` maps to 2048×2048. `auto_2K` / `auto_4K` let FAL choose dimensions
within the respective resolution tier. The model supports outputs up to 4 MP
(2048×2048) standard and up to 16.8 MP with `auto_4K`.

**Output:** standard `{"images": [{...}]}` array → `image` port.

---

## Bugs Fixed in This Audit

| # | Severity | Node | Description | Fix |
|---|----------|------|-------------|-----|
| 1 | HIGH | `gpt-image-2-fal-generate` | `image_size` used WxH strings (`1024x1024` etc.) but FAL `openai/gpt-image-2` schema requires preset names (`square_hd`, `landscape_4_3`, etc.) — WxH strings are rejected | Replaced options with preset names; changed default to `landscape_4_3` |
| 2 | HIGH | `gpt-image-2-fal-edit` | Same `image_size` WxH bug + also had unsupported large values (`2048x2048`, `3840x2160`, `2160x3840`) not in FAL's preset list | Replaced with preset names + `auto`; default `auto` preserved |
| 3 | MEDIUM | `gpt-image-2-fal-generate` | `quality` missing `auto` option (FAL schema: `auto`, `low`, `medium`, `high`) | Added `auto` to quality enum |
| 4 | MEDIUM | `gpt-image-2-fal-edit` | Same `quality` missing `auto` | Added `auto` to quality enum |
| 5 | MEDIUM | `gpt-image-1-5` | Frontend `nodeDefinitions.ts` missing `num_images` param (backend JSON had it) — UI could not expose count control | Added `num_images` to frontend definition |
| 6 | MEDIUM | `gpt-image-1-5-edit` | Same frontend `num_images` gap | Added `num_images` to frontend definition |
| 7 | HIGH | `seedream-4-5` | `image_size` missing `auto_2K` and `auto_4K` presets; default was `landscape_4_3` but FAL schema default is `{"width":2048,"height":2048}` = `square_hd` | Added presets; changed default to `square_hd` |
| 8 | HIGH | `seedream-4-5` | `num_images` max was 15 (backend) / 4 (frontend) — FAL schema max is 6 | Fixed to 6 in both registries |
| 9 | HIGH | `seedream-4-5` | `max_images` max was 15 — FAL schema max is 6 | Fixed to 6 in both registries |
| 10 | MEDIUM | `seedream-4-5` | Frontend missing `enable_safety_checker` boolean param | Added to frontend definition |
| 11 | MEDIUM | `seedream-4-5` | Frontend missing `seed` integer param | Added to frontend definition |

---

## Port Verification

| Node | Input ports | Output port | Handler path |
|------|------------|-------------|-------------|
| `gpt-image-2-fal-generate` | `prompt` | `image` (Image) | SSE stream → `stream_execute_image` |
| `gpt-image-2-fal-edit` | `images` (multi), `prompt` | `image` (Image) | SSE stream → `stream_execute_image`; `images` → `image_urls` list |
| `gpt-image-1-5` | `prompt` | `image` (Image) | async-poll; response `images[0].url` → `image` port |
| `gpt-image-1-5-edit` | `prompt`, `images` (multi) | `image` (Image) | async-poll; `images` → `image_urls` list; guard on missing images |
| `seedream-4-5` | `prompt` | `image` (Image) | async-poll; response `images[0].url` → `image` port |

The `gpt-image-2-fal-edit` input port is named `images` (plural, multi). This
is correct: `_build_fal_stream_body` reads `inputs.get("images")` and maps the
list to `image_urls`. Verified against the fal-universal audit (commit 231c3a5)
and confirmed in `test_gpt_image_2_fal_edit_images_map_to_image_urls`.

---

## No-Op Params (Not Exposed)

- `sync_mode` (all nodes): always `false`; Nebula uses async-poll or SSE, never sync data-URI mode
- `openai_api_key` (`openai/gpt-image-2*`): FAL BYOK; not surfaced — users provide `FAL_KEY` only
- `mask_url` / `mask_image_url` (`edit` nodes): not exposed in Nebula FAL edit nodes
- `moderation` (`openai/gpt-image-2`): FAL schema does not list this param; OpenAI-direct-only

---

## Open Questions

1. `partial_images` on `openai/gpt-image-2` FAL nodes — FAL's OpenAPI schema
   does not list `partial_images` as an accepted input param for the streaming
   endpoint. It may be silently ignored or it may be a FAL-specific extension
   inherited from the OpenAI streaming protocol. Currently forwarded as-is;
   verify with a live call if streaming previews are not appearing.

2. `quality: auto` on `openai/gpt-image-2` FAL nodes — FAL schema lists `auto`
   as a valid quality value. Added to registry but not yet live-tested.

3. Seedream 4.5 `num_images` × `max_images` semantics — FAL docs state total
   output = `num_images` (runs) × `max_images` (images per run). Only `images[0]`
   is currently returned to the `image` output port. If `max_images > 1`, extra
   images are silently discarded. A future `images` multi-output port or an
   iterator node would be needed to expose the full batch.
