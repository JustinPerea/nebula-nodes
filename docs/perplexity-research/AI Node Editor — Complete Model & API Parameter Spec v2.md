# AI Node Editor — Complete Model & API Parameter Reference v2

> **Version:** 2.0 — Updated April 2026  
> **Supersedes:** v1 model catalog + expanded catalog (separate documents)  
> **Changes in v2:** Merged all three research rounds into one authoritative spec; added all new models (Seedream, Nano Banana, Recraft V4, Ideogram V3, Wan 2.6, MiniMax, Luma Ray 2, LTX Video 2.0, Pixverse V4.5, Seedance, Moonvalley, Grok Imagine, Higgsfield); added Video-as-input port rules; added async-poll `executionPattern` field; added SVG port type; added OpenRouter and Replicate dynamic node specs; added `executionPattern` column to all tables.

***

## How to Read This Document

Each model section specifies:
- **Node Type** (Generator / Transform / Analyzer / Utility)
- **Input Ports** and **Output Ports** with color codes
- **`executionPattern`**: `sync` | `async-poll` | `stream`
- **Complete parameter table** (key, type, required, default, options)
- **Required env var** for API key

***

## Port Color Reference

| Color | Type | Description |
|---|---|---|
| 🟢 Green `#4CAF50` | `Image` | PNG, JPEG, WebP |
| 🔴 Red `#F44336` | `Video` | MP4, WebM |
| 🟣 Purple `#9C27B0` | `Text` | Prompts, captions, strings |
| 🔵 Blue `#2196F3` | `Array` | Lists of values |
| 🟡 Yellow `#FFC107` | `Audio` | MP3, WAV, PCM |
| 🟢 Lime `#8BC34A` | `Mask` | Alpha-channel PNG |
| 🟤 Brown `#795548` | `SVG` | Editable vector file |

***

## Section 1 — OpenAI Image Models

### 1.1 GPT Image 1 / 1.5 / 1-mini — Text to Image

**Node Type:** Generator | **Execution:** sync[^1][^2]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Env:** `OPENAI_API_KEY` | **Endpoint:** `POST /v1/images/generations`

| Parameter | Type | Req | Default | Options / Range |
|---|---|---|---|---|
| `model` | enum | yes | — | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini`, `dall-e-3`, `dall-e-2` |
| `prompt` | string | yes | — | Max 32,000 chars |
| `n` | integer | no | 1 | 1–10 |
| `size` | enum | no | `auto` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` |
| `quality` | enum | no | `auto` | `low`, `medium`, `high`, `auto` |
| `output_format` | enum | no | `png` | `png`, `jpeg`, `webp` |
| `output_compression` | integer | no | — | 0–100 (jpeg/webp only) |
| `background` | enum | no | `auto` | `transparent`, `opaque`, `auto` |
| `moderation` | string | no | auto | Content filtering level |
| `user` | string | no | — | End-user identifier |

**Note:** `gpt-image-1` always returns `b64_json`. `dall-e-2`/`dall-e-3` return `url` or `b64_json`.[^3]

***

### 1.2 GPT Image 1 / 1.5 / dall-e-2 — Image Edit (Inpainting)

**Node Type:** Transform | **Execution:** sync[^4]  
**Inputs:** 🟢 Image (up to 16), 🟣 Prompt, 🟢 Lime Mask (opt) | **Outputs:** 🟢 Image  
**Env:** `OPENAI_API_KEY` | **Endpoint:** `POST /v1/images/edits`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `image` | file(s) | yes | — | PNG/WebP/JPG <50MB, up to 16 |
| `prompt` | string | yes | — | — |
| `mask` | file | no | — | PNG with alpha channel |
| `model` | enum | no | `dall-e-2` | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini`, `dall-e-2` |
| `n` | integer | no | 1 | 1–10 |
| `size` | enum | no | `1024x1024` | `1024x1024`, `1536x1024`, `1024x1536` |
| `quality` | enum | no | `medium` | `low`, `medium`, `high` |
| `output_format` | enum | no | `png` | `png`, `jpeg`, `webp` |
| `output_compression` | integer | no | — | 0–100 |
| `background` | enum | no | `auto` | `transparent`, `opaque`, `auto` |
| `input_fidelity` | enum | no | `low` | `high`, `low` (not available on mini) |

***

### 1.3 DALL-E 3 — Text to Image

**Node Type:** Generator | **Execution:** sync  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image | **Env:** `OPENAI_API_KEY`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `n` | integer | no | 1 | `1` only |
| `size` | enum | no | `1024x1024` | `1024x1024`, `1024x1792`, `1792x1024` |
| `quality` | enum | no | `standard` | `standard`, `hd` |
| `style` | enum | no | `vivid` | `natural`, `vivid` |
| `response_format` | enum | no | `url` | `url`, `b64_json` |

***

## Section 2 — OpenAI Language / Vision Models

### 2.1 GPT-4o / GPT-4o-mini / GPT-4.1 — Chat

**Node Type:** Analyzer/Generator | **Execution:** stream[^5]  
**Inputs:** 🟣 Messages, 🟢 Images (vision) | **Outputs:** 🟣 Text  
**Env:** `OPENAI_API_KEY` | **Endpoint:** `POST /v1/chat/completions`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `model` | enum | yes | — | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.5-preview`, `gpt-5-chat-latest` |
| `messages` | array | yes | — | `[{role, content}]` |
| `temperature` | float | no | 1 | 0–2 (**not supported on o-series/gpt-5**) |
| `top_p` | float | no | 1 | 0–1 |
| `max_tokens` | integer | no | — | Model max |
| `frequency_penalty` | float | no | 0 | -2 to 2 |
| `presence_penalty` | float | no | 0 | -2 to 2 |
| `n` | integer | no | 1 | 1–8 |
| `stop` | string/array | no | — | Up to 4 sequences |
| `stream` | boolean | no | false | — |
| `response_format` | object | no | — | `{type: "text"\|"json_object"\|"json_schema"}` |
| `tools` | array | no | — | Function definitions |
| `tool_choice` | string/object | no | `auto` | `none`, `auto`, `required`, `{type, function}` |
| `logprobs` | boolean | no | false | — |
| `user` | string | no | — | — |

> ⚠️ Reasoning models (`gpt-5`, `o4-mini`, `o3`) do NOT support `temperature` or `top_p`. Use `max_completion_tokens` instead of `max_tokens`.[^6]

### 2.2 Sora 2 — Text to Video

**Node Type:** Generator | **Execution:** async-poll[^7][^8]  
**Inputs:** 🟣 Prompt | **Outputs:** 🔴 Video  
**Env:** `OPENAI_API_KEY` | **Endpoint (fal):** `fal-ai/sora-2/text-to-video`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `model` | enum | no | `sora-2` | `sora-2`, `sora-2-pro` |
| `resolution` | enum | no | `1080p` | `720p`, `1080p`, `true_1080p` (pro only) |
| `aspect_ratio` | enum | no | `16:9` | `16:9`, `9:16` |
| `duration` | integer | no | 4 | `4`, `8`, `12`, `16`, `20` (seconds) |

### 2.3 Sora 2 — Video Remix

