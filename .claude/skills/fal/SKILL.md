---
name: fal
description: FAL (fal.ai) is Nebula's all-purpose generation gateway — one API key fronts 45 ready-to-use nodes for image, video, 3D, and audio generation (FLUX, GPT Image 1.5/2, Seedream, Recraft, Sora 2, Kling, Wan, Luma Ray 2, PixVerse, LTX, Seedance, Hunyuan3D, Meshy, Stable Audio 2.5, ACE-Step, MMAudio V2, Demucs, Clarity Upscaler, SeedVR2 Video Upscale) plus the catch-all `fal-universal` slug node. Activate when the user configures any FAL node — flux-1-1-ultra, flux-2-pro, flux-schnell, fast-sdxl, flux-kontext, flux-fill-inpaint, gpt-image-1-5, gpt-image-1-5-edit, gpt-image-2-fal-generate, gpt-image-2-fal-edit, seedream-4-5, recraft-v4-raster, recraft-v4-svg, sora-2, kling-v2-1, kling-v3, kling-o3, wan-2-6-t2v, wan-2-6-i2v, wan-2-6-r2v, luma-ray2-t2v, luma-ray2-i2v, luma-ray2-flash-modify, pixverse-v4-5, ltx-video-2, ltx-2-3, seedance-2-t2v, seedance-2-i2v, seedance-2-r2v, seedance-2-fast-t2v, seedance-2-fast-i2v, seedance-v1-5, meshy-text-to-3d, meshy-image-to-3d, hunyuan3d-text-to-3d, hunyuan3d-image-to-3d, remove-background, seedvr2-upscale, clarity-upscaler, seedvr-video-upscale, stable-audio-25, ace-step, mmaudio-v2, demucs, fal-universal — or asks about FAL in Nebula, which `fal-ai/*` model to use, or how a FAL node is wired. Sourced from the Nebula audit guide `docs/api-guides/fal.md`, the live node roster in `backend/data/node_definitions.json`, the handler `backend/handlers/fal_universal.py`, and FAL's official docs (https://fal.ai/docs) on 2026-06-04.
---

# FAL Skill

## When to use

- The user configures or builds with any of the 45 FAL-backed Nebula nodes (full list in **Pick the right node**).
- The user asks "which FAL model for X" or mentions a specific `fal-ai/*`, `bytedance/*`, `wan/*`, or `openai/gpt-image-2` slug.
- The user wants to reach a FAL catalog model Nebula has no dedicated node for (use the `fal-universal` escape-hatch node).
- Claude is building a graph with a FAL node and needs exact input ports, param names, valid ranges, and output ports.
- The user asks whether Nebula can do something with FAL that it actually **cannot** (audio/TTS, LLM/vision, LoRA training) — see **Capability boundaries**.

## Universal rules

These describe how Nebula's single shared handler (`backend/handlers/fal_universal.py`) talks to FAL. Every one of the 45 nodes routes through it.

1. **Auth header + env var.** `Authorization: Key <FAL_KEY>`. The backend reads a single `FAL_KEY` (set in the repo-root `.env`, then restart the backend). Missing key → `ValueError("FAL_KEY is required")` at run time. Two nodes have a fallback preference: `meshy-text-to-3d` and `meshy-image-to-3d` use the **direct Meshy API** when `MESHY_API_KEY` is set, and only fall back to FAL when it is not. No other FAL node accepts a native-provider key in this handler.
2. **Base URL.** Always `https://queue.fal.run/{endpoint_id}` (the queue transport). The handler never uses the synchronous `https://fal.run/...` host, even for "fast" models. `{endpoint_id}` is the slug from the **Pick the right node** table, injected per-node by `sync_runner.py` via `node.params.setdefault("endpoint_id", ...)`.
3. **Execution pattern (confirmed from the handler):** **queue submit → poll → fetch result** for 43 of 45 nodes. The two exceptions are the GPT Image 2 nodes (`gpt-image-2-fal-generate` and `gpt-image-2-fal-edit`), which use **SSE streaming** (`POST {endpoint}/stream`, `Accept: text/event-stream`) for progressive image preview. Queue flow:
   1. `POST https://queue.fal.run/{endpoint_id}` with the JSON body → `{"request_id", "status_url", "response_url"}`.
   2. Poll `GET {status_url}` every **2s, up to 300 times** (~10 min cap) until `"status": "COMPLETED"`. States: `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`.
   3. `GET {response_url}` to fetch the result, then parse (`_parse_fal_output`).
   - If the submit response has **no** `request_id`, the handler treats the body as the final result directly (some endpoints answer synchronously).
   - **Metadata caveat:** the node definitions declare `executionPattern: "sync"` for `fast-sdxl`/`flux-schnell` and `"stream"` for the two GPT Image 2 nodes, but at runtime only the GPT Image 2 pair actually streams — `fast-sdxl` and `flux-schnell` still go through the queue path like everything else.
4. **Status / error codes.** Submit accepts `200`/`201`; anything else → `RuntimeError("FAL submit failed (<code>): ...")`. Status poll accepts `200`/`202`. A `FAILED` or `CANCELLED` status raises with FAL's `error` field. Timeout after 300 polls raises `"FAL job timed out"`. Typical HTTP meanings: `401` bad key · `402` insufficient credit · `422` invalid params · `429` rate limit.
5. **Input-URI rules.** You may paste a **local file path** or a **public http(s) URL** into any image/video/audio input port. The handler's `_to_fal_url` passes `http://`, `https://`, and `data:` values through unchanged, and **base64-inlines local files as `data:` URIs** before sending. There is no separate upload step. Caveat: large local files bloat the JSON request body (Nebula does **not** use FAL's `upload_file` storage API). Prefer URLs for big videos.
6. **Input port → FAL payload-key mapping** (this is the Nebula-specific wiring an agent must get right — the port id on the canvas is **not** the FAL key):

   | Nebula input port | FAL request key | Used by |
   |---|---|---|
   | `prompt` | `prompt` | all text-driven nodes |
   | `image` | `image_url` | single-image nodes (i2v, edit, transforms) |
   | `images` | `image_urls` (list) | `gpt-image-1-5-edit`, `gpt-image-2-fal-edit`, `seedance-2-r2v` |
   | `mask` | `mask_url` | `flux-fill-inpaint` (white = the region to edit) |
   | `video` | `video_url` | `luma-ray2-flash-modify` |
   | `audio` | `audio_url` | `ltx-2-3` |
   | `end_image` | `end_image_url` | kling-v3, kling-o3, luma-ray2-i2v, seedance-2-i2v/-fast-i2v/-v1-5 |
   | `tail_image` | `tail_image_url` | `kling-v2-1` (end frame) |
   | `front_image` | `input_image_url` | `hunyuan3d-image-to-3d` (primary view) |
   | `back_image` / `left_image` / `right_image` | `back_image_url` / `left_image_url` / `right_image_url` | `hunyuan3d-image-to-3d` |
   | `texture_image` | `texture_image_url` | (handler-supported; no current node exposes it) |
   | `video1` / `video2` / `video3` | collated into `video_urls` (list) | `wan-2-6-r2v` (special-cased in `sync_runner.py`, not the universal handler) |

   All other node params are forwarded to the request body **as-is, except `endpoint_id`** (internal) and any param whose value is `None` or `""` (silently dropped — empty optionals are omitted, which is correct since FAL rejects empty typed values).
