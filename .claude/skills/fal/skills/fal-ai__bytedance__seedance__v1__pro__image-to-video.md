---
name: fal-ai/bytedance/seedance/v1/pro/image-to-video
display_name: Seedance 1.0 Pro (Image-to-Video)
category: image-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video
original_source: https://seed.bytedance.com/en/seedance
summary: High-performance video generation model by ByteDance featuring superior spatiotemporal fluidity and cinematic consistency.
---

# Seedance 1.0 Pro (Image-to-Video)

## Overview
- **Slug:** `fal-ai/bytedance/seedance/v1/pro/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [ByteDance](https://seed.bytedance.com/en/seedance)
- **Best for:** Professional-grade cinematic animations with high temporal stability and realistic motion.
- **FAL docs:** [fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video](https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video)
- **Original source:** [ByteDance Seed](https://seed.bytedance.com/en/seedance) / [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/1587798)

## What it does
Seedance 1.0 Pro is a high-performance video foundation model developed by **ByteDance**. It utilizes a **Diffusion Transformer (DiT)** architecture with decoupled spatial and temporal layers, allowing it to generate 1080p videos with exceptional spatiotemporal fluidity and structural stability ([arXiv:2506.09113](https://arxiv.org/abs/2506.09113)). The model excels at preserving the identity and details of a starting reference image while injecting lifelike motion, complex camera movements, and cinematic aesthetics.

## When to use this model
- **Use when:** You need high-fidelity character consistency, professional marketing visuals, or cinematic shots where physical plausibility and motion fluidity are critical.
- **Don't use when:** You need extremely long-form content (>12 seconds in a single pass) or very fast, low-cost previews (use the **Seedance 1.0 Lite** version instead).
- **Alternatives:** 
    - **Kling 2.5/3.0:** Strong competitor in motion quality, though Seedance often leads in prompt following and structural stability.
    - **Luma Dream Machine:** Good for creative and surreal motion.
    - **Runway Gen-3 Alpha:** High-tier alternative, but typically more expensive via API.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedance/v1/pro/image-to-video` (Sync) / `https://queue.fal.run/fal-ai/bytedance/seedance/v1/pro/image-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | Detailed text description of the desired motion and scene. |
| `image_url` | string | (Required) | - | URL of the starting reference image (first frame). |
| `end_image_url` | string | null | - | URL of the image the video should end with (optional). |
| `aspect_ratio` | string | `"auto"` | `21:9, 16:9, 4:3, 1:1, 3:4, 9:16, auto` | Desired video shape. |
| `resolution` | string | `"1080p"` | `480p, 720p, 1080p` | Output quality level. |
| `duration` | integer | `5` | `2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12` | Video length in seconds. |
| `camera_fixed` | boolean | `false` | `true, false` | If true, locks the camera position. |
| `seed` | integer | `-1` | - | Random seed for reproducibility. |
| `enable_safety_checker`| boolean | `true` | `true, false` | Filters sensitive content. |
| `num_frames` | integer | null | - | Overrides duration if specified. |

### Output
The output is a JSON object containing the generated video file details and the seed used.
```json
{
  "video": {
    "url": "https://storage.googleapis.com/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A cinematic shot of a sunset over the ocean, waves gently crashing against the shore, golden hour lighting, 4k, highly detailed.",
  "image_url": "https://example.com/start_frame.jpg",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "duration": 5
}
```

### Pricing
- **Cost per video:** ~$0.74 per 5-second 1080p generation ([FAL Pricing](https://fal.ai/pricing)).
- **Token-based:** $3.00 per million video tokens (where tokens = `(width * height * FPS * duration) / 1024`).

## API — via Original Source (BYO-key direct)
ByteDance provides direct API access via its enterprise platform, **BytePlus ModelArk**.

- **Endpoint:** `https://ark.ap-southeast.bytepluses.com/api/v3`
- **Auth Method:** Bearer Token (`ARK_API_KEY`).
- **Additional Features:** The native API supports **Seedance 2.0** features including multimodal references (up to 9 images/3 videos/3 audio clips) using a specialized `@` reference syntax (e.g., `@image1`).
- **Link to official docs:** [BytePlus ModelArk Docs](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## Prompting best practices
- **Formula:** [Subject] + [Setting] + [Action] + [Camera Movement] + [Style/Lighting]. 
- **Keywords:** Use cinematic terms like "dolly zoom," "pan left," "shallow depth of field," or "anamorphic lens" for high-end results.
- **Motion Cues:** Explicitly describe the speed and direction of movement (e.g., "slow-motion cascading water" vs "rapidly flickering lights").
- **Safety:** Avoid prompts that might trigger safety filters (deepfakes, explicit content).
- **Reference Image:** The quality of the input image directly dictates the output. Use high-resolution, uncompressed PNG/JPG files (up to 5MB).

## Parameter tuning guide
- **Resolution:** Use `480p` for rapid iteration and `1080p` only for the final render to save costs.
- **Camera Fixed:** Set to `true` if you want a "living photo" effect where only the subject moves. Set to `false` for dynamic cinematic shots.
- **Duration:** 5 seconds is the sweet spot for motion stability. Longer durations (10-12s) may occasionally show slight drift in complex scenes.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Reference Image` (Image Port)
    - `Prompt` (Text Port)
    - `Aspect Ratio` (Dropdown)
    - `Resolution` (Dropdown)
- **Outputs:**
    - `Video URL` (Video Port)
    - `Seed` (Number Port)
- **Chain-friendly with:**
    - **Seedream V4/V4.5:** Best for generating the initial high-quality reference image.
    - **Flux 1.1 Pro:** Another top-tier choice for creating specific reference subjects or styles.
    - **Upscaler Nodes:** Useful for taking the 1080p output to 4K.

## Notes & gotchas
- **Multi-Shot Capability:** While FAL exposes a simple I2V interface, the underlying model natively supports narrative transitions. To achieve this on FAL, use the `end_image_url` to guide the model toward a specific concluding frame.
- **Region Restrictions:** BytePlus API access may require registration in specific regions (e.g., AP-Southeast-1).
- **Latency:** Video generation is compute-intensive; always use the `fal.queue` or `subscribe` methods with webhooks for production applications.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video)
- [ByteDance Seed Official Site](https://seed.bytedance.com/en/seedance)
- [arXiv Technical Report (2506.09113)](https://arxiv.org/abs/2506.09113)
- [BytePlus ModelArk Documentation](https://docs.byteplus.com/en/docs/ModelArk/1587798)
- [Segmind Model Guide](https://blog.segmind.com/generate-ai-videos-seedance-1-pro/)
