---
name: fal-ai/sora-2/text-to-video/pro
display_name: OpenAI Sora 2 Pro
category: text-to-video
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/sora-2/text-to-video/pro
original_source: https://openai.com/index/sora-2/
summary: OpenAI's flagship text-to-video model with native synchronized audio, cinematic 1080p quality, and up to 25-second durations.
---

# OpenAI Sora 2 Pro

## Overview
- **Slug:** `fal-ai/sora-2/text-to-video/pro`
- **Category:** Text-to-Video
- **Creator:** [OpenAI](https://openai.com)
- **Best for:** High-fidelity cinematic video production with native synchronized audio and complex physics simulation.
- **FAL docs:** [fal-ai/sora-2/text-to-video/pro](https://fal.ai/models/fal-ai/sora-2/text-to-video/pro)
- **Original source:** [OpenAI Sora 2 Announcement](https://openai.com/index/sora-2/)

## What it does
OpenAI Sora 2 Pro is a state-of-the-art video generation model that represents a significant leap over the original Sora. Its primary breakthrough is the integration of **native, synchronized audio synthesis**, allowing it to generate dialogue, environmental soundscapes, and sound effects that perfectly match the visual actions (such as lip-syncing). The "Pro" variant is optimized for maximum detail, supporting resolutions up to "True 1080p" (1920x1080) and extended durations up to 25 seconds, while maintaining higher temporal consistency and more accurate physics simulation than the Standard version.

## When to use this model
- **Use when:** You need "one-shot" production-ready clips where audio-visual synchronization is critical (e.g., characters speaking, footsteps on specific surfaces).
- **Use when:** Creating commercial-grade advertisements or cinematic sequences that require high resolution and realistic physics.
- **Don't use when:** Doing rapid prototyping or low-budget exploration; the $0.70/sec pricing for True 1080p makes it expensive for high-volume drafting.
- **Alternatives:** 
    - [Sora 2 Standard](https://fal.ai/models/fal-ai/sora-2/text-to-video): Faster and 3-5x cheaper, but lacks "True 1080p" and has shorter maximum durations.
    - [Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video): Strong alternative for realistic motion, though Sora 2 Pro generally leads in audio-sync quality.
    - [Hunyuan Video V1.5](https://fal.ai/models/fal-ai/hunyuan-video-v1.5/text-to-video): Better for specific stylized or long-form motion where native audio isn't the priority.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sora-2/text-to-video/pro` (Sync) / `https://queue.fal.run/fal-ai/sora-2/text-to-video/pro` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | Detailed description of the video to generate. |
| `resolution` | string | `1080p` | `720p`, `1080p`, `true_1080p` | `1080p` refers to legacy HD (e.g. 1792x1024), while `true_1080p` is full 1920x1080. |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16` | Cinematic widescreen or vertical social media format. |
| `duration` | integer | `4` | `4, 8, 12, 16, 20, 25` | Video length in seconds. (FAL UI caps at 20 in some schemas, but Pro supports up to 25). |
| `delete_video` | boolean | `true` | `true`, `false` | If true, deletes the video from FAL storage after generation (privacy). |
| `detect_and_block_ip`| boolean | `false` | `true`, `false` | Enables checking for known intellectual property or likenesses to block them. |
| `character_ids` | list<string>| `[]` | N/A | Up to two character IDs from Sora's "Cameo" feature to maintain identity consistency. |

### Output
The API returns a JSON object containing the generated media details:
- `video`: Object containing `url`, `width`, `height`, `fps`, and `duration`.
- `video_id`: A unique identifier for the generated clip.
- `thumbnail`: An `ImageFile` object with a preview image URL.
- `spritesheet`: An `ImageFile` object with a grid of frames for scrubbable previews.

### Example request
```json
{
  "prompt": "A cinematic tracking shot of a futuristic neon city under heavy rain. A cyborg character looks into the camera and says 'The future is already here', with perfectly synchronized lip movement and the sound of heavy raindrops hitting metal.",
  "resolution": "true_1080p",
  "aspect_ratio": "16:9",
  "duration": 8,
  "detect_and_block_ip": true
}
```

### Pricing
- **720p:** $0.30 per second of generated video.
- **Legacy 1080p (1792x1024):** $0.50 per second.
- **True 1080p (1920x1080):** $0.70 per second.

## API — via Original Source (BYO-key direct)
OpenAI provides a direct API for Sora 2, though it is currently in a deprecated/sunset phase with a final shutdown scheduled for **September 24, 2026**.

- **Endpoint:** `https://api.openai.com/v1/videos`
- **Auth:** Bearer Token (`OPENAI_API_KEY`)
- **Native Parameters:**
    - `model`: `sora-2-pro`
    - `size`: string (e.g., `"1920x1080"`, `"1024x1792"`)
    - `seconds`: integer or string (4-25)
    - `characters`: list of objects (e.g., `[{"id": "char_123"}]`)
- **Official Docs:** [OpenAI Video Generation Guide](https://developers.openai.com/api/docs/guides/video-generation)

## Prompting best practices
- **Include Sound Cues:** Explicitly describe the sounds you want. Instead of just "a man walking," use "the rhythmic thud of leather boots on a wooden floor." Sora 2 Pro uses the prompt to guide audio synthesis.
- **Camera Direction:** Use professional cinematography terms like "low-angle tracking shot," "shallow depth of field," or "extreme close-up" to leverage the model's cinematic training.
- **Visual Anchors:** Describe specific, tangible objects and their interactions (e.g., "dust motes dancing in a single beam of light") to ground the physics engine.
- **One Action per Shot:** For the most coherent 20-25s clips, focus on one primary subject action or one continuous camera movement.
- **Character Consistency:** Use the "Cameo" feature by uploading a reference and using the generated `character_id` to ensure the same face appears across different prompts.

## Parameter tuning guide
- **Resolution - True 1080p:** Only use this for final renders. It is significantly more expensive ($0.70 vs $0.30/sec) and takes ~20% longer to generate. Use 720p for all prompt testing.
- **Duration - 25s:** The sweet spot for storytelling. However, temporal consistency (objects disappearing) is slightly more likely after the 15s mark; for high-stakes projects, consider generating 8-12s segments.
- **Detect and Block IP:** Keep this enabled if you plan to use the output commercially to ensure you don't accidentally generate protected character likenesses.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Text area for the scene description.
    - `Duration`: Slider or dropdown (4, 8, 12, 16, 20, 25).
    - `Resolution`: Dropdown (720p, 1080p, True 1080p).
    - `Character IDs`: Tag/List input for consistency.
- **Outputs:**
    - `Video URL`: Direct link to the MP4 file.
    - `Thumbnail`: Image URL for UI display.
    - `Audio Metadata`: (Optional) Information about the generated audio tracks.
- **Chain-friendly with:**
    - `fal-ai/flux-pro`: To generate high-quality reference images for Image-to-Video workflows.
    - `fal-ai/sora-2/video-to-video/remix`: To iterate on a generated Sora clip with style changes.

## Notes & gotchas
- **Sunset Notice:** OpenAI has announced the deprecation of the Sora 2 API, with a full shutdown on **September 24, 2026**.
- **Rate Limits:** Pro models often have stricter Requests Per Minute (RPM) limits compared to Standard models; ensure your node-based app handles 429 errors gracefully.
- **Regional Restrictions:** Some features (like the Cameo/Likeness feature) may have restricted availability based on regional safety laws (e.g., Illinois BIPA).

## Sources
- [FAL.ai Sora 2 Pro API Docs](https://fal.ai/models/fal-ai/sora-2/text-to-video/pro/api)
- [OpenAI Sora 2 Official Announcement](https://openai.com/index/sora-2/)
- [OpenAI Developer Video Guide](https://developers.openai.com/api/docs/guides/video-generation)
- [Sora 2 System Card (PDF)](https://cdn.openai.com/pdf/50d5973c-c4ff-4c2d-986f-c72b5d0ff069/sora_2_system_card.pdf)