**Node Type:** Transform | **Execution:** async-poll[^9]  
**Inputs:** 🔴 Video, 🟣 Prompt | **Outputs:** 🔴 Video  
**Endpoint (fal):** `fal-ai/sora-2/video-to-video/remix`

***

## Section 3 — Anthropic Claude Models

### 3.1 Claude — Messages API

**Node Type:** Analyzer/Generator | **Execution:** stream[^10]  
**Inputs:** 🟣 Messages, 🟢 Images (vision) | **Outputs:** 🟣 Text  
**Env:** `ANTHROPIC_API_KEY` | **Endpoint:** `POST /v1/messages`

**Model Options (as of April 2026):**

| Model ID | Context | Use Case |
|---|---|---|
| `claude-opus-4-20250514` | 200K | Most capable, complex reasoning |
| `claude-opus-4.1` | 200K | Enhanced agentic tasks |
| `claude-sonnet-4-20250514` | 200K | Best balance speed/intelligence |
| `claude-sonnet-4-5-20250929` | 200K | Coding, agentic workflows |
| `claude-sonnet-4-6` | 200K | Latest Sonnet |
| `claude-haiku-3-5-20241022` | 200K | Fast, lightweight tasks |

> All Claude models: Input = Text + Images; Output = **Text only** (no native image generation)[^11]

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `model` | string | yes | — | See table above |
| `messages` | array | yes | — | `[{role: "user"\|"assistant", content}]` |
| `max_tokens` | integer | yes | — | **No default — must always specify** |
| `temperature` | float | no | 1 | 0–1 |
| `top_p` | float | no | 1 | 0–1 (mutually exclusive with temperature) |
| `top_k` | integer | no | — | Advanced sampling |
| `stop_sequences` | array | no | — | Halt generation strings |
| `system` | string/array | no | — | System prompt |
| `stream` | boolean | no | false | — |
| `tools` | array | no | — | `[{name, description, input_schema}]` |
| `tool_choice` | object | no | `auto` | `{type: "auto"\|"any"\|"tool"}` |
| `metadata.user_id` | string | no | — | End-user ID |

**Extended Thinking** (claude-sonnet-4+ only):[^12]

| Parameter | Value | Notes |
|---|---|---|
| `thinking.type` | `"enabled"` | Requires `betas=["thinking"]` header |
| `thinking.budget_tokens` | integer ≥1024 | Thinking token budget |
| — | — | Incompatible with `top_k` changes |

***

## Section 4 — Google Gemini Models

### 4.1 Gemini — Generate Content

**Node Type:** Analyzer/Generator | **Execution:** stream[^13]  
**Inputs:** 🟣 Text, 🟢 Image, 🔴 Video, 🟡 Audio | **Outputs:** 🟣 Text (+🟢 Image when configured)  
**Env:** `GOOGLE_API_KEY` | **Endpoint:** `POST /v1beta/models/{model}:generateContent`

| Model ID | Tokens | Special Capability |
|---|---|---|
| `gemini-3-pro-preview` | 1M | Highest capability |
| `gemini-3-flash-preview` | 1M | Fast, multimodal |
| `gemini-3-pro-image-preview` | 1M | Native image output[^14] |
| `gemini-2.5-pro` | 1M | Advanced reasoning + thinking |
| `gemini-2.5-flash` | 1M | Fast, cost-effective |
| `gemini-2.5-flash-image` | — | Native image output |

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `contents` | array | yes | — | `[{role, parts}]` |
| `systemInstruction` | object | no | — | `{parts: [{text}]}` |
| `generationConfig.temperature` | float | no | 1.0 | 0–2 (0–1 for image models)[^15] |
| `generationConfig.topP` | float | no | 0.95 | 0–1 |
| `generationConfig.topK` | integer | no | 64 | Fixed at 64 for Flash |
| `generationConfig.maxOutputTokens` | integer | no | 65535 | Up to 65,535 |
| `generationConfig.candidateCount` | integer | no | 1 | 1–8 |
| `generationConfig.responseMimeType` | string | no | — | `text/plain`, `application/json` |
| `generationConfig.stopSequences` | array | no | — | — |
| `generationConfig.responseModalities` | array | no | `["TEXT"]` | `["TEXT"]`, `["IMAGE"]`, `["TEXT","IMAGE"]` |
| `generationConfig.imageConfig.aspectRatio` | string | no | — | `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"` |
| `generationConfig.imageConfig.imageSize` | string | no | — | `"1K"`, `"2K"`, `"4K"` (Nano Banana 2 only) |
| `tools` | array | no | — | Function declarations, code execution |
| `thinkingConfig.thinkingBudget` | integer | no | — | For 2.5/3 models |

> **Nano Banana** is Google's consumer brand for Gemini native image generation. Use `gemini-2.5-flash-preview-05-20` for Nano Banana 1, `gemini-3.1-flash-image-preview` for Nano Banana 2. Both use the same `generateContent` endpoint with `responseModalities: ["IMAGE", "TEXT"]`.[^14][^16]

***

## Section 5 — Google Imagen 4

### 5.1 Imagen 4 — Text to Image

**Node Type:** Generator | **Execution:** sync[^17]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Env:** `GOOGLE_API_KEY` or Vertex AI service account

| Model ID | Max Output | Max Resolution |
|---|---|---|
| `imagen-4.0-generate-001` | 4 images | 2K |
| `imagen-4.0-ultra-generate-001` | 4 images | 2K (highest fidelity) |
| `imagen-4.0-fast-generate-001` | 4 images | 1408×768 |

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `numberOfImages` | integer | no | 1 | 1–4 |
| `aspectRatio` | string | no | `"1:1"` | `"1:1"`, `"3:4"`, `"4:3"`, `"9:16"`, `"16:9"` |
| `outputOptions.mimeType` | string | no | `image/jpeg` | `image/png`, `image/jpeg` |
| `personGeneration` | string | no | — | `allow_all`, `allow_adult`, `dont_allow` |
| `safetySetting` | string | no | — | `block_few`, `block_some`, `block_most`, `block_all` |
| `addWatermark` | boolean | no | true | SynthID / C2PA watermark |
| `seed` | integer | no | — | Reproducibility |
| `enhancePrompt` | boolean | no | false | Prompt rewriter |

***

## Section 6 — Google Veo 3

### 6.1 Veo 3 — Text to Video

**Node Type:** Generator | **Execution:** async-poll[^18]  
**Inputs:** 🟣 Prompt | **Outputs:** 🔴 Video  
**Env:** `FAL_KEY` | **Endpoint (fal):** `fal-ai/veo3` or `fal-ai/veo3/fast`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `aspect_ratio` | string | no | `16:9` | `16:9`, `9:16` |
| `duration` | string | no | `8s` | `8s` |
| `resolution` | string | no | `720p` | `720p`, `1080p` |
| `generate_audio` | boolean | no | true | Native dialogue, SFX, ambient |
| `auto_fix` | boolean | no | true | Prompt safety auto-correction |
| `safety_tolerance` | string | no | `4` | `1`–`6` |

***

## Section 7 — Runway Models

### 7.1 Runway Gen-4 Turbo — Image to Video

