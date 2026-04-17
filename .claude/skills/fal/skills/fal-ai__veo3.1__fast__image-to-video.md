---
name: fal-ai/veo3.1/fast/image-to-video
display_name: Veo 3.1 Fast | Image to Video
category: image-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video
original_source: https://ai.google.dev/gemini-api/docs/models/veo-3.1-generate-preview
summary: Google's premier video generation model on FAL.ai, featuring native audio, 4K support, and cinematic narrative control.
---

# Veo 3.1 Fast | Image to Video

## Overview
- **Slug:** `fal-ai/veo3.1/fast/image-to-video`
- **Category:** image-to-video
- **Creator:** [Google DeepMind](https://deepmind.google/models/veo/)
- **Best for:** Professional-grade video generation with synced audio, cinematic control, and high resolution (up to 4K).
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)
- **Original source:** [Google Gemini API Docs](https://ai.google.dev/gemini-api/docs/video)

## What it does
Veo 3.1 Fast is Google's state-of-the-art cinematic engine designed for high-end creative storytelling and experimental video production ([Google DeepMind](https://deepmind.google/models/veo/)). It excels at turning a single input image into a high-fidelity video clip up to 8 seconds long, featuring natively synchronized audio (dialogue, sound effects, and ambiance). The "Fast" variant is optimized for speed and cost-efficiency while maintaining significantly higher prompt adherence and visual quality compared to previous generations ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).

## When to use this model
- **Use when:** You need high-fidelity output with 4K support, requires realistic human movement, or want natively generated audio that matches the scene's action ([Google Developers Blog](https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/)).
- **Don't use when:** You need a low-cost "sketch" for rapid iteration (use a "Lite" model or Nano Banana), or when you need more than 8 seconds in a single generation without chaining.
- **Alternatives:** 
    - **[Kling 3.0 Standard](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Excellent for long-form (10s+) motion and complex physics.
    - **[Wan 2.5](https://fal.ai/models/fal-ai/wan-25-preview/text-to-video):** A high-performance open-weight alternative often priced lower per second.
    - **[Flux 2 Flex](https://fal.ai/models/fal-ai/flux-2-flex):** Better for hyper-specific stylized image-to-video if coming from a Flux image source.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3.1/fast/image-to-video` (sync) / `https://queue.fal.run/fal-ai/veo3.1/fast/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | **Required** | N/A | Description of how the image should be animated. Supports audio cues like dialogue in quotes ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)). |
| `image_url` | string | **Required** | N/A | URL of the input image to animate. Supports JPG, PNG, WEBP, GIF, AVIF ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `aspect_ratio` | enum | `auto` | `auto`, `16:9`, `9:16` | The aspect ratio of the generated video ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `duration` | enum | `auto` | `4s`, `6s`, `8s` | Length of the generated video. 8s is standard for 1080p/4k ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `negative_prompt` | string | `""` | N/A | Guide the generation by describing what to avoid. |
| `resolution` | enum | `auto` | `720p`, `1080p`, `4k` | Output resolution ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate a natively synced audio track ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `seed` | integer | Random | N/A | For reproducibility (though not strictly deterministic) ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)). |
| `auto_fix` | boolean | `true` | `true`, `false` | Attempts to fix prompts that fail content policy filters ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |
| `safety_tolerance` | integer | `2` | `1` (strict) to `6` | API-only setting for content moderation levels ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)). |

### Output
The API returns a JSON object containing a `video` file object:
```json
{
  "video": {
    "url": "https://fal.run/output/video.mp4",
    "content_type": "video/mp4",
    "file_name": "veo31_fast.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "A cinematic shot of a calico kitten sleeping in the sunshine, slowly waking up and yawning. The camera zooms in. SFX: Gentle purring, birds chirping in the background.",
  "image_url": "https://storage.googleapis.com/falserverless/example_inputs/veo31_i2v.jpg",
  "resolution": "1080p",
  "duration": "8s"
}
```

### Pricing
FAL.ai bills per generated second:
- **720p / 1080p (Audio On):** ~$0.15 per second ([FAL.ai Pricing](https://fal.ai/pricing)).
- **720p / 1080p (Audio Off):** ~$0.10 per second ([FAL.ai Pricing](https://fal.ai/pricing)).
- **4K Resolution:** ~$0.30 per second ([FAL.ai Pricing](https://fal.ai/pricing)).

## API — via Original Source (BYO-key direct)
The model is natively available via the **Google Gemini API** (Google AI Studio / Vertex AI).
- **Endpoints:** `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning`
- **Extra Features:** The native API supports **multi-image referencing** ("Ingredients to Video") where you can provide up to 3 images to control character, object, and style consistency ([Google Developers Blog](https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/)). It also supports **first and last frame interpolation** and **video extension** up to 141 seconds ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).
- **Auth:** `x-goog-api-key` header.
- **Official Docs:** [Google Gemini API Video Generation](https://ai.google.dev/gemini-api/docs/video)

## Prompting best practices
- **The "Five Pillars" Structure:** Subject, Action, Style, Camera, and Ambiance ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).
- **Audio Keywords:** Use explicit SFX cues like `SFX: tires screeching` or `Ambient: a faint eerie hum` to get the best from the native audio engine.
- **Quotes for Dialogue:** If you want characters to speak, put their lines in quotes: `The woman murmurs, "This must be it."`.
- **Motion Adjectives:** Use specific cinematic terms: `dolly shot`, `aerial pan`, `rack focus`, `high-shutter speed` ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).
- **Failure Mode:** Vague prompts like "make it move" lead to static results. Always specify the *type* of movement.

## Parameter tuning guide
- **Resolution (1080p vs 4K):** 4K provides stunning detail for production but significantly increases latency and cost ($0.30/s vs $0.15/s). Use 1080p for testing.
- **Duration:** 8 seconds allows for more complex "story beats" and is generally the sweet spot for the model's temporal consistency ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).
- **Safety Tolerance:** If your prompt involves cinematic horror or action, you may need to increase the `safety_tolerance` to prevent false-positive blocks, but use with caution ([FAL.ai Docs](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `image` (File/URL): The source frame.
    - `prompt` (String): The animation instruction.
    - `resolution` (Enum): Quality tier.
    - `audio_toggle` (Boolean): Enable/disable sound.
- **Outputs:**
    - `video` (File/URL): The generated MP4.
    - `log` (String): Generation details.
- **Chain-friendly with:**
    - **[Flux 1.1 Pro](https://fal.ai/models/fal-ai/flux/pro):** Generate a high-quality initial frame, then pass to Veo.
    - **[JoyCaption](https://fal.ai/models/fal-ai/joycaption):** Use to describe an existing image before passing it to Veo's prompt input for better context.

## Notes & gotchas
- **Regional Restrictions:** The `personGeneration` feature (generating realistic people) has specific restrictions in the EU, UK, and MENA regions ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).
- **SynthID Watermarking:** All Veo videos are invisibly watermarked using Google's SynthID for AI identification ([Google DeepMind](https://deepmind.google/technologies/synthid/)).
- **Latency:** Even the "Fast" model can take 11 seconds to 6 minutes depending on server load ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)).

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)
- [Google Gemini API Video Docs](https://ai.google.dev/gemini-api/docs/video)
- [Google DeepMind Veo Page](https://deepmind.google/models/veo/)
- [Google Developers Technical Blog](https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/)
- [FAL.ai Pricing Table](https://fal.ai/pricing)
