---
name: fal-ai/kling-video/v2.6/pro/image-to-video
display_name: Kling 2.6 Pro Image-to-Video
category: image-to-video
creator: Kuaishou
fal_docs: https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video
original_source: https://kling.ai/
summary: Professional-grade image-to-video model with 1080p cinematic visuals, physics-aware motion, and native synchronized audio generation.
---

# Kling 2.6 Pro Image-to-Video

## Overview
- **Slug:** `fal-ai/kling-video/v2.6/pro/image-to-video`
- **Category:** image-to-video
- **Creator:** [Kuaishou](https://kling.ai/)
- **Best for:** High-fidelity cinematic animation of static images with perfectly synchronized native audio.
- **FAL docs:** [fal-ai/kling-video/v2.6/pro/image-to-video](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video)
- **Original source:** [Kling AI API Documentation](https://kling.ai/document-api/apiReference/model/imageToVideo)

## What it does
Kling 2.6 Pro is a state-of-the-art image-to-video model that transforms static images into fluid, 1080p cinematic video clips. It excels at maintaining visual consistency from the first frame and supports "end-frame conditioning" to guide how an animation resolves. Its standout feature is **native audio generation**, which synthesizes synchronized sound effects and speech (including lip-sync for characters) directly during the video generation process, eliminating the need for post-production audio alignment.

## When to use this model
- **Use when:** You need professional-grade motion (up to 10 seconds), precise control over the start and end of a scene, or integrated audio/speech that matches character movements perfectly.
- **Don't use when:** You need ultra-fast, low-cost previews (use Kling 2.1 Standard instead) or if you are generating simple animations without the need for audio.
- **Alternatives:** 
    - `fal-ai/kling-video/v2.1/standard/image-to-video`: More cost-effective for high-volume, lower-fidelity tasks.
    - `fal-ai/luma-dream-machine`: Good alternative for creative transitions, though often lacks the native audio precision of Kling 2.6 Pro.
    - `fal-ai/runway-gen3`: Competitive visuals but different prompt sensitivity and motion style.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v2.6/pro/image-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 2500 chars | Describes the motion, camera, and audio intent. Use `<<<voice_1>>>` to reference custom voices. |
| `start_image_url` | string | (Required) | URL | The source image to be animated. Supports jpg, jpeg, png, webp, gif, avif. |
| `duration` | string | `5` | `5`, `10` | Total video length in seconds. |
| `negative_prompt` | string | `""` | Max 2500 chars | Specific elements to exclude from the visual and audio output. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate synchronized sound/speech. Increases cost. |
| `voice_ids` | list<string> | `[]` | [Voice IDs](https://fal.ai/models/fal-ai/kling-video/create-voice) | Optional custom voice IDs for character speech. |
| `end_image_url` | string | `null` | URL | Optional ending frame to guide the animation's resolution. |

### Output
The output returns a JSON object containing a `video` field with file metadata:
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "kling_video.mp4",
    "file_size": 11814817
  }
}
```

### Example request
```json
{
  "prompt": "The character walks slowly towards the camera and says 'Welcome to the future of AI'. Cinematic lighting, 4k.",
  "start_image_url": "https://example.com/start.jpg",
  "duration": "5",
  "generate_audio": true
}
```

### Pricing
Pricing is based on duration and audio features:
- **Video only (audio off):** $0.07 per second ($0.35 for 5s, $0.70 for 10s).
- **Video with native audio:** $0.14 per second ($0.70 for 5s, $1.40 for 10s).
- **Video with audio + voice control:** $0.168 per second ($0.84 for 5s, $1.68 for 10s).

## API — via Original Source (BYO-key direct)
The model is developed by Kuaishou and is available via their [Kling AI API Platform](https://kling.ai/).

- **Endpoint:** `https://api-singapore.klingai.com/v1/videos/image2video`
- **Extra Parameters:** The native API supports **Motion Brush** (via `static_mask` and `dynamic_masks` with coordinate `trajectories`), **Advanced Camera Control** (fine-tuned values for horizontal, vertical, pan, tilt, roll, and zoom), and **Multi-shot** (via `multi_prompt`).
- **Auth method:** Bearer Token (API Key).
- **Link:** [Official Docs](https://kling.ai/document-api/apiReference/model/imageToVideo)

## Prompting best practices
- **Describe the sound:** Since audio is native, include sound descriptions in your prompt. *Example: "A man speaking in a deep gravelly voice while heavy rain patters against the window."*
- **Motion Verbs:** Use strong motion verbs to guide the AI. *Example: "The leaves rustle violently," "The camera pans smoothly to the right."*
- **Character Focus:** If a character is speaking, ensure the `start_image_url` has a clear face. Use `<<<voice_1>>>` tags if you want to use specific cloned or preset voices.
- **Avoid Over-prompting:** Keep the syntax structure simple for better physics adherence.
- **Good Prompt:** "A majestic dragon breathes a slow plume of fire; the sound of roaring flames and crackling heat fills the air. Cinematic 4k, high detail."
- **Bad Prompt:** "Video of a dragon, fire, good sound, 4k." (Too vague for precise motion/audio sync).

## Parameter tuning guide
- **Duration:** Choose `10` for complex narratives or emotional beats; `5` is the sweet spot for social media clips and quick transitions.
- **End Frame Conditioning:** Use `end_image_url` if the clip must resolve in a specific composition (e.g., a logo reveal or a character ending in a specific pose).
- **Negative Prompt:** Use "blur, distort, low quality, sudden jumps" as a standard baseline to improve temporal stability.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Start Image` (Image/URL)
    - `End Image` (Image/URL - Optional)
    - `Duration` (Dropdown: 5, 10)
    - `Audio Enabled` (Boolean)
- **Outputs:**
    - `Video URL` (URL)
    - `Content Type` (String)
- **Chain-friendly with:**
    - `fal-ai/flux/dev`: Generate the high-quality starting frame.
    - `fal-ai/kling-video/v2.6/pro/text-to-video`: Generate complementary clips for a full sequence.
    - `fal-ai/foley-audio`: If you want to replace the native audio with more complex soundscapes.

## Notes & gotchas
- **Aspect Ratio:** The output aspect ratio is determined by the `start_image_url`. Ensure your input image matches your target ratio (16:9, 9:16, or 1:1).
- **Wait Times:** As a "Pro" model, generation can take 2-5 minutes. Always use the **Queue** mode for production apps.
- **Commercial Use:** Commercial use is permitted for results generated via the Pro model.

## Sources
- [FAL.ai Kling 2.6 Pro Documentation](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video/api)
- [Official Kling AI Platform](https://kling.ai/)
- [Kling AI API Technical Reference](https://kling.ai/document-api/apiReference/model/imageToVideo)
- [Eachlabs Kling v2.6 Technical Report](https://www.eachlabs.ai/blog/kling-v2-6-pro-complete-ai-video-guide)
