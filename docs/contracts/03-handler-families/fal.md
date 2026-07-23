---
title: Nebula Contracts — FAL Handler Family (Volume 3)
status: draft
contract_version: 1
handler_family: fal
---

# FAL handler family (Volume 3)

Rules for nodes with `apiProvider: "fal"` and `envKeyName: "FAL_KEY"`.

**Primary handler:** `backend/handlers/fal_universal.py` (+ dedicated handlers for Demucs, etc.)

---

## 1. Routing modes

| Mode | When | URL pattern |
|------|------|-------------|
| **Stream SSE** | `endpoint_id ∈ STREAMING_FAL_ENDPOINTS` and `emit` set | `POST https://queue.fal.run/{endpoint_id}/stream` |
| **Async-poll** | default for most FAL nodes | `POST …/{endpoint_id}` → poll → GET result |

```python
STREAMING_FAL_ENDPOINTS = {"openai/gpt-image-2", "openai/gpt-image-2/edit"}
```

---

## 2. Auth

```http
Authorization: Key <FAL_KEY>
Content-Type: application/json
```

Missing key → `ValueError("FAL_KEY is required")`.

---

## 3. OpenAI passthrough on FAL (gpt-image-2)

Same underlying model as OpenAI direct, **different param names and URLs**.

| Node | `endpoint_id` | Exemplar |
|------|---------------|----------|
| `gpt-image-2-fal-generate` | `openai/gpt-image-2` | [../examples/gpt-image-2-fal.md](../examples/gpt-image-2-fal.md) |
| `gpt-image-2-fal-edit` | `openai/gpt-image-2/edit` | same |
| `nano-banana-fal` | `fal-ai/nano-banana-2` (model enum) | [../examples/nano-banana-fal.md](../examples/nano-banana-fal.md) |
| `nano-banana-fal-edit` | `fal-ai/nano-banana-2/edit` (model enum) | same |
| `gpt-image-1-5` | `fal-ai/gpt-image-1.5` | [../examples/gpt-image-1-5.md](../examples/gpt-image-1-5.md) |
| `gpt-image-1-5-edit` | `fal-ai/gpt-image-1.5/edit` | same |
| `hunyuan3d-text-to-3d` | `fal-ai/hunyuan3d-v3/text-to-3d` | [../examples/hunyuan3d.md](../examples/hunyuan3d.md) |
| `hunyuan3d-image-to-3d` | `fal-ai/hunyuan3d-v3/image-to-3d` | same |

Also on FAL (async-poll, **no exemplar yet**): `seedream-4-5`.

---

## 4. Request body conventions

| Port / input | FAL JSON field |
|--------------|----------------|
| `prompt` | `prompt` |
| `image` (single) | `image_url` |
| `images` (multi) | `image_urls` |
| `mask` | `mask_url` |
| `video` | `video_url` |
| `audio` | `audio_url` |
| `front_image` (Hunyuan3D) | `input_image_url` |
| `back_image` / `left_image` / `right_image` | matching `*_image_url` |

Local paths → data URI via `_to_fal_url()`.

Node `params` (except `endpoint_id`) copied into body when non-empty.

---

## 5. Output parsing (`_parse_fal_output`)

Priority order: mesh URLs → `images[0].url` → single `image` → `audio_url` → `video` → `text`.

Image stream path saves locally and returns file path (same as OpenAI stream runner).

---

## 6. FAL vs OpenAI direct (gpt-image-2)

| | OpenAI direct | FAL passthrough |
|--|---------------|-----------------|
| Key | `OPENAI_API_KEY` | `FAL_KEY` |
| Size | `size` | `image_size` (presets) |
| Count | `n` (dropped on stream) | `num_images` |
| Default partials | `0` (pinned) | `2` (UI) |

Never copy param names across routes.

---

## 7. References

| Resource | URL |
|----------|-----|
| FAL gpt-image-2 | https://fal.ai/models/openai/gpt-image-2 |
| FAL gpt-image-2 edit | https://fal.ai/models/openai/gpt-image-2/edit |
| OpenAPI (generate) | https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2 |
| FAL pricing | https://fal.ai/pricing |
| Nebula audit | `docs/model-providers/fal/openai-passthroughs.md` |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial family doc; gpt-image-2-fal exemplar complete |
| 2026-07-22 | Added Hunyuan3D fixed-wrapper mapping and gold exemplar |
