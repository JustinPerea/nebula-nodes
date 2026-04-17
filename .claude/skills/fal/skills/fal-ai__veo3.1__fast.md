---
name: fal-ai/veo3.1/fast
display_name: Veo 3.1 Fast (Google)
category: text-to-video
creator: Google (DeepMind)
fal_docs: https://fal.ai/models/fal-ai/veo3.1/fast
original_source: https://deepmind.google/models/veo/, https://ai.google.dev/gemini-api/docs/video
summary: A high-performance, cost-effective video generation model by Google featuring native audio synchronization and cinematic control.
---

# Veo 3.1 Fast (Google)

## Overview
- **Slug:** `fal-ai/veo3.1/fast`
- **Category:** Text-to-Video (Fast)
- **Creator:** [Google DeepMind](https://deepmind.google/models/veo/)
- **Best for:** Rapid production-grade video generation with synchronized audio and cinematic precision.
- **FAL docs:** [fal-ai/veo3.1/fast](https://fal.ai/models/fal-ai/veo3.1/fast)
- **Original source:** [Google AI Studio / Gemini API](https://ai.google.dev/gemini-api/docs/video)

## What it does
Veo 3.1 Fast is an optimized version of Google’s state-of-the-art video generation model, designed to deliver high-fidelity video content significantly faster than the standard version. It excels at maintaining visual consistency, adhering to complex cinematic instructions, and generating rich, native audio—including ambient soundscapes and synchronized dialogue—directly from text prompts. While "Fast" prioritizes speed, it still supports professional resolutions up to 4K and maintains Google's industry-leading motion physics.

## When to use this model
- **Use when:** You need high-quality video for standard production workflows, rapid prototyping, or social media content where speed and cost-efficiency are critical without sacrificing the "cinematic" look.
- **Don't use when:** You require the absolute peak visual fidelity for final high-end production (use the standard [Veo 3.1](https://fal.ai/models/fal-ai/veo3.1) instead) or when you need more than 8 seconds in a single pass without chaining extensions.
- **Alternatives:**
    - **[Veo 3.1 (Standard)](https://fal.ai/models/fal-ai/veo3.1):** Higher visual fidelity but slower and more expensive.
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard):** Excellent for hyper-realistic human motion and complex physics.
    - **[Seedance 2.0](https://fal.ai/models/bytedance/seedance-2.0/fast):** High performance for creative effects and stylized visuals.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3.1/fast` (sync) / `https://queue.fal.run/fal-ai/veo3.1/fast` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | The text description of the video. Supports audio cues like "A man murmurs..." |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16` | Aspect ratio of the generated video. |
| `duration` | enum | `8s` | `4s`, `6s`, `8s` | The duration of the generated video clip. |
| `negative_prompt` | string | `""` | N/A | Guide the generation away from unwanted elements or styles. |
| `resolution` | enum | `720p` | `720p`, `1080p`, `4k` | Output resolution (4K is currently in preview). |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate context-aware synchronized audio. |
| `seed` | integer | Random | N/A | Seed for reproducible generations. |
| `auto_fix` | boolean | `true` | `true`, `false` | Automatically attempt to fix prompts that might trigger safety filters. |
| `safety_tolerance` | enum | `2` | `1` to `6` | Content moderation strictness (1 = most strict, 6 = least). |

### Output
The output is a JSON object containing a `video` file object:
```json
{
  "video": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "veo_fast_output.mp4",
    "file_size": 5242880
  }
}
```

### Example request
```json
{
  "input": {
    "prompt": "A cinematic wide shot of a futuristic Tokyo street under neon rain. A cybernetic cat walks across the puddle, its paws making distinct splashing sounds. High-fidelity audio of rain and distant city hum.",
    "aspect_ratio": "16:9",
    "duration": "8s",
    "resolution": "1080p",
    "generate_audio": true
  }
}
```

### Pricing
Pricing is billed per second of generated video:
- **720p / 1080p:** $0.10/sec (no audio) or **$0.15/sec (with audio)**.
- **4k:** $0.30/sec (no audio) or **$0.35/sec (with audio)**.

## API — via Original Source (BYO-key direct)
The model is natively available through Google's developer platforms:
- **Endpoint (Gemini API):** `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning`
- **Endpoint (Vertex AI):** `veo-3.1-fast-generate-001`
- **Auth Method:** API Key (Gemini) / OAuth2 (Vertex AI).
- **Native Capabilities (Not all on FAL yet):**
    - **Reference Images:** Support for up to 3 reference images to maintain character or scene consistency.
    - **Scene Extension:** Capability to extend videos beyond 8 seconds by using the final frame of a previous clip as a starting point.
    - **First/Last Frame:** Specify both a starting and ending image to interpolate a transition.
- **Documentation:** [Google AI Studio Video Docs](https://ai.google.dev/gemini-api/docs/video)

## Prompting best practices
- **The "Cinematic Formula":** Structure prompts as `[Subject] + [Action] + [Context/Setting] + [Style/Lighting] + [Camera Motion]`. 
    - *Example:* "A majestic eagle (subject) diving into a crystal lake (action) in the Swiss Alps at sunrise (context). Shot on 35mm film with warm golden lighting (style) and a slow-motion tracking shot (camera)."
- **Audio Cues:** Incorporate specific sounds into the prompt. Use keywords like "ambient city hum," "crunching leaves," or dialogue tags like "The woman whispers, 'Look at that'."
- **Avoid Over-prompting:** While descriptive, don't use contradictory style tokens (e.g., "hyper-realistic cartoon"). Pick a clear aesthetic and stick to it.
- **Failure Mode:** If the video feels static, add strong motion verbs like "spiraling," "accelerating," or "cascading."

## Parameter tuning guide
- **Resolution (720p vs 4K):** Use 720p for rapid testing and storyboarding. Switch to 4K only for final assets, as it significantly increases cost and generation time.
- **Safety Tolerance:** Level 2 is the standard default. If your prompt is being blocked for harmless reasons (e.g., a "bloody steak" in a cooking video), try raising this to 4 or 5, but remain compliant with content policies.
- **Seed Consistency:** To iterate on a specific composition, lock the `seed`. Once the motion is right, you can adjust the `prompt` slightly while keeping the seed to refine details.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Negative Prompt` (Text)
    - `Resolution` (Select)
    - `Aspect Ratio` (Select)
    - `Duration` (Select)
    - `Seed` (Number)
- **Outputs:**
    - `Video URL` (URL)
    - `Video File` (Binary/File)
- **Chain-friendly with:**
    - **[Nano Banana Pro](https://fal.ai/models/fal-ai/nano-banana-pro):** Use to generate a high-quality initial frame to guide the video.
    - **[Flux 1.1 Pro](https://fal.ai/models/fal-ai/flux/1.1-pro):** Generate character reference sheets for cross-scene consistency.

## Notes & gotchas
- **Safety Policy:** Google's safety filters are strict. Prompts containing public figures, violence, or sensitive content may be "auto-fixed" or rejected.
- **Watermarking:** All videos generated via Veo include [SynthID](https://deepmind.google/technologies/synthid/), an invisible digital watermark to identify AI-generated content.
- **Queue Mode Recommended:** Video generation is a long-running process (often 30s–2mins); always use the `queue` or `subscribe` method in production to avoid timeouts.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/veo3.1/fast)
- [Google DeepMind Official Veo Site](https://deepmind.google/models/veo/)
- [Google AI Studio Documentation](https://ai.google.dev/gemini-api/docs/video)
- [Google Cloud Blog: Veo 3.1 Launch](https://cloud.google.com/blog/products/ai-machine-learning/veo-3-1-lite-and-a-new-veo-upscaling-capability-on-vertex-ai)