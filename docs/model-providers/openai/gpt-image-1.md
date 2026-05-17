---
id: nebula-openai-gpt-image-1
kind: project-model-integration
project: nebula_nodes
provider: openai
model: gpt-image-1
status: active
verified: 2026-05-16
stale_after_days: 30
---

# GPT Image 1 in Nebula Nodes

Audit note for the `gpt-image-1-generate` and `gpt-image-1-edit` nodes.
Sources: openai-python SDK type stubs at `openai/types/image_generate_params.py` and
`openai/types/image_edit_params.py`, fetched 2026-05-16 from
`https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/`.

## Node Matrix

| Node ID | Route | Key | Use |
|---|---|---|---|
| `gpt-image-1-generate` | OpenAI direct | `OPENAI_API_KEY` | Text to image |
| `gpt-image-1-edit` | OpenAI direct | `OPENAI_API_KEY` | Image editing / inpainting |

## Generate Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini` | `gpt-image-1` | All are valid API identifiers per SDK |
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto` | |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | `auto` selects best quality for model |
| `output_format` | `png`, `jpeg`, `webp` | `png` | GPT models only; handler omits when `png` (API default) |
| `background` | `auto`, `transparent`, `opaque` | `auto` | GPT models only; handler omits when `auto` |
| `n` | 1–10 | 1 | Handler omits when 1 (API default) |
| `response_format` | — | — | Not sent; GPT models always return `b64_json` |

## Edit Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini`, `dall-e-2` | `gpt-image-1` | |
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto` | |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | |
| `output_format` | `png`, `jpeg`, `webp` | `png` | |
| `background` | `auto`, `transparent`, `opaque` | `auto` | |
| `n` | 1–10 | 1 | |
| `mask` | optional PNG | — | Applied to first image; same dimensions required |

## Findings (2026-05-16 audit)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | `output_format` in registry but handler never sent it | Added forwarding in `openai_image.py` for non-dall-e models |
| 2 | HIGH | `background` in registry but handler never sent it | Added forwarding in `openai_image.py` for non-dall-e models |
| 3 | MEDIUM | `gpt-image-1-edit` quality missing `auto` option; default was `medium` | Added `auto` option, changed default to `auto` in both registries |
| 4 | MEDIUM | `gpt-image-1-edit` size missing `auto` option; default was `1024x1024` | Added `auto` option, changed default to `auto` in both registries |

## Not Supported in Nebula (generate)

- `style`: dall-e-3 only; not sent for gpt-image-1 variants
- `response_format`: omitted — GPT models always return `b64_json`
- `moderation`: gpt-image-2 only
- `stream` / `partial_images`: gpt-image-2 only

## Open Questions

- `gpt-image-1.5` and `gpt-image-1-mini` appear in the SDK `ImageModel` type; OpenAI's
  public docs page blocked access (HTTP 403) during this audit. The SDK types are
  authoritative for parameter validation purposes. Re-verify if either variant is
  deprecated.
- `output_compression` is not exposed on generate or edit for gpt-image-1. SDK shows it
  applies to GPT image models with jpeg/webp. Consider adding it if users request finer
  size control.
