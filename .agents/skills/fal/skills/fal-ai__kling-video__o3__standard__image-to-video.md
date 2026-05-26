---
name: fal-ai/kling-video/o3/standard/image-to-video
display_name: Kling O3 Standard Image-to-Video
category: image-to-video
creator: Kuaishou
fal_docs: https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video
source: llms.txt (fetched 2026-04-17)
summary: Animate transitions between start and optional end frames with text-driven guidance and optional audio.
---

# Kling O3 Standard Image-to-Video

## Overview
- **Slug:** `fal-ai/kling-video/o3/standard/image-to-video`
- **Endpoint:** `https://fal.run/fal-ai/kling-video/o3/standard/image-to-video`
- **Category:** image-to-video
- **Pricing:** $0.084/s (no audio), $0.112/s (with audio)

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | required | — | Start frame URL. |
| `prompt` | string | optional | — | Text description for generation. |
| `end_image_url` | string | optional | — | End frame URL. |
| `duration` | enum | `"5"` | `"3"`–`"15"` | Length in seconds. |
| `generate_audio` | boolean | `false` | — | Native audio sync. |
| `multi_prompt` | array | — | — | Multi-shot list. |
| `shot_type` | enum | `customize` | `customize`, `intelligent` | Multi-shot strategy. |

## Output
```json
{ "video": { "url": "...", "content_type": "video/mp4" } }
```
