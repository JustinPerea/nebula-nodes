---
name: xai/grok-imagine-video/image-to-video
display_name: Grok Imagine Video (Image to Video)
category: image-to-video
creator: xAI
fal_docs: https://fal.ai/models/xai/grok-imagine-video/image-to-video
original_source: https://docs.x.ai/developers/model-capabilities/video/generation
summary: A high-performance image-to-video model by xAI that generates cinematic 6–15 second clips with native audio and exceptional subject consistency.
---

# Grok Imagine Video (Image to Video)

## Overview
- **Slug:** `xai/grok-imagine-video/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [xAI](https://x.ai/)
- **Best for:** Animating high-quality still images with cinematic motion and native synchronized audio.
- **FAL docs:** [https://fal.ai/models/xai/grok-imagine-video/image-to-video](https://fal.ai/models/xai/grok-imagine-video/image-to-video)
- **Original source:** [xAI Developer Docs](https://docs.x.ai/developers/model-capabilities/video/generation)

## What it does
Grok Imagine Video (Image to Video) is a state-of-the-art generative model that transforms a single static image into a dynamic video clip. Powered by xAI’s **Aurora Engine**—an autoregressive mixture-of-experts (MoE) architecture—it excels at maintaining subject identity and scene composition while introducing fluid, natural motion. Uniquely, the model generates **native synchronized audio** (ambient sounds, dialogue, or sound effects) alongside the video, providing a complete media asset in a single pass.

## When to use this model
- **Use when:** You need high subject consistency (e.g., a specific character or product), cinematic camera movements, or a "one-stop" generation that includes audio.
- **Don't use when:** You need high-resolution output beyond 720p natively (requires upscaling) or for durations exceeding 15 seconds in a single call.
- **Alternatives:**
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Often better for complex human biology and highly realistic physics.
    - **[Luma Dream Machine](https://fal.ai/models/luma-ai/dream-machine/image-to-video):** Competitive for creative, dream-like transitions.
    - **[Gen-3 Alpha](https://fal.ai/models/runway/gen-3-alpha/image-to-video):** Stronger industry standard for professional film-grade control.

## API — via FAL.ai
**Endpoint:** `https://fal.run/xai/grok-imagine-video/image-to-video` (Sync) / `https://queue.fal.run/xai/grok-imagine-video/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | Text description of desired motion, changes, or atmosphere in the video. |
| `image_url` | string | *Required* | N/A | URL of the input image to be animated. |
| `duration` | integer | `6` | 1 - 15 | Video duration in seconds. |
| `resolution` | string | `720p` | `480p`, `720p` | Output video resolution. |
| `aspect_ratio` | enum | `auto` | `auto`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16` | Shape of the output video. `auto` matches the input image. |
| `logs` | boolean | `false` | `true`, `false` | Whether to return generation logs in the response. |

### Output
The output is a JSON object containing a `video` file object:
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 1234567,
    "width": 1280,
    "height": 720,
    "fps": 24,
    "duration": 6.04,
    "num_frames": 145
  }
}
```

### Example request
```json
{
  "prompt": "A medieval knight walking through a mystical forest, bioluminescent plants pulsing with light, cinematic slow motion.",
  "image_url": "https://example.com/knight.png",
  "duration": 6,
  "resolution": "720p",
  "aspect_ratio": "16:9"
}
```

### Pricing
- **480p:** $0.05 per second of video.
- **720p:** $0.07 per second of video.
- **Image Input Fee:** $0.002 per call.
- *Note:* Costs are incurred even if the generation is flagged for moderation violations.

## API — via Original Source (BYO-key direct)
xAI offers a direct API for the Grok Imagine family.
- **Endpoint:** `https://api.x.ai/v1/videos/generations`
- **Model Name:** `grok-imagine-video`
- **Auth:** Bearer Token via `Authorization: Bearer $XAI_API_KEY`
- **Unique Capabilities:** The native API supports **Reference-to-Video**, allowing up to **7 reference images** (using `reference_images` array) and explicit prompt addressing (e.g., using `@image1` to refer to specific inputs).
- **Official Docs:** [xAI Video Generation](https://docs.x.ai/developers/model-capabilities/video/generation)

## Prompting best practices
- **Describe Motion, Not Static Details:** Since the image provides the "what," focus the prompt on "how" it moves. Use terms like "gentle pan," "slow zoom," "leaves rustling," or "character turns and smiles."
- **Audio Cues:** Include auditory descriptions to guide the native audio engine (e.g., "crackling fire and distant wolves howling").
- **Reference Awareness:** If using the native xAI API with multiple images, use `@image1`, `@image2` etc., to tell the model which image should influence which part of the scene.
- **Avoid Over-specifying Appearance:** If the prompt contradicts the image (e.g., image shows a red car, prompt says "blue car"), the model may struggle or create artifacts.

## Parameter tuning guide
- **Duration (6-15s):** 6 seconds is the "sweet spot" for high-intensity action; 10-15 seconds is better for slow-building cinematic pans where the model has time to develop the scene.
- **Resolution (720p vs 480p):** Always use 720p for final output; use 480p only for rapid prototyping or if bandwidth/cost is a major constraint.
- **Aspect Ratio (auto):** Keeping this at `auto` is highly recommended to prevent the model from stretching or cropping the source image unnaturally.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `image_url` (File/URL): The source image.
    - `prompt` (Text): Motion instructions.
    - `duration` (Slider): Length of clip.
- **Outputs:**
    - `video_url` (Video): The final rendered MP4.
    - `logs` (Text): Debugging info.
- **Chain-friendly with:**
    - **[fal-ai/flux-pro](https://fal.ai/models/fal-ai/flux-pro):** Generate the high-fidelity source image first.
    - **[xai/grok-imagine-video/extension](https://replicate.com/xai/grok-imagine-video-extension):** Take the output of this node and extend it by another 5-10 seconds.
    - **[fal-ai/upscaler](https://fal.ai/models/fal-ai/upscaler):** Take the 720p output and bring it to 4K for professional use.

## Notes & gotchas
- **Moderation Policy:** xAI is strict; if your prompt or image is flagged as a policy violation, the generation will fail but **you will still be charged**.
- **Cold Starts:** FAL.ai provides "Inference" mode for this model, typically resulting in very low latency (30-60s per generation).
- **Audio Consistency:** Native audio is a "bonus" and cannot currently be toggled off or fine-tuned with separate seeds; it is bundled with the video generation.

## Sources
- [FAL.ai Grok Imagine Image-to-Video Docs](https://fal.ai/models/xai/grok-imagine-video/image-to-video)
- [Official xAI Developer Documentation](https://docs.x.ai/developers/model-capabilities/video/generation)
- [Artificial Analysis Video Arena](https://artificialanalysis.ai/models/video)
- [WaveSpeed AI Technical Report on Aurora Engine](https://wavespeed.ai/blog/posts/introducing-x-ai-grok-imagine-video-reference-to-video-on-wavespeedai/)
