---
name: fal
description: FAL.ai model catalog access — image, video, audio, 3D, LoRA training, and more via fal-ai/ and bytedance/ and wan/ endpoints. Activate when the user configures any nebula node that routes through FAL (kling, sora, veo, flux, seedance, wan, luma, pixverse, ltx, moonvalley, hunyuan3d, recraft, nano-banana via FAL, and 30+ others), when the user mentions a fal-ai/ slug, or when they ask which FAL model to use for a task. Entry point for 160 curated per-model skills + category overviews at `.agents/skills/fal/`.
---

# FAL Skill

## When to use

- User configures any FAL-backed nebula node (see the full mapping below)
- User asks "which FAL model for X" or mentions a specific `fal-ai/*` or `bytedance/*` or `wan/*` slug
- User asks about FAL pricing, rate limits, or endpoint schemas
- Codex is building a graph with a FAL-backed node and needs exact parameter names and valid ranges

## Universal FAL conventions

All FAL endpoints (there are 1,312+ models on the platform, 160 curated here) share the same API shape:

- **Auth:** `Authorization: Key <FAL_KEY>` header. Our backend uses `FAL_KEY`. A few nodes are dual-route: they list the maker's key first in `envKeyName` and name it in `directKeyName`, run on the maker's own API when that key is set and fall back to FAL otherwise: `veo-3` (Vertex, then `GOOGLE_API_KEY`), `veo-3-flf` (Vertex), `meshy-text-to-3d`/`meshy-image-to-3d` (`MESHY_API_KEY`), the seven `ideogram-*` nodes (`IDEOGRAM_API_KEY`) and, since 2026-10-14, `nano-banana-fal`/`nano-banana-fal-edit` (`GOOGLE_API_KEY`, Gemini API), plus `gpt-image-1-5`/`gpt-image-1-5-edit` and `gpt-image-2-fal-generate`/`gpt-image-2-fal-edit` (`OPENAI_API_KEY`, OpenAI's Images API; every param reaches both routes, GPT Image 1.5 leaves OpenAI on 2026-12-01, and GPT Image 2's Square and 16:9 presets stay on FAL). Route precedence, the same in the router, pricing, the spend gate, readiness and the cache key (`backend/services/node_route.py`, mirrored by `frontend/src/lib/directRoute.ts`).
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
| `gpt-image-1-5` | `fal-ai/gpt-image-1.5` | Text-to-Image | [`skills/fal-ai__gpt-image-1.5.md`](skills/fal-ai__gpt-image-1.5.md) |
| `gpt-image-1-5-edit` | `fal-ai/gpt-image-1.5/edit` | Image Editing | [`skills/fal-ai__gpt-image-1.5__edit.md`](skills/fal-ai__gpt-image-1.5__edit.md) |
| `seedream-4-5` | `fal-ai/bytedance/seedream/v4.5/text-to-image` | Text-to-Image | [`skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md`](skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md) |
| `recraft-v4-raster` | `fal-ai/recraft/v4/text-to-image` | Text-to-Image | [`skills/fal-ai__recraft__v4__text-to-image.md`](skills/fal-ai__recraft__v4__text-to-image.md) |
| `recraft-v4-svg` | `fal-ai/recraft/v4/text-to-vector` | Text-to-Image (Vector) | — |
| `kling-v2-1` | `fal-ai/kling-video/v2.1/pro/image-to-video` | Image-to-Video | [`skills/fal-ai__kling-video__v2.1__master__text-to-video.md`](skills/fal-ai__kling-video__v2.1__master__text-to-video.md) |
| `kling-v3` | `fal-ai/kling-video/v3/standard/text-to-video` | Text-to-Video | [`skills/fal-ai__kling-video__v3__standard__text-to-video.md`](skills/fal-ai__kling-video__v3__standard__text-to-video.md) |
| `kling-o3` | `fal-ai/kling-video/o3/standard/image-to-video` | Image-to-Video | [`skills/fal-ai__kling-video__o3__pro__image-to-video.md`](skills/fal-ai__kling-video__o3__pro__image-to-video.md) |
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
| `meshy-text-to-3d` (FAL route) | `fal-ai/meshy/v6/text-to-3d` | Text-to-3D | [`skills/fal-ai__meshy__v6__text-to-3d.md`](skills/fal-ai__meshy__v6__text-to-3d.md) |
| `meshy-image-to-3d` (FAL route) | `fal-ai/meshy/v6/image-to-3d` | Image-to-3D | [`skills/fal-ai__meshy__v6__image-to-3d.md`](skills/fal-ai__meshy__v6__image-to-3d.md) |
| `hunyuan3d-text-to-3d` | `fal-ai/hunyuan3d-v3/text-to-3d` | Text-to-3D | [`skills/fal-ai__hunyuan3d-v3__text-to-3d.md`](skills/fal-ai__hunyuan3d-v3__text-to-3d.md) |
| `hunyuan3d-image-to-3d` | `fal-ai/hunyuan3d-v3/image-to-3d` | Image-to-3D | [`skills/fal-ai__hunyuan3d-v3__image-to-3d.md`](skills/fal-ai__hunyuan3d-v3__image-to-3d.md) |
| `remove-background` | `fal-ai/imageutils/rembg` | Transform | [`skills/fal-ai__imageutils__rembg.md`](skills/fal-ai__imageutils__rembg.md) |
| `seedvr2-upscale` | `fal-ai/seedvr/upscale/image` | Upscaling | [`skills/fal-ai__seedvr__upscale__image.md`](skills/fal-ai__seedvr__upscale__image.md) |
| `fal-universal` | user-provided slug | Any | route to the matching file under `skills/` |

