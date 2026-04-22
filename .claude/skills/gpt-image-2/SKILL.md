---
name: gpt-image-2
description: Use when building or editing a Nebula graph containing a gpt-image-2-* node (generate, edit, fal-generate, fal-edit) or when the user asks to use gpt-image-2 inside Nebula. Covers Nebula-specific node IDs, param names, and UI wiring. For prompting craft, see the global gpt-image-2 skill.
---

# GPT Image 2 — Nebula Integration

OpenAI's `gpt-image-2` (released 2026-04-21, snapshot `gpt-image-2-2026-04-21`) is available in Nebula via four nodes.

## Node matrix

| Node ID | Path | BYOK key | When to pick |
|---|---|---|---|
| `gpt-image-2-generate` | OpenAI direct | `OPENAI_API_KEY` | Text→image, full streaming previews, need partial frames in canvas |
| `gpt-image-2-edit` | OpenAI direct | `OPENAI_API_KEY` | Image edit / inpainting with up to 10 reference images + optional mask |
| `gpt-image-2-fal-generate` | FAL proxy | `FAL_KEY` | Text→image, no OpenAI org-verification needed, pay-per-image |
| `gpt-image-2-fal-edit` | FAL proxy | `FAL_KEY` | Edit via FAL |

All four use `executionPattern: "stream"`. Partial previews render in the canvas as they arrive.

## OpenAI-direct params (generate + edit)

| Param | Values | Default | Notes |
|---|---|---|---|
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` | `auto` | 4K sizes cost significantly more |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | ~$0.006 / $0.053 / $0.211 at 1024² |
| `output_format` | `png`, `jpeg`, `webp` | `png` | |
| `output_compression` | 0–100 | 90 | Only applied when format != png |
| `moderation` | `auto`, `low` | `auto` | `low` is less restrictive |

Edit node also accepts: `images` (Image, multiple, up to 10), `mask` (alpha-channel PNG, same size + format as first image).

## FAL-routed params

FAL uses slightly different naming: `image_size` (not `size`), `num_images` (not `n`). Same sizes and quality values, but `num_images` maxes at 4 (FAL cap). Otherwise identical semantic surface.

## What's NOT supported (and Nebula does not expose)

- `background: transparent` — v1 supported it, v2 does not. If a user asks for transparent backgrounds, suggest chaining a `remove-background` node downstream instead.
- `input_fidelity` — gpt-image-2 always processes inputs at high fidelity; the param must be omitted.
- `n > 1` — OpenAI rejects `n > 1` when `stream=true`, and our nodes always stream. The `n`/Count param is not exposed on the OpenAI-direct nodes. Run the node multiple times for multiple images. (FAL nodes expose `num_images` because FAL may handle this differently — verify during UAT.)
- `partial_images` (Preview Frames) — removed from the OpenAI-direct node defs. Small/fast generations rarely emit partials (OpenAI docs: "you may not receive the full number of partial images you requested"), and we defaulted to none anyway. FAL nodes still expose it for now pending UAT.

## Cost guidance

- Draft iteration → `quality: low` at `1024x1024` ≈ $0.006 each.
- Hero asset → `quality: high` at chosen aspect ratio.
- 4K → token cost scales roughly with pixel count; use sparingly.
- Batch API (50% off) is not wired up in Nebula yet — handle in a later phase.

## When editing a prompt for this node

If the user asks Claude to write or refine a prompt that will feed into `gpt-image-2-*`, consult the global `gpt-image-2` skill for prompting craft (5-slot template, anti-slop rules, text-rendering guidance).

## Known surprises

- OpenAI direct requires Organization Verification — if the user gets "org isn't verified" errors, direct them to https://platform.openai.com/settings/organization/general.
- FAL path uses different param names: `image_size` not `size`, `num_images` not `n`.
- Mask is prompt-guided — the prompt must describe the **full** desired image, not just the masked region.
- Up to 10 reference images in the edit endpoint; the mask applies to the **first** image when supplied.
- Streaming: enable `partial_images` (default 2) to see preview frames in the canvas as the image renders. Set to 0 for final-only.