7. **Output parsing (port your downstream node expects).** `_parse_fal_output` detects type in priority order: **mesh** (`model_urls.glb` / `glb` / `model_glb` / `model_mesh`) → **image/SVG** (`images[]`; `content_type` containing `svg` routes to an `svg` port) → single **image** → **audio** → **video** → **text** fallback. Output URLs are signed and **expire** — downstream nodes download promptly.
8. **Key gotchas.**
   - `gpt-image-1-5-edit` and `gpt-image-2-fal-edit` **require at least one reference image** on the `images` port, or the handler raises before submitting.
   - `sora-2` selects the Pro endpoint (`fal-ai/sora-2/text-to-video/pro`) when its `model` param is `pro`; the param is popped before send (FAL doesn't receive `model`).
   - `fast-sdxl` (`loras`, `embeddings`) and `kling-v3` (`multi_prompt`) accept **JSON-string** params; the wrapper parses them to arrays/objects and drops them if empty or unparseable.
   - `recraft-v4-raster`/`-svg` post-process `colors`/`background_color` (comma-separated hex) in the wrapper before send.
   - Local-file inlining means a tiny PNG is fine but a 200 MB mp4 base64-encoded into JSON can fail the request — use a URL.

## Pick the right node

All 45 nodes below carry `apiProvider: "fal"` in `backend/data/node_definitions.json`. Endpoint = the slug injected as `endpoint_id`. The right-most column links the matching per-model spec file under `skills/` where one exists (use it for pricing + deep param notes).

| Nebula node id | Display name | Category | FAL endpoint | Key inputs → ports | Per-model file |
|---|---|---|---|---|---|
| `flux-1-1-ultra` | FLUX 1.1 Ultra | image | `fal-ai/flux-pro/v1.1-ultra` | prompt, image | [`skills/fal-ai__flux-pro__v1.1-ultra.md`](skills/fal-ai__flux-pro__v1.1-ultra.md) |
| `flux-2-pro` | FLUX 2 Pro | image | `fal-ai/flux-2-pro` | prompt | [`skills/fal-ai__flux-2-pro.md`](skills/fal-ai__flux-2-pro.md) |
| `flux-schnell` | FLUX Schnell | image | `fal-ai/flux/schnell` | prompt | [`skills/fal-ai__flux__schnell.md`](skills/fal-ai__flux__schnell.md) |
| `fast-sdxl` | Fast SDXL | image | `fal-ai/fast-sdxl` | prompt | [`skills/fal-ai__fast-sdxl.md`](skills/fal-ai__fast-sdxl.md) |
| `flux-kontext` | FLUX Kontext | image (edit) | `fal-ai/flux-pro/kontext` | prompt, image | [`skills/fal-ai__flux-pro__kontext.md`](skills/fal-ai__flux-pro__kontext.md) |
| `flux-fill-inpaint` | FLUX Fill (Inpaint) | image (inpaint) | `fal-ai/flux-pro/v1/fill` | prompt + image + mask → image out | [`skills/fal-ai__flux-pro__v1__fill.md`](skills/fal-ai__flux-pro__v1__fill.md) |
| `gpt-image-1-5` | GPT Image 1.5 | image | `fal-ai/gpt-image-1.5` | prompt | [`skills/fal-ai__gpt-image-1.5.md`](skills/fal-ai__gpt-image-1.5.md) |
| `gpt-image-1-5-edit` | GPT Image 1.5 Edit | image (edit) | `fal-ai/gpt-image-1.5/edit` | prompt, images | [`skills/fal-ai__gpt-image-1.5__edit.md`](skills/fal-ai__gpt-image-1.5__edit.md) |
| `gpt-image-2-fal-generate` | GPT Image 2 (FAL) | image (**stream**) | `openai/gpt-image-2` | prompt | — |
| `gpt-image-2-fal-edit` | GPT Image 2 Edit (FAL) | image (**stream**, edit) | `openai/gpt-image-2/edit` | images, prompt | — |
| `seedream-4-5` | Seedream 4.5 | image | `fal-ai/bytedance/seedream/v4.5/text-to-image` | prompt | [`skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md`](skills/fal-ai__bytedance__seedream__v4.5__text-to-image.md) |
| `recraft-v4-raster` | Recraft V4 | image | `fal-ai/recraft/v4/text-to-image` | prompt | [`skills/fal-ai__recraft__v4__text-to-image.md`](skills/fal-ai__recraft__v4__text-to-image.md) |
| `recraft-v4-svg` | Recraft V4 SVG | image (vector) | `fal-ai/recraft/v4/text-to-vector` | prompt → **svg** out | — |
| `sora-2` | Sora 2 | video (t2v) | `fal-ai/sora-2/text-to-video` (`/pro` when `model=pro`) | prompt | [`skills/fal-ai__sora-2__text-to-video.md`](skills/fal-ai__sora-2__text-to-video.md) |
| `kling-v2-1` | Kling v2.1 | video (i2v) | `fal-ai/kling-video/v2.1/pro/image-to-video` | image, prompt, tail_image | [`skills/fal-ai__kling-video__v2.1__pro__image-to-video.md`](skills/fal-ai__kling-video__v2.1__pro__image-to-video.md) |
| `kling-v3` | Kling V3 | video (t2v/i2v) | `fal-ai/kling-video/v3/standard/text-to-video` | prompt, image, end_image | [`skills/fal-ai__kling-video__v3__standard__text-to-video.md`](skills/fal-ai__kling-video__v3__standard__text-to-video.md) |
| `kling-o3` | Kling Omni 3 | video (i2v) | `fal-ai/kling-video/o3/standard/image-to-video` | image, prompt, end_image | [`skills/fal-ai__kling-video__o3__standard__image-to-video.md`](skills/fal-ai__kling-video__o3__standard__image-to-video.md) |
| `wan-2-6-t2v` | Wan 2.6 T2V | video (t2v) | `wan/v2.6/text-to-video` | prompt | [`skills/wan__v2.6__text-to-video.md`](skills/wan__v2.6__text-to-video.md) |
| `wan-2-6-i2v` | Wan 2.6 I2V | video (i2v) | `wan/v2.6/image-to-video` | image, prompt | [`skills/wan__v2.6__image-to-video.md`](skills/wan__v2.6__image-to-video.md) |
| `wan-2-6-r2v` | Wan 2.6 R2V | video (r2v) | `wan/v2.6/reference-to-video` | prompt, video1–3 → `video_urls` | [`skills/wan__v2.6__reference-to-video.md`](skills/wan__v2.6__reference-to-video.md) |
| `luma-ray2-t2v` | Luma Ray 2 | video (t2v) | `fal-ai/luma-dream-machine/ray-2` | prompt | [`skills/fal-ai__luma-dream-machine__ray-2.md`](skills/fal-ai__luma-dream-machine__ray-2.md) |
| `luma-ray2-i2v` | Luma Ray 2 I2V | video (i2v) | `fal-ai/luma-dream-machine/ray-2/image-to-video` | image, end_image, prompt | [`skills/fal-ai__luma-dream-machine__ray-2__image-to-video.md`](skills/fal-ai__luma-dream-machine__ray-2__image-to-video.md) |
| `luma-ray2-flash-modify` | Luma Ray 2 Flash Modify | video (v2v) | `fal-ai/luma-dream-machine/ray-2-flash/modify` | video, prompt, image | — |
| `pixverse-v4-5` | PixVerse V4.5 | video (t2v/i2v) | `fal-ai/pixverse/v4.5/text-to-video` | prompt, image | [`skills/fal-ai__pixverse__v4.5__text-to-video.md`](skills/fal-ai__pixverse__v4.5__text-to-video.md) |
| `ltx-video-2` | LTX Video 2 | video (i2v) | `fal-ai/ltx-2/image-to-video` | image, prompt | [`skills/fal-ai__ltx-2__image-to-video.md`](skills/fal-ai__ltx-2__image-to-video.md) |
| `ltx-2-3` | LTX 2.3 | video (i2v) | `fal-ai/ltx-2.3/image-to-video` | image, prompt, end_image, audio | [`skills/fal-ai__ltx-2.3__image-to-video.md`](skills/fal-ai__ltx-2.3__image-to-video.md) |
| `seedance-2-t2v` | Seedance 2.0 T2V | video (t2v) | `bytedance/seedance-2.0/text-to-video` | prompt | [`skills/bytedance__seedance-2.0__text-to-video.md`](skills/bytedance__seedance-2.0__text-to-video.md) |
| `seedance-2-i2v` | Seedance 2.0 I2V | video (i2v) | `bytedance/seedance-2.0/image-to-video` | image, prompt, end_image | [`skills/bytedance__seedance-2.0__image-to-video.md`](skills/bytedance__seedance-2.0__image-to-video.md) |
| `seedance-2-r2v` | Seedance 2.0 R2V | video (r2v) | `bytedance/seedance-2.0/reference-to-video` | prompt, images → `image_urls` | [`skills/bytedance__seedance-2.0__reference-to-video.md`](skills/bytedance__seedance-2.0__reference-to-video.md) |
| `seedance-2-fast-t2v` | Seedance 2.0 Fast T2V | video (t2v) | `bytedance/seedance-2.0/fast/text-to-video` | prompt | [`skills/bytedance__seedance-2.0__fast__text-to-video.md`](skills/bytedance__seedance-2.0__fast__text-to-video.md) |
| `seedance-2-fast-i2v` | Seedance 2.0 Fast I2V | video (i2v) | `bytedance/seedance-2.0/fast/image-to-video` | image, prompt, end_image | [`skills/bytedance__seedance-2.0__fast__image-to-video.md`](skills/bytedance__seedance-2.0__fast__image-to-video.md) |
| `seedance-v1-5` | Seedance V1.5 Pro (I2V) | video (i2v) | `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | prompt, image, end_image | [`skills/fal-ai__bytedance__seedance__v1.5__pro__image-to-video.md`](skills/fal-ai__bytedance__seedance__v1.5__pro__image-to-video.md) |
| `meshy-text-to-3d` | Meshy 6 Text-to-3D | 3d | `fal-ai/meshy/v6/text-to-3d` (or direct Meshy if `MESHY_API_KEY`) | prompt → **mesh** out | [`skills/fal-ai__meshy__v6__text-to-3d.md`](skills/fal-ai__meshy__v6__text-to-3d.md) |
| `meshy-image-to-3d` | Meshy 6 Image-to-3D | 3d | `fal-ai/meshy/v6/image-to-3d` (or direct Meshy if `MESHY_API_KEY`) | image → **mesh** out | [`skills/fal-ai__meshy__v6__image-to-3d.md`](skills/fal-ai__meshy__v6__image-to-3d.md) |
| `hunyuan3d-text-to-3d` | Hunyuan3D V3 Text-to-3D | 3d | `fal-ai/hunyuan3d-v3/text-to-3d` | prompt → **mesh** out | [`skills/fal-ai__hunyuan3d-v3__text-to-3d.md`](skills/fal-ai__hunyuan3d-v3__text-to-3d.md) |
| `hunyuan3d-image-to-3d` | Hunyuan3D V3 Image-to-3D | 3d | `fal-ai/hunyuan3d-v3/image-to-3d` | front/back/left/right_image → **mesh** out | [`skills/fal-ai__hunyuan3d-v3__image-to-3d.md`](skills/fal-ai__hunyuan3d-v3__image-to-3d.md) |
| `remove-background` | Remove Background | transform | `fal-ai/imageutils/rembg` | image | [`skills/fal-ai__imageutils__rembg.md`](skills/fal-ai__imageutils__rembg.md) |
| `seedvr2-upscale` | SeedVR2 Upscale | transform | `fal-ai/seedvr/upscale/image` | image | [`skills/fal-ai__seedvr__upscale__image.md`](skills/fal-ai__seedvr__upscale__image.md) |
| `clarity-upscaler` | Clarity Upscaler | transform | `fal-ai/clarity-upscaler` | image → image out | [`skills/fal-ai__clarity-upscaler.md`](skills/fal-ai__clarity-upscaler.md) |
| `seedvr-video-upscale` | SeedVR2 Video Upscale | transform | `fal-ai/seedvr/upscale/video` | video → video out | [`skills/fal-ai__seedvr__upscale__video.md`](skills/fal-ai__seedvr__upscale__video.md) |
| `stable-audio-25` | Stable Audio 2.5 | audio | `fal-ai/stable-audio-25/text-to-audio` | prompt → **audio** out | [`skills/fal-ai__stable-audio-25__text-to-audio.md`](skills/fal-ai__stable-audio-25__text-to-audio.md) |
| `ace-step` | ACE-Step | audio | `fal-ai/ace-step` | (param-only) → **audio** out | [`skills/fal-ai__ace-step.md`](skills/fal-ai__ace-step.md) |
| `mmaudio-v2` | MMAudio V2 | audio | `fal-ai/mmaudio-v2` | video + prompt → video out | [`skills/fal-ai__mmaudio-v2.md`](skills/fal-ai__mmaudio-v2.md) |
| `demucs` | Demucs | audio | `fal-ai/demucs` | audio → vocals/drums/bass/other | [`skills/fal-ai__demucs.md`](skills/fal-ai__demucs.md) |
| `fal-universal` | FAL | universal | user-set `endpoint_id` (default `fal-ai/flux-pro/v1.1-ultra`) | prompt, image | route to matching file under `skills/` |

> The bundle ships **169 per-model spec files** under `skills/` and **16 category overviews** under `categories/` covering the full FAL catalog (including audio, LLM, vision, and training models that Nebula does **not** wrap). Those extra files are reference material for the `fal-universal` escape hatch, not 169 Nebula nodes. The authoritative Nebula roster is the **45 ids above**.

## Param reference

Types, defaults, ranges, and enums below come straight from `backend/data/node_definitions.json`. Inputs marked `*` are required ports. Where a node lists no params, only `defaults` apply (just wire the inputs).

**Image — text-to-image**

- `flux-1-1-ultra` — in: `prompt*`, `image`. out: `image`. Params: *(none — defaults only).*
- `flux-2-pro` — in: `prompt*`. out: `image`. Params: `image_size` enum [square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3 (default), landscape_16_9]; `output_format` enum [jpeg (default), png]; `safety_tolerance` enum 1–5 (default 2); `enable_safety_checker` bool (default true); `seed` int.
- `flux-schnell` — in: `prompt*`. out: `image`. Params: `image_size` enum (default landscape_4_3); `num_inference_steps` int 1–4 (default 4); `guidance_scale` float 1–5 (default 3.5); `num_images` int 1–4 (default 1); `output_format` enum [jpeg (default), png, webp]; `acceleration` enum [none (default), regular, high]; `enable_safety_checker` bool (default true); `seed` int 0–2147483647.
- `fast-sdxl` — in: `prompt*`. out: `image`. Params: `image_size` enum (default square_hd); `num_images` int 1–4 (default 1); `num_inference_steps` int 1–50 (default 25); `guidance_scale` float 1–20 (default 7.5); `negative_prompt` str; `expand_prompt` bool (default false); `loras` textarea (**JSON array string**); `embeddings` textarea (**JSON array string**); `format` enum [jpeg (default), png]; `enable_safety_checker` bool (default true); `safety_checker_version` enum [v1 (default), v2]; `seed` int 0–4294967295.
- `gpt-image-1-5` — in: `prompt*`. out: `image`. Params: `image_size` enum [1024x1024 (default), 1536x1024, 1024x1536]; `quality` enum [low, medium, high (default)]; `background` enum [auto (default), transparent, opaque]; `num_images` int 1–4 (default 1); `output_format` enum [png (default), jpeg, webp].
- `gpt-image-2-fal-generate` — **streams**. in: `prompt*`. out: `image`. Params: `image_size` enum (default landscape_4_3); `quality` enum [auto, low, medium, high (default)]; `num_images` int 1–4 (default 1); `output_format` enum [png (default), jpeg, webp]; `partial_images` int 0–3 (default 2, controls preview frames).
- `seedream-4-5` — in: `prompt*`. out: `image`. Params: `image_size` enum [square_hd (default), square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9, auto_2K, auto_4K]; `num_images` int 1–6 (default 1); `max_images` int 1–6 (default 1); `enable_safety_checker` bool (default true); `seed` int.
- `recraft-v4-raster` — in: `prompt*`. out: `image`. Params: `image_size` enum (default square_hd); `style_id` str; `colors` str (comma-sep hex); `background_color` str; `enable_safety_checker` bool (default true).
- `recraft-v4-svg` — in: `prompt*`. out: **`svg`** (vector). Params: same as `recraft-v4-raster`.

**Image — editing**

- `flux-kontext` — in: `prompt*`, `image*`. out: `image`. Params: `aspect_ratio` enum [1:1 (default), 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9, 9:21]; `num_images` int 1–4 (default 1); `guidance_scale` float 1–20 (default 3.5); `enhance_prompt` bool (default false); `output_format` enum [jpeg (default), png]; `safety_tolerance` enum 1–6 (default 2); `seed` int.
- `gpt-image-1-5-edit` — in: `prompt*`, `images*` (→ `image_urls`, **≥1 required**). out: `image`. Params: `image_size` enum [auto (default), 1024x1024, 1536x1024, 1024x1536]; `quality` enum [low, medium, high (default)]; `input_fidelity` enum [low, high (default)]; `background` enum [auto (default), transparent, opaque]; `num_images` int 1–4 (default 1); `output_format` enum [png (default), jpeg, webp].
- `gpt-image-2-fal-edit` — **streams**. in: `images*` (→ `image_urls`, **≥1 required**), `prompt*`. out: `image`. Params: `image_size` enum [auto (default), square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9]; `quality` enum [auto, low, medium, high (default)]; `num_images` int 1–4 (default 1); `output_format` enum [png (default), jpeg, webp]; `partial_images` int 0–3 (default 2).

**Video — text-to-video**

- `sora-2` — in: `prompt*`. out: `video`. Params: `resolution` enum [720p (default), 1080p]; `aspect_ratio` enum [16:9 (default), 9:16]; `duration` enum [4 (default), 8, 12, 16, 20]. (A UI `model` toggle picks Standard vs Pro endpoint; it is consumed by the wrapper, not sent to FAL.)
- `wan-2-6-t2v` — in: `prompt*`. out: `video`. Params: `duration` enum [5 (default), 10, 15]; `resolution` enum [720p (default), 1080p]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1, 4:3, 3:4]; `negative_prompt` str; `seed` int; `generate_audio` bool (default true); `enable_prompt_expansion` bool (default true); `multi_shots` bool (default true); `enable_safety_checker` bool (default true).
- `luma-ray2-t2v` — in: `prompt*`. out: `video`. Params: `aspect_ratio` enum [16:9 (default), 9:16, 4:3, 3:4, 21:9, 9:21]; `duration` enum [5s (default), 9s]; `loop` bool (default false); `resolution` enum [540p (default), 720p, 1080p].
- `seedance-2-t2v` / `seedance-2-fast-t2v` — in: `prompt*`. out: `video`. Params: `aspect_ratio` enum [auto (default), 21:9, 16:9, 4:3, 1:1, 3:4, 9:16]; `duration` enum [auto (default), 4, 5, 6, 8, 10, 12, 15]; `resolution` enum (t2v: [480p, 720p (default), 1080p]; fast: [480p, 720p (default)]); `generate_audio` bool (default true); `seed` int.

**Video — image-to-video**

- `kling-v2-1` — in: `image*`, `prompt`, `tail_image` (end frame → `tail_image_url`). out: `video`. Params: `duration` enum [5 (default), 10]; `negative_prompt` str (default "blur, distort, and low quality"); `cfg_scale` float 0–1 (default 0.5).
- `kling-v3` — in: `prompt*`, `image`, `end_image`. out: `video`. Params: `duration` enum [3, 5 (default), 10, 15]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1]; `negative_prompt` str; `shot_type` enum [customize (default), intelligent]; `multi_prompt` textarea (**JSON array string** of `{prompt,duration}` shots); `generate_audio` bool (default true); `cfg_scale` float 0–1 (default 0.5).
- `kling-o3` — in: `image*`, `prompt`, `end_image`. out: `video`. Params: `duration` enum [3, 5 (default), 10, 15]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1]; `generate_audio` bool (default false); `negative_prompt` str; `cfg_scale` float 0–1 (default 0.5); `shot_type` enum [customize (default), intelligent].
- `wan-2-6-i2v` — in: `image*`, `prompt*`. out: `video`. Params: `duration` enum [5 (default), 10, 15]; `resolution` enum [720p (default), 1080p]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1, 4:3, 3:4]; `negative_prompt` str; `seed` int; `generate_audio` bool (default true); `enable_prompt_expansion` bool (default true); `multi_shots` bool (default false); `enable_safety_checker` bool (default true).
- `luma-ray2-i2v` — in: `image*`, `end_image`, `prompt`. out: `video`. Params: `aspect_ratio` enum [16:9 (default), 9:16, 4:3, 3:4, 21:9, 9:21]; `resolution` enum [540p (default), 720p, 1080p]; `duration` enum [5s (default), 9s]; `loop` bool (default false).
- `pixverse-v4-5` — in: `prompt*`, `image`. out: `video`. Params: `duration` enum [5 (default), 8]; `aspect_ratio` enum [16:9 (default), 4:3, 1:1, 3:4, 9:16]; `resolution` enum [360p, 540p, 720p (default), 1080p]; `style` enum [<none> (default), anime, 3d_animation, clay, comic, cyberpunk]; `negative_prompt` str; `seed` int.
- `ltx-video-2` — in: `image*`, `prompt*`. out: `video`. Params: `duration` enum [6 (default), 8, 10]; `resolution` enum [1080p (default), 1440p, 2160p]; `fps` enum [25 (default), 50]; `generate_audio` bool (default true).
- `ltx-2-3` — in: `image`, `prompt*`, `end_image`, `audio` (→ `audio_url`). out: `video`. Params: `duration` enum [6 (default), 8, 10]; `resolution` enum [1080p (default), 1440p, 2160p]; `aspect_ratio` enum [auto (default), 16:9, 9:16]; `fps` enum [24, 25 (default), 48, 50]; `generate_audio` bool (default true).
- `seedance-2-i2v` / `seedance-2-fast-i2v` — in: `image*`, `prompt*`, `end_image`. out: `video`. Params: `aspect_ratio` enum [auto (default), 21:9, 16:9, 4:3, 1:1, 3:4, 9:16]; `duration` enum [auto (default), 4, 5, 6, 8, 10, 12, 15]; `resolution` enum (i2v: [480p, 720p (default), 1080p]; fast: [480p, 720p (default)]); `generate_audio` bool (default true); `seed` int.
- `seedance-v1-5` — in: `prompt*`, `image*`, `end_image`. out: `video`. Params: `duration` enum [4–12 (default 5)]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1, 21:9, 4:3, 3:4, auto]; `resolution` enum [480p, 720p (default), 1080p]; `generate_audio` bool (default true); `camera_fixed` bool (default false); `seed` int.

**Video — reference-to-video**

- `wan-2-6-r2v` — in: `prompt*`, `video1*`, `video2`, `video3` (the wrapper collates wired ports into `video_urls`; up to 3 reference clips). out: `video`. Params: `duration` enum [5 (default), 10]; `resolution` enum [720p, 1080p (default)]; `aspect_ratio` enum [16:9 (default), 9:16, 1:1, 4:3, 3:4]; `negative_prompt` str; `seed` int; `enable_prompt_expansion` bool (default true); `multi_shots` bool (default true); `enable_safety_checker` bool (default true).
- `seedance-2-r2v` — in: `prompt*`, `images*` (→ `image_urls`, reference image set). out: `video`. Params: `aspect_ratio` enum [auto (default), 21:9, 16:9, 9:16, 4:3, 1:1, 3:4]; `duration` enum [auto (default), 4, 6, 8, 10, 15]; `resolution` enum [480p, 720p (default), 1080p]; `generate_audio` bool (default true); `seed` int.

**Video — modify**

- `luma-ray2-flash-modify` — in: `video*` (→ `video_url`), `prompt`, `image`. out: `video`. Params: `mode` enum [adhere_1/2/3, flex_1 (default)/2/3, reimagine_1/2/3] (higher = more creative deviation).

**3D**

- `meshy-text-to-3d` — in: `prompt*`. out: `mesh`. Params: *(none — defaults only).* Uses direct Meshy API when `MESHY_API_KEY` set.
- `meshy-image-to-3d` — in: `image*`. out: `mesh`. Params: *(none).* Uses direct Meshy API when `MESHY_API_KEY` set.
- `hunyuan3d-text-to-3d` — in: `prompt*`. out: `mesh`. Params: `generate_type` enum [Normal (default), LowPoly, Geometry]; `face_count` int 40000–1500000 (default 500000); `enable_pbr` bool (default false); `polygon_type` enum [triangle (default), quadrilateral].
- `hunyuan3d-image-to-3d` — in: `front_image*` (→ `input_image_url`), `back_image`, `left_image`, `right_image`. out: `mesh`. Params: same as `hunyuan3d-text-to-3d`.

**Transform**

- `remove-background` — in: `image*`. out: `image` (transparent PNG cutout). Params: `crop_to_bbox` bool (default false).
- `seedvr2-upscale` — in: `image*`. out: `image`. Params: `upscale_mode` enum [factor (default), target]; `upscale_factor` float 1–4 (default 2); `target_resolution` enum [720p, 1080p (default), 1440p, 2160p]; `noise_scale` float 0–1 (default 0.1); `output_format` enum [jpg (default), png, webp]; `seed` int.
- `clarity-upscaler` — in: `image*`. out: `image`. Params: `prompt` str (default "masterpiece, best quality, highres"); `upscale_factor` float 1–4 (default 2); `creativity` float 0–1 (default 0.35, added detail); `resemblance` float 0–1 (default 0.6, fidelity to source); `num_inference_steps` ("Steps") int 10–50 (default 18); `seed` int. Diffusion-based (SD1.5 + ControlNet Tile + ESRGAN) — reconstructs realistic detail/texture; pairs with `seedvr2-upscale` (faithful) when you want creative/added detail instead.
- `seedvr-video-upscale` — in: `video*`. out: `video`. Params: `upscale_mode` enum [factor (default), target]; `upscale_factor` float 1–4 (default 2); `target_resolution` enum [720p, 1080p (default), 1440p, 2160p]; `noise_scale` float 0–1 (default 0.1); `output_quality` enum [low, medium, high (default), maximum]; `seed` int. ByteDance SeedVR2 — one-step, temporally-consistent video upscaling/restoration to up to 4K (the video counterpart of `seedvr2-upscale`); chains from any video node's `video` output.

**Universal**

- `fal-universal` — in: `prompt*`, `image`. out: `image` | `video` | `audio` | `mesh` (whichever the response yields). Params: `endpoint_id` str (default `fal-ai/flux-pro/v1.1-ultra`) — paste any catalog slug. Only `prompt` and `image` ports exist, so endpoints needing other inputs (end frames, multi-image, audio) can't be fully driven from this node — wire those through the dedicated wrapper node instead.

## Recipes

1. **Concept still → cinematic shot.** `flux-1-1-ultra` (hero still from a prompt) → wire its `image` output into `kling-v3`'s `image` input, add a motion `prompt` → moving shot on `kling-v3`'s `video` output. Swap in `seedance-2-i2v` or `luma-ray2-i2v` if you want a start **and** end frame (`end_image` port). For a tail-only end frame on Kling 2.1, use `kling-v2-1` with `tail_image`.

2. **Product cutout → spinnable 3D.** `remove-background` (clean a product photo → transparent PNG on its `image` output) → feed that into `meshy-image-to-3d` → download the `.glb` from its `mesh` output. For a sharper mesh, shoot four angles and use `hunyuan3d-image-to-3d` (`front_image`/`back_image`/`left_image`/`right_image` ports) with `enable_pbr` on.

3. **Logo + asset factory.** `recraft-v4-svg` with a brand prompt and a `colors` palette → editable SVG on its `svg` output. Then `recraft-v4-raster` for matching raster art, and `seedvr2-upscale` (`upscale_factor` up to 4) to push any raster to 4K.

4. **Photo → looping clip with sound, no audio node.** `flux-2-pro` (still) → `wan-2-6-i2v` with `generate_audio: true` → a short audio-bearing clip on the `video` output. (FAL bakes audio into the video here; Nebula has no separate FAL audio node — see Capability boundaries.)

5. **Reach an un-wrapped model.** Drop the **FAL** node (`fal-universal`), set `endpoint_id` to any catalog slug (e.g. `fal-ai/recraft/v4/text-to-image`), wire a `prompt` (and `image` if the model takes one), and run. Output type (image/video/audio/mesh) is auto-detected from FAL's response. Use this only for text/image-driven endpoints — multi-input endpoints need a dedicated wrapper node.

## In the nebula_nodes context

- **Node ids:** the 45 ids in **Pick the right node** (all carry `apiProvider: "fal"`, `envKeyName: "FAL_KEY"` — except the two `meshy-*` nodes whose `envKeyName` is `["MESHY_API_KEY", "FAL_KEY"]`, preferring direct Meshy).
- **Handler files:** `backend/handlers/fal_universal.py` (the single shared handler — submit/poll/parse, port→key mapping, base64 inlining, output detection). Dispatch + `endpoint_id` injection + per-node param pre-processing (`sora-2` tier select, `fast-sdxl` JSON arrays, `kling-v3` `multi_prompt`, `wan-2-6-r2v` `video_urls` collation, `recraft` color params, `meshy` direct-API preference) live in `backend/execution/sync_runner.py`. SSE streaming for the two GPT Image 2 nodes goes through `backend/execution/stream_runner.py`. Deeper infra notes: `docs/model-providers/fal/fal-universal.md`.
- **Input/output ports:** image nodes output an `image` port (Recraft SVG outputs `svg`); video nodes output `video`; 3D nodes output `mesh`; `fal-universal` exposes all four output ports and the runtime picks one. Input ports use canvas-friendly names (`image`, `images`, `end_image`, `front_image`, …) that the handler remaps to FAL keys (`image_url`, `image_urls`, `end_image_url`, `input_image_url`, …) — see the mapping table in **Universal rules**.
- **Chaining rules:** connect an upstream `image` output to a downstream `image` input for i2v / edit / 3D / upscale chains; `mesh` outputs feed 3D-consuming nodes; `video` outputs feed `luma-ray2-flash-modify` / `wan-2-6-r2v` (its `video1`/`video2`/`video3` ports). Multi-image ports (`gpt-image-1-5-edit`, `gpt-image-2-fal-edit`, `seedance-2-r2v` `images`) accept a list; the two edit nodes **error if no image is provided**.
- **How outputs render:** the handler returns a signed FAL URL per output port. Nebula downloads it locally and serves it via `/api/outputs/…`; images render in the canvas image preview, videos in the video player, meshes via the GLB/`model-viewer` preview, SVG inline. URLs are time-limited, so render/download promptly.

### Capability boundaries (what FAL's API can do that these 45 Nebula nodes CANNOT)

State these plainly when a user asks — do not over-promise.

- **Audio is only partly wired (music — instrumental + vocals — video-to-audio Foley, and stem separation).** Music is now wired both ways: `stable-audio-25` (`fal-ai/stable-audio-25/text-to-audio`) reaches text-to-instrumental-music + sound effects (up to 3 min, 44.1kHz, instrumental only — no lyrics/vocals), and `ace-step` (`fal-ai/ace-step`) generates full songs **with synthesized vocals/lyrics** from genre/style `tags` + `lyrics` (up to 60s). Video-to-audio Foley is also wired: `mmaudio-v2` (`fal-ai/mmaudio-v2`) generates synchronized SFX/ambient audio for a video and returns the clip muxed with that audio. Stem separation is wired too: `demucs` (`fal-ai/demucs`) splits a mixed track into four isolated stems (vocals, drums, bass, other). The rest of FAL's large audio catalog is **not** reachable: TTS, speech-to-text, voice cloning, dubbing, audio isolation, and lipsync (sync-lipsync) — ElevenLabs, MiniMax, Whisper, etc. (Some **video** nodes also bake audio into the clip via `generate_audio`, but that's not standalone audio generation.) For TTS/STS/dubbing in Nebula, use Runway or ElevenLabs nodes instead.
- **No LLM / vision / text generation.** FAL hosts LLM and multimodal-vision endpoints; no Nebula FAL node exposes them. The handler has a text fallback but nothing routes to it.
- **No LoRA / model training.** FAL training endpoints (e.g. FLUX LoRA trainers) are not wrapped. `fast-sdxl` can *consume* a LoRA (via its `loras` JSON param) but Nebula cannot *train* one.
- **Inpainting / masked editing is wired.** `flux-fill-inpaint` (`fal-ai/flux-pro/v1/fill`, FLUX.1 [pro] Fill) edits only the masked region of an image — wire `prompt` + `image` + `mask` (white = the region to edit); inpaint to replace objects in a frame or outpaint to extend its borders, leaving unmasked regions untouched. It is the only mask-based node; the other edit nodes (`flux-kontext`, the GPT Image edit nodes) are whole-image.
- **Three upscalers (two image, one video) / one video-modify model.** `seedvr2-upscale` (faithful) and `clarity-upscaler` (creative/added detail) are the wired *image* upscalers, and `seedvr-video-upscale` (ByteDance SeedVR2, one-step, temporally-consistent to up to 4K) is the wired *video* upscaler (FAL also has ESRGAN and other upscalers/restorers, etc.); `luma-ray2-flash-modify` is the lone video-to-video / restyle node (FAL has many more).
- **Transport/control surface is minimal.** Nebula always uses the **queue** transport (never the synchronous `fal.run` host), polls status (no SSE status-stream). **Cancellation is wired** (2026-06-05): when a node's task is cancelled (client disconnect, agent cancel, etc.) the handler PUTs FAL's `cancel_url` on a detached best-effort task so the queued/in-flight job stops upstream instead of running to completion (~10 min). It still does not use: **webhooks** (`?fal_webhook=`), **real-time WebSocket**, the **file-storage upload API** (it base64-inlines local files instead, which bloats large requests), **real log streaming** (`?logs=1` — progress is a synthetic poll-count bar), or the **`X-Fal-*` queue headers** (priority, server-side timeout, no-retry, runner affinity). The only SSE path wired is streaming for the two **GPT Image 2** nodes.
- **Catalog reach via escape hatch only.** ~53% of FAL's overall capability surface is exposed as dedicated nodes. Anything outside the 45 ids (and outside the rest of the audio catalog plus LLM/training, which need different transport or inputs) is reachable **only** through `fal-universal` by pasting a slug — and only if the model needs nothing beyond a `prompt` and a single `image`.

## Sources

- Nebula audit guide (primary, source-cited): `docs/api-guides/fal.md`.
- Live node roster, ports, params, defaults: `backend/data/node_definitions.json` (45 nodes with `apiProvider: "fal"`).
- Handler behavior (submit/poll/stream, port→key mapping, base64 inlining, output detection): `backend/handlers/fal_universal.py`, `backend/execution/sync_runner.py`, `backend/execution/stream_runner.py`; infra notes in `docs/model-providers/fal/fal-universal.md`.
- Per-model specs + category overviews (full FAL catalog, for the `fal-universal` escape hatch): `skills/` (169 files) and `categories/` (16 files) in this bundle; machine-readable `by_category.json`.
- FAL official docs — capability overview <https://fal.ai/docs>; Queue API (submit/status/result/cancel, webhooks, `X-Fal-*`) <https://fal.ai/docs/model-endpoints/queue>; calling patterns (sync `fal.run` vs `queue.fal.run`, subscribe/submit/stream/realtime) <https://fal.ai/docs/model-endpoints>; file storage/upload <https://fal.ai/docs/documentation/development/file-storage>; model catalog <https://fal.ai/models>. For any single model's exact params, the canonical LLM-friendly spec is `https://fal.ai/models/{slug}/llms.txt`.
- Verified 2026-06-04 against the live roster and handler.