**Routing note:** Dual-route nodes have two handlers (direct + FAL); the configured keys pick one, not a param. Params split into `sharedParams` (both routes), `falParams` (FAL only) and `directParams` (direct only). The router (`backend/execution/maker_routes.py` `dual_route`, or `_ideogram_router`/the Veo router) sends each route only its own params, on a copy of the node; the Inspector and Create show the active route's set. Prices can differ per route: `model_pricing.json` `routes` (e.g. `nano-banana-fal` bills FAL's rate on FAL and Google's on the Gemini API). `seedream-4-5` (and `cinema-scene` through it) runs on BytePlus ModelArk when `BYTEPLUS_API_KEY` is saved, unless `seed` is set or the size is one ModelArk can't render (`square`, `auto_3K` on 4.5, a custom size outside its pixel range); `seed` and `enable_safety_checker` are FAL-only. The Seedance nodes (`seedance-2-t2v`, `-2-i2v`, `-2-r2v`, `-2-fast-t2v`, `-2-fast-i2v`, `seedance-v1-5`, `seedance-1-0-t2v`) also run on BytePlus with that key; `seed` is FAL-only on the 2.0 nodes (a set one keeps the run on FAL) and `enable_safety_checker` on `seedance-1-0-t2v`. See the `byteplus` skill.

## fal as a route (FLUX 3, Krea 3 and FLUX.2, 2026-10-15)

Route-table nodes are one node per model with a provider switcher (`_provider`, `docs/PROVIDER-ROUTES.md`); fal is one of their routes. They aren't in the table above and aren't `sync_runner.py` wrappers: the `fal` route client in `backend/execution/route_clients.py` calls `handle_fal_universal` on the endpoint the route picks. fal forwards every param it gets, so the route sends only its own settings plus the media fields. Auto takes the maker's route first; when a setting doesn't fit fal (1.5k, 9:21), the run stops and offers the routes that take it.

| Node | Maker | fal endpoint | Notes |
|---|---|---|---|
| `flux-3-image` | BFL | `blackforestlabs/flux-3/text-to-image`, `/edit-image` when images are wired | no 1.5k or 9:21; fal-only `enable_prompt_expansion` (default off); prices unconfirmed |
| `flux-3-image-klein-base` | (fal only) | `blackforestlabs/flux-3/klein/base/text-to-image`, `/edit-image` | fal's names: `image_size` presets, `seed`, `output_format`, `enable_prompt_expansion`, `enable_safety_checker` |
| `flux-3-video` | BFL | `blackforestlabs/flux-3/{text-to-video, image-to-video, first-last-frame-to-video, keyframes-to-video, extend-video}`, each with a `/draft` variant, picked by the wired ports and `draft` | resolution sent as 720p / 1080p / 1440p / 2160p; no 9:21; drafts at hd only; 30-minute poll budget |
| `flux-video-edit` | BFL | `blackforestlabs/flux-3/edit-video` | the same model as BFL's FLUX Video Edit [fast] (fal's title, price, limits and fields match) |
| `flux-video-upscale` | BFL | `blackforestlabs/flux-video-upscale` | `creativity`, `upscale_factor`; prices unconfirmed |
| `flux-2-pro` (FLUX.2) | BFL | by `model`: `fal-ai/flux-2-pro`, `fal-ai/flux-2-max`, `fal-ai/flux-2/flash`, `fal-ai/flux-2-flex`, `fal-ai/flux-2/klein/9b`, `fal-ai/flux-2/klein/4b` | was a fal-only `sync_runner.py` wrapper; Auto runs it on BFL once `BFL_API_KEY` is set. Flash is fal only (BFL stops and offers fal). fal-only `enable_safety_checker` (default on; saved off, BFL stops). `num_inference_steps` (2-50) and `guidance_scale` on Flex only, hidden and not sent on the others. Klein drops `safety_tolerance` and stops any value but `"2"`. `model` must be a lowercase enum value, or the run stops. Flash and Klein prices unconfirmed ([`skills/fal-ai__flux-2-pro.md`](skills/fal-ai__flux-2-pro.md)) |
| `krea-3` | Krea | `krea/v3/text-to-image`, `krea/v3/edit` when images are wired | fal-only `model` berry/jam, `reasoning_level` (high needs references), `image_size`, `negative_prompt`, `output_format`; $0.025/MP (unconfirmed) |

`flux-3-image-klein` has no fal route: fal's Klein takes only exact pixel sizes, and BFL publishes no exact size for its tiers. Details per node: the `bfl` and `krea` skills.

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
2. **Quote dialogue in video prompts** — Veo and Kling parse quoted strings as speech. SFX as plain text.
3. **Specify camera terms explicitly** — "dolly," "pan," "POV," "tracking shot," "extreme close-up" work across Veo 3.1, Kling v3, Seedance 2.
4. **Put reference images first** in multi-image prompts — most models prioritize the first reference.
5. **Seeds are reproducibility, not style-transfer** — fixing a seed preserves a generation, not a style. For style transfer use model-specific `image_prompt` or `reference_image_urls` params.

## Source note + staleness

- Bundle copied into this repo from the project reference docs on 2026-04-17.
- Master bundle has a `sync_fal_models.py` script that can refresh skills against FAL's live API (uses `fal.ai/api/models` + per-model `llms.txt` + OpenAPI). Re-run it in the vault when you want fresh data, then re-copy into this project.
- For any specific parameter that feels stale, fetch `https://fal.ai/models/{slug}/llms.txt` to verify — that's the canonical LLM-friendly source.
