---
name: fal-ai/veo3.1/first-last-frame-to-video
display_name: Google Veo 3.1 First-Last Frame to Video
category: image-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video
original_source: https://ai.google.dev/gemini-api/docs/video
summary: A high-fidelity video generation model that creates seamless transitions between two provided image frames with native audio and up to 4K resolution.
---

# Google Veo 3.1 First-Last Frame to Video

## Overview
- **Slug:** `fal-ai/veo3.1/first-last-frame-to-video`
- **Category:** image-to-video / interpolation
- **Creator:** [Google DeepMind](https://deepmind.google/technologies/veo/)
- **Best for:** Creating seamless cinematic transitions between two specific images.
- **FAL docs:** [fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video)
- **Original source:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)

## What it does
Google Veo 3.1 First-Last Frame to Video is a specialized video generation model that takes a starting image and an ending image to "fill in the gaps" with a smooth, consistent animation. Unlike standard image-to-video models that only use a single reference, this model ensures that the generated sequence begins exactly with the first frame and ends exactly with the last, making it ideal for storytelling, product reveals, and complex visual effects. It features state-of-the-art spatio-temporal consistency and natively generates synchronized audio.

## When to use this model
- **Use when:** You have two keyframes (e.g., from a storyboard or AI image generator) and need a high-quality transition between them.
- **Use when:** You need high-resolution (up to 4K) video with realistic motion and native sound effects.
- **Don't use when:** You only have a single image and want the AI to imagine the ending (use standard [Veo 3.1 Image-to-Video](https://fal.ai/models/fal-ai/veo3.1/image-to-video) instead).
- **Don't use when:** You need a video longer than 8 seconds in a single pass.
- **Alternatives:** 
    - [Kling 1.5 Image-to-Video](https://fal.ai/models/fal-ai/kling-video/v1.5/pro/image-to-video): Better for longer durations (up to 10s) but doesn't support specific "last frame" constraints as natively as Veo 3.1.
    - [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine/image-to-video): Known for high cinematic quality but has different prompt adherence characteristics.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3.1/first-last-frame-to-video` (sync) / `https://queue.fal.run/fal-ai/veo3.1/first-last-frame-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | - | The text prompt describing the action, style, and atmosphere of the video. |
| `first_frame_url` | string | *Required* | - | URL of the starting image frame. |
| `last_frame_url` | string | *Required* | - | URL of the ending image frame. |
| `aspect_ratio` | enum | `auto` | `auto`, `16:9`, `9:16` | The output aspect ratio. `auto` matches the input images. |
| `duration` | enum | `4s` | `4s`, `6s`, `8s` | Length of the generated video. |
| `resolution` | enum | `720p` | `720p`, `1080p`, `4k` | Vertical resolution of the output. |
| `generate_audio` | boolean | `true` | - | Whether to generate a synchronized audio track. |
| `negative_prompt` | string | - | - | Elements to avoid in the generation. |
| `seed` | integer | - | - | Random seed for reproducible results. |
| `auto_fix` | boolean | `false` | - | Automatically attempt to fix prompts that trigger safety filters. |
| `safety_tolerance`| enum | `2` | `1` to `6` | Content moderation level (1: strict, 6: most permissive). |

### Output
The API returns a JSON object containing the generated video details:
```json
{
  "video": {
    "url": "https://fal.run/...",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "A cinematic tracking shot through a magical ice cave, the light shifts from blue to warm amber as the camera moves.",
  "first_frame_url": "https://example.com/start.jpg",
  "last_frame_url": "https://example.com/end.jpg",
  "aspect_ratio": "16:9",
  "duration": "8s",
  "resolution": "1080p",
  "generate_audio": true
}
```

### Pricing
- **720p or 1080p:** $0.20/sec without audio, $0.40/sec with audio.
- **4K:** $0.40/sec without audio, $0.60/sec with audio.
*Prices are subject to change; refer to the [FAL pricing page](https://fal.ai/pricing) for the latest rates.*

## API — via Original Source (BYO-key direct)
Google offers Veo 3.1 via the **Gemini API** and **Vertex AI**.

- **Endpoint (Gemini API):** `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning`
- **Auth Method:** `x-goog-api-key` header or Google Cloud IAM.
- **Additional Parameters:**
    - `referenceImages`: Supports up to 3 additional images to guide character or style consistency.
    - `video`: Can take an existing video for "extension" (adding time to the end).
- **Official Docs:** [Google AI Video Documentation](https://ai.google.dev/gemini-api/docs/video)

## Prompting best practices
- **Include Action & Motion:** Clearly describe the transition. Use keywords like "morphs into," "dissolves into," "pans across to reveal," or "accelerates toward."
- **Style Consistency:** Mention the specific visual style in the prompt (e.g., "3D animated," "photorealistic," "cinematic noir") to help the model maintain a consistent look between frames.
- **Audio Cues:** Since audio is native, include sound descriptions like "with a low rumble of thunder" or "upbeat electronic music" for better results.
- **Frame Reference:** The model is most successful when the two images have similar lighting and composition. If the jump is too large, the motion may appear "warped."
- **Bad Prompt:** "A man turns into a bird." (Too vague, lacks motion context).
- **Good Prompt:** "A high-fidelity cinematic shot of a man standing on a cliff who slowly extends his arms and transforms into a golden eagle soaring into the sunset."

## Parameter tuning guide
- **Resolution (4k vs 1080p):** Use 1080p for most workflows to save on cost; only switch to 4K for final production exports as it significantly increases the cost per second.
- **Duration (8s):** The "sweet spot" for interpolation. Longer durations (8s) allow for more complex transformations, while 4s is better for quick cuts or simple camera moves.
- **Safety Tolerance:** If your prompt involves safe but "artistic" edgy content (like dark fantasy), raising this to 4 or 5 (via API) can prevent false-positive blocks.
- **Generate Audio:** Always keep this on unless you have a custom soundtrack. The native audio is spatio-temporally aware, meaning sounds correspond to visual events.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (String)
    - `First Frame Image` (Image/URL)
    - `Last Frame Image` (Image/URL)
    - `Negative Prompt` (String)
- **Outputs:**
    - `Video URL` (URL)
    - `Generated Audio URL` (If extracted separately, though usually embedded in MP4)
- **Chain-friendly with:**
    - [Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev): Generate high-quality first and last frames.
    - [Patina](https://blog.fal.ai/introducing-patina/): Post-process the video for specific filmic looks.
    - [Whisper](https://fal.ai/models/fal-ai/whisper): Transcribe any generated speech if "dialogue" was prompted.

## Notes & gotchas
- **Max File Size:** Input images must be under 8MB (FAL) or 20MB (Google Native).
- **English Only:** Prompting is currently optimized for English.
- **C2PA Metadata:** Output videos contain Content Credentials (C2PA) to identify them as AI-generated.
- **Queue Mode:** Highly recommended for this model as generation can take 30-90 seconds.

## Sources
- [FAL.ai Veo 3.1 Model Page](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video)
- [Google AI for Developers - Video Generation Guide](https://ai.google.dev/gemini-api/docs/video)
- [Vertex AI Google Cloud Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate)
- [FAL Blog: Mastering Video Generation with Veo](https://blog.fal.ai/mastering-video-generation-with-veo-2-a-comprehensive-guide/)