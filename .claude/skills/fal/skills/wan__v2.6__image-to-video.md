---
name: wan/v2.6/image-to-video
display_name: Wan v2.6 Image to Video
category: text-to-video
creator: Alibaba (Wan-AI)
fal_docs: https://fal.ai/models/wan/v2.6/image-to-video
original_source: https://www.alibabacloud.com/help/en/model-studio/image-to-video-api-reference
summary: A high-fidelity image-to-video model by Alibaba featuring native audio synchronization and multi-shot narrative capabilities.
---

# Wan v2.6 Image to Video

## Overview
- **Slug:** `wan/v2.6/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [Alibaba (Wan-AI)](https://github.com/Wan-Video)
- **Best for:** Cinematic video animation with perfectly synchronized native audio and multi-shot storytelling.
- **FAL docs:** [fal.ai/models/wan/v2.6/image-to-video](https://fal.ai/models/wan/v2.6/image-to-video)
- **Original source:** [Alibaba Cloud Model Studio](https://www.alibabacloud.com/help/en/model-studio/image-to-video-api-reference)

## What it does
Wan v2.6 Image to Video (I2V) is a state-of-the-art multimodal model developed by Alibaba that transforms static images into high-quality video sequences up to 15 seconds long. Unlike many competitors, it features a unified architecture that generates video and synchronized audio (including lip-sync and ambient sounds) in a single pass. It excels at maintaining character identity and structural consistency while executing complex camera movements and multi-shot narrative transitions defined via text prompts.

## When to use this model
- **Use when:** You need to animate a specific character or product image while maintaining high fidelity to the original source. It is ideal for "talking head" videos, cinematic trailers, and narrative storytelling where scene transitions are required within a single generation.
- **Don't use when:** You need ultra-fast, low-cost previews (consider the "Flash" variant) or when you need absolute control over every single frame's physics (Sora or Veo may offer different trade-offs).
- **Alternatives:** 
    - **[Kling 1.5/2.0](https://fal.ai/models/fal-ai/kling-video/v1.5/standard/image-to-video):** Stronger physics and longer durations but often lacks the integrated A/V sync of Wan.
    - **[Luma Dream Machine](https://fal.ai/models/luma-dream-machine):** Excellent at realistic human motion but can sometimes drift from the reference image.
    - **[Wan v2.6 Image to Video Flash](https://fal.ai/models/wan/v2.6/image-to-video/flash):** Use for rapid iteration and significantly lower cost with slightly reduced motion complexity.

## API — via FAL.ai
**Endpoint:** `https://fal.run/wan/v2.6/image-to-video` (sync) / `https://queue.fal.run/wan/v2.6/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 800 chars | Text describing the motion and scene. Supports multi-shot syntax (e.g., `Shot 1 [0-4s]`). |
| `image_url` | string | (Required) | URL / Base64 | The image to use as the first frame. Supports JPG, PNG, WEBP, BMP. |
| `audio_url` | string | null | URL | Optional background audio or voiceover (3-30s, max 15MB, WAV/MP3). |
| `resolution` | enum | `720p` | `720p`, `1080p` | The output video resolution. |
| `duration` | enum | `5` | `5`, `10`, `15` | Total length of the generated video in seconds. |
| `negative_prompt` | string | "" | Max 500 chars | Elements to exclude from the generation. |
| `enable_prompt_expansion` | boolean | `true` | `true`, `false` | Uses an internal LLM to enrich the prompt for better cinematic results. |
| `multi_shots` | boolean | `false` | `true`, `false` | Enables intelligent narrative segmentation (requires `enable_prompt_expansion`). |
| `seed` | integer | null | Any | For reproducibility. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Filters NSFW or policy-violating content. |

### Output
The API returns a JSON object containing:
- `video`: A `VideoFile` object with `url`, `width`, `height`, `fps`, and `duration`.
- `seed`: The integer seed used for the generation.
- `actual_prompt`: The expanded version of the prompt used by the model.

