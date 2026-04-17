# FAL Node Gap Report

Generated 2026-04-17 by diffing `backend/data/node_definitions.json` against `.claude/skills/fal/skills/`.

## How to read this

- **Nebula params** = keys exposed on the node (from `params`, `sharedParams`, `falParams`, `directParams`) plus input port ids.
- **Missing in nebula** = the FAL skill documents the parameter but the node doesn't expose it. Real gaps unless it's a safe-to-skip convention param.
- **Extra in nebula** = the node exposes a key the skill doesn't list. Often this is an **input-port name** (`image`, `images`, `end_image`, `front_image`, `video1`…) that the `fal_universal` handler renames to the API's `*_url` field before the request. Those are false positives.

## Convention-level findings (apply globally)

- **`sync_mode` can be safely skipped.** It's a FAL convenience that returns the result inline instead of via queue. Our backend always polls the queue — no point exposing it.
- **`*_url` missing while `*` port present** is almost always a handler-level rename, not a real gap. Example: skill says `image_url`, node exposes an `image` input port — the handler converts the port value to the url. Low priority to "fix."
- **`enable_safety_checker` missing on most image models.** It defaults to `true` on FAL. If we never turn it off we're safe, but power users may want to toggle it for edge cases.
- **`guidance_scale`, `num_inference_steps`, `image_size`** — advanced controls that some users want. Currently hidden from nebula; worth exposing at least on flagship image models.

## Two real bugs to flag

### 1. `wan-2-6-i2v` and `wan-2-6-r2v` have a spurious `fal-ai/` prefix

`sync_runner.py` maps:
- `wan-2-6-i2v` → `fal-ai/wan/v2.6/image-to-video`
- `wan-2-6-r2v` → `fal-ai/wan/v2.6/reference-to-video`

But the FAL skill bundle has these slugs as `wan/v2.6/image-to-video` and `wan/v2.6/reference-to-video` (no `fal-ai/` prefix) — consistent with the working `wan-2-6-t2v` route which uses `wan/v2.6/text-to-video`. Verify with `curl -I https://queue.fal.run/wan/v2.6/image-to-video` vs `fal-ai/wan/...`.

### 2. `veo-3` has `aspectRatio` (camelCase) alongside `aspect_ratio` (snake_case, from skill)

Looks like a casing typo in the veo-3 node definition. The skill documents `aspect_ratio`. If our handler doesn't normalize these before submit, the node has both params with one silently ignored by FAL.

## Per-node summary

