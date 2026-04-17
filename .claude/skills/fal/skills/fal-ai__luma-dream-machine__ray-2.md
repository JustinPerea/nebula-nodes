---
name: fal-ai/luma-dream-machine/ray-2
display_name: Luma Ray 2
category: text-to-video
creator: Luma Labs
fal_docs: https://fal.ai/models/fal-ai/luma-dream-machine/ray-2
source: llms.txt (fetched 2026-04-17)
summary: Text-to-video with realistic, coherent motion.
---

# Luma Ray 2

## Overview
- **Slug:** `fal-ai/luma-dream-machine/ray-2`
- **Endpoint:** `https://fal.run/fal-ai/luma-dream-machine/ray-2`
- **Pricing:** $0.5 per 5 seconds (540p). 720p is 2×, 1080p is 4×.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | — | Video description. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21` | Output aspect ratio. |
| `loop` | boolean | `false` | — | Seamless loop output. |
| `resolution` | enum | `540p` | `540p`, `720p`, `1080p` | Quality (pricing multiplier). |
| `duration` | enum | `5s` | `5s`, `9s` | Video length (9s = 2× cost). |

## Output
```json
{ "video": { "url": "..." } }
```