**Node Type:** Transform | **Execution:** async-poll[^19]  
**Inputs:** 🟢 Image, 🟣 Prompt | **Outputs:** 🔴 Video  
**Env:** `RUNWAY_API_KEY` | **Endpoint:** `POST /v1/tasks`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `model` | string | yes | — | `gen4_turbo`, `gen4`, `gen4_aleph` |
| `promptImage` | string | yes | — | HTTPS URL or data URI (<16MB URL / <5MB base64) |
| `promptText` | string | no | — | Up to 1000 chars |
| `duration` | integer | no | 5 | `5`, `10` |
| `ratio` | string | no | `1280:720` | `1280:720`, `1584:672`, `1104:832`, `720:1280`, `832:1104`, `960:960` |
| `seed` | integer | no | — | 0–4294967295 |
| `watermark` | boolean | no | false | — |

**Poll endpoint:** `GET /v1/tasks/{taskId}` | Terminal states: `SUCCEEDED`, `FAILED`

### 7.2 Runway Gen-4.5 — Text or Image to Video

**Node Type:** Generator (T2V) or Transform (I2V)[^19]
**Inputs:** 🟣 Prompt (+ 🟢 Image optional for I2V) | **Outputs:** 🔴 Video

| Variant | Supported Ratios |
|---|---|
| Gen-4.5 T2V | `1280:720`, `720:1280` only |
| Gen-4.5 I2V | `1280:720`, `1584:672`, `1104:832`, `720:1280`, `832:1104`, `672:1584`, `960:960` |

Shared params: `promptText`, `duration` (`5` or `10`), `seed`, `watermark`, `ratio`

### 7.3 Runway Act-Two — Character Animation

**Node Type:** Transform  
**Inputs:** 🟢 Image (character), 🔴 Video (motion source)  
**Outputs:** 🔴 Video | Same ratios as Gen-4 Turbo

***

## Section 8 — Kling AI Models

All Kling models accessible via `FAL_KEY`. Endpoint pattern: `fal-ai/kling-video/{version}/{tier}/{mode}`

### 8.1 Kling v1.6 / v2.1 Pro — Image to Video

**Node Type:** Transform | **Execution:** async-poll[^20][^21]  
**Inputs:** 🟢 Image, 🟣 Prompt | **Outputs:** 🔴 Video | **Env:** `FAL_KEY`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `image_url` | string | yes | — | HTTPS URL or base64 |
| `duration` | string | no | `5` | `5`, `10` |
| `aspect_ratio` | string | no | `16:9` | `16:9`, `9:16`, `1:1` |
| `tail_image_url` | string | no | — | End-frame image |
| `negative_prompt` | string | no | `"blur, distort, and low quality"` | — |
| `cfg_scale` | float | no | 0.5 | Prompt adherence |
| `static_mask_url` | string | no | — | Static motion brush mask |
| `dynamic_masks` | array | no | — | `[{mask_url, trajectories: [{x,y}]}]` |

### 8.2 Kling v3 — Multi-Shot Video

**Node Type:** Generator/Transform | **Execution:** async-poll[^20]  
**Inputs:** 🟣 Prompt or multi_prompt, 🟢 start_image_url (opt), 🟢 end_image_url (opt)  
**Outputs:** 🔴 Video | **Env:** `FAL_KEY`

| Parameter | Type | Notes |
|---|---|---|
| `prompt` | string | Single prompt |
| `multi_prompt` | array | `[{prompt, duration}]` — multi-shot scene segmentation |
| `start_image_url` | string | First frame image |
| `end_image_url` | string | Last frame image |
| `duration` | string | 3–15 seconds |
| `generate_audio` | boolean | Native audio (default true) |
| `elements` | array | `[{frontal_image_url, reference_images}]` — reference as @Element1 in prompt |
| `shot_type` | string | `"customize"`, `"intelligent"` |
| `negative_prompt` | string | — |
| `cfg_scale` | float | — |

### 8.3 Kling — Motion Control

**Node Type:** Transform[^20]
**Inputs:** 🟢 Image (character), 🔴 Video (motion source) | **Outputs:** 🔴 Video | **Env:** `FAL_KEY`

| Parameter | Req | Options |
|---|---|---|
| `image_url` | yes | Character image (must be >5% of frame) |
| `video_url` | yes | Motion reference (realistic character, full/upper body) |
| `character_orientation` | yes | `"image"` (max 10s), `"video"` (max 30s) |
| `keep_original_sound` | no | boolean, default true |
| `elements` | no | Facial binding — max 1 element, orientation=video only |

### 8.4 Kling — Video Effects

**Node Type:** Transform[^20]
**Inputs:** 🟢 Image(s) | **Outputs:** 🔴 Video | **Env:** `FAL_KEY`

| Parameter | Req | Notes |
|---|---|---|
| `input_image_urls` | conditional | Required for hug/kiss/heart_gesture |
| `effect_scene` | yes | 100+ effects: `hug`, `kiss`, `bullet_time`, `bullet_time_360`, `anime_figure`, `3d_cartoon_1_pro`, `zoom_out`, etc. |
| `duration` | no | `5` or `10` |

### 8.5 Kling — Lip Sync

**Node Type:** Transform | **Inputs:** 🔴 Video + (🟡 Audio for A2V or 🟣 Text for T2V) | **Outputs:** 🔴 Video[^20]

**A2V:** `video_url` (req, ≤100MB, 2–10s), `audio_url` (req, 2–60s, ≤5MB)

**T2V:** `video_url` (req, ≤100MB, 2–60s), `text` (req, ≤120 chars), `voice_id` (req, e.g. `oversea_male1`), `voice_language` (`"zh"` or `"en"`), `voice_speed` (float, default 1.0)

***

## Section 9 — Sora 2 (documented in Section 2.2–2.3 above)

***

## Section 10 — FLUX Models (Black Forest Labs)

### 10.1 FLUX 1.1 Pro Ultra — Text to Image

**Node Type:** Generator | **Execution:** sync[^22]  
**Inputs:** 🟣 Prompt, 🟢 Image (opt, for visual guidance) | **Outputs:** 🟢 Image  
**Env:** `FAL_KEY` or `BFL_API_KEY` | **Endpoint (fal):** `fal-ai/flux-pro/v1.1-ultra`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `prompt` | string | yes | — | — |
| `seed` | integer | no | — | Any integer |
| `num_images` | integer | no | 1 | 1–4 |
| `output_format` | enum | no | `jpeg` | `jpeg`, `png` |
| `safety_tolerance` | string | no | `2` | `1`–`6` (1=strict) |
| `enhance_prompt` | boolean | no | false | Prompt upsampling |
| `image_url` / `image_prompt` | string | no | — | URL or base64 (visual guidance) |
| `image_prompt_strength` | float | no | 0.1 | 0–1 |
| `aspect_ratio` | string | no | `16:9` | `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9` |
| `raw` | boolean | no | false | Candid/photographic look |

### 10.2 FLUX Schnell / FLUX Dev — Text to Image

