---
name: fal-ai/kling-video/v1.6/pro/image-to-video
display_name: Kling v1.6 Pro (Image-to-Video)
category: image-to-video
creator: Kuaishou Technology (Kling AI)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video
original_source: https://klingai.com/
summary: State-of-the-art image-to-video model from Kuaishou, featuring high-fidelity 1080p generation and precise motion control.
---

# Kling v1.6 Pro (Image-to-Video)

## Overview
- **Slug:** `fal-ai/kling-video/v1.6/pro/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [Kuaishou Technology](https://klingai.com/)
- **Best for:** Cinematic video generation from high-quality source images with professional-grade motion control.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video)
- **Original source:** [Kling AI Official API](https://kling.ai/document-api/apiReference/model/imageToVideo)

## What it does
Kling v1.6 Pro is an advanced spatiotemporal diffusion model that animates static images into high-fidelity video clips. It excels at maintaining visual consistency with the source image while introducing complex, realistic motion. The "Pro" variant specifically supports Full HD (1080p) output, longer durations, and sophisticated conditioning like start/end frame locking.

## When to use this model
- **Use when:** You need professional-grade animations, cinematic camera movements, or precise control over the start and end states of a 5-second loop.
- **Don't use when:** You need real-time generation (avg. wait is ~6 minutes) or extremely long videos (max 10s).
- **Alternatives:** 
    - [Kling v1.6 Standard](https://fal.ai/models/fal-ai/kling-video/v1.6/standard/image-to-video): Faster and cheaper, but limited to 720p.
    - [Kling v2.5 Turbo](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video): Faster inference with similar quality.
    - [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine): Strong alternative for realistic human movement.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v1.6/pro/image-to-video` (Sync) / `https://queue.fal.run/fal-ai/kling-video/v1.6/pro/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 2500 chars | Description of the desired motion and scene details. |
| `image_url` | string | (Required) | URL / Base64 | The starting frame of the video. |
| `duration` | string | `5` | `5`, `10` | Total length of the generated video in seconds. |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16`, `1:1` | Output frame dimensions. |
| `tail_image_url` | string | null | URL / Base64 | Optional end frame for the video (available for 5s clips). |
| `negative_prompt`| string | "" | Max 2500 chars | Elements to exclude from the animation. |
| `cfg_scale` | float | `0.5` | `0.0` - `1.0` | Guidance scale for prompt adherence. |
| `static_mask_url`| string | null | URL / Base64 | Mask for areas that should remain still. |

### Output
The API returns a JSON object containing the generated video file metadata:
```json
{
  "video": {
    "url": "https://fal-cdn.com/.../video.mp4",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "A majestic dragon flying over a volcanic landscape, slow cinematic camera orbit.",
  "image_url": "https://example.com/dragon.jpg",
  "duration": "10",
  "aspect_ratio": "16:9",
  "cfg_scale": 0.5
}
```

### Pricing
Billed per output second:
- **Cost:** $0.095 per video second.
- **5-second video:** $0.475
- **10-second video:** $0.95

## API — via Original Source (BYO-key direct)
Kling AI offers a native API for developers who prefer direct integration.
- **Endpoint:** `https://api-singapore.klingai.com/v1/videos/image2video`
- **Auth Method:** Bearer Token (API Key).
- **Exclusive Features:** Supports "Multi-shot" storyboarding (up to 6 shots), native audio generation with voice IDs, and "Element Library" for character consistency.
- **Official Docs:** [Kling AI API Reference](https://kling.ai/document-api/apiReference/model/imageToVideo)

## Prompting best practices
- **Be Descriptive:** Instead of "man walking," use "cinematic wide shot of a man in a trench coat walking through neon-lit rainy Tokyo streets, raindrops reflecting light."
- **Motion Keywords:** Use verbs like "orbiting," "zooming," "drifting," or "slow-motion" to guide the temporal dynamics.
- **Reference Framing:** If using `tail_image_url`, describe the transition in the prompt (e.g., "The flower blooms from a bud to a full rose").
- **Avoid Over-complication:** Kling v1.6 is powerful but can hallucinate if too many conflicting movements are requested in a single prompt.

## Parameter tuning guide
- **CFG Scale:** Stick to `0.5` for most tasks. Higher values (up to `1.0`) force strict prompt adherence but may introduce artifacts. Lower values allow more creative "hallucination."
- **Duration:** 10s is great for storytelling, but 5s is more stable for complex physics or loops.
- **Static Masks:** Use these for product videos where the background should stay frozen while the product rotates or moves.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Start Image` (Image/URL)
    - `End Image` (Image/URL - optional)
    - `Duration` (Dropdown: 5, 10)
    - `Aspect Ratio` (Dropdown)
- **Outputs:**
    - `Video URL` (URL)
    - `Preview GIF` (Image)
- **Chain-friendly with:**
    - [Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev): Generate the starting image.
    - [Kling Lip Sync](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/lip-sync): Add synchronized audio to the generated video.

## Notes & gotchas
- **Wait Time:** High-quality generations can take up to 6 minutes. Always use asynchronous queue mode for production apps.
- **Aspect Ratio:** Ensure your input image matches the requested `aspect_ratio` to avoid stretching or black bars.
- **Safety:** Content must adhere to Kling's safety policy; prohibited content will return an error or a blank/placeholder video.

## Sources
- [FAL.ai Kling v1.6 Pro Model Page](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video)
- [Official Kling AI Documentation](https://kling.ai/document-api/apiReference/model/imageToVideo)
- [Kling-Omni Technical Report (arXiv)](https://arxiv.org/abs/2512.16776)
