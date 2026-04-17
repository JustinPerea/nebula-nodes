---
name: fal-ai/ltx-2/image-to-video
display_name: LTX Video 2.0 Pro Image-to-Video
category: image-to-video
creator: Lightricks
fal_docs: https://fal.ai/models/fal-ai/ltx-2/image-to-video
source: llms.txt (fetched 2026-04-17)
summary: High-fidelity video with audio from a still image.
---

# LTX Video 2.0 Pro Image-to-Video

## Overview
- **Slug:** `fal-ai/ltx-2/image-to-video`
- **Endpoint:** `https://fal.run/fal-ai/ltx-2/image-to-video`
- **Pricing:** $0.06/s (1080p), $0.12/s (1440p), $0.24/s (2160p).

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | required | PNG/JPEG/WebP/AVIF/HEIF | Source image. |
| `prompt` | string | required | — | Motion/scene description. |
| `duration` | enum | `6` | `6`, `8`, `10` | Video length (seconds). |
| `resolution` | enum | `1080p` | `1080p`, `1440p`, `2160p` | Quality. |
| `fps` | enum | `25` | `25`, `50` | Frame rate. |
| `generate_audio` | boolean | `true` | — | Produce synchronized audio. |

## Output
```json
{ "video": { "url": "...", "content_type": "video/mp4" } }
```
