---
name: fal-ai/kling-video/v3/pro/text-to-video
display_name: Kling Video v3 Text to Video [Pro]
category: text-to-video
creator: Kuaishou Technology
fal_docs: https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video
original_source: https://klingai.com/
summary: Top-tier AI video generator featuring 1080p resolution, multi-shot storyboarding, and native synchronized audio.
---

# Kling Video v3 Text to Video [Pro]

## Overview
- **Slug:** `fal-ai/kling-video/v3/pro/text-to-video`
- **Category:** Text-to-Video
- **Creator:** [Kuaishou Technology](https://klingai.com/)
- **Best for:** Cinematic high-fidelity video with native audio and complex narrative multi-shot sequences.
- **FAL docs:** [fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video](https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video)
- **Original source:** [klingai.com](https://klingai.com/)

## What it does
Kling Video v3 Pro is a state-of-the-art text-to-video model capable of generating highly realistic, cinematic videos up to 15 seconds long. It distinguishes itself with **Native Audio Generation**, allowing users to generate synchronized dialogue and sound effects directly within the video creation process. The model supports **Multi-Shot Storyboarding**, enabling the creation of complex sequences with automatic shot transitions (like close-ups to wide shots) and consistent identity preservation across those shots.

## When to use this model
- **Use when:** You need high-resolution (up to 1080p) output, synchronized audio/dialogue, or complex storytelling that requires multiple camera angles in a single clip.
- **Don't use when:** You need ultra-fast "turbo" generation for low-cost prototyping, or if your prompt involves restricted content (safety filters are strict).
- **Alternatives:** 
    - **[Kling v2.5 Turbo](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video):** Faster and cheaper but with lower motion consistency and no native v3 multi-shot logic.
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Strong physics and motion, but lacks the native audio and multi-shot orchestration of Kling v3.
    - **[Hailuo MiniMax](https://fal.ai/models/fal-ai/minimax/video-01):** Excellent for human movements and expressive characters, though Kling v3 Pro generally offers higher overall fidelity.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v3/pro/text-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/v3/pro/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | - | - | Text description of the video. Required unless `multi_prompt` is used. |
| `duration` | `enum` | `5` | `3, 4, 5, ..., 15` | Total duration of the generated video in seconds. |
| `multi_prompt` | `list` | `[]` | Max 6 shots | A list of prompts and durations for multi-shot generation. Overrides single `prompt`. |
| `generate_audio` | `boolean` | `true` | `true, false` | Whether to generate native audio (English/Chinese supported). |
| `shot_type` | `enum` | `intelligent` | `customize, intelligent` | Method for storyboarding. `customize` requires `multi_prompt`. |
| `aspect_ratio` | `enum` | `16:9` | `16:9, 9:16, 1:1` | Frame aspect ratio. |
| `negative_prompt` | `string` | `""` | - | Descriptions of elements to avoid. |
| `cfg_scale` | `float` | `0.5` | `0.0 - 1.0` | Guidance scale. Lower values (near 0) allow more model creativity; higher values stick closer to the prompt. |

### Output
The API returns a JSON object containing the generated video file information:
```json
{
  "video": {
    "url": "https://fal-cdn.com/...",
    "content_type": "video/mp4",
    "file_name": "kling_v3_output.mp4",
    "file_size": 8062911
  }
}
```

### Example request
```json
{
  "prompt": "Cinematic close-up of a cyberpunk chef cooking in a neon-lit alleyway, steam rising from the wok, photorealistic, 4k.",
  "duration": 10,
  "aspect_ratio": "16:9",
  "generate_audio": true
}
```

### Pricing
- **FAL.ai:** Approximately **$0.168 per second** of generated video for the Pro model ([Atlas Cloud Source](https://www.atlascloud.ai/blog/guides/kling-3.0-review-features-pricing-ai-alternatives)).
- Costs scale with resolution and the inclusion of native audio.

## API — via Original Source (BYO-key direct)
Kling AI offers a direct API through their developer platform.
- **Endpoint:** `https://api.klingai.com/v1/videos/text2video`
- **Auth method:** Bearer Token (API Key)
- **Extra parameters:** The native API supports granular **Camera Control** (horizontal, vertical, pan, tilt, roll, zoom) which may not be fully exposed in all third-party wrappers.
- **Official Docs:** [Kling AI API Documentation](https://kling.ai/document-api/apiReference/model/textToVideo)

## Prompting best practices
- **Describe the sound:** Since v3 supports native audio, include sound descriptions in your prompt (e.g., "the sizzle of the pan," "birds chirping in the background").
- **Multi-Shot Syntax:** Use the multi-shot feature for complex narratives rather than trying to describe 5 different things in one prompt.
- **Keyword Weighting:** Use cinematic keywords like "8k," "photorealistic," "anamorphic lens," and "dynamic lighting" to leverage the Pro model's high-fidelity training.
- **Text Fidelity:** Kling v3 is exceptionally good at rendering text. If you need a sign or logo, explicitly name it in the prompt (e.g., "a sign that reads 'NEON BAR'").
- **Avoid Over-Prompting:** Don't crowd the prompt with too many "low quality" negative tokens; the Pro model is highly capable and often produces better results with focused, descriptive language.

## Parameter tuning guide
- **CFG Scale (0.5):** This is the sweet spot. Moving toward 1.0 makes the model extremely literal but can introduce artifacts. Moving toward 0.0 makes the motion more fluid but might drift from your specific visual requirements.
- **Duration:** 5-10 seconds is the optimal range for motion consistency. 15-second clips are possible but have a slightly higher risk of "temporal drift" where characters or objects morph toward the end.
- **Multi-Shot:** If using `customize`, ensure the sum of durations in your `multi_prompt` exactly matches the total `duration` parameter.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (Text)
  - `Duration` (Integer/Dropdown)
  - `Aspect Ratio` (Dropdown)
  - `Generate Audio` (Boolean)
  - `Negative Prompt` (Text)
- **Outputs:**
  - `Video URL` (URL)
  - `Audio Status` (Boolean/String)
- **Chain-friendly with:**
  - **[Flux.1 Pro](https://fal.ai/models/fal-ai/flux-pro/v1.1):** Generate a perfect reference image first, then use Kling's Image-to-Video mode (separate endpoint).
  - **[ElevenLabs](https://fal.ai/models/fal-ai/elevenlabs/text-to-speech):** While Kling has native audio, ElevenLabs can provide more specific character voices to be paired in a post-processing node.

## Notes & gotchas
- **Regional Locking:** The official Kuaishou API can be region-locked or require Chinese payment methods; using the FAL.ai endpoint is the recommended way for international developers to bypass these hurdles.
- **Safety Filter:** Kling has one of the strictest safety filters in the industry; avoid any prompts that could be construed as political, suggestive, or violent, as the task will fail and credits may still be consumed (depending on the provider's policy).
- **Processing Time:** Pro v3 tasks are computationally heavy and can take 2-5 minutes to complete depending on queue depth.

## Sources
- [FAL.ai Kling v3 Pro Docs](https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video/api)
- [Official Kling AI Developer Portal](https://kling.ai/document-api/apiReference/model/textToVideo)
- [Kling 3.0 Technical Overview (Higgsfield)](https://higgsfield.ai/kling-3.0)
- [API Pricing Comparisons (EvoLink)](https://evolink.ai/blog/kling-3-o3-api-official-discount-pricing-developers)
