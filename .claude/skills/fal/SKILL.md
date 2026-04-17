---
name: fal
description: FAL.ai model catalog access — image, video, audio, 3D, LoRA training, and more via fal-ai/ and bytedance/ and wan/ endpoints. Activate when the user configures any nebula node that routes through FAL (kling, sora, veo, flux, seedance, wan, luma, pixverse, ltx, moonvalley, hunyuan3d, recraft, nano-banana via FAL, and 30+ others), when the user mentions a fal-ai/ slug, or when they ask which FAL model to use for a task. Entry point for 160 curated per-model skills + category overviews at `.claude/skills/fal/`.
---

# FAL Skill

## When to use

- User configures any FAL-backed nebula node (see the full mapping below)
- User asks "which FAL model for X" or mentions a specific `fal-ai/*` or `bytedance/*` or `wan/*` slug
- User asks about FAL pricing, rate limits, or endpoint schemas
- Claude is building a graph with a FAL-backed node and needs exact parameter names and valid ranges

## Universal FAL conventions

All FAL endpoints (there are 1,312+ models on the platform, 160 curated here) share the same API shape:

- **Auth:** `Authorization: Key <FAL_KEY>` header. Our backend uses `FAL_KEY`. Some models also accept native-provider keys (e.g. `BFL_API_KEY` for Flux, `GOOGLE_API_KEY` for Veo) — nebula handlers prefer native when set, fall back to FAL.
- **Two base URLs:** `https://fal.run/{endpoint_id}` (sync, for fast models) and `https://queue.fal.run/{endpoint_id}` (queue, for slow/long-running models). Nebula's `fal_universal.py` handler uses queue for everything since most models benefit from async.
- **Queue flow:**
  1. `POST https://queue.fal.run/{endpoint_id}` with JSON body → returns `{"request_id": "...", "status_url": "...", "response_url": "..."}`
  2. Poll `GET {status_url}` until `"status": "COMPLETED"` (states: `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED`)
  3. `GET {response_url}` to fetch the result
- **Standard status codes:** `200` (sync success or poll OK) · `401` (bad key) · `402` (insufficient credit) · `422` (invalid params) · `429` (rate limit).
- **Output shape varies by model type** but follows conventions:
  - Image: `{"images": [{"url": "..."}], "seed": ...}`
  - Video: `{"video": {"url": "...", "content_type": "video/mp4"}}`
  - Audio: `{"audio": {"url": "...", "content_type": "audio/mpeg"}}`
  - 3D mesh: `{"model_glb": {"url": "..."}}` or `{"model_mesh": {"url": "..."}}`
- **URL tokens expire.** Response URLs include signed `?Expires=` params. Download promptly.

## Nebula node → FAL endpoint map

The source of truth for this routing is `backend/execution/sync_runner.py`. Each nebula node id on the left is implemented as a FAL-universal wrapper that defaults `endpoint_id` to the slug on the right.

