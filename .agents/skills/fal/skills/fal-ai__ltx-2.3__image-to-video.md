---
name: fal-ai/ltx-2.3/image-to-video
display_name: LTX-2.3: Image-to-Video AI Generator
category: image-to-video
creator: Lightricks
fal_docs: [FAL.ai LTX-2.3 Image-to-Video](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video)
original_source: [LTX.io](https://ltx.io/model), [Lightricks on Hugging Face](https://huggingface.co/Lightricks)
summary: A 22B parameter Diffusion Transformer (DiT) model by Lightricks that generates high-fidelity 1080p-4K video with synchronized native audio from a single image and prompt.
---

# LTX-2.3: Image-to-Video AI Generator

## Overview
- **Slug:** `fal-ai/ltx-2.3/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [Lightricks](https://ltx.io/model)
- **Best for:** High-fidelity cinematic video generation with synchronized native audio and precise motion control.
- **FAL docs:** [fal.ai/models/fal-ai/ltx-2.3/image-to-video](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video)
- **Original source:** [LTX.io Model Page](https://ltx.io/model)

## What it does
LTX-2.3 is a state-of-the-art 22-billion parameter Diffusion Transformer (DiT) model designed for high-quality video synthesis. It excels at transforming static images into cinematic sequences with remarkable temporal consistency, sharp visual details (via a new VAE architecture), and synchronized native audio generated in a single pass ([Lightricks Blog](https://huggingface.co/blog/azhan77168/ltx-2-3)). The model supports multiple resolutions up to 4K and native portrait ratios, making it suitable for both professional production and social media content.

## When to use this model
- **Use when:** You need high-resolution (1080p+) video from a specific starting frame, require synchronized background sound effects/ambience, or need precise control over the camera motion and subject consistency.
- **Don't use when:** You need extremely long-form content (>20s) in a single shot or if you require perfect lip-sync accuracy (which is noted as a relative weakness compared to specialized lip-sync models) ([AI FILMS Studio](https://studio.aifilms.ai/blog/ltx-2-3-open-source-model)).
- **Alternatives:**
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Higher motion range but often lacks native audio.
    - **[Veo 3.1](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video):** Better for complex first-to-last frame transitions.
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Strong alternative for realistic human movement.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ltx-2.3/image-to-video` (Sync) / `https://queue.fal.run/fal-ai/ltx-2.3/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (Required) | URL / Base64 | The URL of the start image to use for the generated video. |
| `end_image_url` | string | null | URL / Base64 | The URL of the end image for transition videos. |
| `prompt` | string | (Required) | Text | Description of the desired motion, atmosphere, and sound. |
| `duration` | enum | `6` | `6, 8, 10` | The duration of the video in seconds (Standard model). |
| `resolution` | enum | `1080p` | `1080p, 1440p, 2160p` | The output resolution. |
| `aspect_ratio` | enum | `auto` | `auto, 16:9, 9:16` | If 'auto', determined by input image. |
| `fps` | enum | `25` | `24, 25, 48, 50` | Frames per second. |
| `generate_audio` | boolean | `true` | `true, false` | Whether to generate synchronized audio. |

*Note: The "Fast" variant (`fal-ai/ltx-2.3/image-to-video/fast`) supports durations up to 20 seconds at 1080p/25fps ([FAL Docs](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/fast)).*

### Output
The API returns a JSON object containing a `video` field of type `VideoFile`:
- `url`: Publicly accessible download URL.
- `content_type`: Mime type (typically `video/mp4`).
- `file_size`: Size in bytes.
- `width` / `height`: Dimensions in pixels.
- `duration`: Actual duration in seconds.
- `num_frames`: Total frame count.

### Example request
```json
{
  "image_url": "https://example.com/start_frame.jpg",
  "prompt": "Cinematic tracking shot following the runner, sound of heavy breathing and rhythmic footsteps on gravel, sun flare hitting the lens.",
  "duration": 10,
  "resolution": "1080p",
  "generate_audio": true
}
```

### Pricing
Pricing is pay-per-second based on resolution ([FAL Pricing](https://fal.ai/ltx-2.3)):
- **1080p:** $0.06 / second
- **1440p:** $0.12 / second
- **2160p (4K):** $0.24 / second
- **Fast Variant:** Starts at $0.04 / second for 1080p.

## API — via Original Source (BYO-key direct)
Lightricks provides an open-source codebase and **LTX Desktop** for local execution. They do not currently offer a centralized "Lightricks Cloud API" with a separate key system like OpenAI; however, the model is available on multiple cloud providers (FAL, Runware, Hugging Face Inference Endpoints).

- **FAL.ai** is the primary recommended API surface for production workflows.
- **Local/Self-hosted:** Users can run the model on their own hardware (32GB+ VRAM recommended for full BF16) using the official [GitHub repository](https://github.com/Lightricks/LTX-Video).

## Prompting best practices
- **Multimodal Prompting:** Since LTX-2.3 generates audio and video simultaneously, include auditory keywords (e.g., "cracking thunder," "soft piano music," "city traffic hum") to guide the sound generation.
- **Motion Keywords:** Use cinematic terminology like "tracking shot," "slow zoom," "pan left," or "dynamic motion" to leverage the DiT's spatial-temporal understanding.
- **Fidelity to Image:** If the motion feels too erratic, simplify the prompt to focus on the environment rather than adding too many new objects ([MaxVideoAI](https://maxvideoai.com/models/ltx-2-3-fast)).
- **Avoiding Hallucinations:** When generating non-English content, avoid prompts that might trigger the "visual subtitle" hallucination bug (where the model tries to paint text on screen) ([YouTube Review](https://www.youtube.com/watch?v=xEUpj51e2A8)).
- **Example Good Prompt:** "A drone descent through the open oculus of a derelict radio telescope dish, spiraling down towards the mossy floor, low wind whistle and mechanical echoes."

## Parameter tuning guide
- **Resolution:** Stick to **1080p** for the best balance of stability and cost. 4K is impressive but more sensitive to prompt-induced distortions.
- **FPS:** **25 FPS** is the standard for web/social media. Use **48/50 FPS** only when you intend to do post-production slow-motion.
- **Duration:** 6-8 seconds is the "sweet spot" for temporal consistency. At 10 seconds or higher, you may encounter "end-frame collapse" where the video logic begins to degrade ([YouTube Review](https://www.youtube.com/watch?v=xEUpj51e2A8)).
- **Guidance Scale (Local/Advanced):** If accessible via custom workflows, a scale of **1.0** is typically used for the distilled 8-step model, while the full dev model performs better at **3.0-5.0**.

## Node inputs/outputs
- **Inputs:**
    - `Start Image` (Image URL)
    - `Prompt` (String)
    - `Duration` (Dropdown)
    - `Resolution` (Dropdown)
    - `Enable Audio` (Boolean)
- **Outputs:**
    - `Video URL` (URL)
    - `Thumbnail` (Image URL)
    - `Metadata` (JSON)
- **Chain-friendly with:**
    - **Flux-1.1 [pro]:** To generate the high-quality starting `image_url`.
    - **ElevenLabs:** If you need more complex, multi-track audio/voiceover beyond the native environmental sound.
    - **Upscaler Nodes:** For pushing 1080p outputs to high-fidelity 4K post-generation.

## Notes & gotchas
- **Divisibility:** Internally, resolution inputs must be divisible by 32 ([AI FILMS Studio](https://studio.aifilms.ai/blog/ltx-2-3-open-source-model)).
- **Safety:** Content is filtered based on standard safety guidelines; explicit or harmful content generation will return an error or a blacked-out frame.
- **Webhooks:** Supports `webhookUrl` in queue mode for asynchronous workflow integration.

## Sources
- [FAL.ai LTX-2.3 Documentation](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video)
- [Lightricks LTX-2.3 Technical Post (Hugging Face)](https://huggingface.co/blog/azhan77168/ltx-2-3)
- [Lightricks Official Site](https://ltx.io/model)
- [LTX-2.3 Community Review (YouTube)](https://www.youtube.com/watch?v=xEUpj51e2A8)
- [Runware LTX-2.3 Specs](https://runware.ai/docs/models/lightricks-ltx-2-3)