**Node Type:** Generator | **Execution:** sync[^23]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image | **Env:** `FAL_KEY`

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | — | Required |
| `aspect_ratio` | `1:1` | Standard ratios |
| `num_outputs` | 1 | 1–4 |
| `output_format` | `webp` | `webp`, `jpg`, `png` |
| `output_quality` | 80 | 0–100 |
| `go_fast` | true | fp8 quantized |
| `megapixels` | `1` | Output resolution target |
| `seed` | — | Reproducibility |
| `disable_safety_checker` | false | — |

### 10.3 FLUX Redux — Image Variation

**Node Type:** Transform | **Execution:** sync  
**Inputs:** 🟢 Image, 🟣 Prompt (opt) | **Outputs:** 🟢 Image  
**Endpoint (fal):** `fal-ai/flux-pro/v1.1-ultra/redux`[^24]

Same params as FLUX Ultra plus `image_url` (required), `image_prompt_strength` 0–1.

***

## Section 11 — Stable Diffusion XL (via fal.ai)

### 11.1 Fast SDXL / SDXL Lightning — Text to Image

**Node Type:** Generator | **Execution:** sync[^23][^25]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Env:** `FAL_KEY` | **Endpoints:** `fal-ai/fast-sdxl`, `fal-ai/fast-lightning-sdxl`

| Parameter | Default | Options |
|---|---|---|
| `prompt` | — | Required |
| `negative_prompt` | — | — |
| `image_size` | `square_hd` | `square_hd`, `landscape_16_9`, `portrait_16_9`, `landscape_4_3`, `portrait_4_3`, `square` |
| `num_inference_steps` | 25 (SDXL), `4` (Lightning, enum: 1/2/4/8) | 1–100 |
| `guidance_scale` | 7.5 | Higher = more prompt-adherent |
| `num_images` | 1 | 1–8 |
| `seed` | — | — |
| `format` | `jpeg` | `jpeg`, `png` |
| `loras` | `[]` | LoRA fine-tunes |
| `embeddings` | `[]` | Textual inversions |

***

## Section 12 — ElevenLabs Audio Models

### 12.1 Text to Speech

**Node Type:** Generator | **Execution:** sync[^26][^27]  
**Inputs:** 🟣 Text | **Outputs:** 🟡 Audio  
**Env:** `ELEVENLABS_API_KEY` | **Endpoint:** `POST /v1/text-to-speech/{voice_id}`

**Model Options:**

| Model ID | Quality | Latency | Languages |
|---|---|---|---|
| `elevenlabs_v3` | Highest | High | 70+ |
| `eleven_multilingual_v2` | High | Medium | 29 |
| `eleven_turbo_v2_5` | High | Low | 32 |
| `eleven_flash_v2_5` | Good | ~75ms | 32 |
| `eleven_flash_v2` | Good | ~75ms | English only |

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `text` | string | yes | — | — |
| `model_id` | string | no | `eleven_multilingual_v2` | See table above |
| `language_code` | string | no | — | ISO 639-1 |
| `voice_settings.stability` | float | no | 0.5 | 0–1 |
| `voice_settings.similarity_boost` | float | no | 0.75 | 0–1 |
| `voice_settings.style` | float | no | 0 | 0–1 (style exaggeration) |
| `voice_settings.use_speaker_boost` | boolean | no | true | — |
| `voice_settings.speed` | float | no | 1.0 | 0.1–4.0 |
| `output_format` | string | no | `mp3_44100_128` | `mp3_22050_32`, `mp3_44100_128`, `pcm_16000`, `pcm_24000`, `pcm_44100` |
| `seed` | integer | no | — | Reproducibility |

***

## Section 13 — Seedream (ByteDance)

### 13.1 Seedream 4.5 / 5.0 — Text/Multi-Image to Image

**Node Type:** Generator/Transform | **Execution:** sync[^28][^29]  
**Inputs:** 🟣 Prompt, 🟢 Images (up to 14) | **Outputs:** 🟢 Image  
**Env:** `BYTEDANCE_API_KEY`

| Parameter | Type | Req | Default | Options |
|---|---|---|---|---|
| `model` | string | yes | — | `seedream-4-5-251128`, `seedream-5.0` |
| `prompt` | string | yes | — | Max 4000 chars |
| `image` | string/array | no | — | URL or base64; up to 14 for multi-image |
| `size` | string | no | `2K` | `2K`, `4K` |
| `seed` | integer | no | — | — |
| `sequential_image_generation` | string | no | `disabled` | `disabled`, `auto` |
| `sequential_image_generation_options.max_images` | integer | no | — | 2–6 (storyboard mode) |
| `watermark` | boolean | no | false | SynthID toggle |
| `response_format` | string | no | `url` | `url`, `b64_json` |

> **Seedream 5.0** adds real-time web search and logical reasoning before generating.[^30]

***

## Section 14 — Recraft V4

### 14.1 Recraft V4 — Text to Image (Raster)

**Node Type:** Generator | **Execution:** sync[^31][^32]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Env:** `RECRAFT_API_KEY` or `FAL_KEY` | **Endpoint (fal):** `fal-ai/recraft/v4/text-to-image`

| Parameter | Type | Default | Options |
|---|---|---|---|
| `prompt` | string | — | Required |
| `model` | string | — | `recraft20b`, `recraftv3` (2048×2048 max) |
| `image_size` | string/object | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, or `{width, height}` |
| `style` | string | — | `realistic_image`, `digital_illustration`, `vector_illustration`, `icon` |
| `colors` | array | — | `[{r, g, b}]` — palette control |
| `style_id` | string | — | Custom style UUID from Recraft's style gallery |

### 14.2 Recraft V4 — Text to SVG Vector

**Node Type:** Generator | **Execution:** sync[^33][^34]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟤 SVG  
**Env:** `RECRAFT_API_KEY` or `FAL_KEY` | **Endpoint (fal):** `fal-ai/recraft/v4/text-to-vector`

Same parameters as raster above. Output `content_type: "image/svg+xml"` — structured, editable paths. Compatible with Figma, Illustrator, and Sketch without conversion.

> **Note:** The SVG node should connect to the `svg-rasterize` utility node if the downstream model requires a raster Image port.

***

## Section 15 — Ideogram V3

**Node Type:** Generator | **Execution:** sync[^35]  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Env:** `IDEOGRAM_API_KEY` | **Endpoint:** `POST https://api.ideogram.ai/v1/ideogram-v3/generate`

| Parameter | Type | Req | Options |
|---|---|---|---|
| `prompt` | string | yes | — |
| `num_images` | integer | no | 1–4 |
| `resolution` | enum | no | Various standard resolutions |
| `style_ids` | array | no | Preset style UUIDs |
| `negative_prompt` | string | no | — |
| `seed` | integer | no | 0–2147483647 |

> **Best use case:** Text-in-image rendering — logos, signage, typographic art, titles.[^36][^37]

***

## Section 16 — Wan 2.6 (Alibaba)

**Execution:** async-poll[^38] | **Env:** `FAL_KEY`

### 16.1 Wan 2.6 — Text to Video

**Node Type:** Generator  
**Inputs:** 🟣 Prompt | **Outputs:** 🔴 Video  
**Endpoint (fal):** `wan/v2.6/text-to-video`

### 16.2 Wan 2.6 — Image to Video

