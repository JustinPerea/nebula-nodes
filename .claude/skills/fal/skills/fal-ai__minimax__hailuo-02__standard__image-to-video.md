---
name: fal-ai/minimax/hailuo-02/standard/image-to-video
display_name: MiniMax Hailuo-02 [Standard] (Image to Video)
category: text-to-video
creator: MiniMax
fal_docs: https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video/api
original_source: https://platform.minimax.io/docs/api-reference/video-generation-i2v
summary: A professional-grade cinematic image-to-video model by MiniMax featuring extreme physics simulation and advanced director-level camera controls.
---

# MiniMax Hailuo-02 [Standard] (Image to Video)

## Overview
- **Slug:** `fal-ai/minimax/hailuo-02/standard/image-to-video`
- **Category:** image-to-video
- **Creator:** [MiniMax](https://minimax.io/)
- **Best for:** Generating cinematic, high-fidelity videos from static images with complex motion and precise camera control.
- **FAL docs:** [fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video)
- **Original source:** [platform.minimax.io](https://platform.minimax.io/docs/api-reference/video-generation-i2v)

## What it does
MiniMax Hailuo-02 is a next-generation video generation model that transforms a starting image into a high-quality video clip. It is renowned for its **"Extreme Physics"** engine, which handles complex interactions like fluid dynamics, gravity, and intricate human movements (e.g., acrobatics) with industry-leading realism. The "Standard" version balances speed and quality, outputting 768p resolution videos at 24-25 FPS. It excels at maintaining character consistency and responding to sophisticated natural language instructions or explicit camera commands.

## When to use this model
- **Use when:** You need high-end cinematic quality, realistic physics (water, hair, fabric), or specific camera movements like dolly zooms or tracking shots.
- **Don't use when:** You need ultra-high resolution (1080p) in the same call (use the `hailuo-02/pro` variant for that) or when generating very long narrative sequences (clips are limited to 6–10 seconds).
- **Alternatives:** 
    - **[Kling 2.5 Turbo](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video):** Similar high quality, often faster but with different motion aesthetics.
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Good for broad creative motion but lacks the explicit "Director" camera tags of MiniMax.
    - **[Hailuo-02 Pro](https://fal.ai/models/fal-ai/minimax/hailuo-02/pro/text-to-video):** Use for native 1080p output and slightly better fidelity.

## API — via FAL.ai
**Endpoints:** 
- `https://fal.run/fal-ai/minimax/hailuo-02/standard/image-to-video` (Synchronous)
- `https://queue.fal.run/fal-ai/minimax/hailuo-02/standard/image-to-video` (Queue-based)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | max 2000 chars | Text description of the motion and scene. Supports camera commands in `[]`. |
| `image_url` | string | (required) | URL / Base64 | The starting frame of the video. Supports JPG, PNG, WebP (<20MB). |
| `duration` | integer | `6` | `6`, `10` | The length of the generated video in seconds. |
| `resolution` | string | `768P` | `512P`, `768P` | Output vertical resolution. 768P is the standard for this model. |
| `prompt_optimizer` | boolean | `true` | `true`, `false` | Automatically rewrites the prompt for better quality. Disable for precise command following. |
| `end_image_url` | string | `null` | URL / Base64 | Optional image to serve as the final frame for start-to-end generation. |

### Output
The output is a JSON object containing a `video` object:
```json
{
  "video": {
    "url": "https://fal-cdn.com/outputs/...",
    "content_type": "video/mp4",
    "file_name": "generated_video.mp4",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "prompt": "A futuristic car racing through a neon city at night, [Pan right, Zoom in]. High speed, motion blur, cinematic lighting.",
  "image_url": "https://example.com/start_frame.jpg",
  "duration": 6,
  "resolution": "768P",
  "prompt_optimizer": true
}
```

### Pricing
- **768P Resolution:** $0.045 per second ($0.27 per 6s video).
- **512P Resolution:** Roughly $0.017 per second (~$0.10 per 6s video).
- **10s Duration:** $0.45 (at 768P).
*(Source: [fal.ai/pricing](https://fal.ai/pricing))*

## API — via Original Source (BYO-key direct)
The model is natively served via the MiniMax Platform API.
- **Endpoint:** `https://api.minimax.io/v1/video_generation`
- **Auth Method:** Bearer Token (API Key)
- **Additional Parameters:** MiniMax supports `fast_pretreatment` (boolean) to speed up optimized prompts and `callback_url` for async status updates.
- **Official Docs:** [platform.minimax.io/docs/api-reference/video-generation-i2v](https://platform.minimax.io/docs/api-reference/video-generation-i2v)

## Prompting best practices
- **Camera Commands:** Use square brackets for precise control: `[Zoom in]`, `[Pan left]`, `[Truck right]`, `[Dolly zoom]`, `[Shake]`. 
- **Sequential Motion:** You can chain movements: `[Pan left], then [Zoom in]` works to time actions.
- **Natural Language Connectors:** Use words like "simultaneously" or "while" to link character action to camera motion (e.g., "Man runs while [Tracking shot]").
- **Avoid Over-Detailing:** If `prompt_optimizer` is ON, keep your prompt descriptive but focused. If OFF, specify every detail of the lighting and style.
- **Example Good Prompt:** "A majestic dragon breathes fire onto a castle tower, [Pan right, Tilt up], cinematic epic fantasy style, embers flying in air."
- **Example Bad Prompt:** "The dragon moves a bit and the camera goes around." (Too vague for the physics engine to calculate meaningful motion).

## Parameter tuning guide
- **`prompt_optimizer` (True/False):** Set to **True** for most users; the model is exceptionally good at "guessing" the cinematic intent. Set to **False** only when using strict technical camera commands in `[]` to avoid the AI overriding your specific directions.
- **`duration` (6 vs 10):** 6 seconds is the "sweet spot" for physics stability. 10 seconds allows for more narrative development but may introduce more "warping" or artifacts towards the end of the clip.
- **`resolution` (768P vs 512P):** Use 768P for all professional work. 512P is primarily for rapid prototyping or low-cost thumbnail previews.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Text input for the scene and camera instructions.
    - `Source Image`: Image input for the initial frame.
    - `End Image` (Optional): Image input for the target final frame.
    - `Duration`: Dropdown (6s, 10s).
- **Outputs:**
    - `Video URL`: The final generated MP4.
- **Chain-friendly with:**
    - **[Flux.1 Pro](https://fal.ai/models/fal-ai/flux-pro):** Use Flux to generate the high-quality base image, then pass it to Hailuo-02 for animation.
    - **[foley-video-to-audio](https://fal.ai/models/fal-ai/foley-video-to-audio):** Use this to add realistic sound effects to the silent video generated by Hailuo.

## Notes & gotchas
- **Safety Filters:** MiniMax employs strict content moderation. Prompts involving NSFW content, extreme violence, or specific public figures may trigger a "Harmful content" rejection or produce a generic "Safe" output.
- **Copyright:** While the model allows uploading many types of images, using trademarked characters or copyrighted artworks is subject to MiniMax's usage policy and legal restrictions.
- **Watermarks:** Videos generated via the public website often have watermarks, but API-generated videos (via FAL or direct) are generally clean for commercial use.

## Sources
- [FAL.ai API Documentation](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video/api)
- [MiniMax Official API Docs](https://platform.minimax.io/docs/api-reference/video-generation-i2v)
- [Atlas Cloud Model Specs](https://www.atlascloud.ai/models/minimax/hailuo-02/standard)
- [Artificial Analysis - Video Model Benchmarks](https://artificialanalysis.ai/models/minimax-hailuo-02)
