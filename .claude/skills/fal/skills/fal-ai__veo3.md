---
name: fal-ai/veo3
display_name: Google Veo 3
category: text-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3
original_source: https://deepmind.google/models/veo/
summary: Google's flagship video generation model featuring native synchronized audio, cinematic physics, and 1080p resolution.
---

# Google Veo 3

## Overview
- **Slug:** `fal-ai/veo3`
- **Category:** text-to-video
- **Creator:** [Google DeepMind](https://deepmind.google/models/veo/)
- **Best for:** Creating cinematic, high-fidelity video clips with native, synchronized audio and realistic physics.
- **FAL docs:** [fal.ai/models/fal-ai/veo3](https://fal.ai/models/fal-ai/veo3)
- **Original source:** [Google DeepMind Veo Page](https://deepmind.google/models/veo/)

## What it does
Google Veo 3 is an advanced generative video model capable of producing high-quality video clips up to 1080p resolution from text descriptions. Its standout feature is **native audio generation**, allowing it to synthesize synchronized sound effects, ambient noise, and even dialogue directly within the video generation process. It utilizes a diffusion-based architecture to ensure temporal coherence and realistic motion dynamics, such as mass-based acceleration and fluid viscosity.

## When to use this model
- **Use when:** You need professional-grade video content with "one-shot" audio synchronization, cinematic camera movements, or complex prompt adherence.
- **Don't use when:** You need extremely long-form content (beyond 8 seconds) or real-time generation speeds (Standard mode is slower than "Fast" variants).
- **Alternatives:** 
    - [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine): Good for high-energy motion but lacks native audio.
    - [Kling 1.5](https://fal.ai/models/fal-ai/kling-video): Excellent for human anatomy and long durations.
    - [Sora](https://openai.com/sora): Highly competitive in physics, but often less accessible via direct API.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3` (sync) / `https://queue.fal.run/fal-ai/veo3` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | The core text description of the video and audio. |
| `negative_prompt` | string | "" | N/A | Elements to exclude from the generation. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16` | Cinematic landscape or mobile portrait formats. |
| `duration` | enum | `8s` | `4s`, `6s`, `8s` | Length of the generated video clip. |
| `resolution` | enum | `720p` | `720p`, `1080p` | Output quality level. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to include native synchronized sound. |
| `seed` | integer | Random | 0 - 4294967295 | For reproducible generations. |
| `auto_fix` | boolean | `true` | `true`, `false` | Automatically rewrites prompts for better adherence/safety. |
| `safety_tolerance` | enum | `4` | `1, 2, 3, 4, 5, 6` | Level of content moderation (1=strict, 6=permissive). |

### Output
The API returns a JSON object containing the video file details:
```json
{
  "video": {
    "url": "https://v2.fal.media/.../video.mp4",
    "content_type": "video/mp4",
    "file_name": "veo3_gen.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "First-person view soaring low over a medieval battlefield at dawn, gliding past clashing knights in armor, fire-lit arrows whizzing overhead. Ambient sounds of swords striking and distant war cries.",
  "aspect_ratio": "16:9",
  "duration": "8s",
  "resolution": "1080p",
  "generate_audio": true
}
```

### Pricing
FAL.ai bills based on the duration and audio settings:
- **Video with Audio:** $0.40 per second generated.
- **Video Only (No Audio):** $0.20 per second generated.
*(e.g., an 8s video with audio costs $3.20).*

## API — via Original Source (BYO-key direct)
Veo 3 is available natively through **Google Cloud Vertex AI** and **Google AI Studio (Gemini API)**.
- **Endpoint:** `https://us-central1-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/us-central1/publishers/google/models/veo-3.0-generate-001:predict`
- **Native-only Parameters:** Vertex AI supports `image` (Base64/GCS) for image-to-video anchoring and `personGeneration` (allow_adult/allow_all) for granular safety controls.
- **Auth:** OAuth 2.0 via Google Cloud Service Account.
- **Official Docs:** [Vertex AI Veo Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-0-generate)

## Prompting best practices
- **The "Director's Brief" Method:** Structure your prompt with Subject, Context, Action, Style, and Audio.
- **Cinematic Keywords:** Use terms like "dolly zoom," "shallow depth of field," or "handheld camera" to trigger specific camera behaviors.
- **Audio Cues:** Explicitly mention sounds (e.g., "crunching gravel," "heavy rain hitting metal") to take full advantage of native audio.
- **Avoid Vague Terms:** Instead of "cool lighting," use "cinematic lighting with high contrast and warm orange rim light."
- **Example Good Prompt:** "A cinematic tracking shot of a 1960s red convertible driving along a coastal cliff at sunset. High-speed motion blur, realistic engine roar, and seagulls crying in the background. 1080p, photorealistic."

## Parameter tuning guide
- **Duration:** 8s provides the best narrative arc, but 4s is useful for quick transitions or b-roll to save cost.
- **Auto Fix:** Keep this **Enabled** unless you are an expert prompt engineer. The model’s internal rewriter is highly optimized for the model's latent space.
- **Safety Tolerance:** Levels 4-5 are generally safe for creative work; use 1-2 for corporate-restricted environments.
- **Generate Audio:** Always set to `true` unless you plan to add a custom soundtrack, as native sync is difficult to replicate in post-production.

## Node inputs/outputs
- **Inputs:** `prompt` (text), `negative_prompt` (text), `aspect_ratio` (dropdown), `duration` (dropdown), `resolution` (dropdown), `seed` (integer), `generate_audio` (boolean).
- **Outputs:** `video_url` (url).
- **Chain-friendly with:** 
    - `fal-ai/flux-pro/v1.1`: To generate high-quality reference images.
    - `fal-ai/veo3.1/first-last-frame-to-video`: For extending scenes or creating loops.
    - `fal-ai/play-v3`: For adding high-quality narration over the ambient Veo audio.

## Notes & gotchas
- **Regional Restrictions:** Some person-generation features (like children) are blocked in the EU/UK via the native API; FAL applies its own safety layers.
- **Latency:** As a "Standard" quality model, expect 90-120 seconds for an 8s video.
- **FAL vs Source:** FAL currently exposes a subset of parameters (e.g., no direct image-to-video anchor in the basic `veo3` slug as of this documentation).

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/veo3)
- [Google DeepMind Technical Blog](https://deepmind.google/models/veo/)
- [Vertex AI Technical Reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-0-generate)
- [FAL.ai Prompting Guide](https://blog.fal.ai/mastering-video-generation-with-veo-2-a-comprehensive-guide/)