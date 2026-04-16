# FAL Model API Schemas

Complete input/output parameter reference for all FAL models used in Nebula Nodes.
Scraped from fal.ai API documentation on 2026-04-14.

---

## Table of Contents

1. [FLUX.1 [dev]](#1-flux1-dev)
2. [Seedream 4.5 Edit](#2-seedream-45-edit)
3. [Seedance 2 I2V](#3-seedance-2-i2v)
4. [Flux 2 Pro](#4-flux-2-pro)
5. [FLUX1.1 [pro]](#5-flux11-pro)
6. [FLUX Kontext](#6-flux-kontext)
7. [GPT-Image 1.5 Edit](#7-gpt-image-15-edit)
8. [Flux 2 Pro Edit](#8-flux-2-pro-edit)
9. [Seedance 2 R2V](#9-seedance-2-r2v)
10. [FLUX.1 LoRA](#10-flux1-lora)
11. [SeedVR2 Upscale](#11-seedvr2-upscale)
12. [Seedance 2.0 T2V](#12-seedance-20-t2v)
13. [GPT-Image 1.5](#13-gpt-image-15)
14. [Seedream 5.0 Lite Edit](#14-seedream-50-lite-edit)
15. [Seedream 4.5 T2I](#15-seedream-45-t2i)
16. [Seedance 1.5 Pro I2V](#16-seedance-15-pro-i2v)
17. [Bria RMBG 2.0](#17-bria-rmbg-20)
18. [Z-Image Turbo](#18-z-image-turbo)
19. [Seedance 2.0 Fast T2V](#19-seedance-20-fast-t2v)
20. [Seedance 2.0 Fast I2V](#20-seedance-20-fast-i2v)
21. [Birefnet BG Removal](#21-birefnet-bg-removal)
22. [Seedream v4 Edit](#22-seedream-v4-edit)

---

## 1. FLUX.1 [dev]

**Endpoint**: `fal-ai/flux/dev`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_size | ImageSize \| Enum | No | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| num_inference_steps | integer | No | `28` | The number of inference steps to perform |
| seed | integer | No | - | Seed for reproducible generation |
| guidance_scale | float | No | `3.5` | CFG scale -- how closely model follows prompt |
| sync_mode | boolean | No | - | If true, returns data URI; output not saved to history |
| num_images | integer | No | `1` | Number of images to generate |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| acceleration | Enum | No | `none` | `none`, `regular`, `high` |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, width, height, content_type) |
| timings | Timings | Processing timing info |
| seed | integer | Seed used |
| has_nsfw_concepts | list\<boolean\> | NSFW detection per image |
| prompt | string | Prompt used |

---

## 2. Seedream 4.5 Edit

**Endpoint**: `fal-ai/bytedance/seedream/v4.5/edit`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The text prompt used to edit the image |
| image_urls | list\<string\> | Yes | - | List of input image URLs (up to 10) |
| image_size | ImageSize \| Enum | No | - | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto_2K`, `auto_4K` -- or custom `{width, height}` (1920-4096) |
| num_images | integer | No | `1` | Number of separate generations |
| max_images | integer | No | `1` | Multi-image generation; total input+output <= 15 |
| seed | integer | No | - | Random seed for reproducibility |
| sync_mode | boolean | No | - | If true, returns data URI |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, content_type, file_name, file_size, width, height) |

---

## 3. Seedance 2 I2V

**Endpoint**: `bytedance/seedance-2.0/image-to-video`
**Category**: image-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt describing desired motion/action |
| image_url | string | Yes | - | Starting frame image URL (JPEG, PNG, WebP; max 30MB) |
| end_image_url | string | No | - | Image for the last frame of video |
| resolution | Enum | No | `720p` | `480p`, `720p` |
| duration | Enum | No | `auto` | `auto`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` |
| aspect_ratio | Enum | No | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| generate_audio | boolean | No | `true` | Generate synchronized audio (sound effects, ambient, lip-sync) |
| seed | integer | No | - | Random seed (results may still vary slightly) |
| end_user_id | string | No | - | Unique end user ID |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 4. Flux 2 Pro

**Endpoint**: `fal-ai/flux-2-pro`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_size | ImageSize \| Enum | No | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| seed | integer | No | - | Seed for reproducibility |
| safety_tolerance | Enum | No | `2` | `1`, `2`, `3`, `4`, `5` (1=strict, 5=permissive). API only |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<ImageFile\> | Generated images (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |

---

## 5. FLUX1.1 [pro]

**Endpoint**: `fal-ai/flux-pro/v1.1`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_size | ImageSize \| Enum | No | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| seed | integer | No | - | Seed for reproducibility |
| sync_mode | boolean | No | - | If true, returns data URI |
| num_images | integer | No | `1` | Number of images to generate |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| safety_tolerance | Enum | No | `2` | `1`, `2`, `3`, `4`, `5`, `6` (1=strict, 5=permissive). API only |
| enhance_prompt | boolean | No | - | Enhance prompt for better results |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, width, height, content_type) |
| timings | Timings | Processing timing info |
| seed | integer | Seed used |
| has_nsfw_concepts | list\<boolean\> | NSFW detection per image |
| prompt | string | Prompt used |

---

## 6. FLUX Kontext

**Endpoint**: `fal-ai/flux-pro/kontext`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_url | string | Yes | - | Image prompt for the omni model |
| seed | integer | No | - | Seed for reproducibility |
| guidance_scale | float | No | `3.5` | CFG scale |
| sync_mode | boolean | No | - | If true, returns data URI |
| num_images | integer | No | `1` | Number of images to generate |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| safety_tolerance | Enum | No | `2` | `1`, `2`, `3`, `4`, `5`, `6` (1=strict, 5=permissive). API only |
| enhance_prompt | boolean | No | - | Enhance prompt for better results |
| aspect_ratio | Enum | No | - | `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21` |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, width, height, content_type, file_name, file_size) |
| timings | Timings | Processing timing info |
| seed | integer | Seed used |
| has_nsfw_concepts | list\<boolean\> | NSFW detection per image |
| prompt | string | Prompt used |

---

## 7. GPT-Image 1.5 Edit

**Endpoint**: `fal-ai/gpt-image-1.5/edit`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt for image generation |
| image_urls | list\<string\> | Yes | - | URLs of reference images |
| image_size | Enum | No | `auto` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` |
| background | Enum | No | `auto` | `auto`, `transparent`, `opaque` |
| quality | Enum | No | `high` | `low`, `medium`, `high` |
| input_fidelity | Enum | No | `high` | `low`, `high` |
| num_images | integer | No | `1` | Number of images to generate |
| output_format | Enum | No | `png` | `jpeg`, `png`, `webp` |
| sync_mode | boolean | No | - | If true, returns data URI |
| mask_image_url | string | No | - | Mask image URL indicating what part to edit |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<ImageFile\> | Generated images (url, content_type, file_name, file_size, width, height) |

---

## 8. Flux 2 Pro Edit

**Endpoint**: `fal-ai/flux-2-pro/edit`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_urls | list\<string\> | Yes | - | List of input image URLs for editing |
| image_size | ImageSize \| Enum | No | `auto` | `auto`, `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| seed | integer | No | - | Seed for reproducibility |
| safety_tolerance | Enum | No | `2` | `1`, `2`, `3`, `4`, `5` (1=strict, 5=permissive). API only |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<ImageFile\> | Generated images (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |

---

## 9. Seedance 2 R2V

**Endpoint**: `bytedance/seedance-2.0/reference-to-video`
**Category**: image-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt to generate the video |
| image_urls | list\<string\> | No | - | Reference images (up to 9, JPEG/PNG/WebP, max 30MB each). Referenced as @Image1, @Image2, etc. in prompt |
| video_urls | list\<string\> | No | - | Reference videos (up to 3, MP4/MOV, 2-15s combined, <50MB total). Referenced as @Video1, @Video2, etc. |
| audio_urls | list\<string\> | No | - | Reference audio (up to 3, MP3/WAV, max 15s combined, 15MB each). Referenced as @Audio1, etc. Requires image or video ref |
| resolution | Enum | No | `720p` | `480p`, `720p` |
| duration | Enum | No | `auto` | `auto`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` |
| aspect_ratio | Enum | No | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| generate_audio | boolean | No | `true` | Generate synchronized audio (sound effects, ambient, lip-sync) |
| seed | integer | No | - | Random seed for reproducibility |
| end_user_id | string | No | - | Unique end user ID |

> Note: Total files across all modalities must not exceed 12.

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 10. FLUX.1 LoRA

**Endpoint**: `fal-ai/flux-lora`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_size | ImageSize \| Enum | No | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| num_inference_steps | integer | No | `28` | Number of inference steps |
| seed | integer | No | - | Seed for reproducibility |
| loras | list\<LoraWeight\> | No | - | LoRA weights: each has `path` (string, required -- URL or path) and `scale` (float, default `1`) |
| guidance_scale | float | No | `3.5` | CFG scale |
| sync_mode | boolean | No | - | If true, returns data URI |
| num_images | integer | No | `1` | Number of images to generate |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| output_format | Enum | No | `jpeg` | `jpeg`, `png` |
| acceleration | Enum | No | `none` | `none`, `regular` |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, width, height, content_type) |
| timings | Timings | Processing timing info |
| seed | integer | Seed used |
| has_nsfw_concepts | list\<boolean\> | NSFW detection per image |
| prompt | string | Prompt used |

---

## 11. SeedVR2 Upscale

**Endpoint**: `fal-ai/seedvr/upscale/image`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| image_url | string | Yes | - | The input image to be processed |
| upscale_mode | Enum | No | `factor` | `target`, `factor` -- determines upscale calculation method |
| upscale_factor | float | No | `2` | Multiplier for dimensions (used when mode=`factor`) |
| target_resolution | Enum | No | `1080p` | `720p`, `1080p`, `1440p`, `2160p` (used when mode=`target`) |
| seed | integer | No | - | Random seed |
| noise_scale | float | No | `0.1` | Controls noise in generation |
| output_format | Enum | No | `jpg` | `png`, `jpg`, `webp` |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| image | ImageFile | Upscaled image (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |

---

## 12. Seedance 2.0 T2V

**Endpoint**: `bytedance/seedance-2.0/text-to-video`
**Category**: text-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt to generate the video |
| resolution | Enum | No | `720p` | `480p`, `720p` |
| duration | Enum | No | `auto` | `auto`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` |
| aspect_ratio | Enum | No | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| generate_audio | boolean | No | `true` | Generate synchronized audio (sound effects, ambient, lip-sync) |
| seed | integer | No | - | Random seed (results may vary slightly) |
| end_user_id | string | No | - | Unique end user ID |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 13. GPT-Image 1.5

**Endpoint**: `fal-ai/gpt-image-1.5`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt for image generation |
| image_size | Enum | No | `1024x1024` | `1024x1024`, `1536x1024`, `1024x1536` |
| background | Enum | No | `auto` | `auto`, `transparent`, `opaque` |
| quality | Enum | No | `high` | `low`, `medium`, `high` |
| num_images | integer | No | `1` | Number of images to generate |
| output_format | Enum | No | `png` | `jpeg`, `png`, `webp` |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<ImageFile\> | Generated images (url, content_type, file_name, file_size, width, height) |

---

## 14. Seedream 5.0 Lite Edit

**Endpoint**: `fal-ai/bytedance/seedream/v5/lite/edit`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The text prompt used to edit the image |
| image_urls | list\<string\> | Yes | - | Input image URLs (up to 10; if more, only last 10 used) |
| image_size | ImageSize \| Enum | No | `auto_2K` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto_2K`, `auto_3K` -- or custom `{width, height}` (total pixels 2560x1440 to 3072x3072) |
| num_images | integer | No | `1` | Number of separate generations |
| max_images | integer | No | `1` | Multi-image generation per run |
| sync_mode | boolean | No | - | If true, returns data URI |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |

---

## 15. Seedream 4.5 T2I

**Endpoint**: `fal-ai/bytedance/seedream/v4.5/text-to-image`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The text prompt used to generate the image |
| image_size | ImageSize \| Enum | No | `auto_2K` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto_2K`, `auto_4K` -- or custom `{width, height}` (1920-4096 range, total pixels 2560x1440 to 4096x4096) |
| num_images | integer | No | `1` | Number of separate generations |
| max_images | integer | No | `1` | Multi-image generation per run |
| seed | integer | No | - | Random seed for reproducibility |
| sync_mode | boolean | No | - | If true, returns data URI |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |

---

## 16. Seedance 1.5 Pro I2V

**Endpoint**: `fal-ai/bytedance/seedance/v1.5/pro/image-to-video`
**Category**: image-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt to generate the video |
| image_url | string | Yes | - | URL of the image to animate |
| aspect_ratio | Enum | No | `16:9` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `auto` |
| resolution | Enum | No | `720p` | `480p`, `720p`, `1080p` |
| duration | Enum | No | `5` | `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12` |
| camera_fixed | boolean | No | - | Whether camera position is fixed |
| seed | integer | No | - | Random seed (-1 for random) |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| generate_audio | boolean | No | `true` | Generate audio for the video |
| end_image_url | string | No | - | URL of image the video ends with |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 17. Bria RMBG 2.0

**Endpoint**: `fal-ai/bria/background/remove`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| image_url | string | Yes | - | Input image to remove background from |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| image | Image | Image with background removed (url, content_type, file_name, file_size, width, height) |

---

## 18. Z-Image Turbo

**Endpoint**: `fal-ai/z-image/turbo`
**Category**: text-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The prompt to generate an image from |
| image_size | ImageSize \| Enum | No | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` -- or custom `{width, height}` |
| num_inference_steps | integer | No | `8` | Number of inference steps |
| seed | integer | No | - | Seed for reproducibility |
| sync_mode | boolean | No | - | If true, returns data URI |
| num_images | integer | No | `1` | Number of images to generate |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| output_format | Enum | No | `png` | `jpeg`, `png`, `webp` |
| acceleration | Enum | No | `regular` | `none`, `regular`, `high` |
| enable_prompt_expansion | boolean | No | - | Enable prompt expansion (adds 0.0025 credits) |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<ImageFile\> | Generated images (url, content_type, file_name, file_size, width, height) |
| timings | Timings | Processing timing info |
| seed | integer | Seed used |
| has_nsfw_concepts | list\<boolean\> | NSFW detection per image |
| prompt | string | Prompt used |

---

## 19. Seedance 2.0 Fast T2V

**Endpoint**: `bytedance/seedance-2.0/fast/text-to-video`
**Category**: text-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt to generate the video |
| resolution | Enum | No | `720p` | `480p`, `720p` |
| duration | Enum | No | `auto` | `auto`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` |
| aspect_ratio | Enum | No | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| generate_audio | boolean | No | `true` | Generate synchronized audio (sound effects, ambient, lip-sync) |
| seed | integer | No | - | Random seed (results may vary slightly) |
| end_user_id | string | No | - | Unique end user ID |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 20. Seedance 2.0 Fast I2V

**Endpoint**: `bytedance/seedance-2.0/fast/image-to-video`
**Category**: image-to-video

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | Text prompt describing desired motion/action |
| image_url | string | Yes | - | Starting frame image URL (JPEG, PNG, WebP; max 30MB) |
| end_image_url | string | No | - | Image for the last frame of video |
| resolution | Enum | No | `720p` | `480p`, `720p` |
| duration | Enum | No | `auto` | `auto`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` |
| aspect_ratio | Enum | No | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| generate_audio | boolean | No | `true` | Generate synchronized audio (sound effects, ambient, lip-sync) |
| seed | integer | No | - | Random seed (results may vary slightly) |
| end_user_id | string | No | - | Unique end user ID |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| video | File | Generated video (url, content_type, file_name, file_size) |
| seed | integer | Seed used |

---

## 21. Birefnet BG Removal

**Endpoint**: `fal-ai/birefnet/v2`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| image_url | string | Yes | - | URL of image to remove background from |
| model | Enum | No | `General Use (Light)` | `General Use (Light)`, `General Use (Light 2K)`, `General Use (Heavy)`, `Matting`, `Portrait`, `General Use (Dynamic)` |
| operating_resolution | Enum | No | `1024x1024` | `1024x1024`, `2048x2048`, `2304x2304` (2304 only for Dynamic model) |
| output_format | Enum | No | `png` | `webp`, `png`, `gif` |
| refine_foreground | boolean | No | `true` | Refine foreground using estimated mask |
| output_mask | boolean | No | - | Output the mask used for removal |
| mask_only | boolean | No | - | Return only the segmentation mask |
| sync_mode | boolean | No | - | If true, returns data URI |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| image | ImageFile | Image with background removed (url, content_type, file_name, file_size, width, height) |
| mask_image | ImageFile | (Optional) Mask used for removal |

---

## 22. Seedream v4 Edit

**Endpoint**: `fal-ai/bytedance/seedream/v4/edit`
**Category**: image-to-image

**Input Parameters**:

| Name | Type | Required | Default | Values/Description |
|------|------|----------|---------|-------------------|
| prompt | string | Yes | - | The text prompt used to edit the image |
| image_urls | list\<string\> | Yes | - | Input image URLs (up to 10) |
| image_size | ImageSize \| Enum | No | - | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`, `auto_2K`, `auto_4K` -- or custom `{width, height}` (min 921600 total pixels) |
| num_images | integer | No | `1` | Number of separate generations |
| max_images | integer | No | `1` | Multi-image generation; total input+output <= 15 |
| seed | integer | No | - | Random seed for reproducibility |
| sync_mode | boolean | No | - | If true, returns data URI |
| enable_safety_checker | boolean | No | `true` | Enable safety checker |
| enhance_prompt_mode | Enum | No | `standard` | `standard`, `fast` |

**Output**:

| Name | Type | Description |
|------|------|-------------|
| images | list\<Image\> | Generated images (url, content_type, file_name, file_size, width, height) |
| seed | integer | Seed used |