| Nebula node id | FAL endpoint | Category | Individual skill file |
|---|---|---|---|
| `flux-1-1-ultra` | `fal-ai/flux-pro/v1.1-ultra` | Text-to-Image | [`skills/fal-ai__flux-pro__v1.1-ultra.md`](skills/fal-ai__flux-pro__v1.1-ultra.md) |
| `flux-schnell` | `fal-ai/flux/schnell` | Text-to-Image | [`skills/fal-ai__flux__schnell.md`](skills/fal-ai__flux__schnell.md) |
| `fast-sdxl` | `fal-ai/fast-sdxl` | Text-to-Image | [`skills/fal-ai__fast-sdxl.md`](skills/fal-ai__fast-sdxl.md) |
| `flux-kontext` | `fal-ai/flux-pro/kontext` | Image Editing | [`skills/fal-ai__flux-pro__kontext.md`](skills/fal-ai__flux-pro__kontext.md) |
| `flux-2-pro` | `fal-ai/flux-2-pro` | Text-to-Image | [`skills/fal-ai__flux-2-pro.md`](skills/fal-ai__flux-2-pro.md) |
| `gpt-image-1-5` | `fal-ai/gpt-image-1.5` | Text-to-Image | [`skills/fal-ai__gpt-image-1.5.md`](skills/fal-ai__gpt-image-1.5.md) |
| `gpt-image-1-5-edit` | `fal-ai/gpt-image-1.5/edit` | Image Editing | [`skills/fal-ai__gpt-image-1.5__edit.md`](skills/fal-ai__gpt-image-1.5__edit.md) |
| `seedream-4-5` | `fal-ai/bytedance/seedream/v4.5/text-to-image` | Text-to-Image | [`skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md`](skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md) |
| `recraft-v4-raster` | `fal-ai/recraft/v4/text-to-image` | Text-to-Image | [`skills/fal-ai__recraft__v4__text-to-image.md`](skills/fal-ai__recraft__v4__text-to-image.md) |
| `recraft-v4-svg` | `fal-ai/recraft/v4/text-to-vector` | Text-to-Image (Vector) | — |
| `kling-v2-1` | `fal-ai/kling-video/v2.1/pro/image-to-video` | Image-to-Video | [`skills/fal-ai__kling-video__v2.1__master__text-to-video.md`](skills/fal-ai__kling-video__v2.1__master__text-to-video.md) |
| `kling-v3` | `fal-ai/kling-video/v3/standard/text-to-video` | Text-to-Video | [`skills/fal-ai__kling-video__v3__standard__text-to-video.md`](skills/fal-ai__kling-video__v3__standard__text-to-video.md) |
| `kling-o3` | `fal-ai/kling-video/o3/standard/image-to-video` | Image-to-Video | [`skills/fal-ai__kling-video__o3__pro__image-to-video.md`](skills/fal-ai__kling-video__o3__pro__image-to-video.md) |
| `sora-2` | `fal-ai/sora-2/text-to-video` (standard) or `.../pro` (when `model=pro`) | Text-to-Video | [`skills/fal-ai__sora-2__text-to-video.md`](skills/fal-ai__sora-2__text-to-video.md), [`skills/fal-ai__sora-2__text-to-video__pro.md`](skills/fal-ai__sora-2__text-to-video__pro.md) |
| `veo-3` | `fal-ai/veo3` | Text-to-Video | [`skills/fal-ai__veo3.md`](skills/fal-ai__veo3.md) |
| `wan-2-6-t2v` | `wan/v2.6/text-to-video` | Text-to-Video | [`skills/wan__v2.6__text-to-video.md`](skills/wan__v2.6__text-to-video.md) |
| `wan-2-6-i2v` | `wan/v2.6/image-to-video` | Image-to-Video | [`skills/wan__v2.6__image-to-video.md`](skills/wan__v2.6__image-to-video.md) |
| `wan-2-6-r2v` | `wan/v2.6/reference-to-video` | Reference-to-Video | [`skills/wan__v2.6__reference-to-video.md`](skills/wan__v2.6__reference-to-video.md) |
| `luma-ray2-t2v` | `fal-ai/luma-dream-machine/ray-2` | Text-to-Video | [`skills/fal-ai__luma-dream-machine__ray-2.md`](skills/fal-ai__luma-dream-machine__ray-2.md) |
| `luma-ray2-i2v` | `fal-ai/luma-dream-machine/ray-2/image-to-video` | Image-to-Video | [`skills/fal-ai__luma-dream-machine__ray-2__image-to-video.md`](skills/fal-ai__luma-dream-machine__ray-2__image-to-video.md) |
| `luma-ray2-flash-modify` | `fal-ai/luma-dream-machine/ray-2-flash/modify` | Video-to-Video | — |
| `ltx-video-2` | `fal-ai/ltx-2/image-to-video` | Image-to-Video | [`skills/fal-ai__ltx-2__image-to-video.md`](skills/fal-ai__ltx-2__image-to-video.md) |
| `ltx-2-3` | `fal-ai/ltx-2.3/image-to-video` | Image-to-Video | [`skills/fal-ai__ltx-2.3__image-to-video.md`](skills/fal-ai__ltx-2.3__image-to-video.md) |
| `pixverse-v4-5` | `fal-ai/pixverse/v4.5/text-to-video` | Text-to-Video | [`skills/fal-ai__pixverse__v4.5__text-to-video.md`](skills/fal-ai__pixverse__v4.5__text-to-video.md) |
| `seedance-v1-5` | `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | Image-to-Video | [`skills/fal-ai__bytedance__seedance__v1.5__pro__image-to-video.md`](skills/fal-ai__bytedance__seedance__v1.5__pro__image-to-video.md) |
| `seedance-2-t2v` | `bytedance/seedance-2.0/text-to-video` | Text-to-Video | [`skills/bytedance__seedance-2.0__text-to-video.md`](skills/bytedance__seedance-2.0__text-to-video.md) |
| `seedance-2-i2v` | `bytedance/seedance-2.0/image-to-video` | Image-to-Video | [`skills/bytedance__seedance-2.0__image-to-video.md`](skills/bytedance__seedance-2.0__image-to-video.md) |
| `seedance-2-r2v` | `bytedance/seedance-2.0/reference-to-video` | Reference-to-Video | [`skills/bytedance__seedance-2.0__reference-to-video.md`](skills/bytedance__seedance-2.0__reference-to-video.md) |
| `seedance-2-fast-t2v` | `bytedance/seedance-2.0/fast/text-to-video` | Text-to-Video | [`skills/bytedance__seedance-2.0__fast__text-to-video.md`](skills/bytedance__seedance-2.0__fast__text-to-video.md) |
| `seedance-2-fast-i2v` | `bytedance/seedance-2.0/fast/image-to-video` | Image-to-Video | [`skills/bytedance__seedance-2.0__fast__image-to-video.md`](skills/bytedance__seedance-2.0__fast__image-to-video.md) |
| `moonvalley` | `fal-ai/moonvalley/image-to-video` | Image-to-Video | — |
| `meshy-text-to-3d` (FAL route) | `fal-ai/meshy/v6/text-to-3d` | Text-to-3D | [`skills/fal-ai__meshy__v6__text-to-3d.md`](skills/fal-ai__meshy__v6__text-to-3d.md) |
| `meshy-image-to-3d` (FAL route) | `fal-ai/meshy/v6/image-to-3d` | Image-to-3D | [`skills/fal-ai__meshy__v6__image-to-3d.md`](skills/fal-ai__meshy__v6__image-to-3d.md) |
| `hunyuan3d-text-to-3d` | `fal-ai/hunyuan3d-v3/text-to-3d` | Text-to-3D | [`skills/fal-ai__hunyuan3d-v3__text-to-3d.md`](skills/fal-ai__hunyuan3d-v3__text-to-3d.md) |
| `hunyuan3d-image-to-3d` | `fal-ai/hunyuan3d-v3/image-to-3d` | Image-to-3D | [`skills/fal-ai__hunyuan3d-v3__image-to-3d.md`](skills/fal-ai__hunyuan3d-v3__image-to-3d.md) |
| `remove-background` | `fal-ai/imageutils/rembg` | Transform | [`skills/fal-ai__imageutils__rembg.md`](skills/fal-ai__imageutils__rembg.md) |
| `seedvr2-upscale` | `fal-ai/seedvr/upscale/image` | Upscaling | [`skills/fal-ai__seedvr__upscale__image.md`](skills/fal-ai__seedvr__upscale__image.md) |
| `fal-universal` | user-provided slug | Any | route to the matching file under `skills/` |

**Routing note:** Some nebula nodes have two handlers (direct + FAL) with a `routing` param selecting which. The dual-param convention (`sharedParams`, `falParams`, `directParams`) comes from that — `falParams` only apply when routed through FAL.

## How to use this skill

**When the user configures or builds with a FAL-backed node:**
1. Find the endpoint in the table above.
2. Open the matching skill file in `skills/` for that model.
3. Use its **Input parameters** section as the source of truth for valid params, defaults, and ranges.
4. Use its **When to use / Don't use / Alternatives** section to decide if it's the right model.
5. Use its **Prompting best practices** section (most skills have one) to craft the input.

**When the user asks about a FAL model not in the table above:**
1. Check `skills/fal-ai__*.md` for a direct file matching the slug (file naming: `fal-ai__` prefix, `__` for `/`, `.md` suffix — so `fal-ai/foo/bar` → `fal-ai__foo__bar.md`).
2. If no file exists, fetch live: `https://fal.ai/models/{slug}/llms.txt` via WebFetch. That's FAL's LLM-friendly spec.
3. Mention to the user that this model isn't currently a curated nebula node — they can use `fal-universal` with the slug.

