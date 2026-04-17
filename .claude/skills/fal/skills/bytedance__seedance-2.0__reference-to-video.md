---
name: bytedance/seedance-2.0/reference-to-video
display_name: Seedance 2.0 Reference to Video
category: image-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/bytedance/seedance-2.0/reference-to-video, https://fal.ai/learn/tools/how-to-use-seedance-2-0
original_source: https://seed.bytedance.com/en/seedance2_0, https://www.volcengine.com/experience/ark
summary: ByteDance's unified audio-video model that generates cinematic sequences using multiple image, video, and audio references with native sound and physics.
---

# Seedance 2.0 Reference to Video

## Overview
- **Slug:** `bytedance/seedance-2.0/reference-to-video`
- **Category:** Multi-modal Video Generation / Reference-to-Video
- **Creator:** [ByteDance](https://seed.bytedance.com/en/seedance2_0)
- **Best for:** High-fidelity video production with precise control via multi-asset referencing (images, videos, audio).
- **FAL docs:** [FAL.ai Model Page](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video)
- **Original source:** [ByteDance Seed Research](https://seed.bytedance.com/en/seedance2_0), [Volcengine Ark](https://www.volcengine.com/experience/ark)

## What it does
Seedance 2.0 is a unified multi-modal model that generates video and audio simultaneously in a single pass. Unlike previous models that "bolt on" audio or animate images in isolation, Seedance 2.0 uses a joint architecture to ensure sound effects, music, and physics-based motion are perfectly synchronized. It allows users to provide up to 12 total reference assets (images, videos, and audio) to guide the generation, supporting complex instructions like "animate @Image1 in the style of @Image2 with the camera movement of @Video1 and the rhythm of @Audio1."

## When to use this model
- **Use when:** You need brand consistency across assets, complex multi-shot sequences, or realistic synchronized audio (e.g., footsteps landing on beat, mechanical clicks).
- **Don't use when:** You need very long-form content (>15s per clip) or resolutions higher than 720p (on FAL).
- **Alternatives:** 
    - `fal-ai/kling-video`: Better for surreal, dream-like motion.
    - `fal-ai/veo3.1`: Stronger for first/last frame consistency in simple animations.
    - `bytedance/seedance-2.0/text-to-video`: Better if you have no starting assets and want pure creative generation.

## API — via FAL.ai
**Endpoints:** 
- `https://fal.run/bytedance/seedance-2.0/reference-to-video` (Standard)
- `https://fal.run/bytedance/seedance-2.0/fast/reference-to-video` (Fast - lower latency/cost)
- Queue mode is supported via `https://queue.fal.run/...`

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | Text description. Reference assets using `@Image1`, `@Video1`, etc. |
| `image_urls` | list<string> | `[]` | Max 9 images | Reference images for style, subject, or composition. |
| `video_urls` | list<string> | `[]` | Max 3 videos | Reference videos for motion, camera work, or structure. |
| `audio_urls` | list<string> | `[]` | Max 3 audio | Reference audio for rhythm, mood, or sound effects. |
| `resolution` | enum | `720p` | `480p`, `720p` | Output quality. 480p is recommended for fast prototyping. |
| `duration` | enum/int | `auto` | `auto`, `4` to `15` | Video length in seconds. `auto` lets the model decide. |
| `aspect_ratio` | enum | `auto` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `auto` | Standard cinematic and mobile ratios. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate native synchronized audio. |
| `seed` | integer | Random | N/A | Seed for reproducible results. |
| `end_user_id` | string | `null` | N/A | Tracking ID for billing/analytics. |

### Output
The output returns a JSON object containing the video file and the seed used:
```json
{
  "video": {
    "url": "https://v3.fal.media/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "Shot 1: Close-up of @Image1 splashing into water as seen in @Video1. The sound of a heavy splash follows. Shot 2: Wide view of the ocean.",
  "image_urls": ["https://example.com/bottle.jpg"],
  "video_urls": ["https://example.com/splash_ref.mp4"],
  "duration": 10,
  "aspect_ratio": "16:9"
}
```

### Pricing
- **Standard Tier:** ~$0.3024 per generated second.
- **Fast Tier:** ~$0.2419 per generated second.
- **Video Input Discount:** Providing video references grants a ~40% discount on the per-second rate (bringing Standard to ~$0.1814/s).
- **Audio:** Included at no extra cost when `generate_audio` is enabled.

## API — via Original Source (BYO-key direct)
The original model is accessible via ByteDance's **Volcengine Ark (Ark Platform)**.
- **Endpoint:** `https://ark.cn-beijing.volces.com/api/v3` (Regional endpoints vary).
- **Parameters:** Native API often supports up to **2K resolution** and specialized "Storytelling" modes not fully exposed on FAL.
- **Auth:** API Key via Volcengine.
- **Docs:** [Volcengine Model Experience](https://www.volcengine.com/experience/ark)

## Prompting best practices
- **Use Director Labels:** Structure multi-shot prompts with "Shot 1:", "Shot 2:", etc. This triggers the model's editing logic.
- **Reference Explicitly:** Always use the `@` tag (e.g., "@Image1") to link prompt instructions to specific uploads.
- **Cinematic Keywords:** Use technical camera terms like "Dolly zoom," "Rack focus," "Tracking shot," or "Handheld." The model interprets these as literal instructions.
- **Sound Cues:** Mention specific sounds you want to hear (e.g., "the soft crackle of a vinyl record") to guide the joint audio generator.
- **Avoid Tag Clouds:** Do not use comma-separated keywords (e.g., "4k, cinematic, masterpiece"). Use full, descriptive sentences focusing on action and physics.

## Parameter tuning guide
- **Resolution:** Use `480p` for testing motion and timing. Only switch to `720p` for final renders to save ~30% in cost during iteration.
- **Duration (auto):** Use `auto` for multi-shot prompts. The model is surprisingly good at timing cuts to the action described.
- **Aspect Ratio:** If `auto`, the model defaults to the aspect ratio of `@Image1` or `@Video1`. Set it explicitly if targeting mobile (9:16).

## Node inputs/outputs
- **Inputs:** 
    - `Prompt` (Text)
    - `Images` (List of URLs)
    - `Videos` (List of URLs)
    - `Audio` (List of URLs)
    - `Resolution` (Dropdown)
- **Outputs:** 
    - `Video URL` (Link)
    - `Seed` (Integer)
- **Chain-friendly with:** 
    - `fal-ai/flux`: Generate the initial `@Image1` for consistency.
    - `fal-ai/standard-vocal-remover`: If you need to strip audio from a reference before use.
    - `fal-ai/ff-video-editor`: For further stitching of 15s clips into longer sequences.

## Notes & gotchas
- **File Limit:** You can upload up to 12 files total across image/video/audio inputs.
- **Audio Requirement:** If providing an audio reference, you *must* also provide at least one image or video reference.
- **Physics Accuracy:** While highly accurate, fast-moving objects (like fans or wheels) can still exhibit "rolling shutter" artifacts or blurring.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video/api)
- [ByteDance Seed Official Page](https://seed.bytedance.com/en/seedance2_0)
- [FAL Learn: How to Use Seedance 2.0](https://fal.ai/learn/tools/how-to-use-seedance-2-0)
- [arXiv:2604.14148 - Technical Report](https://arxiv.org/abs/2604.14148)