---
name: fal-ai/bytedance/seedance/v1.5/pro/image-to-video
display_name: Bytedance Seedance 1.5 Pro Image-to-Video
category: image-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video
source: llms.txt (fetched 2026-04-17)
summary: Generate video with audio from a source image; supports start/end frames and fixed camera.
---

# Bytedance Seedance 1.5 Pro (I2V)

## Overview
- **Slug:** `fal-ai/bytedance/seedance/v1.5/pro/image-to-video`
- **Endpoint:** `https://fal.run/fal-ai/bytedance/seedance/v1.5/pro/image-to-video`
- **Pricing:** ~$0.26 for 5s 720p with audio. Tokens: `(h × w × fps × duration) / 1024` → $2.4/M with audio, $1.2/M without.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | — | Desired motion/scene. |
| `image_url` | string | required | — | Source image. |
| `aspect_ratio` | enum | `16:9` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `auto` | Output aspect. |
| `resolution` | enum | `720p` | `480p`, `720p`, `1080p` | Quality. |
| `duration` | string | `"5"` | `"4"`–`"12"` | Seconds. |
| `camera_fixed` | boolean | `false` | — | Lock camera position. |
| `seed` | integer | random | `-1` = random | Reproducibility. |
| `enable_safety_checker` | boolean | `true` | — | Safety validation. |
| `generate_audio` | boolean | `true` | — | Include synchronized audio. |
| `end_image_url` | string | — | — | Optional end frame. |

## Output
```json
{ "video": { "url": "..." }, "seed": 12345 }
```
