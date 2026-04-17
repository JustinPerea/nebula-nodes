---
name: fal-ai/veo3.1/image-to-video
display_name: Google Veo 3.1 (Image to Video)
category: image-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3.1/image-to-video
original_source: https://deepmind.google/models/veo/
summary: Google DeepMind's flagship cinematic video generation model, optimized for high-fidelity animation of still images with native audio.
---

# Google Veo 3.1 (Image to Video)

## Overview
- **Slug:** `fal-ai/veo3.1/image-to-video`
- **Category:** image-to-video
- **Creator:** [Google DeepMind](https://deepmind.google/models/veo/)
- **Best for:** High-fidelity, cinematic video generation from a single reference image with synchronized audio.
- **FAL docs:** [https://fal.ai/models/fal-ai/veo3.1/image-to-video](https://fal.ai/models/fal-ai/veo3.1/image-to-video)
- **Original source:** [Google Cloud Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate) / [Gemini API](https://ai.google.dev/gemini-api/docs/video)

## What it does
Veo 3.1 is Google DeepMind's state-of-the-art video generation model, designed to transform static images into dynamic, high-definition video clips up to 8 seconds long. It excels at understanding complex cinematic instructions, physical world logic, and artistic styles. A standout feature is its **native audio generation**, which creates synchronized sound effects and ambiance that match the visual action perfectly.

## When to use this model
- **Use when:** You need professional-grade, broadcast-quality video; you require perfect character/style consistency from a source image; you want a "one-click" solution that includes matching audio.
- **Don't use when:** You need very long-form content (>8s) in a single pass; you are on a tight budget (this is a premium model); you need extreme real-time performance (inference is slower than "fast" or "lite" models).
- **Alternatives:** 
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Better for hyper-realistic human motion but lacks native audio.
    - **[Kling 2.5/3.0](https://fal.ai/models/fal-ai/kling-video):** Stronger at complex physical interactions and longer durations (up to 10s-20s on some platforms).
    - **[Veo 3.1 Fast](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video):** Lower latency and cost, but reduced visual/audio fidelity.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3.1/image-to-video` (Sync) / `https://queue.fal.run/fal-ai/veo3.1/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | Detailed description of the desired animation, action, and style. |
| `image_url` | string | (required) | URL / Base64 | The source image to animate. Supports JPG, PNG, WebP, etc. (Max 8MB). |
| `aspect_ratio` | enum | `auto` | `auto`, `16:9`, `9:16` | The output dimensions. `auto` matches the input image. |
| `duration` | enum | `5s` | `4s`, `6s`, `8s` | Length of the generated video. |
| `resolution` | enum | `720p` | `720p`, `1080p`, `4k` | Output quality. 4K is currently in preview/limited. |
| `negative_prompt`| string | `""` | N/A | Elements to exclude from the generation. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate a synchronized soundtrack. |
| `seed` | integer | random | 0 - 2^32 | Fixed seed for reproducibility. |
| `auto_fix` | boolean | `false` | `true`, `false` | Automatically improves the prompt for better results. |
| `safety_tolerance`| integer | `2` | 1 (strict) - 6 (lenient)| Control level for content moderation filters. |

### Output
The API returns a JSON object containing the video metadata and a hosted URL.
```json
{
  "video": {
    "url": "https://fal-cdn.com/outputs/...",
    "content_type": "video/mp4",
    "file_name": "veo_output.mp4",
    "file_size": 1245890
  }
}
```

### Example request
```json
{
  "input": {
    "prompt": "The camera slowly pans around the subject as they walk through a futuristic neon city. High-energy electronic music, cinematic lighting.",
    "image_url": "https://example.com/character.jpg",
    "duration": "8s",
    "aspect_ratio": "16:9",
    "generate_audio": true
  }
}
```

### Pricing
- **$0.40 per second** of generated video ([FAL Pricing](https://fal.ai/pricing)).
- An 8-second video costs approximately **$3.20**.

## API — via Original Source (BYO-key direct)
Veo 3.1 is available via Google's enterprise platforms.
- **Provider:** [Google Cloud Vertex AI](https://cloud.google.com/vertex-ai) or [Google AI Studio (Gemini API)](https://ai.google.dev/).
- **Model ID:** `veo-3.1-generate-001`
- **Auth Method:** Google Cloud IAM Service Account or Gemini API Key.
- **Native-only features:** 
    - `referenceImages`: Use up to 3 images for character/asset consistency.
    - `lastFrame`: Specify both start and end frames for precise interpolation.
    - `video` (extension): Pass a previous video to extend its duration.

## Prompting best practices
- **Be Action-Oriented:** Start with the motion. Use verbs like "swirling," "gliding," "exploding," or "gently swaying."
- **Cinematic Language:** Include camera directions like "Low angle shot," "Tracking shot," or "Dolly zoom" for professional results.
- **Audio Context:** Since it generates audio, describe the soundscape: "crunching gravel," "distant thunder," or "a soft jazz melody in the background."
- **Failure Mode (Static Images):** If the video doesn't move enough, use words like "dynamic motion" or "major transformation."
- **Good Prompt:** "A cinematic tracking shot of a dragon breathing fire onto a frozen lake. The ice cracks and steam rises. Deep, rumbling sound effects of fire and cracking ice."
- **Bad Prompt:** "Dragon fire lake video."

## Parameter tuning guide
- **`safety_tolerance`:** If your request is being blocked but is benign (e.g., stylized fantasy violence), increase this to 4 or 5.
- **`auto_fix`:** Enable this if you are getting poor results; Google's internal LLM will rewrite your prompt to align better with the model's training.
- **`duration`:** Always default to `8s` for narrative work, as it gives the physics engine more time to establish realistic motion.

## Node inputs/outputs
- **Inputs:**
    - `Image URL` (Image input)
    - `Prompt` (String)
    - `Negative Prompt` (String)
    - `Duration` (Dropdown)
- **Outputs:**
    - `Video URL` (Video output)
    - `Audio URL` (Usually embedded in the MP4, but can be extracted)
- **Chain-friendly with:**
    - **[Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** Generate the perfect high-quality starting image first.
    - **[Remove Background](https://fal.ai/models/fal-ai/bria/background-removal):** Clean up the source image before animating.

## Notes & gotchas
- **Safety Filters:** Google is very strict. Prompts containing celebrities, copyrighted characters, or sensitive political content will often trigger a "content policy" error. Use `auto_fix` to bypass minor violations.
- **C2PA:** Generated videos include metadata (Content Credentials) indicating they are AI-generated, which is mandatory for Google models.

## Sources
- [FAL.ai Veo 3.1 Docs](https://fal.ai/models/fal-ai/veo3.1/image-to-video/api)
- [Google DeepMind Veo Model Page](https://deepmind.google/models/veo/)
- [Google Cloud Vertex AI Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate)
- [Gemini API Video Documentation](https://ai.google.dev/gemini-api/docs/video)