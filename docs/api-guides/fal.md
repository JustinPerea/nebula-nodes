# FAL (fal.ai) in Nebula Nodes

> FAL is Nebula's all-purpose generation gateway: one API key unlocks dozens of top image, video, and 3D models — FLUX, Sora 2, Kling, Seedance, Luma, Wan, Recraft, Hunyuan3D, Meshy, GPT Image, and more — that you wire together on the canvas.

## What you can make

FAL is a *universal gateway* — a single provider that proxies many different downstream models. In Nebula, that surfaces as 41 ready-to-use nodes spanning five media types:

- **Images** (text-to-image): photoreal and stylized stills with FLUX 1.1 Ultra, FLUX 2 Pro, FLUX Schnell (fast), Fast SDXL, Seedream 4.5, Recraft V4, GPT Image 1.5, and GPT Image 2.
- **Vector art (SVG):** true scalable vector graphics from a text prompt with Recraft V4 SVG — logos, icons, flat illustrations.
- **Image editing / reference images:** edit or remix existing images with FLUX Kontext, GPT Image 1.5 Edit, and GPT Image 2 Edit (feed one or more reference images + an instruction).
- **Video — from text:** Sora 2, Kling V3, Wan 2.6 T2V, Luma Ray 2, PixVerse V4.5, Seedance 2.0 (+ Fast).
- **Video — from a still image:** animate a photo with Kling v2.1, Kling Omni 3, Luma Ray 2 I2V, Wan 2.6 I2V, LTX Video 2, LTX 2.3, Seedance V1.5 Pro, Seedance 2.0 I2V (+ Fast). Many support a start frame *and* an end frame.
- **Video — from reference clips/images:** drive a new video off reference footage with Wan 2.6 R2V (up to 3 reference videos) and Seedance 2.0 R2V (reference image set).
- **Video — modify existing video:** restyle/edit a clip you already have with Luma Ray 2 Flash Modify.
- **3D models (.glb mesh):** generate game-/web-ready 3D from text or images with Meshy 6 (text & image to 3D), Hunyuan3D V3 (text to 3D, and multi-view image to 3D using front/back/left/right photos).
- **Audio (text-to-music + sound effects):** high-fidelity instrumental music and sound effects from a text prompt with Stable Audio 2.5 — up to 3 minutes at 44.1kHz, instrumental only (no lyrics/vocals). For music *with* vocals, ACE-Step turns genre/style tags plus lyrics into full songs with synthesized vocals (up to 60s).
- **Audio (video → audio Foley):** generate synchronized sound effects / ambient audio for a (typically silent) video with MMAudio V2 — feed a video clip plus an audio prompt and get the same clip back muxed with newly generated, synchronized audio.
- **Utilities / transforms:** Remove Background (cutouts), and SeedVR2 Upscale (increase image resolution up to 4×).

> FAL's audio catalog is now *partly* wired: Stable Audio 2.5 covers instrumental text-to-music and sound effects, ACE-Step adds music with vocals/lyrics (full songs, up to 60s), and MMAudio V2 covers video-to-audio Foley (synchronized SFX/ambient audio for a video). The rest of the catalog — TTS, speech-to-text, voice cloning, dubbing, lipsync, stem separation — is still not exposed through Nebula's FAL nodes. See the coverage section below.

## Nodes available in Nebula (41)

