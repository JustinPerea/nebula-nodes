---
name: fal-ai/wan/v2.7/text-to-video
display_name: Wan v2.7 Text to Video
category: text-to-video
creator: Alibaba (Tongyi Lab)
fal_docs: https://fal.ai/models/fal-ai/wan/v2.7/text-to-video
original_source: https://wan.video/, https://github.com/Wan-Video
summary: Alibaba's 27B parameter MoE model for cinematic 1080p video generation with optional audio synchronization and thinking-mode prompt logic.
---

# Wan v2.7 Text to Video

## Overview
- **Slug:** `fal-ai/wan/v2.7/text-to-video`
- **Category:** Text-to-Video
- **Creator:** Alibaba (Tongyi Lab)
- **Best for:** Cinematic 1080p video generation with complex motion, realistic characters, and synchronized audio.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/wan/v2.7/text-to-video)
- **Original source:** [Official Site](https://wan.video/), [GitHub](https://github.com/Wan-Video)

## What it does
Wan 2.7 is Alibaba's flagship 27B parameter Mixture-of-Experts (MoE) video generation model. It produces high-fidelity videos up to 1080p resolution with a maximum duration of 15 seconds. The model is distinguished by its "Thinking Mode," which reasons about composition and spatial relationships before generation, resulting in superior prompt adherence and realistic motion dynamics. It supports native audio generation or synchronization with user-provided audio files.

## When to use this model
- **Use when:** You need high-resolution (1080p) cinematic video, realistic human character consistency, or complex motion that requires understanding of spatial logic.
- **Don't use when:** You need extremely fast generation (under 20 seconds) or simple animated GIFs where lower-parameter models suffice.
- **Alternatives:** 
  - **Kling 3.0:** Strong competitor for realism and motion but has different aesthetic signatures.
  - **Flux 2 (Video):** Better for specific stylized or hyper-detailed textures.
  - **Seedance 2.0:** Optimized for faster turnaround times on simpler prompts.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/wan/v2.7/text-to-video` (sync) / `https://queue.fal.run/fal-ai/wan/v2.7/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 5000 chars | Text description of the desired video. |
| `audio_url` | string | `null` | URL | URL of driving audio (WAV/MP3). 3-30s, Max 15MB. If omitted, matching background music is auto-generated. |
| `aspect_ratio` | enum | `"16:9"` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | The target aspect ratio of the generated video. |
| `resolution` | enum | `"1080p"` | `720p`, `1080p` | Output video resolution tier. |
| `duration` | enum | `"5"` | `2` to `15` | Video length in seconds. |
| `negative_prompt`| string | `null` | Max 500 chars | Content to avoid in the video. |
| `enable_prompt_expansion` | boolean | `true` | `true`, `false` | Enable intelligent prompt rewriting for more detail. |
| `seed` | integer | (Random) | `0` to `2147483647` | Seed for reproducibility. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Enable content moderation for input and output. |

### Output
Returns a JSON object containing the generated video file details and the configuration used.
```json
{
  "video": {
    "url": "https://v3.fal.media/...",
    "content_type": "video/mp4",
    "file_name": "wan_v2_7_output.mp4",
    "file_size": 4404019
  },
  "seed": 123456789,
  "actual_prompt": "Expanded prompt used by the model..."
}
```

### Example request
```json
{
  "prompt": "Extreme close-up of rich dark chocolate being poured in slow motion over a layered cake.",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "duration": 5,
  "enable_prompt_expansion": true
}
```

### Pricing
- **Cost:** $0.10 per generated second.
- **Example:** A 10-second 1080p video costs $1.00.

## API — via Original Source (BYO-key direct)
The original model is served via **Alibaba Cloud Model Studio (Bailian)**.
- **Endpoint:** `https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/generation`
- **Auth Method:** Bearer Token (API Key)
- **Extra Parameters:** Native Alibaba API supports "Thinking Mode" toggles and more granular control over frame rates not always exposed via proxy providers.
- **Official Docs:** [Alibaba Cloud Bailian Documentation](https://bailian.console.alibabacloud.com/)

## Prompting best practices
- **Be Descriptive:** Use keywords like "cinematic lighting," "shallow depth of field," or "4k texture" to guide the high-parameter model.
- **Leverage Multi-shot:** Use natural language to describe sequences (e.g., "The camera starts on the eyes then zooms out to reveal the city").
- **Style Tokens:** Works exceptionally well with style descriptors like "neofuturistic," "renaissance oil painting," or "hand-drawn animation."
- **Avoid Over-negation:** Instead of long negative prompts, focus on describing what you *want* in positive detail.
- **Good Prompt:** "A majestic lion walking through a neon-lit futuristic city at night, rain falling, puddles reflecting neon signs, 8k, highly detailed, slow motion."
- **Bad Prompt:** "Lion city night rain." (Too vague for a 27B model).

## Parameter tuning guide
- **Duration:** Set to `10-15s` for complex narratives; shorter durations (`2-5s`) are better for simple loops or reaction shots.
- **Prompt Expansion:** Keep `true` for general creative work; turn `false` if you have a highly specific technical prompt that you don't want the AI to modify.
- **Resolution:** Use `1080p` for final renders; `720p` is useful for faster iteration during the brainstorming phase.

## Node inputs/outputs
- **Inputs:** 
  - `Prompt` (Text)
  - `Negative Prompt` (Text)
  - `Audio File/URL` (Optional)
  - `Aspect Ratio` (Dropdown)
  - `Duration` (Slider/Dropdown)
- **Outputs:** 
  - `Video URL` (File)
  - `Expanded Prompt` (Text)
- **Chain-friendly with:** 
  - **Flux 2:** Use Flux to generate a character reference image, then pass to Wan I2V (related model).
  - **ElevenLabs:** Generate voiceover, then use Wan's audio synchronization to drive character lip-sync.

## Notes & gotchas
- **Safety Filters:** The model has a strict content policy; highly controversial or NSFW prompts will be blocked by the safety checker.
- **Cold Starts:** As a heavy 27B parameter model, the first request in a session may have a slight overhead as the model loads into VRAM.
- **Audio Generation:** If you don't provide an `audio_url`, the model will "guess" appropriate sound effects, which can sometimes be hit-or-miss for non-standard scenes.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/wan/v2.7/text-to-video)
- [Wan.video Official Site](https://wan.video/)
- [GitHub: Wan-Video](https://github.com/Wan-Video)
- [Together AI Model Card](https://www.together.ai/models/wan-27)
- [Replicate: Wan 2.7 T2V](https://replicate.com/wan-video/wan-2.7-t2v)
