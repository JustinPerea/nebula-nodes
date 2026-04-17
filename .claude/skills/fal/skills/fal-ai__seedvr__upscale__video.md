---
name: fal-ai/seedvr/upscale/video
display_name: SeedVR2 Video Upscale (ByteDance)
category: video-to-video
creator: ByteDance Seed
fal_docs: https://fal.ai/models/fal-ai/seedvr/upscale/video
original_source: https://iceclear.github.io/projects/seedvr2/
summary: A high-performance, one-step video restoration model by ByteDance that upscales video to 4K with exceptional temporal consistency.
---

# SeedVR2 Video Upscale (ByteDance)

## Overview
- **Slug:** `fal-ai/seedvr/upscale/video`
- **Category:** Video-to-Video / Restoration
- **Creator:** [ByteDance Seed](https://github.com/ByteDance-Seed)
- **Best for:** Fast, temporally consistent 4K video upscaling and noise removal.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/seedvr/upscale/video)
- **Original source:** [Official Project Page](https://iceclear.github.io/projects/seedvr2/) | [GitHub](https://github.com/ByteDance-Seed/SeedVR)

## What it does
SeedVR2 is a state-of-the-art **one-step video restoration model** based on a Diffusion Transformer (DiT) architecture ([ByteDance Seed GitHub](https://github.com/ByteDance-Seed/SeedVR)). It is designed to transform low-resolution, noisy, or blurry video into high-fidelity outputs up to 4K resolution. Unlike traditional diffusion models that require many sampling steps, SeedVR2 achieves high-quality results in a single inference step using adversarial post-training, making it up to 10x faster than comparable models while maintaining industry-leading temporal consistency ([ICLR 2026 Technical Report](https://iceclear.github.io/projects/seedvr2/)).

## When to use this model
- **Use when:** You need to upscale AI-generated video (e.g., from Kling or Luma) to professional 4K standards.
- **Use when:** You are restoring old or low-bitrate archival footage that suffers from compression artifacts.
- **Use when:** Speed and cost-efficiency are critical—the one-step architecture is significantly cheaper to run than multi-step upscalers.
- **Don't use when:** You need perfect "forensic" reconstruction of original film grain; SeedVR2 tends to produce a "clean," slightly synthetic "AI" look ([Adam Holter Review](https://adam.holter.com/seedvr2-on-fal-ai-cheap-10k-image-and-4k-video-upscaling-with-a-catch/)).
- **Alternatives:**
    - **Stability AI Video Upscaler**: Good for native SVD workflows but generally slower.
    - **AuraSR**: Excellent for static image restoration but lacks the temporal causal attention needed for flicker-free video.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/seedvr/upscale/video` (Sync) / `https://queue.fal.run/fal-ai/seedvr/upscale/video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | string | *Required* | Any valid URL | The source video file (MP4, MOV, WebM, GIF) to be upscaled. |
| `upscale_mode` | enum | `factor` | `target`, `factor` | Whether to upscale by a multiplier or to a specific preset resolution. |
| `upscale_factor` | float | `2.0` | `1.0` - `10.0` | Dimension multiplier used when `upscale_mode` is set to `factor`. |
| `target_resolution` | enum | `1080p` | `720p`, `1080p`, `1440p`, `2160p` | The target resolution when `upscale_mode` is `target`. |
| `seed` | integer | random | - | Random seed for the generation process to ensure reproducibility. |
| `noise_scale` | float | `0.1` | `0.0` - `1.0` | Controls the amount of synthetic detail/noise added back to the video. |
| `output_format` | enum | `X264 (.mp4)` | `X264`, `VP9`, `PRORES4444`, `GIF` | The container and codec for the output file. |
| `output_quality` | enum | `high` | `low`, `medium`, `high`, `maximum` | The bit-rate/quality level of the encoded output video. |
| `output_write_mode`| enum | `balanced` | `fast`, `balanced`, `small` | Optimizes for encoding speed vs. final file size. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns a Base64 data URI (not recommended for large 4K files). |

### Output
The API returns a JSON object with the upscaled video file details:
```json
{
  "video": {
    "url": "https://fal-cdn.com/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 10485760
  },
  "seed": 123456789
}
```

### Example request
```json
{
  "video_url": "https://example.com/input.mp4",
  "upscale_mode": "target",
  "target_resolution": "2160p",
  "noise_scale": 0.1,
  "output_format": "PRORES4444 (.mov)"
}
```

### Pricing
FAL.ai charges **$0.001 per megapixel** (Width × Height × Frames).
- **Example:** A 1080p video (1920x1080) with 121 frames costs approximately **$0.25** per run ([FAL.ai Model Page](https://fal.ai/models/fal-ai/seedvr/upscale/video)).

## API — via Original Source (BYO-key direct)
ByteDance Seed provides the model weights under the **Apache 2.0 License**. There is no official public API endpoint hosted by ByteDance; FAL.ai is the primary managed interface for this model.
- **Official Weights:** Available on [Hugging Face](https://huggingface.co/ByteDance-Seed/SeedVR2-3B) for both the 3B and 7B variants.
- **Architecture:** Causal Video DiT with Adaptive Window Attention ([ICLR 2026](https://iceclear.github.io/projects/seedvr2/)).

## Prompting best practices
*Note: As an upscaling model, SeedVR2 does not take text prompts, but "prompting" the model involves source preparation.*
- **Clean Sources:** For best results, avoid sources with heavy "digital noise" or "film grain" as the model may interpret them as textures to be "smoothed" or "cleaned."
- **Standard Ratios:** The model is optimized for 16:9 and 4:3. Non-standard ratios are supported but may result in minor padding to meet the model's **multiple-of-32** pixel requirement.
- **Contrast is King:** SeedVR2 performs exceptionally well on high-contrast, colorful inputs (like anime or brightly lit 3D renders).

## Parameter tuning guide
- **Noise Scale (0.1):** This is the sweet spot. Setting it to `0.0` can sometimes lead to an overly "plastic" look, while values above `0.3` may introduce synthetic "hallucinated" textures.
- **Upscale Mode (Target vs. Factor):** Use `Target` when you have a specific delivery format (like 4K YouTube). Use `Factor` (2.0) when you want to preserve the exact pixel ratio of a custom-sized source.
- **Output Quality (Maximum):** Use "Maximum" quality only when selecting `PRORES4444` for high-end editing workflows; for web viewing, "High" with `X264` is indistinguishable and much faster to download.

## Node inputs/outputs
- **Inputs:**
    - `Video`: The input video stream.
    - `Target Res`: Dropdown for 720p/1080p/2K/4K.
    - `Noise Scale`: Float slider (Default 0.1).
- **Outputs:**
    - `Upscaled Video`: The final high-resolution video file.
- **Chain-friendly with:**
    - **Kling 1.5 / Luma Dream Machine**: Use as the final step in a generation pipeline to bring 720p generations to 4K.
    - **Remove Background**: Process a high-res video after upscaling for cleaner alpha edges.

## Notes & gotchas
- **Temporal Consistency:** SeedVR2 uses a "causal" attention mechanism, meaning it looks at previous frames to ensure the upscale is flicker-free.
- **Input Size:** The model requires dimensions to be multiples of 32. FAL.ai automatically handles cropping/padding to meet this requirement.
- **One-Step Nature:** Because it is a one-step model, it doesn't have a "Steps" parameter like standard Stable Diffusion models.

## Sources
- [FAL.ai Model Documentation](https://fal.ai/models/fal-ai/seedvr/upscale/video)
- [Official SeedVR2 Project Page](https://iceclear.github.io/projects/seedvr2/)
- [ByteDance Seed GitHub Repository](https://github.com/ByteDance-Seed/SeedVR)
- [Hugging Face Model Card (3B)](https://huggingface.co/ByteDance-Seed/SeedVR2-3B)
- [Adam Holter Performance Review](https://adam.holter.com/seedvr2-on-fal-ai-cheap-10k-image-and-4k-video-upscaling-with-a-catch/)