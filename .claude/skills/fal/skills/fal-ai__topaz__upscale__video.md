---
name: fal-ai/topaz/upscale/video
display_name: Topaz Video Upscale
category: video-to-video
creator: Topaz Labs
fal_docs: https://fal.ai/models/fal-ai/topaz/upscale/video
original_source: https://www.topazlabs.com/topaz-video, https://developer.topazlabs.com/
summary: Professional-grade AI video enhancement and upscaling for high-fidelity restoration, frame interpolation, and noise reduction.
---

# Topaz Video Upscale

## Overview
- **Slug:** `fal-ai/topaz/upscale/video`
- **Category:** Video-to-Video / Enhancement
- **Creator:** [Topaz Labs](https://www.topazlabs.com/)
- **Best for:** Professional-grade video upscaling, denoising, and frame rate conversion for high-fidelity restoration.
- **FAL docs:** [fal.ai/models/fal-ai/topaz/upscale/video](https://fal.ai/models/fal-ai/topaz/upscale/video)
- **Original source:** [Topaz Labs Developer Docs](https://developer.topazlabs.com/)

## What it does
Topaz Video Upscale leverages state-of-the-art AI models (including Proteus, Artemis, and Gaia) to enhance video quality by increasing resolution, reducing noise, and removing compression artifacts while preserving natural details ([Topaz Labs](https://developer.topazlabs.com/video-models/proteus)). Unlike generative models that "hallucinate" content, Topaz focuses on "Precision" enhancement, making it ideal for restoring historical footage, improving low-resolution CGI, or polishing AI-generated video ([fal.ai](https://fal.ai/models/fal-ai/topaz/upscale/video)). It also supports advanced frame interpolation to increase FPS (e.g., from 30 to 60 or 120) and slow-motion effects.

## When to use this model
- **Use when:** 
    - You need to upscale 720p or 1080p footage to 4K or 8K with professional clarity.
    - You are working with "noisy" or "blocky" low-bitrate videos (e.g., legacy security footage or compressed web videos).
    - You want to convert standard footage into smooth slow-motion or high-frame-rate (HFR) video.
- **Don't use when:** 
    - You want to drastically change the content or style of the video (use a Video-to-Video diffusion model instead).
    - The source footage is so damaged that it requires generative reconstruction rather than precision restoration.
- **Alternatives:** 
    - `fal-ai/esrgan`: A faster, open-source alternative for basic upscaling, though with less control over specific artifacts.
    - `fal-ai/kling-video/v2.5-turbo/image-to-video`: If you need to "re-imagine" a low-res video by using it as a reference for a new generation.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/topaz/upscale/video` (Sync) / `https://queue.fal.run/fal-ai/topaz/upscale/video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | `string` | - | - | **Required.** Public URL of the video to upscale. |
| `model` | `enum` | `Proteus` | `Proteus`, `Artemis HQ`, `Artemis MQ`, `Artemis LQ`, `Nyx`, `Nyx Fast`, `Nyx XL`, `Nyx HF`, `Gaia HQ`, `Gaia CG`, `Iris` | Selects the enhancement model. Proteus is general-purpose; Artemis is for denoise+sharpen; Nyx is for low-light/extreme noise; Gaia is for high-quality CGI. |
| `upscale_factor` | `float` | `2.0` | `1.0` - `4.0` | Factor to upscale (e.g., 2.0 doubles width and height). |
| `target_fps` | `integer` | - | `16` - `120` | Enables frame interpolation if set. |
| `compression` | `float` | `0.0` | `0.0` - `1.0` | Level of compression artifact removal. |
| `noise` | `float` | `0.0` | `0.0` - `1.0` | Level of noise reduction. |
| `halo` | `float` | `0.0` | `0.0` - `1.0` | Halo reduction (sharpening artifact removal). |
| `grain` | `float` | `0.0` | `0.0` - `1.0` | Amount of film grain to add back for a natural look. |
| `recover_detail` | `float` | `0.0` | `0.0` - `1.0` | Preserves original detail; higher values are more faithful to the source. |
| `H264_output` | `boolean` | `false` | `true`, `false` | If `false`, uses H265 codec (smaller file, higher quality). |

### Output
The output is a JSON object containing a `video` object with the URL of the processed file.
```json
{
  "video": {
    "url": "https://fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "upscaled_video.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "video_url": "https://example.com/source.mp4",
  "model": "Proteus",
  "upscale_factor": 2,
  "noise": 0.5,
  "recover_detail": 0.8
}
```

### Pricing
FAL.ai bills based on the output duration and resolution ([fal.ai pricing](https://fal.ai/pricing)):
- **Up to 720p:** $0.01 / second.
- **720p to 1080p:** $0.02 / second.
- **Above 1080p (4K+):** $0.08 / second.
- **Note:** Price doubles for **60fps** output. **Gaia 2** models are charged at half the standard rate.

## API — via Original Source (BYO-key direct)
Topaz Labs offers a direct REST API for high-volume enterprise users.
- **Endpoint:** `https://api.topazlabs.com/video/`
- **Auth method:** API Key (Bearer Token).
- **Direct API Advantages:** Access to more granular "Local" parameters like `prenoise`, `preblur`, `grain_sigma`, and `focus_fix_level` which are not always exposed in the FAL wrapper ([Topaz Developer Docs](https://developer.topazlabs.com/video-models/proteus/proteus)).
- **Link:** [Topaz Labs API Documentation](https://developer.topazlabs.com/)

## Prompting best practices
*Note: As an enhancement model, "prompting" applies primarily if using the generative "Redefine" model variant.*
- **Avoid Over-Sharpening:** Don't crank `noise` and `halo` to 1.0 simultaneously; it can lead to a "plastic" look.
- **Grain for Realism:** When upscaling old film, add a small amount of `grain` (0.1 - 0.2) to prevent the AI from making the footage look unnaturally smooth.
- **Model Matching:** Use `Gaia CG` specifically for animation or CGI to avoid the AI trying to "photorealize" stylized textures.
- **Iterative Testing:** If the video has faces, the `Iris` model is significantly better at preserving facial features than the standard `Proteus`.

## Parameter tuning guide
- **Recover Detail (0.8+):** Use high values for high-quality sources where you just want a resolution bump.
- **Compression (0.5+):** Essential for "blocky" YouTube or social media downloads.
- **Target FPS:** If upscaling from 24fps, set `target_fps` to 48 or 60 for a "soap opera" effect, or keep it null to maintain the cinematic motion cadence.
- **Upscale Factor:** 2.0 is the "sweet spot" for quality; 4.0 may introduce artifacts if the source is very low quality.

## Node inputs/outputs
- **Inputs:**
    - `video_url` (Video Link)
    - `model` (Selection)
    - `upscale_factor` (Number)
    - `noise_reduction` (Slider)
- **Outputs:**
    - `video_url` (Video Link)
- **Chain-friendly with:**
    - **Pre-Upscale:** `fal-ai/kling-video` (to upscale generated content).
    - **Post-Upscale:** `fal-ai/ffmpeg-utils` (for cropping or watermarking the high-res output).

## Notes & gotchas
- **Max Resolution:** FAL typically limits output to 4K via this endpoint, though the native Topaz technology supports 8K+ ([Topaz Labs](https://developer.topazlabs.com/video-models/proteus)).
- **Processing Time:** High-factor upscaling (4x) with frame interpolation is computationally intensive and may take several minutes for a 30-second clip. Use the **Queue** mode.
- **Codec:** Default is H265; ensure your target player supports HEVC, otherwise set `H264_output` to `true`.

## Sources
- [FAL.ai Topaz Model Page](https://fal.ai/models/fal-ai/topaz/upscale/video)
- [Topaz Labs Official API Documentation](https://developer.topazlabs.com/)
- [Topaz Labs Video Models Overview](https://developer.topazlabs.com/video-models/proteus)
