---
id: nebula-openai-gpt-image-2
kind: project-model-integration
project: nebula_nodes
provider: openai
model: gpt-image-2
status: active
verified: 2026-05-16
stale_after_days: 30
---

# GPT Image 2 in Nebula Nodes

Nebula-specific integration notes for `gpt-image-2`.

Read the shared model reference first:

`~/Documents/Workspace/Reference/model-providers/openai/gpt-image-2.md`

## Node Matrix

| Node ID | Route | Key | Use |
|---|---|---|---|
| `gpt-image-2-generate` | OpenAI direct | `OPENAI_API_KEY` | Text to image with streaming previews |
| `gpt-image-2-edit` | OpenAI direct | `OPENAI_API_KEY` | Image edit/inpainting with references and optional mask |
| `gpt-image-2-fal-generate` | FAL proxy | `FAL_KEY` | Text to image through FAL |
| `gpt-image-2-fal-edit` | FAL proxy | `FAL_KEY` | Image edit through FAL |

## OpenAI Direct Params

Nebula exposes a subset of the full OpenAI parameter surface. The backend pins
`model: gpt-image-2`, forces `stream: true`, and defaults `partial_images` to
`0` for OpenAI-direct nodes unless a legacy saved graph provides a value.

| Param | Values | Default | Notes |
|---|---|---|---|
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` | `auto` | 4K costs more; custom sizes may be possible outside this UI list |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | Use `low` for draft iterations |
| `output_format` | `png`, `jpeg`, `webp` | `png` | JPEG is useful for latency/size-sensitive outputs |
| `output_compression` | `0-100` | `90` | Only meaningful for JPEG/WebP |
| `moderation` | `auto`, `low` | `auto` | `low` is less restrictive |
| `stream` | `true` | `true` | Backend-forced; not a UI param |
| `partial_images` | `0-3` | `0` | Backend default; no longer exposed by OpenAI-direct node UI |
| `n` | omitted | omitted | Backend drops `n` because OpenAI rejects `n > 1` with `stream=true` |

Edit-specific inputs:

- `images`: one or more image inputs
- `mask`: optional alpha-channel PNG; applies to the first image when multiple images are supplied

## FAL-Routed Differences

FAL uses different naming for some fields:

- `image_size`, not `size`
- `num_images`, not `n`
- `partial_images` is exposed on FAL nodes and defaults to `2`

Keep this distinction visible in UI and handler code so Daedalus does not copy
OpenAI-direct params into FAL requests.

## Not Supported in Nebula

- `background: transparent`: not supported by `gpt-image-2`; chain a background-removal node instead.
- `input_fidelity`: omit it; `gpt-image-2` uses high-fidelity image inputs automatically.
- `n > 1` on OpenAI-direct streaming nodes: run multiple node instances for multiple direct outputs.

## Audit Status (2026-05-16 re-verification)

Re-verified against openai-python SDK type stubs fetched 2026-05-16:
`https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/image_generate_params.py`

| Check | Result |
|---|---|
| `size` enum values match API | PASS — `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` all valid |
| `quality` enum values | PASS — `auto`, `low`, `medium`, `high` correct |
| `output_format` values | PASS — `png`, `jpeg`, `webp` correct |
| `moderation` values | PASS — `auto`, `low` correct |
| `stream: true` forced by handler | PASS |
| `n` dropped when streaming | PASS — handler comment confirms OpenAI rejects `n > 1` with `stream=true` |
| `background` defensively stripped | PASS — `build_generate_body` pops it |
| `input_fidelity` defensively stripped | PASS — `build_generate_body` pops it |
| Edit port id is `images` (plural) | PASS — handler reads `inputs.get("images")` and registry declares `id: "images"` |
| Output port returns `Image` type | PASS |
| Missing API key error names `OPENAI_API_KEY` | PASS |
| Org verification error gives friendly message | PASS |

No changes required to gpt-image-2 nodes in this audit cycle.

## Daedalus Guidance

Before building a `gpt-image-2-*` graph:

1. Read the shared GPT Image 2 model reference.
2. Use `nebula nodes` to confirm the current node IDs.
3. Use `nebula info <node_id>` to confirm the live param schema.
4. Create one stage, run it, inspect the output, then continue downstream.

For prompt craft, use the shared reference. For node IDs and wiring, use this
file and the live `nebula` CLI output.
