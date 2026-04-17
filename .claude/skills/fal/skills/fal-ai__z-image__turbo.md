---
name: fal-ai/z-image/turbo
display_name: Z-Image Turbo
category: text-to-image
creator: Alibaba Tongyi-MAI
fal_docs: https://fal.ai/models/fal-ai/z-image/turbo
original_source: https://github.com/Tongyi-MAI/Z-Image
summary: A lightning-fast 6B-parameter text-to-image model by Alibaba optimized for sub-second generation and bilingual text rendering.
---

# Z-Image Turbo

## Overview
- **Slug:** `fal-ai/z-image/turbo`
- **Category:** Text-to-Image
- **Creator:** [Alibaba Tongyi-MAI](https://github.com/Tongyi-MAI/Z-Image)
- **Best for:** Ultra-fast, real-time image generation with accurate English/Chinese text rendering.
- **FAL docs:** [fal.ai/models/fal-ai/z-image/turbo](https://fal.ai/models/fal-ai/z-image/turbo)
- **Original source:** [Tongyi-MAI/Z-Image (GitHub)](https://github.com/Tongyi-MAI/Z-Image) / [Hugging Face](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)

## What it does
Z-Image Turbo is a highly efficient 6-billion parameter text-to-image model designed for production environments where latency and throughput are critical. Developed by Alibaba's Tongyi Lab, it utilizes a Scalable Single-Stream Diffusion Transformer (S3-DiT) architecture and advanced Decoupled-DMD distillation to achieve high-quality, photorealistic results in just 8 inference steps ([Artificial Analysis](https://artificialanalysis.ai/)). It is particularly noted for its ability to render legible text in both English and Chinese directly within the image ([Hugging Face](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)).

## When to use this model
- **Use when:** You need sub-second generation for real-time applications, interactive creative tools, or high-volume asset generation where cost-per-megapixel is a priority.
- **Don't use when:** You require maximum artistic detail or complex multi-subject compositions that larger models like FLUX.1 [pro] handle better.
- **Alternatives:** 
    - **FLUX.1 [schnell]:** Similar speed but larger parameter count; better for complex prompt adherence at the cost of higher VRAM.
    - **Stable Diffusion 3.5 Large Turbo:** Highly versatile for artistic styles but may be slower than Z-Image's 6B optimized architecture.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/z-image/turbo` (sync) / `https://queue.fal.run/fal-ai/z-image/turbo` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text prompt describing the image content and style. |
| `image_size` | enum/object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{width, height}` | The dimensions of the generated image. Custom sizes up to 4MP are supported. |
| `num_inference_steps` | integer | `8` | 1–25 | Number of denoising steps. 4–8 is the "Turbo" sweet spot. |
| `seed` | integer | random | 0–2^32 | Used for reproducible generations. |
| `num_images` | integer | `1` | 1–4 | Number of images to generate in a single batch. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the media as a data URI immediately. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Filters for NSFW content. |
| `output_format` | enum | `jpeg` | `jpeg`, `png`, `webp` | File format of the resulting image. |
| `acceleration` | enum | `none` | `none`, `regular`, `high` | Internal optimization level for inference speed. |
| `enable_prompt_expansion` | boolean | `false` | `true`, `false` | Automatically improves short prompts for $0.0025 extra. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects with `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: A list of booleans indicating if the corresponding image triggered safety filters.
- `timings`: Generation metadata (inference time, etc.).

### Example request
```json
{
  "prompt": "A futuristic cityscape at night with neon signs in Chinese and English saying 'Z-Image' and '造相', 8k resolution, cinematic lighting",
  "image_size": "landscape_16_9",
  "num_inference_steps": 8,
  "enable_safety_checker": true
}
```

### Pricing
- **Base Rate:** $0.005 per megapixel ([fal.ai pricing](https://fal.ai/models/fal-ai/z-image/turbo)).
- **Prompt Expansion:** +$0.0025 per request.

## API — via Original Source (BYO-key direct)
The model is hosted on Alibaba's official platforms:
- **DashScope (Alibaba Cloud):** `z-image-turbo` via the DashScope SDK or REST API ([Alibaba Cloud Docs](https://www.alibabacloud.com/help/en/model-studio/z-image-api-reference)).
- **ModelScope:** Accessible via `api-inference.modelscope.cn` ([ModelScope](https://www.modelscope.cn/models/Tongyi-MAI/Z-Image-Turbo)).
- **Parameters:** Native endpoints may support `guidance_scale` (recommended 0.0 for Turbo) and `negative_prompt` (though typically ignored by the distilled Turbo variant).

## Prompting best practices
- **Camera-First Structure:** Start with composition and shot type (e.g., "Close-up portrait", "Wide-angle landscape") to steer the S3-DiT architecture effectively ([GitHub](https://github.com/Tongyi-MAI/Z-Image)).
- **In-Prompt Constraints:** Z-Image Turbo **ignores separate negative prompts**. To exclude elements, use natural language within the main prompt (e.g., "...with a plain background and no text or watermarks").
- **Bilingual Advantage:** Use Chinese characters for specific cultural nuances or text rendering; the model excels at "造相" (Z-Image) and complex glyphs.
- **Avoid Vague Tags:** Use descriptive sentences rather than comma-separated tag lists. "A woman wearing a red silk dress" performs better than "woman, red dress, silk, highly detailed".
- **Lighting Keywords:** The model is highly responsive to lighting tokens like "rim lighting", "volumetric fog", or "golden hour" due to its aesthetic-heavy training data.

## Parameter tuning guide
- **Steps (num_inference_steps):** Use **8 steps** for the intended Turbo experience. Going below 4 steps significantly degrades quality; going above 12 steps provides diminishing returns and may introduce artifacts unless the model is running in non-distilled mode.
- **Guidance Scale:** If using a raw implementation (like ComfyUI), set `guidance_scale` to **0.0 or 1.0**. The Turbo distillation (Decoupled-DMD) is designed to operate without classifier-free guidance at inference ([arXiv:2511.22699](https://arxiv.org/abs/2511.22699)).
- **Resolution:** Stick to standard aspect ratios (1024x1024, 1280x720). While it supports up to 4MP, extreme aspect ratios can cause subject duplication or "tiling" artifacts.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Resolution` (Select: Square, Landscape, Portrait)
    - `Steps` (Slider: 1–25)
    - `Seed` (Integer/Random)
    - `Safety Filter` (Toggle)
- **Outputs:**
    - `Image URL` (Link)
    - `Seed` (Integer)
- **Chain-friendly with:**
    - **Qwen-VL:** Use to generate highly descriptive prompts from reference images before feeding into Z-Image.
    - **SigLIP 2:** For upstream image analysis or embedding comparison.
    - **RMBG (Remove Background):** Essential for UI/UX workflows to clean up Z-Image's often complex backgrounds.

## Notes & gotchas
- **No Negative Prompt Support:** This is the most common failure point for users coming from Stable Diffusion. Ensure all "negatives" are written as "without [X]" or "[X]-free" in the primary prompt.
- **Bilingual Focus:** The model was heavily trained on Chinese/English pairs; it may struggle with other languages (Spanish, French, etc.) for text rendering compared to its native bilingual capabilities.
- **VRAM Footprint:** For local users, the 6B parameter size fits well in 16GB VRAM, but fal's API abstracts this for cloud users.

## Sources
- [FAL.ai Z-Image Turbo Documentation](https://fal.ai/models/fal-ai/z-image/turbo)
- [Tongyi-MAI/Z-Image GitHub Repository](https://github.com/Tongyi-MAI/Z-Image)
- [Z-Image Technical Report (arXiv:2511.22699)](https://arxiv.org/abs/2511.22699)
- [Hugging Face Model Card: Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)
- [Alibaba Cloud Model Studio API Reference](https://www.alibabacloud.com/help/en/model-studio/z-image-api-reference)