## Category overviews

Browse all 160 skills by category: `categories/{category}.md`. Categories available:

```
audio-to-audio.md   audio-to-video.md   image-to-3d.md    image-to-image.md
image-to-video.md   llm.md              speech-to-text.md text-to-3d.md
text-to-audio.md    text-to-image.md    text-to-speech.md text-to-video.md
training.md         upscaling.md        video-to-video.md vision.md
```

Machine-readable: `by_category.json`.

## Rate limits + pricing

FAL doesn't publish public rate-limit numbers. Empirically:
- **Sync endpoints** (`fal.run/...`) are usage-billed per-request, often with per-second rate limits documented per model.
- **Queue endpoints** handle bursts but a single request still blocks on queue position.
- Each model's skill file has a **Pricing** section with exact $/image, $/second-of-video, or $/credit figures.

## Universal prompting guidance

The bundle's skill files each have a "Prompting best practices" section. High-leverage universal patterns across FAL models:

1. **Narrative > keyword soup** — full prose descriptions beat comma-separated tags on every FAL image model (Flux, Nano Banana, Imagen, Recraft, Seedream, Ideogram).
2. **Quote dialogue in video prompts** — Veo, Sora 2, Kling all parse quoted strings as speech. SFX as plain text.
3. **Specify camera terms explicitly** — "dolly," "pan," "POV," "tracking shot," "extreme close-up" work across Veo 3.1, Kling v3, Seedance 2.
4. **Put reference images first** in multi-image prompts — most models prioritize the first reference.
5. **Seeds are reproducibility, not style-transfer** — fixing a seed preserves a generation, not a style. For style transfer use model-specific `image_prompt` or `reference_image_urls` params.

## Source note + staleness

- Bundle copied from user's Obsidian vault at `raw/api-docs/fal/` on 2026-04-17.
- Master bundle has a `sync_fal_models.py` script that can refresh skills against FAL's live API (uses `fal.ai/api/models` + per-model `llms.txt` + OpenAPI). Re-run it in the vault when you want fresh data, then re-copy into this project.
- For any specific parameter that feels stale, fetch `https://fal.ai/models/{slug}/llms.txt` to verify — that's the canonical LLM-friendly source.