**Node Type:** Transform  
**Inputs:** 🟢 Image, 🟣 Prompt | **Outputs:** 🔴 Video

### 16.3 Wan 2.6 — Reference to Video (unique mode)

**Node Type:** Transform  
**Inputs:** 🔴 Video × 1–3 (reference), 🟣 Prompt | **Outputs:** 🔴 Video

Reference videos are tagged in the prompt as `@Video1`, `@Video2`, `@Video3`.

**Shared Parameters across all Wan 2.6 modes:**

| Parameter | T2V | I2V | R2V | Options |
|---|---|---|---|---|
| `prompt` | ✅ req | ✅ req | ✅ req | Max 800 chars |
| `image_url` | ❌ | ✅ req | ❌ | 360–2000px, ≤100MB |
| `video_urls` | ❌ | ❌ | ✅ 1–3 | MP4 references |
| `duration` | 5/10/15s | 5/10/15s | 5/10s | string |
| `resolution` | 720p, 1080p | 480p, 720p, 1080p | varies | string |
| `aspect_ratio` | 16:9, 9:16, 1:1, 4:3, 3:4 | same | same | string |
| `multi_shots` | boolean | false | ❌ | Scene segmentation |
| `negative_prompt` | opt | opt | opt | string |
| `seed` | opt | opt | opt | integer |
| `generate_audio` | opt | opt | ❌ | boolean |

***

## Section 17 — MiniMax / Hailuo AI Video

**Execution:** async-poll (3-step pattern)[^39]
**Env:** `MINIMAX_API_KEY` or `FAL_KEY`

> **3-step async pattern:** (1) `POST /v1/video_generation` → get `task_id`, (2) Poll `GET /v1/query/video_generation?task_id={id}` until `status=Success`, (3) Retrieve file via `file_id` from result.

### 17.1 MiniMax — Text to Video

**Node Type:** Generator  
**Inputs:** 🟣 Prompt | **Outputs:** 🔴 Video

### 17.2 MiniMax — Image to Video (First+Last Frame)

**Node Type:** Transform  
**Inputs:** 🟢 First Frame (req for I2V), 🟢 Last Frame (opt), 🟣 Prompt | **Outputs:** 🔴 Video

### 17.3 MiniMax — Subject Reference Video (S2V-01)

**Node Type:** Transform  
**Inputs:** 🟢 Character Image, 🟣 Prompt | **Outputs:** 🔴 Video

**Full parameter table (all modes):**

| Parameter | Type | Req | Modes | Options |
|---|---|---|---|---|
| `prompt` | string | yes | all | — |
| `model` | string | no | — | `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-02`, `S2V-01` |
| `duration` | integer | no | — | `6`, `9` |
| `resolution` | string | no | — | `720P`, `1080P` |
| `first_frame_image` | URL | conditional | I2V/First+Last | Required for I2V |
| `last_frame_image` | URL | no | First+Last | Optional end frame |
| `subject_reference` | array | conditional | S2V-01 only | `[{type:"character", image:[URL]}]` |

**Director camera control (I2V Director model):** Write camera commands inside brackets in the prompt: `[Push in]`, `[Orbit left]`, `[Pan right]`, `[Follow]`, `[Crane up]`, `[Zoom out]`.[^40]

***

## Section 18 — Luma Ray 2

**Execution:** async-poll[^41][^42] | **Env:** `FAL_KEY` or `LUMA_API_KEY`

### 18.1 Luma Ray 2 — Text to Video

**Node Type:** Generator  
**Endpoint (fal):** `fal-ai/luma-dream-machine/ray-2`

### 18.2 Luma Ray 2 — Image to Video

**Node Type:** Transform  
**Inputs:** 🟢 Image, 🟣 Prompt | **Endpoint:** `fal-ai/luma-dream-machine/ray-2/image-to-video`

### 18.3 Luma Ray 2 Flash — Modify / V2V

**Node Type:** Transform  
**Inputs:** 🔴 Video, 🟣 Prompt | **Endpoint:** `fal-ai/luma-dream-machine/ray-2-flash/modify`

**Shared parameters all Luma Ray 2 modes:**

| Parameter | Type | Default | Options |
|---|---|---|---|
| `prompt` | string | — | Required for T2V, I2V |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21` |
| `loop` | boolean | false | Seamless loop blend |
| `resolution` | string | `540p` | `540p`, `720p`, `1080p` (720p costs 2x; 1080p 4x) |
| `duration` | string | `5s` | `5s`, `9s` |
| `image_url` | string | — | Required for I2V |
| `end_image_url` | string | — | Optional last frame (I2V) |
| `video_url` | string | — | Required for Modify |

***

## Section 19 — LTX Video 2.0 Pro (Lightricks)

**Node Type:** Transform | **Execution:** async-poll[^43]  
**Inputs:** 🟢 Image, 🟣 Prompt | **Outputs:** 🔴 Video  
**Env:** `FAL_KEY` | **Endpoint:** `fal-ai/ltx-2/image-to-video`

| Parameter | Type | Default | Options |
|---|---|---|---|
| `image_url` | string | — | Required; PNG/JPEG/WebP/AVIF/HEIF |
| `prompt` | string | — | Required |
| `duration` | integer | 6 | `6`, `8`, `10` |
| `resolution` | string | `1080p` | `1080p`, `1440p`, `2160p` **(4K!)** |
| `aspect_ratio` | string | `16:9` | `16:9` |
| `fps` | integer | 25 | `25`, `50` |
| `generate_audio` | boolean | true | — |

> **Only model with 4K (2160p) video output at image-to-video endpoint.**[^44][^43]

***

## Section 20 — Pixverse V4.5

**Node Type:** Generator (T2V) or Transform (I2V/Effects) | **Execution:** async-poll[^45][^46]  
**Env:** `FAL_KEY`

| Parameter | Type | Default | Options |
|---|---|---|---|
| `prompt` | string | — | Required for T2V/I2V |
| `model` | string | `v4.5` | `v3.5`, `v4`, `v4.5`, `v5` |
| `image_url` | string | — | Required for I2V/Effects |
| `effect` | string | — | Required for Effects mode |
| `duration` | string | `5` | `5`, `8` |
| `resolution` | string | `720p` | `360p`, `540p`, `720p`, `1080p` |
| `quality` | string | `Normal` | `Turbo`, `Normal`, `Fast` |
| `seed` | integer | — | — |
| `negative_prompt` | string | — | — |

***

## Section 21 — Seedance V1.5 (ByteDance)

**Node Type:** Generator/Transform | **Execution:** async-poll[^44]  
**Inputs:** 🟣 Prompt (+🟢 Image for I2V) | **Outputs:** 🔴 Video | **Env:** `FAL_KEY`

| Parameter | Options |
|---|---|
| `duration` | 4–12s |
| `aspect_ratio` | `16:9`, `9:16`, `1:1`, `21:9`, `3:4`, `4:3` |
| `resolution` | `720p`, `480p` |
| `prompt` | Required |
| `image_url` | Required for I2V |

***

## Section 22 — Grok Imagine (xAI)

**Execution:** sync | **Env:** `XAI_API_KEY`

### 22.1 Grok Imagine — Image Generation

**Node Type:** Generator  
**Inputs:** 🟣 Prompt | **Outputs:** 🟢 Image  
**Endpoint:** `POST https://api.x.ai/v1/images/generations`

