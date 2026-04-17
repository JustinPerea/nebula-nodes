---
name: xai/grok-imagine-video/text-to-video
display_name: Grok Imagine Video (Text-to-Video)
category: text-to-video
creator: xAI
fal_docs: https://fal.ai/models/xai/grok-imagine-video/text-to-video/api
original_source: https://docs.x.ai/developers/model-capabilities/video/generation
summary: High-speed cinematic video generation with native synchronized audio powered by xAI's Aurora engine.
---

# Grok Imagine Video (Text-to-Video)

## Overview
- **Slug:** `xai/grok-imagine-video/text-to-video`
- **Category:** Text-to-Video
- **Creator:** [xAI](https://x.ai)
- **Best for:** High-speed, cinematic video generation with native synchronized audio (sound effects, ambient noise, and dialogue).
- **FAL docs:** [fal.ai/models/xai/grok-imagine-video/text-to-video/api](https://fal.ai/models/xai/grok-imagine-video/text-to-video/api)
- **Original source:** [docs.x.ai/developers/model-capabilities/video/generation](https://docs.x.ai/developers/model-capabilities/video/generation)

## What it does
Grok Imagine Video is xAI's state-of-the-art video generation model powered by the proprietary **Aurora Engine**. It transforms text descriptions into high-quality video clips ranging from 6 to 15 seconds. Its standout feature is **native audio generation**, where sound effects, ambient atmosphere, and even lip-synced dialogue are generated simultaneously with the visuals in a single pass. The model is exceptionally fast, generating content in approximately 17 seconds, which is significantly quicker than many diffusion-based competitors.

## When to use this model
- **Use when:** You need fast iteration, cinematic realism, or videos where sound and visuals must be perfectly synchronized (e.g., footsteps, rain, or character speech).
- **Don't use when:** You require ultra-long durations (>15 seconds) in a single generation or resolution higher than 720p.
- **Alternatives:** 
  - [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine): Better for complex physics and artistic consistency.
  - [Kling Video](https://fal.ai/models/fal-ai/kling-video): Offers longer durations and higher resolution (1080p).
  - [Runway Gen-3 Alpha](https://fal.ai/models/fal-ai/runway-gen3): Known for high-end aesthetic control but often slower.

## API — via FAL.ai
**Endpoint:** `https://fal.run/xai/grok-imagine-video/text-to-video` (sync) / `https://queue.fal.run/xai/grok-imagine-video/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | — | Required | Text description of the desired video scene and motion. |
| `duration` | `integer` | `6` | `1` - `15` | Video duration in seconds. |
| `aspect_ratio` | `Enum` | `16:9` | `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16` | Aspect ratio of the generated video. |
| `resolution` | `Enum` | `720p` | `480p`, `720p` | Output resolution of the video. |

### Output
The output is a `video` object containing the following fields:
- `url` (string): The temporary URL of the generated MP4 file.
- `width` (integer): Width of the video in pixels.
- `height` (integer): Height of the video in pixels.
- `fps` (float): Frames per second (typically 24).
- `duration` (float): Exact duration of the generated video.
- `num_frames` (integer): Total number of frames.
- `content_type` (string): Mime type (e.g., `video/mp4`).
- `file_name` (string): Name of the generated file.

### Example request
```json
{
  "prompt": "A street musician plays violin on a rain-soaked Tokyo crosswalk at night, neon reflections in puddles, cinematic lighting, slow zoom in.",
  "duration": 10,
  "aspect_ratio": "16:9",
  "resolution": "720p"
}
```

### Pricing
- **480p:** $0.05 per second of video.
- **720p:** $0.07 per second of video.
*(Example: A 10-second 720p video costs $0.70 via FAL.)*

## API — via Original Source (BYO-key direct)
xAI provides a direct API for developers.
- **Endpoint:** `https://api.x.ai/v1/videos/generations`
- **Auth method:** Bearer Token (`XAI_API_KEY`).
- **Additional parameters:** Supports `reference_image_urls` for multi-image guidance and `video_url` for editing/extensions directly through specific endpoints.
- **Official Docs:** [xAI Video Docs](https://docs.x.ai/developers/model-capabilities/video/generation)

## Prompting best practices
- **Include Sound Cues:** Explicitly mention sounds like "crunching gravel," "heavy rain," or "whispered dialogue" to take advantage of the native audio engine.
- **Specify Camera Motion:** Use keywords like "pan left," "slow zoom," "drone shot," or "tracking shot" to define movement.
- **Detail the Lighting:** Describe the atmosphere (e.g., "golden hour," "neon-lit," "volumetric fog") for better cinematic results.
- **Avoid Over-complication:** While detailed, very conflicting instructions can confuse the autoregressive frame prediction.
- **Good Prompt:** "A futuristic chef stir-frying vegetables in a high-tech kitchen, blue flames hissing, steam rising, close-up shot, 8k realism."
- **Bad Prompt:** "Video of a kitchen with a cook and sounds." (Too vague; lacks motion and style cues.)

## Parameter tuning guide
- **Duration (6-15s):** 6s is great for quick loops; 15s is ideal for storytelling but takes slightly longer to process.
- **Resolution (720p vs 480p):** Always use 720p for final output; 480p is only recommended for rapid prototyping to save costs.
- **Aspect Ratio:** Match your target platform (e.g., `9:16` for TikTok/Reels, `16:9` for YouTube/Cinematic).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (Text)
  - `Duration` (Number)
  - `Aspect Ratio` (Dropdown)
  - `Resolution` (Dropdown)
- **Outputs:**
  - `Video URL` (URL)
  - `Audio Metadata` (Object)
- **Chain-friendly with:**
  - `xai/grok-imagine-image`: Generate a concept art first, then pass to `grok-imagine-video` (via Image-to-Video node).
  - `fal-ai/ffmpeg-utils`: To crop or watermark the final generated video.

## Notes & gotchas
- **Content Moderation:** xAI is strict on safety. If a prompt violates policy, the request may still be billed a small fee ($0.05) even if the generation is blocked.
- **URL Expiration:** Generated URLs are ephemeral. Always download or transfer the video to permanent storage immediately.
- **Audio Sensitivity:** The model might generate unexpected audio if the scene is ambiguous; be specific about the desired atmosphere.

## Sources
- [FAL.ai Grok Imagine API](https://fal.ai/models/xai/grok-imagine-video/text-to-video/api)
- [xAI Official Documentation](https://docs.x.ai/developers/model-capabilities/video/generation)
- [xAI Model Pricing](https://docs.x.ai/developers/models)
- [Aurora Engine Announcement](https://x.ai/blog)
