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
| `gpt-image-2-edit` | OpenAI direct | `OPENAI_API_KEY` | Image edit / inpainting with up to 16 reference images + optional mask |
| `gpt-image-2-fal-generate` | OpenAI direct with `OPENAI_API_KEY`, else FAL proxy | `OPENAI_API_KEY` or `FAL_KEY` | Text→image; on FAL no OpenAI org-verification needed |
| `gpt-image-2-fal-edit` | OpenAI direct with `OPENAI_API_KEY`, else FAL proxy | `OPENAI_API_KEY` or `FAL_KEY` | Edit |

**FAL copies on your OpenAI key (2026-10-14).** With `OPENAI_API_KEY` saved, the two FAL nodes call OpenAI's own Images API (`gpt-image-2`). Their presets map to the size their label names (Square HD 1024x1024, Portrait 4:3 768x1024, Landscape 4:3 1024x768); Square (512x512) and the 16:9 presets are under OpenAI's 655,360-pixel minimum, so those stay on FAL. Count makes that many streamed calls (first image shown); Preview Frames are sent as `partial_images` (100 extra output tokens each). The OpenAI route is unpriced at the default Landscape 4:3: OpenAI's per-image table covers only 1024x1024, 1024x1536 and 1536x1024.

All four use `executionPattern: "stream"`. Partial previews render in the canvas as they arrive.

## OpenAI-direct params (generate + edit)

| Param | Values | Default | Notes |
|---|---|---|---|
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` | `auto` | 4K sizes cost significantly more |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | ~$0.006 / $0.053 / $0.211 at 1024² |
| `output_format` | `png`, `jpeg`, `webp` | `png` | |
| `output_compression` | 0–100 | 90 | Only applied when format != png |
| `moderation` | `auto`, `low` | `auto` | `low` is less restrictive |

Edit node also accepts: `images` (Image, multiple, up to 16), `mask` (alpha-channel PNG, same size + format as first image).

## The FAL nodes on your OpenAI key (since 2026-10-14)

With `OPENAI_API_KEY` saved, `gpt-image-2-fal-generate` / `-edit` run on OpenAI's own API (`gpt-image-2`), billed by OpenAI, with the same params: `image_size` becomes `size` (`square_hd` 1024x1024, `portrait_4_3` 768x1024, `landscape_4_3` 1024x768), `num_images` becomes that many streamed calls (first image shown), `partial_images` is sent as is. `square` (512x512) and the two 16:9 presets (576x1024, 1024x576) are below OpenAI's 655,360-pixel minimum, so a node set to one stays on FAL. Without an OpenAI key they run on FAL as before. Details: the OpenAI skill's "Your OpenAI key on the fal and Krea copies".

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
- Up to 16 reference images in the edit endpoint ("For GPT image models, you can provide up to 16 images"); the mask applies to the **first** image when supplied.
- Streaming: enable `partial_images` (default 2) to see preview frames in the canvas as the image renders. Set to 0 for final-only.
- SSE event namespaces differ by endpoint: `/v1/images/generations` emits `image_generation.completed` / `image_generation.partial_image`, but `/v1/images/edits` emits `image_edit.completed` / `image_edit.partial_image`. Our parser accepts both. OpenAI's docs don't highlight this distinction — discovered during UAT 2026-04-22.
