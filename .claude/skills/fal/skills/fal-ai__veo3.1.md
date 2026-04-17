---
name: fal-ai/veo3.1
display_name: Google Veo 3.1 (via FAL.ai)
category: text-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3.1
original_source: https://deepmind.google/models/veo/
summary: Google's flagship generative video model featuring native high-fidelity audio, cinematic control, and multi-modal animation capabilities.
---

# Google Veo 3.1 (fal-ai/veo3.1)

## Overview
- **Slug:** `fal-ai/veo3.1`
- **Category:** Video Generation (Text-to-Video, Image-to-Video)
- **Creator:** [Google DeepMind](https://deepmind.google/models/veo/)
- **Best for:** Cinematic video production with high-fidelity synchronized audio and multi-person dialogue.
- **FAL docs:** [fal.ai/models/fal-ai/veo3.1](https://fal.ai/models/fal-ai/veo3.1)
- **Original source:** [Google Vertex AI Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo)

## What it does
Veo 3.1 is Google's most advanced video generation model, designed to transform text or image inputs into high-quality 720p, 1080p, or 4K video clips. It features a unique architecture that jointly models spatio-temporal video latents and temporal audio latents, allowing it to generate perfectly synchronized sound effects, ambient scores, and multi-person dialogue directly from the text prompt. It excels at cinematic realism, complex camera movements, and maintaining character consistency when provided with reference images.

## When to use this model
- **Use when:** You need high-quality cinematic footage (especially for TikTok/Reels in 9:16), realistic synchronized audio/speech, or precise "First and Last Frame" transitions for product reveals.
- **Don't use when:** You need videos longer than 8 seconds in a single shot, or when your scene requires extremely intricate hand gestures or complex fluid dynamics (e.g., precise pouring of water), as these can still exhibit artifacts.
- **Alternatives:** 
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Often preferred for slightly higher "raw" photorealism in human movements, though audio is less integrated.
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Better for fast, high-action sequences but may lack the cinematic "directorial" control of Veo 3.1.
    - **[Sora 2](https://fal.ai/models/fal-ai/sora):** Stronger physics engine but often has higher latency and stricter prompt adherence requirements.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3.1` (Sync) / `https://queue.fal.run/fal-ai/veo3.1` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | Descriptive text for the video, including audio/dialogue cues. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `auto` | Vertical (portrait) or Horizontal (landscape) video. |
| `duration` | enum | `8s` | `4s`, `6s`, `8s` | Length of the generated clip. |
| `resolution` | enum | `1080p` | `720p`, `1080p`, `4k` | Output video resolution. |
| `image_url` | string | `null` | - | Input image for Image-to-Video animation. |
| `negative_prompt`| string | `null` | - | Elements to exclude (e.g., "blur, low quality, subtitles"). |
| `generate_audio` | boolean | `true` | - | Whether to synthesize synchronized sound/voice. |
| `seed` | integer | (Random) | - | Fixed seed for reproducible generations. |
| `auto_fix` | boolean | `true` | - | Automatically rewrites prompts for better compliance and quality. |
| `safety_tolerance`| integer | `4` | `1` (strict) to `6` (relaxed) | Content moderation sensitivity (API only). |

### Output
The API returns a JSON object containing a `video` object:
```json
{
  "video": {
    "url": "https://storage.fal.run/model_outputs/...",
    "content_type": "video/mp4",
    "file_name": "veo3.1_output.mp4",
    "file_size": 12458900
  }
}
```

### Example request
```json
{
  "input": {
    "prompt": "Cinematic wide shot, a futuristic neon-lit city in the rain. A woman in a transparent raincoat walks slowly toward the camera. SFX: Gentle rain patter, distant hover-car hum. Audio: She whispers, 'The city never sleeps.'",
    "aspect_ratio": "16:9",
    "duration": "8s",
    "resolution": "1080p",
    "generate_audio": true
  }
}
```

### Pricing
Billed per second of generated video:
- **720p/1080p (No Audio):** $0.20/second ($1.60 per 8s clip)
- **720p/1080p (With Audio):** $0.40/second ($3.20 per 8s clip)
- **4K (No Audio):** $0.40/second
- **4K (With Audio):** $0.60/second

## API — via Original Source (BYO-key direct)
Google offers Veo 3.1 directly through **Google Cloud Vertex AI** and **Google AI Studio (Gemini API)**.
- **Model ID:** `veo-3.1-generate-001`
- **Auth:** OAuth 2.0 or API Key (via Google Cloud project).
- **Extra Parameters:** Native Google APIs support **SynthID Watermarking**, **Reference Asset Images** (for character locking), and **Scene Extension** (chaining clips).
- **Docs:** [Google Vertex AI Video Generation](https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo)

## Prompting best practices
- **The "Directorial" Formula:** Structure your prompt as: `[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance] + [Audio Cues]`.
- **Specify Sound Explicitly:** Use keywords like `SFX: [sound]` or `Ambient noise: [sound]` to guide the audio engine. For dialogue, use quotation marks: `The man says, "Hello there."`.
- **Character Locking:** Front-load the subject description at the very beginning of the prompt to avoid "character drift" between frames.
- **Negative Prompting:** Use the negative prompt to explicitly block "subtitles, captions, watermark" if you notice unwanted text generation.
- **Example Good Prompt:** `Dolly zoom, close-up: A weathered clockmaker with brass spectacles peering into a mechanical watch. Tiny sparks fly as he adjusts a gear. Dimly lit workshop, dust motes dancing in shafts of sunlight. SFX: The rhythmic ticking of hundreds of clocks, the metallic scrape of a small tool.`

## Parameter tuning guide
- **Duration (8s):** Always start with 8s for final production; use 4s or 6s for "drafts" to save on costs, as physics and lighting remain consistent across durations.
- **Safety Tolerance:** If your prompt is being blocked for "cinematic violence" or medical realism, increasing this to `5` or `6` can bypass false positives (requires partner/commercial tier).
- **Auto Fix:** Leave this `true` for general use, but turn it `false` if you are a professional prompt engineer wanting exact adherence to complex technical keywords.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Textual scene description.
    - `Image URL`: Starting frame or reference asset.
    - `Negative Prompt`: Exclusion list.
    - `Duration/Resolution/Aspect Ratio`: Format settings.
- **Outputs:**
    - `Video URL`: Direct link to the hosted MP4 file.
- **Chain-friendly with:**
    - **[Flux Kontext Pro](https://fal.ai/models/fal-ai/flux-kontext-pro):** Generate a starting image with specific characters, then feed it into Veo 3.1 Image-to-Video.
    - **[ElevenLabs](https://fal.ai/models/fal-ai/elevenlabs):** Use for even more professional voice-overs if the native Veo audio is not precise enough for your specific language/accent.

## Notes & gotchas
- **U.S. Restriction:** Some direct Google API features are region-locked to the U.S., but FAL.ai provides a global proxy to these models.
- **Subtitles:** The model occasionally generates garbled text if you describe signs or posters; use negative prompts to mitigate this.
- **Hand Physics:** Despite being "state-of-the-art," fast hand movements (piano playing, typing) may still show finger glitches.

## Sources
- [FAL.ai Veo 3.1 Documentation](https://fal.ai/models/fal-ai/veo3.1/api)
- [Google DeepMind Veo Model Page](https://deepmind.google/models/veo/)
- [Google Cloud Vertex AI Reference](https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate)
- [ArXiv: Process-aware Evaluation for Generative Video Reasoning (2025)](https://arxiv.org/html/2512.24952v2)