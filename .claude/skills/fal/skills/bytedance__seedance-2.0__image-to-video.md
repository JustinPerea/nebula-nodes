---
name: bytedance/seedance-2.0/image-to-video
display_name: Seedance 2.0 Image-to-Video
category: image-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/bytedance/seedance-2.0/image-to-video
original_source: https://seed.bytedance.com/en/seedance2_0
summary: ByteDance's premium image-to-video model featuring synchronized audio, precise start/end frame control, and a unified multimodal architecture.
---

# Seedance 2.0 Image-to-Video

## Overview
- **Slug:** `bytedance/seedance-2.0/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [ByteDance](https://seed.bytedance.com/en/seedance2_0)
- **Best for:** Cinematic video generation with native audio and precise frame interpolation.
- **FAL docs:** [fal.ai/models/bytedance/seedance-2.0/image-to-video](https://fal.ai/models/bytedance/seedance-2.0/image-to-video)
- **Original source:** [Seedance 2.0 Official Page](https://seed.bytedance.com/en/seedance2_0)

## What it does
Seedance 2.0 is ByteDance's flagship image-to-video model, utilizing a **dual-branch diffusion transformer structure** to generate high-fidelity video and synchronized audio simultaneously ([PixVerse](https://pixverse.ai/en/blog/what-is-seedance-2-0-ai-video-model)). It allows users to animate a single image into a cinematic sequence or perform precise "start-to-end" frame interpolation by providing two images ([FAL.ai Docs](https://fal.ai/models/bytedance/seedance-2.0/image-to-video)). The model excels at preserving the fine details of the input image while synthesizing complex motion and environmental effects.

## When to use this model
- **Use when:** You need high-quality product animations, cinematic transitions between two specific images, or realistic video clips that require ambient sound effects.
- **Don't use when:** You need long-form narrative content (beyond 15 seconds) or extremely stylized, non-physical animations where traditional diffusion models might be more flexible.
- **Alternatives:** 
  - **[Kling 2.5](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video):** Better for stylized character movement.
  - **[Veo 3.1](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video):** Google's equivalent for precise first/last frame control.
  - **[Wan 2.5](https://fal.ai/models/fal-ai/wan-25-preview/text-to-video):** A faster, more cost-effective preview model for quick prototyping.

## API — via FAL.ai
**Endpoint:** `https://fal.run/bytedance/seedance-2.0/image-to-video` (Sync) / `https://queue.fal.run/bytedance/seedance-2.0/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | Required | Text description of the desired motion and action. |
| `image_url` | string | - | Required | The URL of the starting frame image. Supports JPEG, PNG, WebP (Max 30MB). |
| `end_image_url` | string | - | Optional | The URL of the image to use as the last frame for interpolation. |
| `resolution` | Enum | `720p` | `480p`, `720p` | Output video resolution. |
| `duration` | Enum | `10` | `auto`, `4` to `15` | Video length in seconds. |
| `aspect_ratio` | Enum | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | The frame dimensions. |
| `generate_audio`| boolean | `true` | `true`, `false` | Whether to generate synced sound effects. |
| `seed` | integer | random | 0 to Max Int | Random seed for reproducibility. |
| `end_user_id` | string | - | Optional | Unique ID for usage tracking. |

### Output
The API returns a JSON object containing the generated video file details and the seed used.
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "generated_video.mp4",
    "file_size": 1234567
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A macro cinematic shot of a blooming flower with dewdrops glistening, slow camera zoom in.",
  "image_url": "https://example.com/flower_start.jpg",
  "resolution": "720p",
  "duration": 5,
  "aspect_ratio": "16:9",
  "generate_audio": true
}
```

### Pricing
Seedance 2.0 is billed based on the computing tokens consumed, which scales with resolution and duration ([FAL.ai Pricing](https://fal.ai/pricing)):
- **Approximate cost:** **$0.3024 per second** of 720p video.
- **Token rate:** $0.014 per 1000 tokens.
- **Token formula:** `(width * height * duration * 24) / 1024`.

## API — via Original Source (BYO-key direct)
The model is natively available through ByteDance's cloud platforms:
- **Endpoint:** `https://api.byteplus.com/seedance/v1/videos` (International / BytePlus)
- **Extra Features:** The native API supports **quad-modal inputs**, allowing up to 12 reference files (9 images, 3 videos, 3 audio files) for complex multi-lens storytelling ([NxCode Resources](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026)).
- **Auth:** Bearer Token authentication via BytePlus/Volcengine API keys.
- **Official Docs:** [BytePlus API Reference](https://www.byteplus.com/en/docs/seedance) (Note: Access may require enterprise account approval).

## Prompting best practices
- **Motion Guidance:** Be explicit about camera movements (e.g., "slow vertical tilt down", "dolly zoom", "360-degree orbit").
- **Lighting & Texture:** Use keywords like "ray tracing", "subsurface scattering", or "caustics" to leverage the model's physics engine.
- **Subject focus:** Clearly define the subject of the motion (e.g., "the liquid ripples from the center", not just "liquid movement").
- **Avoid Ambiguity:** Don't just say "it moves." Specify the direction and speed to prevent random jitter.
- **Example Good Prompt:** "Photorealistic product shot, the watch face catches the light as the camera rotates slowly in a 45-degree arc, studio lighting, bokeh background."
- **Example Bad Prompt:** "The watch moves and looks cool with audio."

## Parameter tuning guide
- **`end_image_url`:** Crucial for transitions. If the two images are too different, the model may produce a "morphing" effect. For natural motion, ensure the subjects are visually consistent between the two frames.
- **`duration`:** For complex physics (like water or smoke), `auto` often yields more realistic results as the model chooses the natural timing of the simulation.
- **`resolution`:** Use `480p` for quick iteration at ~$0.13/sec, then switch to `720p` for final renders.
- **`generate_audio`:** If the scene is silent (e.g., abstract art), disable this to potentially reduce processing overhead, though FAL currently bundles it.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Text Prompt` (String)
  - `Starting Image` (Image/URL)
  - `Ending Image` (Image/URL)
  - `Aspect Ratio` (Dropdown)
  - `Resolution` (Dropdown)
- **Outputs:**
  - `Video URL` (URL)
  - `Audio-Video File` (File)
  - `Generation Seed` (Integer)
- **Chain-friendly with:**
  - **[Flux 2](https://fal.ai/models/fal-ai/flux-2-flex):** Generate the high-quality starting image.
  - **[Nano Banana Pro](https://fal.ai/models/fal-ai/nano-banana-pro/edit):** Edit the starting frame before animating.
  - **[Ovi](https://fal.ai/models/fal-ai/ovi/image-to-video):** For rapid alternative variations.

## Notes & gotchas
- **Max File Size:** Input images must be under 30MB ([FAL.ai Docs](https://fal.ai/models/bytedance/seedance-2.0/image-to-video/api)).
- **Resolution Limit:** While the original model supports 1080p and 2K, the current FAL implementation is capped at **720p** for the standard endpoint.
- **Safety Filter:** Standard content filters apply to both text prompts and uploaded images; sexually explicit or violent content will result in an API error.

## Sources
- [FAL.ai Seedance 2.0 Docs](https://fal.ai/models/bytedance/seedance-2.0/image-to-video)
- [ByteDance Seed Official Page](https://seed.bytedance.com/en/seedance2_0)
- [PixVerse Technical Analysis](https://pixverse.ai/en/blog/what-is-seedance-2-0-ai-video-model)
- [NxCode API Guide](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026)
- [FAL.ai Pricing Table](https://fal.ai/pricing)