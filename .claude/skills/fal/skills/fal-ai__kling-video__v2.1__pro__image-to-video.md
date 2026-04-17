---
name: fal-ai/kling-video/v2.1/pro/image-to-video
display_name: Kling 2.1 Pro Image-to-Video
category: image-to-video
creator: Kuaishou
fal_docs: https://fal.ai/models/fal-ai/kling-video/v2.1/pro/image-to-video
source: llms.txt (fetched 2026-04-17)
summary: Professional-grade Kling 2.1 endpoint with enhanced visual fidelity, precise camera movements, and dynamic motion control.
---

# Kling 2.1 Pro Image-to-Video

## Overview
- **Slug:** `fal-ai/kling-video/v2.1/pro/image-to-video`
- **Endpoint:** `https://fal.run/fal-ai/kling-video/v2.1/pro/image-to-video`
- **Category:** image-to-video
- **Pricing:** $0.49 for 5s video, +$0.098 per additional second.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | — | Text description. |
| `image_url` | string | required | — | Source image URL. |
| `duration` | enum | `"5"` | `"5"`, `"10"` | Video length in seconds. |
| `negative_prompt` | string | `"blur, distort, and low quality"` | — | Content to avoid. |
| `cfg_scale` | float | `0.5` | 0.0–1.0 | Prompt adherence. |
| `tail_image_url` | string | — | — | Optional end frame. |

## Output
```json
{ "video": { "url": "..." } }
```
