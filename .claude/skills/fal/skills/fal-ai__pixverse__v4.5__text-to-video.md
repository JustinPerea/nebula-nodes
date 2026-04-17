---
name: fal-ai/pixverse/v4.5/text-to-video
display_name: Pixverse v4.5 Text-to-Video
category: text-to-video
creator: Pixverse
fal_docs: https://fal.ai/models/fal-ai/pixverse/v4.5/text-to-video
source: llms.txt (fetched 2026-04-17)
summary: Stylized text-to-video generation across multiple aesthetic presets.
---

# Pixverse v4.5 Text-to-Video

## Overview
- **Slug:** `fal-ai/pixverse/v4.5/text-to-video`
- **Endpoint:** `https://fal.run/fal-ai/pixverse/v4.5/text-to-video`
- **Pricing (5s):** $0.15 (360p/540p), $0.20 (720p), $0.40 (1080p). 8s doubles cost; 1080p is capped at 5s.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | — | Video description. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | Output aspect ratio. |
| `resolution` | enum | `720p` | `360p`, `540p`, `720p`, `1080p` | Quality. |
| `duration` | enum | `"5"` | `"5"`, `"8"` | Length in seconds. |
| `negative_prompt` | string | — | — | Content to avoid. |
| `style` | enum | — | `anime`, `3d_animation`, `clay`, `comic`, `cyberpunk` | Visual style preset. |
| `seed` | integer | random | — | For reproducibility. |

## Output
```json
{ "video": { "url": "..." } }
```