| Parameter | Options |
|---|---|
| `model` | `grok-2-image`, `aurora` |
| `prompt` | Required |
| `n` | 1–4 |
| `response_format` | `url`, `b64_json` |
| `size` | Standard sizes |

### 22.2 Grok Imagine — Video (T2V / I2V)

**Node Type:** Generator/Transform[^44]
**Inputs:** 🟣 Prompt (+🟢 Image for I2V) | **Outputs:** 🔴 Video  
- Duration: 1–15s  
- Aspect ratios: `16:9`, `9:16`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`

***

## Section 23 — Moonvalley, Higgsfield

### 23.1 Moonvalley — Image to Video

**Node Type:** Transform | **Execution:** async-poll[^44]  
**Inputs:** 🟢 Image, 🟣 Prompt | **Outputs:** 🔴 Video | **Env:** `FAL_KEY`  
Resolutions: `1920×1080`, `1080×1920`, `1152×1152`, `1536×1152`, `1152×1536`  
Duration: `5s` or `10s`

### 23.2 Higgsfield Video — Text to Video

**Node Type:** Generator | **Execution:** async-poll[^47]  
**Inputs:** 🟣 Prompt | **Outputs:** 🔴 Video | **Env:** `HIGGSFIELD_API_KEY`  
Features: Keyframing, camera direction, character consistency. Also acts as a model aggregator (wraps Kling 2.6, Sora 2, Veo 3.1).

***

## Section 24 — Utility Models

### 24.1 Remove Background

**Node Type:** Utility/Transform[^48][^49]
**Inputs:** 🟢 Image | **Outputs:** 🟢 Image (transparent PNG) + 🟢 Lime Mask  
**Env:** `REPLICATE_API_TOKEN`

| Model | Notes |
|---|---|
| `851-labs/background-remover` | Fastest, cleanest edges |
| `bria/remove-background` | 256-level alpha, commercially-safe training data |
| `recraft-ai/recraft-remove-background` | Tuned for AI-generated images |

***

## Section 25 — OpenRouter Universal Node

**Execution:** stream or sync depending on selected model | **Env:** `OPENROUTER_API_KEY`  
**Endpoint:** `POST https://openrouter.ai/api/v1/chat/completions`

Dynamically renders input/output ports based on selected model's `input_modalities` and `output_modalities`.

```python
# Image generation via OpenRouter (NOT standard /v1/images/generations endpoint)
payload = {
    "model": "black-forest-labs/flux.2-klein-4b",   # or any OR image model
    "messages": [{"role": "user", "content": prompt}],
    "modalities": ["text", "image"]  # triggers image output
}
# Response: delta.images[] contains generated image URLs
```

**Model discovery:**
```bash
# All available models
GET https://openrouter.ai/api/v1/models

# Image-capable models only
GET https://openrouter.ai/api/v1/models?output_modalities=image
```

> ⚠️ OpenRouter does NOT support image editing/inpainting. Only image generation via the chat completions endpoint.[^50][^51]

***

## Section 26 — Replicate Universal Node

**Execution:** async-poll | **Env:** `REPLICATE_API_TOKEN`  
**Endpoint:** `POST https://api.replicate.com/v1/predictions`  
**Poll:** `GET https://api.replicate.com/v1/predictions/{id}` until `succeeded`/`failed`[^52]

**Schema auto-discovery for any model:**
```bash
GET /v1/models/{owner}/{name}/versions/{version_id}
# Returns openapi_schema with full input/output type definitions
```

Node auto-generates settings panel and ports from schema. See Section 8 of the Architecture Spec for full implementation code.

**Model search API (September 2025+):**[^53]
```python
import replicate
results = replicate.models.search("lip sync")
# Returns name, owner, description, run_count per model
```

***

## Section 27 — Complete Quick-Reference Table (All Models)

| Model | Node Type | Input Ports | Output Ports | Execution | Env Key |
|---|---|---|---|---|---|
| gpt-image-1 generate | Generator | 🟣 Prompt | 🟢 Image | sync | `OPENAI_API_KEY` |
| gpt-image-1 edit | Transform | 🟢 Image, 🟣 Prompt, 🟢 Mask | 🟢 Image | sync | `OPENAI_API_KEY` |
| dall-e-3 | Generator | 🟣 Prompt | 🟢 Image | sync | `OPENAI_API_KEY` |
| gpt-4o / 4.1 | Analyzer | 🟣 Messages, 🟢 Images | 🟣 Text | stream | `OPENAI_API_KEY` |
| sora-2 T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `OPENAI_API_KEY` |
| sora-2 V2V | Transform | 🔴 Video, 🟣 Prompt | 🔴 Video | async-poll | `OPENAI_API_KEY` |
| claude-opus-4 / sonnet-4 | Analyzer | 🟣 Messages, 🟢 Images | 🟣 Text | stream | `ANTHROPIC_API_KEY` |
| gemini-2.5-flash / 3-pro | Analyzer | 🟣🟢🔴🟡 Multi | 🟣 Text (+🟢) | stream | `GOOGLE_API_KEY` |
| nano-banana | Generator | 🟣 Prompt, 🟢 Images | 🟢 Image, 🟣 Text | sync | `GOOGLE_API_KEY` |
| imagen-4.0-generate | Generator | 🟣 Prompt | 🟢 Image | sync | `GOOGLE_API_KEY` |
| veo3 | Generator | 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| runway-gen4-turbo I2V | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `RUNWAY_API_KEY` |
| runway-gen4.5 T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `RUNWAY_API_KEY` |
| runway-act-two | Transform | 🟢 Image, 🔴 Video | 🔴 Video | async-poll | `RUNWAY_API_KEY` |
| kling-1.6 / 2.1 I2V | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| kling-v3 T2V/I2V | Generator/Transform | 🟣 Prompt, 🟢 Image | 🔴 Video | async-poll | `FAL_KEY` |
| kling-motion-control | Transform | 🟢 Image, 🔴 Video | 🔴 Video | async-poll | `FAL_KEY` |
| kling-effects | Transform | 🟢 Image | 🔴 Video | async-poll | `FAL_KEY` |
| kling-lipsync A2V | Transform | 🔴 Video, 🟡 Audio | 🔴 Video | async-poll | `FAL_KEY` |
| kling-lipsync T2V | Transform | 🔴 Video, 🟣 Text | 🔴 Video | async-poll | `FAL_KEY` |
| flux-1.1-ultra | Generator | 🟣 Prompt, 🟢 Image? | 🟢 Image | sync | `FAL_KEY` |
| flux-schnell | Generator | 🟣 Prompt | 🟢 Image | sync | `FAL_KEY` |
| flux-redux | Transform | 🟢 Image, 🟣 Prompt? | 🟢 Image | sync | `FAL_KEY` |
| fast-sdxl | Generator | 🟣 Prompt | 🟢 Image | sync | `FAL_KEY` |
| elevenlabs-tts | Generator | 🟣 Text | 🟡 Audio | sync | `ELEVENLABS_API_KEY` |
| seedream-4.5 / 5.0 | Generator | 🟣 Prompt, 🟢 Images | 🟢 Image | sync | `BYTEDANCE_API_KEY` |
| recraft-v4 raster | Generator | 🟣 Prompt | 🟢 Image | sync | `RECRAFT_API_KEY` |
| recraft-v4 svg | Generator | 🟣 Prompt | 🟤 SVG | sync | `RECRAFT_API_KEY` |
| ideogram-v3 | Generator | 🟣 Prompt | 🟢 Image | sync | `IDEOGRAM_API_KEY` |
| grok-imagine image | Generator | 🟣 Prompt | 🟢 Image | sync | `XAI_API_KEY` |
| grok-imagine video | Generator/Transform | 🟣 Prompt, 🟢 Image? | 🔴 Video | async-poll | `XAI_API_KEY` |
| wan-2.6 T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| wan-2.6 I2V | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| wan-2.6 R2V | Transform | 🔴 Video × 1–3, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| minimax T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `MINIMAX_API_KEY` |
| minimax I2V (First+Last) | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `MINIMAX_API_KEY` |
| minimax S2V-01 | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `MINIMAX_API_KEY` |
| luma-ray2 T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| luma-ray2 I2V | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| luma-ray2-flash modify | Transform | 🔴 Video, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| ltx-video-2 I2V | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video (4K) | async-poll | `FAL_KEY` |
| pixverse-v4.5 T2V | Generator | 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| pixverse-v4.5 effects | Transform | 🟢 Image | 🔴 Video | async-poll | `FAL_KEY` |
| seedance-v1.5 | Generator/Transform | 🟣 Prompt, 🟢 Image? | 🔴 Video | async-poll | `FAL_KEY` |
| moonvalley | Transform | 🟢 Image, 🟣 Prompt | 🔴 Video | async-poll | `FAL_KEY` |
| higgsfield | Generator | 🟣 Prompt | 🔴 Video | async-poll | `HIGGSFIELD_API_KEY` |
| remove-background | Utility | 🟢 Image | 🟢 Image (alpha) | sync | `REPLICATE_API_TOKEN` |
| openrouter (universal) | Any | Dynamic | 🟣 Text (+🟢 Image) | stream/sync | `OPENROUTER_API_KEY` |
| replicate (universal) | Any | Schema-driven | Schema-driven | async-poll | `REPLICATE_API_TOKEN` |
| fal (universal) | Any | Schema-driven | Schema-driven | async-poll | `FAL_KEY` |

