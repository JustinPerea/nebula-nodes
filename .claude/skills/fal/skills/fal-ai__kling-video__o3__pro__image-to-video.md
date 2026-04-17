---
name: fal-ai/kling-video/o3/pro/image-to-video
display_name: Kling O3 Image to Video [Pro]
category: image-to-video
creator: Kuaishou Technology
fal_docs: https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video
original_source: https://kling.ai/
summary: Professional-grade image-to-video model supporting 3-15s clips with start/end frame control, native audio, and 1080p output.
---

# Kling O3 Image to Video [Pro]

## Overview
- **Slug:** `fal-ai/kling-video/o3/pro/image-to-video`
- **Category:** image-to-video
- **Creator:** [Kuaishou Technology](https://kling.ai/)
- **Best for:** Cinematic, high-fidelity video generation with precise start/end frame control and native synchronized audio.
- **FAL docs:** [fal-ai/kling-video/o3/pro/image-to-video](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video)
- **Original source:** [Kling AI Official Site](https://kling.ai/)

## What it does
Kling O3 (also known as Kling 3.0) is a state-of-the-art generative video model that transforms static images into dynamic, high-definition video clips. It excels at maintaining character consistency, simulating complex physics (like cloth and fluid), and following intricate cinematic instructions ([Imagine.Art](https://www.imagine.art/blogs/kling-3-0-prompt-guide)). The "Pro" version on FAL provides 1080p resolution and supports extended durations of up to 15 seconds, along with the ability to generate synchronized native audio and control transitions between a starting and ending image ([fal.ai](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api)).

## When to use this model
- **Use when:** You need professional-grade marketing assets, cinematic storytelling with multi-shot consistency, or videos that require synchronized character dialogue ([Atlabs.ai](https://www.atlabs.ai/blog/kling-3-0-prompting-guide-master-ai-video-generation)).
- **Don't use when:** You need rapid, low-cost previews (use Standard mode or faster models like Luma Dream Machine) or highly stylized/anime content (where Seedance might perform better) ([Kling 3.0 Pro Blog](https://kling3pro.com/blog/kling-3-0-vs-seedance-1-5-pro-comparison)).
- **Alternatives:** 
    - `fal-ai/kling-video/v1.5/pro/image-to-video`: Older version, often faster but with less advanced motion logic.
    - `fal-ai/luma-dream-machine`: High speed and great motion, but lacks the native audio and multi-shot storyboard features of Kling 3.0.
    - `fal-ai/veo`: Google's equivalent, strong on realism but different prompting requirements.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/o3/pro/image-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/o3/pro/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | max 2500 chars | Text prompt for video generation. Describe the action and style. |
| `image_url` | string | (Required) | URL | URL of the start frame image. |
| `end_image_url` | string | - | URL | URL of the end frame image for start-to-end frame interpolation. |
| `duration` | enum | 5 | 3, 4, ..., 15 | Video duration in seconds. |
| `generate_audio` | boolean | false | true, false | Whether to generate native audio (lip-sync and ambient) for the video. |
| `multi_prompt` | list | - | - | List of prompts for multi-shot generation (up to 6 shots). |
| `shot_type` | string | - | "customize", "intelligent" | Method for storyboard control. |
| `negative_prompt` | string | "" | - | Elements to exclude from the video. |
| `cfg_scale` | float | 0.5 | 0.0 - 1.0 | Sticks more closely to the prompt (higher value) or allows more creativity. |

### Output
The output is a JSON object containing a `video` field with metadata and a download URL.
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "kling_video.mp4",
    "file_size": 12037975
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/start.jpg",
  "prompt": "A futuristic car speeds through a neon city, reflections on the wet pavement.",
  "duration": 5,
  "generate_audio": true
}
```

### Pricing
- **Audio Off:** $0.112 per second of video generated ([fal.ai](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api)).
- **Audio On:** $0.14 per second of video generated ([fal.ai](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api)).

## API — via Original Source (BYO-key direct)
Kling AI offers a direct API through their Singapore-based developer portal.
- **Endpoint:** `https://api-singapore.klingai.com/v1/videos/image2video`
- **Unique Parameters:**
    - `static_mask`: Allows users to paint a mask to define areas that should remain static.
    - `dynamic_masks`: Allows defining "Motion Brushes" with specific x,y trajectory coordinates ([Kling.ai Docs](https://kling.ai/document-api/apiReference/model/imageToVideo)).
    - `camera_control`: Explicit control over pan, tilt, roll, and zoom values (-10 to 10 range).
- **Auth method:** Bearer Token (API Key).
- **Link:** [Kling AI API Documentation](https://kling.ai/document-api/apiReference/model/imageToVideo)

## Prompting best practices
- **The 5-Layer Template:** Structure your prompt as **Scene → Characters → Action → Camera → Audio & Style** ([Imagine.Art](https://www.imagine.art/blogs/kling-3-0-prompt-guide)).
- **Cinematic Verbs:** Use specific motion terms like "dolly push," "whip-pan," "shoulder-cam drift," or "crash zoom" instead of just "moves" ([Atlabs.ai](https://www.atlabs.ai/blog/kling-3-0-prompting-guide-master-ai-video-generation)).
- **Visual Anchoring:** Bind dialogue to actions. E.g., *"The character slams the table. [Character A, angrily shouting]: 'No!'"* ([fal.ai Blog](https://blog.fal.ai/kling-3-0-prompting-guide/)).
- **Avoid Over-prompting:** Don't cram too many ideas into one 5-second clip; for 15-second clips, describe the progression chronologically.
- **Micro-Motions:** Add "breathing," "blinking," or "fabric sway" to prompts to increase realism in static scenes ([Atlabs.ai](https://www.atlabs.ai/blog/kling-3-0-prompting-guide-master-ai-video-generation)).

## Parameter tuning guide
- **CFG Scale (0.5 - 0.7):** Use 0.5 for most natural results. Increase to 0.7 if the model ignores specific prompt instructions, but be aware of possible color oversaturation ([fal.ai](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api)).
- **Duration:** 5s is the sweet spot for consistency. 15s clips are powerful for narrative development but may experience slight drift in character features if the prompt isn't extremely detailed ([fal.ai Blog](https://blog.fal.ai/kling-3-0-prompting-guide/)).
- **End Image URL:** Use this for "interpolation" tasks where you have a clear destination. It significantly stabilizes the video's conclusion.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:** 
    - `start_image` (Image/URL)
    - `prompt` (Text)
    - `duration` (Number/Slider)
    - `negative_prompt` (Text)
    - `generate_audio` (Boolean)
- **Outputs:** 
    - `video_url` (Video/URL)
- **Chain-friendly with:** 
    - `fal-ai/flux/pro`: Generate the perfect starting frame.
    - `fal-ai/elevenlabs`: For custom narrated voiceovers that go beyond Kling's native generation.
    - `fal-ai/face-swap`: For replacing the face in the final video for personalized content.

## Notes & gotchas
- **Safety Filters:** Kling has a very strict content policy; prompts mentioning celebrities, political figures, or suggestive content will often trigger a "failed" status ([Atlas Cloud](https://www.atlascloud.ai/blog/guides/kling-3-0-review-features-pricing-ai-alternatives)).
- **Base64 Note:** If using the native API directly, do not include the `data:image/...` prefix in the base64 string ([Kling.ai Docs](https://kling.ai/document-api/apiReference/model/imageToVideo)).
- **Queue Times:** During peak hours, generations can take 5-10 minutes even on "Pro" plans ([Atlas Cloud](https://www.atlascloud.ai/blog/guides/kling-3-0-review-features-pricing-ai-alternatives)).

## Sources
- [FAL.ai Kling O3 API Docs](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api)
- [Official Kling AI Developer Portal](https://kling.ai/document-api/apiReference/model/imageToVideo)
- [fal.ai Kling 3.0 Prompting Guide](https://blog.fal.ai/kling-3-0-prompting-guide/)
- [Kling 3.0 Review and Benchmarks](https://www.atlascloud.ai/blog/guides/kling-3-0-review-features-pricing-ai-alternatives)
- [Imagine.Art Kling 3.0 Prompting Logic](https://www.imagine.art/blogs/kling-3-0-prompt-guide)
