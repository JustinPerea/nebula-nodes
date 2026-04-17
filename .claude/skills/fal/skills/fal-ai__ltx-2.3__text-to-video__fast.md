---
name: fal-ai/ltx-2.3/text-to-video/fast
display_name: LTX-2.3 Fast (Text-to-Video)
category: text-to-video
creator: Lightricks
fal_docs: https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast
original_source: https://ltx.io/model, https://github.com/Lightricks/LTX-2, https://huggingface.co/Lightricks/LTX-2.3
summary: A high-speed, 22B parameter Diffusion Transformer model by Lightricks that generates synchronized 1080p-4K video and audio in seconds.
---

# LTX-2.3 Fast (Text-to-Video)

## Overview
- **Slug:** `fal-ai/ltx-2.3/text-to-video/fast`
- **Category:** Text-to-Video
- **Creator:** [Lightricks](https://ltx.io/)
- **Best for:** Rapid prototyping and high-speed generation of cinematic videos with synchronized audio.
- **FAL docs:** [fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast](https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast)
- **Original source:** [Lightricks GitHub](https://github.com/Lightricks/LTX-2), [Hugging Face Model Card](https://huggingface.co/Lightricks/LTX-2.3)

## What it does
LTX-2.3 Fast is a state-of-the-art, 22-billion parameter Diffusion Transformer (DiT) model optimized for speed via 8-step distillation. It is designed to generate high-quality video clips (up to 4K resolution) with natively synchronized audio in a single pass. Compared to the "Pro" variant, the "Fast" model prioritizes inference speed and lower compute costs, making it ideal for rapid iteration and storyboarding while maintaining strong prompt adherence and visual consistency.

## When to use this model
- **Use when:** You need fast turnaround times for concepting, social media content (native 9:16 support), or when generating high volumes of video where cost-efficiency is a priority.
- **Don't use when:** You require the absolute highest level of temporal consistency or complex multi-step cinematic motion, which is better handled by the LTX-2.3 Pro variant.
- **Alternatives:** 
    - **LTX-2.3 Pro:** Higher quality, better motion consistency, but slower and more expensive.
    - **Kling 3.0:** Superior realism for human movement, though often slower and more restricted.
    - **SVD (Stable Video Diffusion):** Good for shorter, simpler animations but lacks the native audio and text-to-video flexibility of LTX.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ltx-2.3/text-to-video/fast` (Sync) / `https://queue.fal.run/fal-ai/ltx-2.3/text-to-video/fast` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | 1-5000 chars | Descriptive text for the video and audio content. |
| `duration` | integer | `6` | `6, 8, 10, 12, 14, 16, 18, 20` | Video length in seconds. Note: >10s requires 1080p and 25 FPS. |
| `resolution` | string | `"1080p"` | `"1080p", "1440p", "2160p"` | Output video resolution. |
| `aspect_ratio` | string | `"16:9"` | `"16:9", "9:16"` | Native aspect ratio (landscape or portrait). |
| `fps` | integer | `25` | `24, 25, 48, 50` | Frames per second. |
| `generate_audio`| boolean | `true` | `true, false` | Whether to generate a synchronized audio track. |

### Output
The API returns a JSON object containing a `video` field with metadata and a download URL:
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 4404019,
    "width": 1920,
    "height": 1080,
    "fps": 25,
    "duration": 6,
    "num_frames": 151
  }
}
```

### Pricing
Pricing is billed per generated second of video based on resolution:
- **1080p:** $0.04 / second
- **1440p:** $0.08 / second
- **2160p (4K):** $0.16 / second

## API — via Original Source (BYO-key direct)
Lightricks provides LTX-2.3 as an open-source model. While they offer the [LTX Studio](https://ltx.studio/) platform for creative work, there is no separate "direct-to-creator" pay-as-you-go API similar to FAL's. Developers can host the model themselves using the [official Python library](https://github.com/Lightricks/LTX-2) or via [ComfyUI](https://github.com/Lightricks/ComfyUI-LTXVideo).

## Prompting best practices
- **Be Verb-Heavy:** Describe the motion explicitly (e.g., "The camera tracks beside the runner" rather than "A runner moving").
- **Describe the Audio:** Include sound keywords like "crunching gravel," "distant thunder," or "ambient lo-fi music" to leverage the native audio generator.
- **Match Length to Duration:** Longer videos (10s+) require more detailed prompts to prevent the model from "stalling" or repeating motion.
- **Cinematic Keywords:** Use "shallow depth of field," "golden hour lighting," or "handheld camera" to direct the visual style.
- **Avoid Over-specification:** Use natural language instead of technical coordinates (e.g., "slow zoom" vs "zoom at 2% per frame").

**Example Good Prompt:**
> "A close-up tracking shot of a vintage motorcycle speeding down a desert highway at sunset. Dust kicks up from the tires, the engine roars with a deep mechanical rumble, and the camera vibrates slightly to simulate high speed. Warm, cinematic lighting."

## Parameter tuning guide
- **Duration vs FPS:** If you select a duration over 10 seconds, you *must* use 25 FPS and 1080p resolution; otherwise, the model may fail or default to lower settings.
- **Resolution Sweet Spot:** Use **1080p** for general prototyping. **2160p** is excellent for final renders but significantly increases cost and generation time.
- **FPS for Realism:** Use **24 or 25 FPS** for a traditional cinematic feel. Use **48 or 50 FPS** for slow-motion effects or high-action scenes to reduce motion blur.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Duration` (Select/Integer)
    - `Resolution` (Select)
    - `Aspect Ratio` (Select)
    - `FPS` (Select/Integer)
    - `Generate Audio` (Boolean Toggle)
- **Outputs:**
    - `Video URL` (File/URL)
    - `Audio Stream` (Extracted from video if needed)
    - `Metadata` (Width, Height, Duration)
- **Chain-friendly with:**
    - **Flux.1 [dev]:** Generate a high-quality reference image first, then use LTX-2.3 Image-to-Video.
    - **ElevenLabs:** Replace the native LTX audio with high-fidelity AI voiceovers.
    - **Kling 3.0:** Use LTX for fast drafts, then "up-res" or re-render key scenes with Kling for final high-fidelity motion.

## Notes & gotchas
- **Resolution Limits:** All dimensions must be divisible by 32. Frame counts follow the `(8 * n) + 1` formula internally.
- **Content Safety:** FAL.ai applies its standard safety filters to prompts and outputs; NSFW content is generally blocked.
- **Queue Priority:** During peak hours, use the `https://queue.fal.run` endpoint to avoid timeout errors on long (20s) generations.

## Sources
- [FAL.ai LTX-2.3 Fast API Documentation](https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/api)
- [Lightricks LTX-2.3 Official Blog](https://ltx.io/model)
- [Hugging Face: Lightricks/LTX-2.3 Model Card](https://huggingface.co/Lightricks/LTX-2.3)
- [Replicate LTX-2.3 Pro Reference](https://replicate.com/lightricks/ltx-2.3-pro/readme)