### Example request
```json
{
  "input": {
    "prompt": "Shot 1 [0-5s]: The character looks into the camera and smiles warmly. Shot 2 [5-10s]: A cinematic zoom out reveals they are standing on a busy Tokyo street at night. Neon lights reflecting in puddles.",
    "image_url": "https://example.com/character.jpg",
    "duration": "10",
    "resolution": "1080p",
    "enable_prompt_expansion": true
  }
}
```

### Pricing
- **720p:** $0.10 per second of video generated.
- **1080p:** $0.15 per second of video generated.
- *Example:* A 10-second 1080p video costs $1.50.

## API — via Original Source (BYO-key direct)
Alibaba Cloud provides a direct API via the **DashScope (Model Studio)** platform.
- **Endpoint:** `https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`
- **Auth Method:** Bearer Token (API Key from Alibaba Cloud).
- **Additional parameters:** Alibaba's native API supports `watermark` (boolean) and `prompt_extend` (equivalent to FAL's expansion). The international version is optimized for regions outside of China.
- **Link:** [Alibaba Cloud API Docs](https://www.alibabacloud.com/help/en/model-studio/image-to-video-api-reference)

## Prompting best practices
- **Use Shot Timing:** Explicitly define timing for narrative changes using `[0-5s]` syntax. This tells the model when to execute "cuts" or major motion shifts.
- **Describe Motion, Not Just Subjects:** Use keywords like "slow pan," "dolly zoom," "character waves," or "hair blowing in the wind" to guide the animation.
- **Identify the First Frame:** If the image is very specific, start the prompt with "Continue from first frame..." to help the model transition smoothly.
- **Style Tokens:** Include style keywords such as "cinematic lighting," "8k resolution," "photorealistic," or "anime style" to maintain visual consistency.
- **Common Failure Mode:** Overloading the prompt with too many characters (max 800) or providing an image with too much noise can lead to "morphing" artifacts.

## Parameter tuning guide
- **Duration (5/10/15):** Longer durations require more descriptive prompts to prevent the motion from becoming static or repetitive in the final seconds.
- **Prompt Expansion:** Leave this `true` for general creative work; turn it `false` if you have a highly technical or precisely engineered prompt that the LLM might "misinterpret."
- **Multi-Shots:** Enable this only when your prompt describes a sequence of events. For a single continuous motion (like a character just waving), leave it `false` to avoid jarring cuts.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Image` (Image Port): The source image for the first frame.
  - `Prompt` (Text Port): Motion and scene description.
  - `Audio` (Audio/URL Port): Background music or voice.
  - `Duration` (Dropdown): 5s, 10s, 15s.
- **Outputs:**
  - `Video` (Video Port): The final rendered MP4/H.264 file.
  - `Expanded Prompt` (Text Port): Useful for debugging what the model actually "saw."
- **Chain-friendly with:**
  - **[Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** To generate the initial high-quality character/scene image.
  - **[Remove Background](https://fal.ai/models/fal-ai/bria/background-removal):** To clean up reference images before animation.
  - **[Upscaler](https://fal.ai/models/fal-ai/aura-sr):** To push the output beyond 1080p for final delivery.

## Notes & gotchas
- **Image Size:** Recommended image resolution is between 360px and 2000px. Images larger than 25MB will be rejected.
- **Audio Limits:** Audio input must be between 3 and 30 seconds. If the video is shorter than the audio, the audio will be truncated.
- **Safety Filter:** The model is strictly filtered for realistic violence and adult content; attempts to bypass this via prompt expansion will still be caught by the output safety checker.

## Sources
- [FAL.ai Wan v2.6 Documentation](https://fal.ai/models/wan/v2.6/image-to-video)
- [Alibaba Cloud Model Studio I2V Reference](https://www.alibabacloud.com/help/en/model-studio/image-to-video-api-reference)
- [Higgsfield Wan 2.6 Announcement](https://higgsfield.ai/wan-2.6)
- [Wan-Video GitHub Repository](https://github.com/Wan-Video)