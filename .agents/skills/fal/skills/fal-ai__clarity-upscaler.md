---
name: fal-ai/clarity-upscaler
display_name: Clarity Upscaler
category: upscaling
creator: philz1337x (Clarity AI)
fal_docs: https://fal.ai/models/fal-ai/clarity-upscaler
original_source: https://github.com/philz1337x/clarity-upscaler
summary: A high-fidelity image upscaler and enhancer based on Stable Diffusion and ControlNet, designed as a powerful alternative to Magnific AI.
---

# Clarity Upscaler

## Overview
- **Slug:** `fal-ai/clarity-upscaler`
- **Category:** Image-to-Image / Upscaling
- **Creator:** [philz1337x](https://github.com/philz1337x) (Clarity AI)
- **Best for:** Enhancing low-resolution images with realistic detail and texture reconstruction.
- **FAL docs:** [fal-ai/clarity-upscaler](https://fal.ai/models/fal-ai/clarity-upscaler)
- **Original source:** [GitHub Repository](https://github.com/philz1337x/clarity-upscaler), [ClarityAI.co](https://clarityai.co)

## What it does
Clarity Upscaler is an advanced image enhancement tool that goes beyond simple pixel interpolation. It uses a **diffusion-based approach** ([Upsampler](https://upsampler.com/free-clarity-ai-upscaler-no-sign-up)) powered by Stable Diffusion 1.5, ControlNet Tile, and 4x-UltraSharp ESRGAN to intelligently reconstruct and enhance image details ([Hugging Face](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)). By performing a partial denoise, it generates new high-frequency details—such as skin pores, hair strands, and fabric textures—while maintaining strict structural fidelity to the original image ([WaveSpeedAI](https://wavespeed.ai/blog/posts/introducing-clarity-ai-flux-upscaler-on-wavespeedai/)).

## When to use this model
- **Use when:** You need to upscale AI-generated art, old photographs, or compressed social media images while adding "hallucinated" but realistic micro-details.
- **Don't use when:** You require forensic accuracy where no new details should be invented (e.g., medical imaging or legal evidence).
- **Alternatives:**
  - **[Crystal Upscaler](https://fal.ai/models/clarityai/crystal-upscaler):** Better for portraits and facial restoration.
  - **[SUPIR](https://fal.ai/models/fal-ai/supir):** A more "heavyweight" model that provides even higher quality but at a significantly higher compute cost ([Reddit](https://www.reddit.com/r/StableDiffusion/comments/1kz9q84/comparing_a_few_different_upscalers_2025/)).
  - **[AuraSR](https://fal.ai/models/fal-ai/aurasr):** A faster, more "faithful" upscaler that adds less creative detail.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/clarity-upscaler` (sync) / `https://queue.fal.run/fal-ai/clarity-upscaler` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | (Required) | URL | The URL of the image to upscale. |
| `prompt` | `string` | `"masterpiece, best quality, highres"` | Text | Guidance for the enhancement process. |
| `negative_prompt` | `string` | `"(worst quality, low quality, normal quality:2)"` | Text | Details to avoid in the upscaled image. |
| `upscale_factor` | `float` | `2` | 1.0 - 4.0 (standard) | The multiplier for the output resolution. |
| `creativity` | `float` | `0.35` | 0.0 - 1.0 | Denoise strength; higher values add more new detail ([Hugging Face](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)). |
| `resemblance` | `float` | `0.6` | 0.0 - 1.0 | ControlNet strength; higher values keep the original structure ([Hugging Face](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)). |
| `guidance_scale` | `float` | `4` | 1.0 - 20.0 | CFG scale; how closely the model follows the prompt. |
| `num_inference_steps` | `integer` | `18` | 10 - 50 | Number of denoising steps. |
| `seed` | `integer` | (Random) | Integer | For reproducible results. |
| `enable_safety_checker` | `boolean` | `true` | `true`/`false` | Filters NSFW content. |

### Output
The output returns an object containing the upscaled image details:
- **`image`**: Object containing `url` (string), `width`, `height`, `content_type`, and `file_size`.
- **`seed`**: The seed used for the generation.
- **`timings`**: Execution time for different pipeline stages.

### Example request
```json
{
  "image_url": "https://example.com/photo.jpg",
  "prompt": "highly detailed skin texture, 8k, professional photography",
  "creativity": 0.4,
  "resemblance": 0.7,
  "upscale_factor": 2
}
```

### Pricing
- **Cost:** **$0.03 per megapixel** ([fal.ai Pricing](https://fal.ai/pricing)).
- Pricing is proportional to the **output** resolution. For example, a 4MP output (e.g., 2000x2000) costs $0.12.

## API — via Original Source (BYO-key direct)
The original model is open-source and can be accessed directly via Replicate:
- **Endpoint:** `https://replicate.com/philz1337x/clarity-upscaler`
- **Auth Method:** Replicate API Token.
- **Notes:** Replicate pricing is approximately **$0.012 per run** ([Replicate](https://replicate.com/philz1337x/clarity-upscaler)) on A100 hardware, which can be cheaper than megapixel-based pricing for large upscales.

## Prompting best practices
- **Describe the target texture:** Use keywords like "pores", "fabric weave", "weathered wood", or "fine brushstrokes" to guide the `creativity` engine.
- **Keep it simple:** The model is an enhancer, not a generator. Avoid complex scene descriptions; focus on quality and style tokens (e.g., "cinematic lighting", "ultra-sharp").
- **Negative prompt is key:** To prevent "over-cooked" or "plastic" looks, ensure the negative prompt includes `(deformed, distorted, over-saturated, plastic skin)`.
- **Match the base style:** If upscaling an oil painting, include "oil painting, canvas texture" in the prompt to ensure added details match the medium.

## Parameter tuning guide
- **`creativity` (0.35 - 0.45):** This is the "hallucination" slider. Set to **0.3** for faithful restoration of clean photos. Set to **0.5+** for heavily compressed images where the model needs to "guess" missing details.
- **`resemblance` (0.6 - 0.8):** This controls structural integrity. If you notice faces changing shape or lines becoming wobbly, increase this to **0.75+**.
- **`upscale_factor`:** For best results, perform 2x upscales sequentially rather than a single 4x jump if the input is very low-res ([Hugging Face](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)).
- **`guidance_scale` (4 - 7):** Keep this low (around **4**) for photorealistic results. Higher values (7+) can make the image look too "contrasty" or stylized.

## Node inputs/outputs
- **Inputs:**
  - `Image` (URL/File): The source image.
  - `Prompt` (String): Enhancement instructions.
  - `Creativity` (Float): Detail generation strength.
  - `Resemblance` (Float): Fidelity strength.
- **Outputs:**
  - `Upscaled Image` (URL): The final enhanced image.
- **Chain-friendly with:**
  - **[Flux.1 Dev](https://fal.ai/models/fal-ai/flux/dev):** Generate a 1MP image, then pass it to Clarity for a 4MP professional finish.
  - **[Remove Background](https://fal.ai/models/fal-ai/bria/background-removal):** Clean the background before upscaling to avoid enhancing unwanted background artifacts.

## Notes & gotchas
- **Tile Artifacts:** The model uses **MultiDiffusion (tiling)**. On very high resolutions, you might occasionally see faint "seams" if the creativity is too high ([Hugging Face](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)).
- **Face Distortion:** While good for general images, use **Crystal Upscaler** specifically for portraits if identity preservation is the top priority.
- **Memory Limits:** Extremely large upscales (resulting in 20MP+) may time out or fail on standard serverless instances.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/clarity-upscaler)
- [Clarity AI GitHub Repository](https://github.com/philz1337x/clarity-upscaler)
- [Hugging Face Technical Reproduction](https://huggingface.co/blog/1aurent/clarity-ai-upscaler-reproduction)
- [Replicate Model Card](https://replicate.com/philz1337x/clarity-upscaler)