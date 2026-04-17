---
name: fal-ai/luma-dream-machine/ray-2/image-to-video
display_name: Luma Ray 2 Image-to-Video
category: image-to-video
creator: Luma Labs
fal_docs: https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/image-to-video
source: llms.txt (fetched 2026-04-17)
summary: Image-conditioned video generation via Luma Ray 2 with optional end-frame control.
---

# Luma Ray 2 Image-to-Video

## Overview
- **Slug:** `fal-ai/luma-dream-machine/ray-2/image-to-video`
- **Endpoint:** `https://fal.run/fal-ai/luma-dream-machine/ray-2/image-to-video`
- **Pricing:** $0.5 per 5 seconds at 540p. 720p is 2×, 1080p is 4×.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | — | Video description. |
| `image_url` | string | optional | — | Starting image. |
| `end_image_url` | string | optional | — | Ending image. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21` | Output aspect ratio. |
| `loop` | boolean | `false` | — | Seamless loop. |
| `resolution` | enum | `540p` | `540p`, `720p`, `1080p` | Quality. |
| `duration` | enum | `5s` | `5s`, `9s` | Length. |

## Output
```json
{ "video": { "url": "..." } }
```