Names, node IDs, and parameter keys below are taken directly from `backend/data/node_definitions.json`. "Key inputs" are the node's input ports; "Notable params" are the exposed settings (every node also implicitly takes a `prompt` and/or `image` where listed).

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| FLUX 1.1 Ultra | `flux-1-1-ultra` | image-gen | prompt, image | *(defaults only)* | High-end photoreal stills |
| FAL | `fal-universal` | universal | prompt, image | `endpoint_id` | Power-user escape hatch: paste any `fal-ai/...` slug to reach a model Nebula has no dedicated node for |
| Kling v2.1 | `kling-v2-1` | video-gen | image, prompt, tail_image | `duration`, `negative_prompt`, `cfg_scale` | Animate a photo (with optional end frame) |
| Sora 2 | `sora-2` | video-gen | prompt | `resolution`, `aspect_ratio`, `duration` | Text-to-video, OpenAI Sora 2 |
| FLUX Schnell | `flux-schnell` | image-gen | prompt | `image_size`, `num_inference_steps`, `guidance_scale`, `num_images`, `output_format`, `acceleration`, `enable_safety_checker`, `seed` | Fast, cheap image drafts |
| Fast SDXL | `fast-sdxl` | image-gen | prompt | `image_size`, `num_images`, `num_inference_steps`, `guidance_scale`, `negative_prompt`, `expand_prompt`, `loras`, `embeddings`, `format`, `enable_safety_checker`, `safety_checker_version`, `seed` | SDXL with LoRA/embedding support |
| Wan 2.6 T2V | `wan-2-6-t2v` | video-gen | prompt | `duration`, `resolution`, `aspect_ratio`, `negative_prompt`, `seed`, `generate_audio`, `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` | Text-to-video with optional audio |
| Luma Ray 2 | `luma-ray2-t2v` | video-gen | prompt | `aspect_ratio`, `duration`, `loop`, `resolution` | Cinematic text-to-video |
| LTX Video 2 | `ltx-video-2` | video-gen | image, prompt | `duration`, `resolution`, `fps`, `generate_audio` | Image-to-video |
| Meshy 6 Text-to-3D | `meshy-text-to-3d` | 3d-gen | prompt | *(defaults only)* | 3D mesh from a text prompt |
| Meshy 6 Image-to-3D | `meshy-image-to-3d` | 3d-gen | image | *(defaults only)* | 3D mesh from one image |
| Hunyuan3D V3 Text-to-3D | `hunyuan3d-text-to-3d` | 3d-gen | prompt | `generate_type`, `face_count`, `enable_pbr`, `polygon_type` | 3D mesh from text, PBR option |
| Hunyuan3D V3 Image-to-3D | `hunyuan3d-image-to-3d` | 3d-gen | front_image, back_image, left_image, right_image | `generate_type`, `face_count`, `enable_pbr`, `polygon_type` | 3D mesh from multi-view photos |
| Remove Background | `remove-background` | transform | image | `crop_to_bbox` | Cut out the subject (transparent PNG) |
| Recraft V4 | `recraft-v4-raster` | image-gen | prompt | `image_size`, `style_id`, `colors`, `background_color`, `enable_safety_checker` | Stylized raster art, brand styles |
| Recraft V4 SVG | `recraft-v4-svg` | image-gen | prompt | `image_size`, `style_id`, `colors`, `background_color`, `enable_safety_checker` | True vector (SVG) logos/icons |
| Kling V3 | `kling-v3` | video-gen | prompt, image, end_image | `duration`, `aspect_ratio`, `negative_prompt`, `shot_type`, `multi_prompt`, `generate_audio`, `cfg_scale` | Text- or image-to-video, multi-shot |
| Luma Ray 2 I2V | `luma-ray2-i2v` | video-gen | image, end_image, prompt | `aspect_ratio`, `resolution`, `duration`, `loop` | Animate a photo (start + end frame) |
| Wan 2.6 I2V | `wan-2-6-i2v` | video-gen | image, prompt | `duration`, `resolution`, `aspect_ratio`, `negative_prompt`, `seed`, `generate_audio`, `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` | Image-to-video with optional audio |
| Luma Ray 2 Flash Modify | `luma-ray2-flash-modify` | video-gen | video, prompt, image | `mode` | Restyle / modify an existing clip |
| Wan 2.6 R2V | `wan-2-6-r2v` | video-gen | prompt, video1, video2, video3 | `duration`, `resolution`, `aspect_ratio`, `negative_prompt`, `seed`, `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` | Reference-to-video from up to 3 clips |
| PixVerse V4.5 | `pixverse-v4-5` | video-gen | prompt, image | `duration`, `aspect_ratio`, `resolution`, `style`, `negative_prompt`, `seed` | Stylized text/image-to-video |
| Seedance V1.5 Pro (I2V) | `seedance-v1-5` | video-gen | prompt, image, end_image | `duration`, `aspect_ratio`, `resolution`, `generate_audio`, `camera_fixed`, `seed` | High-quality image-to-video |
| Kling Omni 3 | `kling-o3` | video-gen | image, prompt, end_image | `duration`, `aspect_ratio`, `generate_audio`, `negative_prompt`, `cfg_scale`, `shot_type` | Image-to-video, newest Kling |
| LTX 2.3 | `ltx-2-3` | video-gen | image, prompt, end_image, audio | `duration`, `resolution`, `aspect_ratio`, `fps`, `generate_audio` | Image-to-video; can take an audio track |
| Seedance 2.0 Text-to-Video | `seedance-2-t2v` | video-gen | prompt | `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `seed` | Text-to-video, ByteDance Seedance 2 |
| Seedance 2.0 I2V | `seedance-2-i2v` | video-gen | image, prompt, end_image | `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `seed` | Image-to-video (start + end frame) |
| Seedance 2.0 R2V | `seedance-2-r2v` | video-gen | prompt, images | `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `seed` | Reference-to-video from an image set |
| Seedance 2.0 Fast T2V | `seedance-2-fast-t2v` | video-gen | prompt | `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `seed` | Faster/cheaper text-to-video |
| Seedance 2.0 Fast I2V | `seedance-2-fast-i2v` | video-gen | image, prompt, end_image | `aspect_ratio`, `duration`, `resolution`, `generate_audio`, `seed` | Faster/cheaper image-to-video |
| FLUX Kontext | `flux-kontext` | image-gen | prompt, image | `aspect_ratio`, `num_images`, `guidance_scale`, `enhance_prompt`, `output_format`, `safety_tolerance`, `seed` | Edit/remix an image by instruction |
| FLUX 2 Pro | `flux-2-pro` | image-gen | prompt | `image_size`, `output_format`, `safety_tolerance`, `enable_safety_checker`, `seed` | Latest high-end FLUX stills |
| GPT Image 1.5 | `gpt-image-1-5` | image-gen | prompt | `image_size`, `quality`, `background`, `num_images`, `output_format` | OpenAI GPT Image text-to-image |
| GPT Image 1.5 Edit | `gpt-image-1-5-edit` | image-gen | prompt, images | `image_size`, `quality`, `input_fidelity`, `background`, `num_images`, `output_format` | Edit with reference image(s) |
| GPT Image 2 (FAL) | `gpt-image-2-fal-generate` | image-gen | prompt | `image_size`, `quality`, `num_images`, `output_format`, `partial_images` | GPT Image 2 text-to-image (streamed) |
| GPT Image 2 Edit (FAL) | `gpt-image-2-fal-edit` | image-gen | images, prompt | `image_size`, `quality`, `num_images`, `output_format`, `partial_images` | GPT Image 2 edit with reference(s) |
| SeedVR2 Upscale | `seedvr2-upscale` | transform | image | `upscale_mode`, `upscale_factor`, `target_resolution`, `noise_scale`, `output_format`, `seed` | Upscale an image (up to 4× / 4K) |
| Seedream 4.5 | `seedream-4-5` | image-gen | prompt | `image_size`, `num_images`, `max_images`, `enable_safety_checker`, `seed` | ByteDance Seedream high-quality stills |
| Stable Audio 2.5 | `stable-audio-25` | audio-gen | prompt | `seconds_total`, `num_inference_steps`, `guidance_scale`, `seed` | Text → instrumental music + sound effects |
| ACE-Step (Music + Vocals) | `ace-step` | audio-gen | *(none — param-only)* | `tags`, `lyrics`, `duration`, `number_of_steps`, `guidance_scale`, `seed` | Text → full songs with vocals & lyrics |
| MMAudio V2 (Video Foley) | `mmaudio-v2` | audio-gen | video, prompt ("Audio Prompt", Text) → video (with audio) | `negative_prompt`, `duration`, `num_steps`, `cfg_strength`, `mask_away_clip`, `seed` | Generate synchronized Foley/SFX audio for a video |

