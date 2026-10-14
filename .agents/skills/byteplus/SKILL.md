---
name: byteplus
description: BytePlus ModelArk in Nebula — ByteDance's own API for Seedream images and Seedance video, used as the direct route for the fal Seedream node (seedream-4-5, and cinema-scene through it), the Krea Seedream copies (krea-image-bytedance-seedream-4, -5-lite, -5-pro), the fal Seedance nodes (seedance-2-t2v, -2-i2v, -2-r2v, -2-fast-t2v, -2-fast-i2v, seedance-v1-5, seedance-1-0-t2v) and the Krea Seedance copies (krea-video-bytedance-seedance-1-0-pro, -1-0-pro-fast, -2, -2-fast, -2-mini, -2-5) when BYTEPLUS_API_KEY is saved. Activate when the user asks about BytePlus, ModelArk, running Seedream or Seedance on ByteDance's API, a ModelNotOpen or BytePlus error, or which route a Seedream or Seedance node takes. Sourced from docs.byteplus.com (image-generation-api, create-video-generation-task-api, model-pricing, model-list, error-codes, region-availability, Service Specific Terms) on 2026-10-14; user guide at docs/api-guides/byteplus.md.
---

# BytePlus ModelArk

## Hard facts first

- **Not available in the United States.** BytePlus Service Specific Terms, "Model Services": "The BytePlus Model Services are not available in the United States." Don't steer a US user to BytePlus; the fal or Krea key keeps working for the same nodes.
- **Region:** Nebula calls Asia Pacific only, `https://ark.ap-southeast.bytepluses.com/api/v3`. Keys and model activation are per region, so an EU console key fails here.
- **Activation:** each model must be switched on in the ModelArk console's Model activation page (https://ai.byteplus.com/ark/region:ap-southeast-1/openManagement) before it runs. Otherwise: 404 `ModelNotOpen`. Seedance 2.x needs USD 30 of credits (or a USD 30 Savings Plan / resource pack) before activation.
- **Key:** `BYTEPLUS_API_KEY` (not Volcengine's `ARK_API_KEY`), sent as `Authorization: Bearer`. Nebula never probes it (no free read-only check is documented).

## Which route a Seedream node takes

Same rules in routing, pricing, the spend gate, readiness and the cache key (`backend/services/node_route.py`, mirrored in `frontend/src/lib/directRoute.ts`):

1. Krea copy set to the Krea plan (`_kreaAuth == "mcp"`): Krea plan.
2. `BYTEPLUS_API_KEY` saved and the recipe fits ModelArk: BytePlus, billed by BytePlus.
3. Otherwise the fal key (`seedream-4-5`) or the Krea API token (Krea copies).

What keeps a run on the copy (the readiness line names it):

- `seedream-4-5`: a set `seed` (`directRoute.blockedBy`); `image_size` of `square` (512x512), `auto_3K` on model 4.5, or a custom `{width, height}` outside 3,686,400–16,777,216 pixels or past 16:1 (`directRoute.size`).
- Krea copies: set `style_images` (Krea's `strength` has no ModelArk field); `width` x `height` outside the model's limits — 4.0: 921,600–16,777,216 px; 5 Lite: 3,686,400–16,777,216; 5 Pro: 921,600–4,624,220.

To move a recipe onto BytePlus, clear the seed or style images, or pick a size it takes. Never rewrite someone's recipe silently to make it fit.

## Models

| Node | Choice | ModelArk id | Price per image (USD) |
|---|---|---|---|
| `seedream-4-5` | `model: 4.5` | `seedream-4-5-251128` | 0.04 |
| `seedream-4-5` | `model: 5.0-lite` | `seedream-5-0-lite-260128` | 0.035 |
| `krea-image-bytedance-seedream-4` | | `seedream-4-0-250828` | 0.03 |
| `krea-image-bytedance-seedream-5-lite` | | `seedream-5-0-lite-260128` | 0.035 |
| `krea-image-bytedance-seedream-5-pro` | | `dola-seedream-5-0-pro-260628` | 0.045 (≤ 2.61 MP) / 0.09 (above) |

Only successful images are billed. On `seedream-4-5`, `num_images` sends that many separate requests; `max_images` > 1 turns on sequential generation, where the model returns 1 to `max_images` images, so the estimate is a range. The output port shows the first image; every image is saved.

## Request shape

`POST /images/generations`, synchronous: `model`, `prompt`, `size` (a tier like `2K` or `WxH`, never both), optional `image` (URLs or `data:image/<fmt>;base64,...`, up to 10 from the node), `sequential_image_generation: auto` + `sequential_image_generation_options.max_images` only when `max_images` > 1 (left out for one image: the default is `disabled`, and Seedream 5.0 pro doesn't take the field), `watermark: false`, `response_format: b64_json`. ModelArk has no seed, negative prompt or count field.

## Errors

`backend/handlers/byteplus.py` `explain()` adds the fix to BytePlus's code: `AuthenticationError` (check the key and region), `ModelNotOpen` / `InvalidEndpointOrModel.*` / `OperationDenied.ServiceNotOpen` (activate the model), `AccountOverdueError` (top up), `QuotaExceeded` (free-trial quota used up or too many queued tasks), other 429 (rate limit), `*SensitiveContentDetected` (change the prompt or inputs).

## Seedance video

Same three-step route order. Runway's Seedance options (`runway-video`) are not routed (Runway resells them).

| Node | ModelArk id | Stays on its copy when |
|---|---|---|
| `seedance-2-t2v`, `-2-i2v`, `-2-r2v` | `dreamina-seedance-2-0-260128` | `seed` set |
| `seedance-2-fast-t2v`, `-2-fast-i2v` | `dreamina-seedance-2-0-fast-260128` | `seed` set |
| `seedance-v1-5` (`model` 1.5 / 1.0) | `seedance-1-5-pro-251215` / `seedance-1-0-pro-250528` | never |
| `seedance-1-0-t2v` | `seedance-1-0-pro-250528` | `enable_safety_checker` switched off (ModelArk always filters; left on, it isn't sent) |
| `krea-video-bytedance-seedance-1-0-pro` | `seedance-1-0-pro-250528` | `start_video` or `reference_images` set |
| `krea-video-bytedance-seedance-1-0-pro-fast` | `seedance-1-0-pro-fast-251015` | `start_video` set |
| `krea-video-bytedance-seedance-2`, `-2-fast` | 2.0 / 2.0 fast | `seed` or `effects` set; `upscale` or `enhance_prompt` on |
| `krea-video-bytedance-seedance-2-mini` | `dreamina-seedance-2-0-mini-260615` | `seed` set |
| `krea-video-bytedance-seedance-2-5` | `dreamina-seedance-2-5-260628` | `seed` or `effects` set; `enhance_prompt` or `draft` on |

Krea copies also stay on Krea for an `aspect_ratio` outside 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, or a duration that isn't whole seconds in range (1.0: 2–12, 2.0: 4–15, 2.5: 4–30). That's `directRoute.accepts` (route reason `value`), for settings that have defaults and so can't be `blockedBy` blockers.

Hard facts:

- `seed` and `camera_fixed` are documented for 1.5 pro, 1.0 pro and 1.0 pro fast only. Never send a seed to 2.x.
- Frames (`first_frame`, `last_frame`) and references (`reference_image`/`_video`/`_audio`) "cannot be mixed". Last frame isn't on 1.0 pro fast. References: 2.0 series 9 images / 3 videos / 3 audio; 2.5 30 / 10 / 10; none on 1.x. 2.0 rejects audio-only input.
- Reference videos are "Video URL or asset ID" only: a local file is refused before the request. Images and audio go as data URIs when local.
- A setting the recipe never saved uses the node's own default (the value its price reads), not BytePlus's: an unsaved `duration` on `seedance-v1-5` / `seedance-1-0-t2v` is 5 s, never `-1`, and an unsaved ratio is 16:9 (1.0 text-to-video doesn't take `adaptive`).
- Tasks are async: create, poll every 5 s, save `video_url` at once (valid 24 h). Nebula sends `watermark: false` and `execution_expires_after: 3600`. DELETE cancels only a queued task; a running one finishes and is billed.
- Price: tokens = (input video s + output s) x width x height x 24 / 1024, times the per-million rate (2.5 10.70 / 11.7 at 1080p; 2.0 7.0 / 7.7 / 4.0 at 4K; 2.0 fast 5.6; mini 3.5; 1.5 pro 2.4 with audio, 1.2 silent; 1.0 pro 2.5; 1.0 pro fast 1). Runs with reference videos are unpriced. Code: `backend/execution/byteplus_seedance_prices.py`.
- 1.5 pro is "Retiring" (replacement: 2.0 mini) with no date published.

Code: `backend/execution/maker_routes_byteplus_seedance.py` (translations, handlers), `backend/handlers/byteplus.py` (`run_video_task`).

## Not wired yet

- Seedream 5.0 flash, and a region setting (eu-west-1 Seedream support is not confirmed).
