---
name: wan/v2.6/reference-to-video
display_name: Wan v2.6 Reference-to-Video
category: image-to-video
creator: Alibaba (Wan-AI)
fal_docs: https://fal.ai/models/wan/v2.6/reference-to-video
source: llms.txt (fetched 2026-04-17)
summary: Reference-video conditioned generation supporting up to 3 @VideoN tags and multi-shot timing markers.
---

# Wan v2.6 Reference-to-Video

## Overview
- **Slug:** `wan/v2.6/reference-to-video`
- **Endpoint:** `https://fal.run/wan/v2.6/reference-to-video`
- **Category:** image-to-video (reference-driven)
- **Pricing:** $0.10/s (720p), $0.15/s (1080p)

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | ≤800 chars | Use `@Video1`, `@Video2`, `@Video3` to reference subjects. Multi-shot: `[0-3s] Shot 1. [3-6s] Shot 2.` |
| `video_urls` | array | required | 1–3 videos, ≥16 FPS | Reference videos for subject consistency. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | Output frame dimensions. |
| `resolution` | enum | `1080p` | `720p`, `1080p` | Output resolution. |
| `duration` | enum | `5` | `5`, `10` | Video length in seconds. |
| `negative_prompt` | string | `""` | ≤500 chars | Content to avoid. |
| `enable_prompt_expansion` | boolean | `true` | — | LLM prompt rewriting. |
| `multi_shots` | boolean | `true` | — | Multi-shot segmentation. |
| `seed` | integer | random | — | For reproducibility. |
| `enable_safety_checker` | boolean | `true` | — | Safety validation. |

## Output
```json
{
  "video": { "url": "..." },
  "seed": 12345,
  "actual_prompt": "..."
}
```

## Notes
- People, animals, and objects all work as reference subjects.