## How to use it in Nebula

**Where the nodes appear.** Open the node palette on the canvas and browse by category. FAL nodes are spread across **Image**, **Video**, **3D**, and **Transform** groups — they look like any other model node (e.g. "Sora 2", "FLUX 1.1 Ultra", "Remove Background"). There is no separate "FAL" section; the gateway is invisible unless you reach for the catch-all **FAL** node (`fal-universal`), which lives under the **Universal** group and lets you type a raw `fal-ai/...` endpoint slug.

**API-key setup (one time).** All FAL nodes authenticate with a single key:

1. Create an API key at <https://fal.ai/dashboard/keys>.
2. In the repo root, add it to your `.env` file:
   ```
   FAL_KEY=your-fal-key-here
   ```
3. Restart the backend so it picks up the variable. Every FAL node now works — no per-node configuration. (If the key is missing you'll get a `FAL_KEY is required` error when you run the graph.)

You can paste a local file path or a public URL into any image/video/audio input — Nebula auto-converts local files to data URIs before sending them to FAL, so you don't have to upload anything yourself.

**Example pipelines (using real node IDs):**

1. **Concept → cinematic shot.** `flux-1-1-ultra` (generate a hero still from a prompt) → wire its `image` output into `kling-v3`'s `image` input, add a motion `prompt` → get a moving shot. Swap in `seedance-2-i2v` or `luma-ray2-i2v` if you want a start *and* end frame.

2. **Product cutout → spinnable 3D.** `remove-background` (clean a product photo) → feed the cutout `image` into `meshy-image-to-3d` → download the `.glb` mesh for the web. For a sharper result, shoot four angles and use `hunyuan3d-image-to-3d` (front/back/left/right ports).

3. **Logo factory.** `recraft-v4-svg` with a brand prompt and a `colors` palette → get an editable SVG logo. Then `recraft-v4-raster` for matching raster assets, and `seedvr2-upscale` to push any raster to 4K.

4. **Photo → looping clip with sound.** `flux-2-pro` (still) → `wan-2-6-i2v` with `generate_audio` on and `loop`-friendly settings → a short, audio-bearing loop, no separate audio node required.

5. **Reach an un-wrapped model.** Drop the **FAL** node (`fal-universal`), set `endpoint_id` to any catalog slug (e.g. `fal-ai/recraft/v4/text-to-image`), wire a `prompt`, and run. Output type (image/video/audio/mesh) is detected automatically from FAL's response.

## API coverage — what Nebula uses vs. what FAL (fal.ai) offers

FAL is a gateway, so "the API surface" here means *capabilities* — auth, the call lifecycle, transport modes, input/output modalities, and which model families are reachable — not the 1,000+ individual downstream models.

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Auth via `Authorization: Key $FAL_KEY` | Yes | **full** | Handler sends exactly this header; single `FAL_KEY`. |
| Queue submit `POST queue.fal.run/{id}` | Yes | **full** | Primary path for every non-streaming node. |
| Status poll `GET .../requests/{id}/status` | Yes | **full** | Polled every 2s, up to 300×; uses canonical `status_url` from the submit response. |
| Result fetch `GET .../requests/{id}` | Yes | **full** | Uses canonical `response_url`. |
| Direct (non-queue) result on submit | Yes | **full** | Handler returns the body directly when no `request_id` is present. |
| SSE streaming `.../stream` | Yes | **partial** | Wired only for `openai/gpt-image-2` and `.../edit` (progressive image preview). All other models use poll, even where FAL supports `/stream`. |
| SSE status stream `.../status/stream` | Yes | **none** | Nebula polls status instead of subscribing to the status stream. |
| Cancel `PUT .../requests/{id}/cancel` | Yes | **none** | No cancel call; an in-flight job runs to completion or times out. |
| Webhooks (`?fal_webhook=`) | Yes | **none** | Nebula blocks-and-polls; never registers a webhook. |
| Real-time WebSocket (`realtime`) | Yes | **none** | Not used (would suit `fast-sdxl`-style live preview). |
| Sync base URL `fal.run/{id}` | Yes | **none** | Handler always uses `queue.fal.run`, even for fast models. |
| Queue priority / timeout / no-retry / runner-hint headers (`X-Fal-*`) | Yes | **none** | None of the `X-Fal-Queue-Priority`, `X-Fal-Request-Timeout`, `X-Fal-No-Retry`, `X-Fal-Runner-Hint` controls are surfaced. |
| File storage upload API (`upload_file`) | Yes | **partial** | Nebula doesn't call the upload API; it inlines local files as base64 **data URIs** (works, but large files bloat the request) and passes public URLs through. |
| Logs on status (`?logs=1`) | Yes | **none** | Progress is shown as a synthetic poll-count bar, not FAL's real logs. |
| **Image — text-to-image** | Yes | **full** | FLUX (Schnell/1.1 Ultra/2 Pro), Fast SDXL, Seedream 4.5, Recraft V4, GPT Image 1.5 / 2. |
| **Image — editing / reference** | Yes | **full** | FLUX Kontext, GPT Image 1.5 Edit, GPT Image 2 Edit. |
| **Image — vector (SVG)** | Yes | **full** | Recraft V4 SVG (`text-to-vector`); SVG output type detected by handler. |
| **Image — inpainting / masked edit** | Yes | **none** | No mask/inpaint node, though FAL hosts inpainting models. |
| **Image — background removal** | Yes | **full** | `remove-background` (`imageutils/rembg`). |
| **Image — upscaling** | Yes | **partial** | One upscaler exposed (`seedvr2-upscale`); FAL has many more (Clarity, ESRGAN, etc.). |
| **Video — text-to-video** | Yes | **full** | Sora 2, Kling V3, Wan 2.6, Luma Ray 2, PixVerse, Seedance 2.0 (+ Fast). |
| **Video — image-to-video** | Yes | **full** | Kling v2.1/Omni 3, Luma Ray 2 I2V, Wan 2.6 I2V, LTX 2 / 2.3, Seedance V1.5 / 2.0. |
| **Video — reference-to-video** | Yes | **full** | Wan 2.6 R2V, Seedance 2.0 R2V. |
| **Video — video-to-video / modify** | Yes | **partial** | Only Luma Ray 2 Flash Modify; FAL has many v2v / video-edit models. |
| **3D — text-to-3D & image-to-3D** | Yes | **full** | Meshy 6, Hunyuan3D V3 (incl. multi-view image-to-3D). |
| **Audio — text-to-music / SFX** | Yes | **partial** | `stable-audio-25` (`fal-ai/stable-audio-25/text-to-audio`) wires instrumental text-to-music + sound effects (up to 3 min, 44.1kHz), and `ace-step` (`fal-ai/ace-step`) adds music *with* vocals/lyrics (full songs, up to 60s). FAL hosts other music/SFX models that remain unwired. |
| **Audio — video-to-audio / Foley** | Yes | **full** | `mmaudio-v2` (`fal-ai/mmaudio-v2`) generates synchronized SFX/ambient audio for a video and returns the clip muxed with that audio. |
| **Audio — TTS / STT / voice clone / dubbing / isolation / lipsync / stems** | Yes | **none** | Rest of the large FAL audio catalog (ElevenLabs, MiniMax, Whisper, sync-lipsync, demucs, etc.); no Nebula FAL node targets these endpoints. |
| **LLM / vision (text + multimodal)** | Yes | **none** | FAL hosts LLM and vision endpoints; no Nebula FAL node exposes them (handler has a text fallback but nothing routes to it). |
| **LoRA / model training** | Yes | **none** | FAL training endpoints (e.g. FLUX LoRA trainers) are not exposed; `fast-sdxl` can *consume* a LoRA but Nebula can't *train* one. |

**Coverage: ~49% of the FAL (fal.ai) API surface is exposed in Nebula.** Image, video, and 3D *generation* are well covered (the heart of what most users want), music is now wired both ways — instrumental/SFX via Stable Audio 2.5 and vocals/lyrics via ACE-Step — and video-to-audio Foley is wired via MMAudio V2; but most of the rest of the audio catalog (TTS/STT, voice cloning, dubbing, lipsync, stems), LLM/vision, training, and most of the advanced transport/control surface (streaming for non-GPT models, webhooks, cancel, sync URL, priority headers, real upload API) remain unused.

**Notable unused capabilities:** most of the **audio catalog** (TTS, speech-to-text, voice cloning, dubbing, audio isolation, lipsync, stem separation — music is now wired both ways: instrumental/SFX via `stable-audio-25` and vocals/lyrics via `ace-step`, and video-to-audio/Foley is wired via `mmaudio-v2`); **LLM / vision** endpoints; **LoRA/model training**; **inpainting/masked image editing**; the broader **upscaler** and **video-to-video** families; **webhooks** and **request cancellation** (so long jobs can't be aborted); **real-time WebSocket** and broader **SSE streaming** (only GPT Image 2 streams today); the **synchronous `fal.run`** path for fast models; the **file-storage upload API** (Nebula inlines base64 instead); and the **`X-Fal-*` queue controls** (priority, server-side timeout, no-retry, runner affinity) plus **real log streaming**.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/fal/SKILL.md` (refreshed 2026-06-04). It is the most complete provider skill in the repo and covers all **41** FAL-backed Nebula nodes, plus the catch-all `fal-universal` slug node for reaching un-wrapped FAL catalog models. It gives an agent the node IDs and ports, per-node params and ranges, wiring/chaining rules, and the provider's capability boundaries — so an agent can drive any FAL pipeline without reading the handlers.

What it covers:

- **Universal FAL conventions** — the auth header, the two base URLs, the full queue lifecycle (submit → poll → result, with status states and HTTP codes), and per-modality output shapes.
- **The Nebula node → FAL endpoint map**, reconciled to the authoritative **41-node** roster in `node_definitions.json` (the stale 39/160 framing and non-current models were dropped and the `kling-v2-1` slug fixed).
- **Nebula-specific wiring** — the input-port → FAL-key mapping (`image`→`image_url`, `images`→`image_urls`, `front_image`→`input_image_url`, etc.), base64 data-URI inlining of local files, and that **only the two GPT Image 2 nodes stream** (all 38 others queue-poll).
- **Capability boundaries** — which FAL capabilities Nebula **cannot** reach (most audio plus LLM/training nodes are not wired; music is now wired both ways — instrumental/SFX via `stable-audio-25`, vocals/lyrics via `ace-step` — and video-to-audio/Foley via `mmaudio-v2`), so an agent doesn't over-promise a modality no node delivers.

## Sources

- FAL docs home / capability overview — <https://fal.ai/docs> (redirected from <https://docs.fal.ai/>)
- Queue API (submit / status / status-stream / result / cancel, webhooks, `X-Fal-*` headers) — <https://fal.ai/docs/model-endpoints/queue>
- Model-endpoint calling patterns (sync `fal.run` vs `queue.fal.run`, `subscribe`/`submit`/`stream`/`realtime`) — <https://fal.ai/docs/model-endpoints>
- File storage / upload API and file-input options — <https://fal.ai/docs/documentation/development/file-storage>, <https://docs.fal.ai/platform-apis/v1/serverless/files/file/url/%7Bfile%7D>
- Model catalog & task categories — <https://fal.ai/models>