---

## References

1. [OpenAI makes its upgraded image generator available to developers](https://techcrunch.com/2025/04/23/openai-makes-its-upgraded-image-generator-available-to-developers/) - In OpenAI's API, the image-generation capability is powered by an AI model called “gpt-image-1.” A n...

2. [OpenAI Releases gpt-image-1 Model via API for Developer Integration](https://adtmag.com/articles/2025/04/23/openai-releases-model-via-api-for-developer-integration.aspx) - According to OpenAI, gpt-image-1 supports tasks such as: Generating and editing illustrations from t...

3. [Error when attempting to access gpt-image-1.5 in images/edits - API](https://community.openai.com/t/error-when-attempting-to-access-gpt-image-1-5-in-images-edits/1375534) - Hi All, I am encountering an issue when attempting to access any model other than dall-e-2 via the i...

4. [Create image edit | OpenAI API Reference](https://developers.openai.com/api/reference/python/resources/images/methods/edit/) - Creates an edited or extended image given one or more source images and a prompt. This endpoint supp...

5. [Completions API - OpenAI Developers](https://developers.openai.com/api/docs/guides/completions) - The Chat Completions API is the interface to our most capable model ( gpt-4o ), and our most cost ef...

6. [Temperature in GPT-5 models - API - OpenAI Developer Community](https://community.openai.com/t/temperature-in-gpt-5-models/1337133) - Will they add the ability of temperature being a parameter in the future? Don't count on it. Tempera...

7. [OpenAI Sora 2: High Quality Text-to-Video Generator with Audio | fal](https://fal.ai/models/fal-ai/sora-2/text-to-video/pro/api) - Generate cinematic videos with OpenAI Sora 2. Text-to-video with native audio, 1080p quality, commer...

8. [Sora 2 API Size Error Fix: Complete Resolution Reference Guide 2026](https://yingtu.ai/en/blog/sora2-api-size-error) - Working with the Sora 2 API often leads to frustrating size and dimension errors that provide minima...

9. [Video to Video (Remix) - Sora 2 - Fal.ai](https://fal.ai/models/fal-ai/sora-2/video-to-video/remix/api) - Video-to-video remix endpoint for Sora 2, OpenAI's advanced model that transforms existing videos ba...

10. [Introducing Claude 4 - Anthropic](https://www.anthropic.com/news/claude-4) - Claude Opus 4 is the world's best coding model, with sustained performance on complex, long-running ...

11. [Anthropic Claude Models: Full List & Comparison 2026 - Lorka AI](https://www.lorka.ai/ai-models/anthropic) - Inputs: Text, Images. Outputs: Text. Context: Up to 200K tokens. Price (input): $5 per 1M tokens. Pr...

12. [Building with extended thinking - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) - With extended thinking enabled, the Messages API for Claude 4 models returns a summary of Claude's f...

13. [Gemini 2.5 Flash | Generative AI on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash) - Text generation · System instructions · Function calling ... 5-flash. Supported inputs & outputs. In...

14. [Nano Banana image generation - Google AI for Developers](https://ai.google.dev/gemini-api/docs/image-generation) - Nano Banana is the name for Gemini's native image generation capabilities. Gemini can generate and p...

15. [accurate temperature support for Gemini models (e.g. Gemini 3 Pro ...](https://github.com/enricoros/big-AGI/issues/953) - "For Gemini 3, we strongly recommend keeping the temperature parameter at its default value of 1.0. ...

16. [Nano Banana 2: How developers can use the new AI image model](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-nano-banana-2/) - Here's a look at the new capabilities you can build with in Google AI Studio or the Gemini API. A pa...

17. [Imagen 4 | Generative AI on Vertex AI - Google Cloud Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate) - Imagen 4 is our latest line of image generation models. This page documents the capabilities and fea...

18. [Google Veo 3: AI Video Generator | Text-to-Video AI + Audio | fal.ai](https://fal.ai/models/fal-ai/veo3/api) - Generate videos with Google Veo 3 - the most advanced AI video model. Text-to-video with sound, 1080...

19. [API Input Parameters - Runway API](https://docs.dev.runwayml.com/assets/inputs/) - Learn about input parameters for Runway's API. Understand how to format images, videos, text prompts...

20. [Kling 1.0 | Image to Video - Fal.ai](https://fal.ai/models/fal-ai/kling-video/v1/standard/image-to-video/api) - We provide a convenient file storage that allows you to upload files and use them in your requests. ...

21. [Image to Video - Kling 1.6 - Fal.ai](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video/api) - Kling 1.6 (pro) Image to Video API. 1. Calling the API#. Install the client#. The client provides a ...

22. [FLUX1.1 [pro] Ultra Mode - Black Forest Labs](https://docs.bfl.ml/flux_models/flux_1_1_pro_ultra_raw) - Generate varying aspect ratios from text, at 4MP resolution fast. To generate an image from text, yo...

23. [Stable Diffusion XL | Text to Image - Fal.ai](https://fal.ai/models/fal-ai/fast-sdxl/api) - The client API handles the API submit protocol. It will handle the request status updates and return...

24. [LLMs - Fal.ai](https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra/redux/llms.txt) - ... FLUX capabilities. ## Overview - **Endpoint**: `https://fal.run/fal-ai/flux-pro/v1.1-ultra/redux...

25. [Stable Diffusion XL Lightning | Text to Image - Fal.ai](https://fal.ai/models/fal-ai/fast-lightning-sdxl/api) - The client API handles the API submit protocol. It will handle the request status updates and return...

26. [Create speech | ElevenLabs Documentation](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) - Converts text into speech using a voice of your choice and returns audio. Path parameters. voice_ids...

27. [Get voice settings | ElevenLabs Documentation](https://elevenlabs.io/docs/api-reference/voices/settings/get) - Adjusts the speed of the voice. A value of 1.0 is the default speed, while values less than 1.0 slow...

28. [Seedream 4.5 - Docs Azerion AI Platform](https://docs.azerion.ai/api-reference/create-image/seedream-4-5/) - It supports various generation modes including text-to-image, image-to-image, sequential image gener...

29. [Seedream 4.5: A Complete Guide With Python - DataCamp](https://www.datacamp.com/tutorial/seedream-4-5) - In this article, I'll teach you how to use Seedream 4.5 with Python by integrating it through its AP...

30. [Seedream 5.0 - AI Image Generator - Higgsfield](https://higgsfield.ai/seedream-5.0) - Create images powered by real-time web search and multi-step reasoning. Seedream 5.0 by ByteDance de...

31. [Recraft V4](https://www.recraft.ai/docs/recraft-models/recraft-V4) - Recraft V4 is the latest generation of Recraft's proprietary model family, released in February 2026...

32. [Recraft V4: image generation with design taste – Replicate blog](https://replicate.com/blog/recraft-v4) - Recraft V4 generates art-directed images — and actual editable SVGs — with strong composition, accur...

33. [Recraft V4 Vector: Text-to-SVG AI Generator | Scalable Graphics | fal.ai](https://fal.ai/models/fal-ai/recraft/v4/text-to-vector/api) - Generate scalable SVG vectors from text with Recraft V4. Native vector output for logos, icons, and ...

34. [Recraft V4 SVG — generate editable vector images from text](https://replicate.com/recraft-ai/recraft-v4-svg) - Generate production-ready SVG vector graphics from text prompts. Recraft V4 SVG produces clean, edit...

35. [Generate with Ideogram 3.0](https://developer.ideogram.ai/api-reference/api-reference/generate-v3) - Generates images synchronously based on a given prompt and optional parameters using the Ideogram 3....

36. [Best AI Image Generator 2026 — Top 10 Compared - maginary](https://maginary.ai/best-ai-image-generator-2026) - Compare the best AI image generators in 2026. Midjourney, DALL-E, Maginary, Flux, Stable Diffusion, ...

37. [Ideogram Guide 2026: Features, Pricing, How to Use, and Complete ...](https://aitoolsdevpro.com/ai-tools/ideogram-guide/) - This guide covers everything from the internal architecture of Ideogram's latest models to practical...

38. [Wan 2.6 Developer Guide: Next-Generation Video Generation - Fal.ai](https://fal.ai/learn/devs/wan-26-developer-guide-mastering-next-generation-video-generation) - This guide covers implementation patterns, API specifications, and production considerations for dev...

39. [Video Generation - Models - MiniMax API Docs](https://platform.minimax.io/docs/guides/video-generation) - Text-to-Video: Generate a video directly from a text description. Image-to-Video: Generate a video b...

40. [MiniMax (Hailuo AI) Video 01 Director - Image to Video - Fal.ai](https://fal.ai/models/fal-ai/minimax/video-01-director/image-to-video/api) - Generate video clips more accurately with respect to initial image, natural language descriptions, a...

41. [Luma Ray 2: Premium Text-to-Video AI Generator | fal](https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/api) - The client API handles the API submit protocol. It will handle the request status updates and return...

42. [fal-ai/luma-dream-machine/ray-2/image-to-video](https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/image-to-video/api) - The client API handles the API submit protocol. It will handle the request status updates and return...

43. [LTX Video 2.0 Pro Image to Video Developer Guide - Fal.ai](https://fal.ai/learn/devs/ltx-video-2-pro-image-to-video-developer-guide) - Complete guide to integrating LTX Video 2.0 Pro's image-to-video API. Learn setup, implementation pa...

44. [Video Models Comparison | Figma Weave's Knowledge Center](https://help.weavy.ai/en/articles/12344226-video-models-comparison) - Model Name. Kling 3. Seedance V1.5 Pro. Wan 2.5. Grok Imagine Video. Sora 2. Wan ... Luma Ray 2 Flas...

45. [Pixverse | Image to Video - Fal.ai](https://fal.ai/models/fal-ai/pixverse/v4.5/effects/api) - The API uses an API Key for authentication. It is recommended you set the FAL_KEY environment variab...

46. [PixVerse v4.5 | Text to Video | AI Model - Eachlabs](https://www.eachlabs.ai/pixverse/pixverse-v4-5/pixverse-v4-5-text-to-video) - Turn your imagined scenes into text with pixverse v4 5 text to video; obtain cinema quality video ou...

47. [Best AI Video Generators in 2026 - Higgsfield AI](https://higgsfield.ai/blog/best-ai-video-generators-2026) - Discover the definitive list of 2026's best AI video generators. Learn which tools give you the crea...

48. [recraft-ai/recraft-remove-background | Run with an API on Replicate](https://replicate.com/recraft-ai/recraft-remove-background) - Automated background removal for images. Tuned for AI-generated content, product photos, portraits, ...

49. [Remove backgrounds from photos and videos via API - Replicate](https://replicate.com/collections/remove-backgrounds) - Run popular AI models using our API to remove backgrounds from images & videos. Get clean cutouts fo...

50. [Use OpenRouter cannot generate image by DALL.E model](https://community.n8n.io/t/use-openrouter-cannot-generate-image-by-dall-e-model/249902) - Finally: to generate an image with OpenRouter, you'll need to use an HTTP node with the correct endp...

51. [How to make image generation model work through the OpenRouter ...](https://www.reddit.com/r/OpenWebUI/comments/1s6216b/how_to_make_image_generation_model_work_through/) - I have an OpenRouter api key and want to use the model called black-forest-labs/flux.2-klein-4b thro...

52. [Run all models with the same API endpoint – Replicate changelog](https://replicate.com/changelog/2025-08-05-run-all-models-with-the-same-api-endpoint) - You can now use the POST /v1/predictions HTTP API endpoint to run any model on Replicate, whether it...

53. [Introducing our new search API – Replicate blog](https://replicate.com/blog/new-search-api) - We've added a new search API to help you find the best models. This API is currently in beta, but it...

