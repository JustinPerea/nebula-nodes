---
name: fal-ai/kling-video/v3/pro/image-to-video
display_name: Kling Video v3 Image to Video [Pro]
category: image-to-video
creator: Kling AI (Kuaishou)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video
original_source: https://kling.ai/quickstart/klingai-video-3-model-user-guide
summary: Top-tier image-to-video model with cinematic visuals, fluid motion, native audio generation, and advanced subject consistency support.
---

# Kling Video v3 Image to Video [Pro]

## Overview
- **Slug:** `fal-ai/kling-video/v3/pro/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [Kling AI (Kuaishou)](https://kling.ai/)
- **Best for:** Professional-grade cinematic video generation from static images with high subject consistency and synchronized audio.
- **FAL docs:** [https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video)
- **Original source:** [https://kling.ai/quickstart/klingai-video-3-model-user-guide](https://kling.ai/quickstart/klingai-video-3-model-user-guide)

## What it does
Kling Video v3 Pro is a state-of-the-art image-to-video generation model that excels in creating high-fidelity, cinematic videos from static image inputs. It features advanced physics simulation for realistic motion, superior subject consistency across frames, and the unique ability to generate synchronized native audio (in Chinese and English) directly during the video synthesis process. The Pro version supports extended durations up to 15 seconds and offers multi-shot sequencing capabilities for complex storytelling.

## When to use this model
- **Use when:** You need high-quality, professional-looking animations of characters or products, require precise motion control, or want built-in audio that matches the visual scene perfectly.
- **Don't use when:** You need ultra-fast, low-cost previews (use the Standard tier instead) or for very short, simple social media loops where the Pro-tier's advanced physics might be overkill.
- **Alternatives:** 
    - [Kling Video v3 Standard](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video): Faster and more affordable for simpler tasks.
    - [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine): Strong alternative for realistic motion but lacks native audio generation.
    - [Runway Gen-3 Alpha](https://fal.ai/models/fal-ai/runway-gen3-alpha): Similar high-end performance with different artistic characteristics.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v3/pro/image-to-video` (Sync) / `https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | - | Text prompt for video generation. Required if `multi_prompt` is not provided. |
| `multi_prompt` | list | - | - | List of prompts for multi-shot video generation. Divides the video into multiple shots. |
| `start_image_url` | string | (Required) | - | URL of the image to be used as the starting frame. |
| `duration` | enum | `5` | `3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15` | The duration of the generated video in seconds. |
| `generate_audio` | boolean | `true` | `true, false` | Whether to generate native audio for the video. Supports Chinese and English. |
| `end_image_url` | string | - | - | URL of the image to be used for the end of the video (interpolates between start and end). |
| `elements` | list | - | - | Elements (characters/objects) to include for enhanced consistency. |
| `shot_type` | string | `"customize"` | `"customize", "intelligent"` | The type of multi-shot generation. Required when `multi_prompt` is used. |
| `negative_prompt` | string | `"blur, distort, and low quality"` | - | Text description of what to exclude from the video. |
| `cfg_scale` | float | `0.5` | `0.0 - 1.0` | Measure of how closely the model sticks to the prompt. |

### Output
The output is a JSON object containing a `video` object with the generated file details:
```json
{
  "video": {
    "url": "https://storage.googleapis.com/...",
    "content_type": "video/mp4",
    "file_name": "out.mp4",
    "file_size": 8431922
  }
}
```

### Example request
```json
{
  "prompt": "A cinematic shot of a sunset over a calm ocean, waves gently lapping at the shore.",
  "start_image_url": "https://example.com/start.jpg",
  "duration": "10",
  "generate_audio": true,
  "cfg_scale": 0.5
}
```

### Pricing
FAL.ai bills this model at approximately **$0.112 per second** for the Pro tier. A standard 10-second video costs roughly **$1.12**. Pricing may vary based on whether native audio is enabled.

## API — via Original Source (BYO-key direct)
The original creator, Kling AI (Kuaishou), provides a direct API.
- **Endpoint:** `https://api.klingai.com/v1/videos/image-to-video`
- **Auth method:** API Key via Bearer Token.
- **Additional Features:** The native API sometimes exposes advanced "Motion Brush" trajectories and "Lip Sync" modes that may have varying levels of support on third-party providers.
- **Link:** [Kling AI Developer Documentation](https://kling.ai/quickstart/klingai-video-3-model-user-guide)

## Prompting best practices
- **Be Descriptive:** Use keywords like "cinematic," "high detail," "realistic physics," and "fluid motion" to leverage the Pro model's strengths.
- **Control Motion:** Specify the intensity of movement (e.g., "gentle breeze," "rapid explosion," "slow-motion walking").
- **Audio Context:** Include audio-relevant keywords (e.g., "birds chirping," "ambient city noise") if `generate_audio` is set to `true`.
- **Negative Prompts:** Use the default or add specific terms like "jitter," "flicker," or "warped faces" to improve stability.
- **Avoid Over-Prompting:** Keep the prompt focused on the action; the `start_image_url` handles the scene's visual identity.

## Parameter tuning guide
- **CFG Scale (0.5):** The sweet spot for this model is quite low compared to image models. Increasing it beyond 0.7 can often lead to visual artifacts or "over-cooked" motion.
- **Duration (3-15s):** Longer durations (10s+) are better for complex scenes, while shorter durations (5s) provide higher consistency for simple character movements.
- **Start/End Frames:** Providing both a `start_image_url` and an `end_image_url` significantly improves control over specific transitions, making it ideal for "before and after" or "A to B" animations.

## Node inputs/outputs
- **Inputs:**
  - `Text Prompt` (string)
  - `Start Image` (image/url)
  - `End Image` (image/url, optional)
  - `Duration` (integer/enum)
  - `Negative Prompt` (string)
- **Outputs:**
  - `Video URL` (url)
  - `Audio URL` (url, if separate or embedded in video)
- **Chain-friendly with:**
  - [Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev) for generating high-quality starting images.
  - [Magnific AI](https://magnific.ai/) or similar upscalers for 4K video post-processing.
  - [ElevenLabs](https://elevenlabs.io/) if more complex voiceovers are needed beyond native audio.

## Notes & gotchas
- **Safety Filters:** The model has strict content policies regarding nudity, violence, and public figures.
- **Queue Times:** As a Pro-tier model, generation can take several minutes; always use the Queue mode for production applications.
- **Region Restrictions:** Some features may vary in availability depending on the API provider's region and agreement with Kuaishou.

## Sources
- [FAL.ai Kling v3 Pro API Docs](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api)
- [Kling AI Official User Guide](https://kling.ai/quickstart/klingai-video-3-model-user-guide)
- [CineD: Kling 3.0 Technical Report](https://www.cined.com/kling-3-0-ai-video-model-introduced/)
