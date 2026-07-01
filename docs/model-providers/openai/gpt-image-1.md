---
id: nebula-openai-gpt-image-1
kind: project-model-integration
project: nebula_nodes
provider: openai
model: gpt-image-1
status: active
verified: 2026-06-30
stale_after_days: 30
---

# GPT Image 1 in Nebula Nodes

Audit note for the `gpt-image-1-generate` and `gpt-image-1-edit` nodes.

Verified against `node_definitions.json`, `backend/handlers/openai_image.py`,
`backend/handlers/openai_image_edit.py`, and `backend/tests/test_openai_handler.py`
on 2026-06-30.

> **DALL-E removed:** `dalle-3-generate` was removed 2026-06-10 after OpenAI shut down
> dall-e-2/3 on 2026-05-12. Use these GPT Image nodes or `gpt-image-2-*` instead.

## Node Matrix

| Node ID | Route | Key | Use |
|---|---|---|---|
| `gpt-image-1-generate` | OpenAI direct | `OPENAI_API_KEY` | Text to image |
| `gpt-image-1-edit` | OpenAI direct | `OPENAI_API_KEY` | Image editing / inpainting |

**FAL alternate:** `gpt-image-1.5` / `gpt-image-1.5-edit` use `FAL_KEY` with FAL param
naming (`image_size`, etc.). The same `gpt-image-1.5` model is also selectable on the
direct nodes via the `model` enum.

## Generate Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini` | `gpt-image-1` | |
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto` | Omitted when `auto` |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | Omitted when `auto` |
| `output_format` | `png`, `jpeg`, `webp` | `png` | Omitted when `png` (API default) |
| `background` | `auto`, `transparent`, `opaque` | `auto` | Omitted when `auto` |

`n` (batch count) is **not** exposed on generate — use `gpt-image-1-edit` Count or run
the node multiple times.

## Edit Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini` | `gpt-image-1` | dall-e-2 removed 2026-06 |
| `n` | 1–10 | 1 | Omitted when 1 |
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto` | |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | |
| `output_format` | `png`, `jpeg`, `webp` | `png` | |
| `background` | `auto`, `transparent`, `opaque` | `auto` | Omitted when `auto` |
| `mask` | optional PNG | — | Applied to first image |

## Not Supported

- DALL-E 2/3 — API retired 2026-05-12; node and handler branches removed
- `moderation`, `stream`, `partial_images` — gpt-image-2 only
- `output_compression` — not exposed on gpt-image-1 (consider if requested)

## Check Summary (2026-06-30)

| Check | Result |
|---|---|
| Generate params match registry | PASS |
| Edit params match registry (no dall-e-2) | PASS |
| `output_format` / `background` forwarded on generate | PASS |
| Edit `background` omits `auto` | PASS |
| Generate does not forward stray `n` | PASS |
| Missing API key error names `OPENAI_API_KEY` | PASS |
