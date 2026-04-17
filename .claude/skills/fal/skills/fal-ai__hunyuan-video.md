---
name: fal-ai/hunyuan-video
display_name: HunyuanVideo (Tencent)
category: text-to-video
creator: Tencent Hunyuan Team
fal_docs: https://fal.ai/models/fal-ai/hunyuan-video
original_source: https://github.com/Tencent-Hunyuan/HunyuanVideo, [Hugging Face](https://huggingface.co/tencent/HunyuanVideo)
summary: A high-performance open-source video foundation model by Tencent featuring a dual-stream DiT architecture for high-fidelity 720p video generation.
---

# HunyuanVideo

## Overview
- **Slug:** `fal-ai/hunyuan-video`
- **Category:** text-to-video, video-to-video
- **Creator:** [Tencent Hunyuan Team](https://github.com/Tencent-Hunyuan)
- **Best for:** High-fidelity, cinematic video generation with strong instruction following and complex motion.
- **FAL docs:** [fal.ai/models/fal-ai/hunyuan-video](https://fal.ai/models/fal-ai/hunyuan-video)
- **Original source:** [GitHub Repository](https://github.com/Tencent-Hunyuan/HunyuanVideo) | [Technical Report](https://arxiv.org/abs/2412.03603)

## What it does
HunyuanVideo is a leading open-source video foundation model that utilizes a **Diffusion Transformer (DiT)** architecture. It features a unique **dual-stream to single-stream hybrid design** that independently processes text and video tokens before fusing them, leading to superior text-to-video alignment. It is capable of generating highly realistic videos with complex motion, physical consistency, and fine-grained detail, often outperforming many closed-source alternatives.

## When to use this model
- **Use when:** You need high-quality 720p cinematic shots, complex camera movements (pan/tilt/zoom), or specific bilingual (English/Chinese) text rendering within a scene.
- **Don't use when:** You require ultra-fast generation (inference can take ~4m on FAL), very high resolution (max 720p on standard FAL endpoint), or extremely long durations beyond 5 seconds (129 frames).
- **Alternatives:** 
  - **[Kling 1.0](https://fal.ai/models/fal-ai/kling-video):** Better for stylized/creative motion but often slower.
  - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Excellent for physics and character consistency.
  - **[Flux 1 (T2I)](https://fal.ai/models/fal-ai/flux):** If you only need a single frame, Flux is the gold standard for quality.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hunyuan-video` (sync) / `https://queue.fal.run/fal-ai/hunyuan-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | - | The text prompt to generate the video from. |
| `seed` | integer | Random | - | Seed for deterministic generation. |
| `pro_mode` | boolean | `false` | `true, false` | If `true`, uses 55 steps (vs 35) for higher quality. Costs 2x more. |
| `aspect_ratio` | enum | `"16:9"` | `16:9, 9:16` | The aspect ratio of the generated video. |
| `resolution` | enum | `"720p"` | `480p, 580p, 720p` | The vertical resolution of the video. |
| `num_frames` | enum | `"129"` | `129, 85` | The number of frames (129 ≈ 5s at 24fps). |
| `enable_safety_checker`| boolean | `true` | `true, false` | Filters sensitive or prohibited content. |
| `video_url` | string | - | - | (V2V only) URL of the input video. |
| `strength` | float | `0.85` | `0.0 - 1.0` | (V2V only) How much the original video is modified. |

### Output
The API returns a JSON object containing a `video` object and the `seed`.
```json
{
  "video": {
    "url": "https://v3.fal.media/files/.../video.mp4",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 123456
  },
  "seed": 123456789
}
```

### Pricing
- **Standard Call:** $0.40 per successful generation (720p, 129 frames).
- **Pro Mode:** ~$0.80 per generation (2x billing units).
- **V1.5 Pricing:** $0.075 per second of output.

---

## API — via Original Source (BYO-key direct)
Tencent offers a direct API via **Tencent Cloud**.
- **Endpoint:** `https://hunyuan.cloud.tencent.com/openai/v1/chat/completions` (for Prompt Rewrite/LLM) or specific Model Studio endpoints for video generation.
- **Auth Method:** Tencent Cloud SecretID/SecretKey.
- **Native Parameters:** The original implementation supports `--embedded-cfg-scale` (default 6.0) and `--flow-shift` (default 7.0), which are sometimes abstracted away in cloud providers.
- **Docs:** [Tencent Cloud Model Studio](https://www.tencentcloud.com/document/product/1297)

---

## Prompting best practices
- **Be Descriptive:** Use cinematic terminology like "low-angle tracking shot," "shallow depth of field," and "golden hour lighting."
- **Structure:** [Subject] + [Action] + [Setting] + [Style/Lighting/Camera].
- **Bilingual Advantage:** The model is natively trained on both English and Chinese; for specific cultural nuances, Chinese prompts can be very effective.
- **Keywords:** Use "realistic," "cinematic," "high detail" for photorealism. For text rendering, put the text in quotes (e.g., "A sign saying 'Open 24/7'").
- **Failure Mode:** Avoid overly long, rambling prompts without structure. The model might lose focus on the primary subject.
- **Example Good:** "Cinematic tracking shot follows a cybernetic wolf running through a rainy neon-lit Tokyo street, reflections on puddles, 8k resolution, photorealistic."
- **Example Bad:** "A dog running fast in the city with lights and rain."

## Parameter tuning guide
- **Steps:** 35 (Standard) is the sweet spot for speed. Use 55 (Pro) only when fine details like text or intricate textures are blurry.
- **Seed:** Lock the seed when testing prompt variations to see exactly how keywords change the composition.
- **Resolution:** Stick to 720p for final renders; 480p is only recommended for rapid prototyping.
- **Strength (V2V):** `0.85` is the default. Lower it (~0.4-0.6) if you want the output to strictly follow the original motion and structure; keep it high for creative re-imagining.

## Node inputs/outputs
- **Inputs:**
  - `Prompt` (String)
  - `Aspect Ratio` (Enum)
  - `Seed` (Integer)
  - `Video Input` (File/URL - for V2V)
- **Outputs:**
  - `Video URL` (URL)
  - `Seed` (Integer)
- **Chain-friendly with:**
  - **[Hunyuan-Large](https://fal.ai/models/fal-ai/hunyuan-large):** Use as a pre-processor to rewrite/expand prompts (Normal/Master mode).
  - **[Minimax Video-01](https://fal.ai/models/fal-ai/minimax-video):** Chain for comparison or fallback.
  - **[Video-to-Video Upscalers](https://fal.ai/models/fal-ai/video-upscaler):** To push 720p output to 4K.

## Notes & gotchas
- **Generation Time:** Be prepared for ~4-minute waits. Use the **Queue** mode for production apps.
- **Aspect Ratio:** The model is optimized for 16:9 and 9:16. Other ratios might lead to letterboxing or cropping artifacts.
- **Text Encoding:** Uses a custom MLLM encoder that is significantly better at "reading" prompts than standard CLIP-only models.

## Sources
- [FAL.ai Hunyuan Video Documentation](https://fal.ai/models/fal-ai/hunyuan-video/api)
- [Official GitHub Repository](https://github.com/Tencent-Hunyuan/HunyuanVideo)
- [arXiv:2412.03603 (Technical Report)](https://arxiv.org/abs/2412.03603)
- [Hugging Face Model Card](https://huggingface.co/tencent/HunyuanVideo)