| Nebula node | FAL endpoint | Real gaps (after filtering false positives) | Notes |
|---|---|---|---|
| `flux-1-1-ultra` | `fal-ai/flux-pro/v1.1-ultra` | — | `image_url` is port-rename, `sync_mode` skip |
| `flux-schnell` | `fal-ai/flux/schnell` | **high** — `image_size`, `guidance_scale`, `num_inference_steps`, `output_format`, `enable_safety_checker`, `acceleration` | Advanced controls all hidden |
| `fast-sdxl` | `fal-ai/fast-sdxl` | **medium** — `loras`, `embeddings`, `expand_prompt`, `num_inference_steps`, `seed`, `enable_safety_checker` | No LoRA support currently exposed |
| `flux-kontext` | `fal-ai/flux-pro/kontext` | **medium** — `num_images` | `image_url` is port-rename |
| `flux-2-pro` | `fal-ai/flux-2-pro` | **low** — `enable_safety_checker` | Clean; matches doc |
| `gpt-image-1-5` | `fal-ai/gpt-image-1.5` | **medium** — `num_images`, `mask_image_url`, `input_fidelity` | Edit features partially unexposed |
| `gpt-image-1-5-edit` | `fal-ai/gpt-image-1.5/edit` | **medium** — `num_images`, `mask_image_url`, `openai_api_key` | Missing mask = missing key edit workflow |
| `seedream-4-5` | `fal-ai/bytedance/seedream/v4.5/text-to-image` | **low** — `max_images`, `enable_safety_checker` | |
| `recraft-v4-raster` | `fal-ai/recraft/v4/text-to-image` | **low** — `background_color`, `enable_safety_checker` | `style` / `style_id` may be legit custom params |
| `kling-v2-1` | `fal-ai/kling-video/v2.1/pro/image-to-video` | _no matching skill file_ | Bundle has master variant only |
| `kling-v3` | `fal-ai/kling-video/v3/standard/text-to-video` | **medium** — `multi_prompt`, `shot_type` | Multi-shot + shot-type are real features |
| `kling-o3` | `fal-ai/kling-video/o3/standard/image-to-video` | _no matching skill file_ | |
| `sora-2` | `fal-ai/sora-2/text-to-video` | **medium** — `model` (pro/standard), `character_ids`, `delete_video`, `detect_and_block_ip` | `model` lets user pick sora-2-pro |
| `veo-3` | `fal-ai/veo3` | **medium** — `aspect_ratio` (snake), `auto_fix`, `generate_audio` | Casing typo (see bug #2); `auto_fix` is prompt rewrite |
| `wan-2-6-t2v` | `wan/v2.6/text-to-video` | **medium** — `audio_url`, `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` | |
| `wan-2-6-i2v` | `fal-ai/wan/v2.6/image-to-video` | _no matching skill file, see bug #1_ | Routing has spurious `fal-ai/` |
| `wan-2-6-r2v` | `fal-ai/wan/v2.6/reference-to-video` | _no matching skill file, see bug #1_ | Same routing issue |
| `luma-ray2-t2v` | `fal-ai/luma-dream-machine/ray-2` | _no matching skill file_ | |
| `luma-ray2-i2v` | `fal-ai/luma-dream-machine/ray-2/image-to-video` | _no matching skill file_ | |
| `ltx-video-2` | `fal-ai/ltx-2/image-to-video` | _no matching skill file_ | Bundle has LTX-2.3 but not LTX-2 |
| `ltx-2-3` | `fal-ai/ltx-2.3/image-to-video` | **low** — `end_image_url` (end_image port-rename), `image_url` (image port-rename) | `audio` port is legit |
| `pixverse-v4-5` | `fal-ai/pixverse/v4.5/text-to-video` | _no matching skill file_ | |
| `seedance-v1-5` | `fal-ai/seedance/v1.5/text-to-video` | _no matching skill file_ | |
| `seedance-2-t2v` | `bytedance/seedance-2.0/text-to-video` | **low** — `end_user_id` | |
| `seedance-2-i2v` | `bytedance/seedance-2.0/image-to-video` | **low** — `end_user_id` | `end_image_url` / `image_url` are port-renames |
| `seedance-2-r2v` | `bytedance/seedance-2.0/reference-to-video` | **medium** — `audio_urls`, `resolution`, `end_user_id` | `image_urls` / `video_urls` are port-renames |
| `meshy-text-to-3d` | `fal-ai/meshy/v6/text-to-3d` | **high** — `enable_rigging`, `enable_animation`, `animation_action_id`, `rigging_height_meters`, `texture_image_url`, `art_style` | FAL-specific shortcuts for one-shot rig+animate |
| `meshy-image-to-3d` | `fal-ai/meshy/v6/image-to-3d` | **high** — `enable_rigging`, `enable_animation`, `animation_action_id`, `rigging_height_meters`, `texture_image_url` | Same: one-shot workflow |
| `hunyuan3d-text-to-3d` | `fal-ai/hunyuan3d-v3/text-to-3d` | _no matching skill file_ | |
| `hunyuan3d-image-to-3d` | `fal-ai/hunyuan3d-v3/image-to-3d` | **low** — `seed` | All `*_image_url` are port-renames |
| `remove-background` | `fal-ai/imageutils/rembg` | **low** — `crop_to_bbox` | `image_url` is port-rename |
| `seedvr2-upscale` | `fal-ai/seedvr/upscale/image` | — | `image_url` is port-rename, `sync_mode` skip |

## Actionable triage (recommended order)

**Tier 1 — bug fixes (minutes)**
1. Fix `veo-3` casing: drop `aspectRatio`, keep `aspect_ratio`.
2. Fix `wan-2-6-i2v` and `wan-2-6-r2v` routing: drop the spurious `fal-ai/` prefix from their `setdefault("endpoint_id", ...)` calls in `sync_runner.py`. Verify by curling the corrected URL.

**Tier 2 — high-value feature gaps (~1 session)**
3. Meshy FAL nodes: expose `enable_rigging`, `enable_animation`, `animation_action_id`, `rigging_height_meters`, `texture_image_url`. These are one-shot convenience features the FAL wrapper provides that our direct Meshy nodes also don't have — significant UX win.
4. Sora-2: expose `model` so users can pick `sora-2-pro` vs standard.
5. Flux Schnell: expose `guidance_scale`, `num_inference_steps`, `image_size`, `output_format`. Power users need these.
6. Kling-v3: add `multi_prompt` + `shot_type` — multi-shot composition.

**Tier 3 — nice-to-have (future)**
7. Add `enable_safety_checker` as an optional toggle on image models (defaults true, users rarely need to disable).
8. Add `num_images` on batch-capable models (flux-kontext, gpt-image, seedream, recraft).
9. Add `auto_fix` on veo-3 (default true).
10. Add LoRA support (`loras` array) to fast-sdxl and similar.

**Tier 4 — fill in missing skill files**
- Bundle missing skills for: `fal-ai/kling-video/v2.1/pro/image-to-video`, `fal-ai/kling-video/o3/standard/image-to-video`, `fal-ai/wan/v2.6/image-to-video`, `fal-ai/wan/v2.6/reference-to-video`, `fal-ai/luma-dream-machine/ray-2`, `fal-ai/luma-dream-machine/ray-2/image-to-video`, `fal-ai/ltx-2/image-to-video`, `fal-ai/pixverse/v4.5/text-to-video`, `fal-ai/seedance/v1.5/text-to-video`, `fal-ai/hunyuan3d-v3/text-to-3d`.
- Either fetch `https://fal.ai/models/{slug}/llms.txt` live for each, OR run the vault's `sync_fal_models.py` to populate them, then re-copy.

## Caveats

- The skill-file param tables were parsed heuristically from markdown. Some skills may have additional params in nested sections (e.g. `ImageSize` object literals, enum option lists) that this diff didn't enumerate.
- Any "extra" param in nebula that looks like an input-port name (singular `image`, plural `images`, `front_image`, `video1`, etc.) is almost always handled by the `fal_universal` handler's port→url mapping — not a real gap. The "Notes" column flags these.
- Skills were copied from the vault at 2026-04-17 — if FAL has updated its API since, live `llms.txt` fetch is the source of truth.
