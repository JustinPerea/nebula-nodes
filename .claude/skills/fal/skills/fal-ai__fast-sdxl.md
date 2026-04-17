---
name: fal-ai/fast-sdxl
display_name: Stable Diffusion XL (Fast)
category: text-to-image
creator: Stability AI
fal_docs: https://fal.ai/models/fal-ai/fast-sdxl
original_source: https://stability.ai/stable-diffusion
summary: A highly optimized, sub-second inference implementation of SDXL 1.0 for professional-grade 1MP image generation.
---

# Stable Diffusion XL (Fast)

## Overview
- **Slug:** fal-ai/fast-sdxl
- **Category:** Text-to-Image
- **Creator:** Stability AI (optimized by FAL.ai)
- **Best for:** Rapid generation of high-quality 1MP images with full SDXL 1.0 capabilities.
- **FAL docs:** [https://fal.ai/models/fal-ai/fast-sdxl](https://fal.ai/models/fal-ai/fast-sdxl)
- **Original source:** [Stability AI SDXL 1.0](https://stability.ai/stable-diffusion)

## What it does
Stable Diffusion XL (SDXL) 1.0 represented a massive leap forward in the Stable Diffusion ecosystem, featuring a significantly larger parameter count (3.5B base model + 6.6B refiner) compared to its predecessors. The `fal-ai/fast-sdxl` endpoint is FAL.ai's premier high-speed implementation of this architecture. It is specifically tuned to deliver the high-compositional quality of SDXL 1.0 at speeds that rival much smaller models. By optimizing the denoising pipeline and leveraging high-performance GPU clusters, this model can generate 1024x1024 images in under a second, making it ideal for interactive applications, real-time creative tools, and high-volume production pipelines.

The model excels at understanding complex spatial relationships, rendering legible (though still occasionally imperfect) text, and producing realistic human anatomy—areas where previous SD iterations often struggled. It supports the full suite of SDXL features, including multi-aspect ratio training and fine-grained control via LoRAs and Embeddings.

## When to use this model
- **Use when:** You need professional-grade image quality with high fidelity and prompt adherence, but cannot afford the 5-10 second wait times of standard diffusion endpoints. It is the "workhorse" model for most modern AI image workflows.
- **Don't use when:** You need the absolute state-of-the-art text rendering or prompt adherence (in which case, move to **FLUX.1 [pro]** or **DALL-E 3**) or when you are working on a strictly constrained budget where the lower-quality but cheaper SD v1.5 might suffice.
- **Alternatives:** 
    - **fal-ai/flux-pro**: Superior at complex text and hyper-realistic human features, though slower and more expensive.
    - **fal-ai/sdxl-turbo**: Faster (1-step generation) but limited to 512x512 resolution and significantly lower compositional detail.
    - **fal-ai/stable-diffusion-v1-5**: Much cheaper and faster for low-res prototyping or when using very specific older LoRAs.
    - **fal-ai/aura-flow**: An alternative high-quality open-weights model with a different aesthetic profile.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/fast-sdxl` (Synchronous) / `https://queue.fal.run/fal-ai/fast-sdxl` (Asynchronous/Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The core description of the image. Works best with descriptive, natural language. |
| `negative_prompt` | string | `""` | N/A | Defines what the model should avoid. Less critical for SDXL than for SD 1.5, but still useful for removing "styles" like "cartoon" or "3D render". |
| `image_size` | enum/object | `"square_hd"` | `square_hd` (1024x1024), `square` (512x512), `portrait_4_3` (768x1024), `portrait_16_9` (576x1024), `landscape_4_3` (1024x768), `landscape_16_9` (1024x576) | Sets the dimensions. You can also pass a custom object: `{"width": 1024, "height": 1024}`. |
| `num_inference_steps` | integer | `25` | 1 - 50 | The number of iterations the model performs. 20-30 is the "sweet spot" for SDXL; going beyond 40 rarely adds visible quality but increases cost/latency. |
| `guidance_scale` | float | `7.5` | 0.0 - 20.0 | Also known as CFG Scale. Higher values make the output stick more rigidly to the prompt; lower values allow for more artistic "hallucination". |
| `seed` | integer | random | 0 - 2^32 | Used to lock the random noise generation. Providing the same seed with the same prompt will yield the same image. |
| `num_images` | integer | `1` | 1 - 4 | Number of unique images to generate in a single request. |
| `expand_prompt` | boolean | `false` | `true`, `false` | When enabled, FAL uses an LLM to rewrite and "beef up" your prompt for better aesthetics. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Enables the post-generation NSFW filter. If triggered, the image will be blocked. |
| `safety_checker_version` | enum | `"v1"` | `"v1"`, `"v2"` | `v1` is the standard CompVis checker; `v2` is a more modern, less prone to false-positives version. |
| `format` | enum | `"jpeg"` | `"jpeg"`, `"png"` | The compression format. JPEG is faster for transfers; PNG is lossless. |
| `loras` | array | `[]` | N/A | A list of LoRA objects: `[{"path": "URL_TO_SAFE_TENSORS", "scale": 1.0}]`. Allows for specific character or style injection. |
| `embeddings` | array | `[]` | N/A | A list of Textual Inversion embeddings to guide the model's understanding of specific concepts. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the image as a base64 Data URI in the response body instead of a hosted URL. |

### Output Schema
The standard response returns a JSON object:
- **`images`**: An array of objects, each containing:
    - `url`: A temporary URL to the generated image (hosted on FAL's CDN).
    - `width`/`height`: The final dimensions.
    - `content_type`: e.g., "image/jpeg".
- **`seed`**: The seed used (useful for logging if you didn't provide one).
- **`has_nsfw_concepts`**: Array of booleans corresponding to the `images` array.
- **`prompt`**: The final prompt string (reflects expansions if used).
- **`timings`**: Performance telemetry (inference time, queue time).

### Example request
```json
{
  "prompt": "Cinematic portrait of a cyberpunk hacker in a neon-lit rain-slicked alley, wearing a chrome mask, hyper-realistic, 8k resolution, volumetric lighting",
  "negative_prompt": "low quality, blurry, distorted eyes, extra limbs, cartoon, 2d",
  "image_size": {
    "width": 1024,
    "height": 1024
  },
  "num_inference_steps": 28,
  "guidance_scale": 7.5,
  "expand_prompt": true
}
```

### Pricing
FAL.ai bills based on usage. 
- **Cost:** Approximately **$0.003 per image** (for 1MP images).
- Pricing is typically normalized to 1MP; higher resolutions or more steps may increase the cost.
- GPU-based pricing (if using private deployments) starts at ~$0.99/hr for A100 or ~$1.89/hr for H100.

## API — via Original Source (BYO-key direct)
Stability AI provides a direct API for SDXL models:
- **Endpoint:** `https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image`
- **Auth method:** Bearer Token (API Key)
- **Parameters:** Similar to FAL but uses `text_prompts` (array of objects with weights) instead of a single string. Includes `style_preset`, `sampler`, and `clip_guidance_preset`.
- **Official Docs:** [Stability AI API Docs](https://platform.stability.ai/docs/api-reference#tag/v1generation/operation/textToImage)

## Prompting best practices
- **Be Descriptive, Not Just Keywords**: Unlike SD 1.5, SDXL understands natural language. Instead of a "keyword soup" like `face, beautiful, hyperreal, 8k`, use a descriptive sentence: `A close-up portrait of a weathered sailor with a thick white beard, gazing at the horizon during a stormy sunset.`
- **Use Photographic Language**: SDXL was trained extensively on photographic datasets. Keywords like `f/1.8`, `85mm lens`, `shallow depth of field`, `soft rim lighting`, and `Kodak Portra 400` are highly effective for achieving realism.
- **The "Subject-First" Rule**: Put your primary subject at the very beginning of the prompt. The model gives more weight to the first 20 tokens.
- **Negative Prompting (The "Less is More" approach)**: Modern models like SDXL often perform *worse* if you provide a 200-word negative prompt copied from a forum. Keep it targeted: `cartoon, illustration, 3d render` is usually enough to force photorealism.
- **Style Tokens**: For specific aesthetics, use known strong tokens:
    - **Cinematic:** `high dynamic range, anamorphic flares, cinematic color grading`
    - **Macro:** `extreme close up, microscopic detail, macro lens`
    - **Artistic:** `impasto oil painting, thick brushstrokes, vibrant palette`

## Parameter tuning guide
- **Steps (25-28 is the Sweet Spot)**: While the model supports up to 50 steps, you will see diminishing returns after 28. For most "fast" use cases, 25 is perfect. Use 35+ only for very complex textures like intricate lace or fine jewelry.
- **CFG Scale (7.0 for realism, 9.0+ for "punch")**: A CFG of 7.0 provides the most natural lighting and color. If you find the images look "washed out" or don't follow a color instruction, bump it to 8.5 or 9.5. Avoid going above 12.0 as it can cause "burn" (oversaturated pixels).
- **LoRA Scaling (0.6 - 0.8)**: When using LoRAs, starting at a scale of 1.0 often overpowers the base model's anatomy. 0.7 is usually the ideal balance for style LoRAs.
- **Resolution and Composition**: SDXL is highly sensitive to aspect ratio. If you generate a 1024x1024 (1:1) image, the model will try to center the subject. For landscapes, always use `landscape_16_9` to get proper horizon placement.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - **Prompt** (Text Area): The primary creative driver.
    - **Negative Prompt** (Text Area): For quality control and style avoidance.
    - **Aspect Ratio** (Dropdown): Presets for Square, Portrait, Landscape.
    - **Inference Steps** (Slider, 1-50): Controls quality vs. speed.
    - **CFG Scale** (Slider, 1-20): Controls prompt adherence.
    - **Seed** (Input/Randomizer): For reproducibility.
- **Outputs:**
    - **Image** (Image Port): The generated visual asset.
    - **Seed Output** (Integer): To pass to downstream nodes for consistent variations.
    - **NSFW Flag** (Boolean): To trigger "safe-mode" filters in UI nodes.
- **Chain-friendly with:**
    - **fal-ai/face-restore**: Essential for cleaning up tiny faces in wide shots.
    - **fal-ai/creative-upscaler**: To take the native 1MP output and push it to 4MP or 8MP with added detail.
    - **fal-ai/layered-diffusion**: To generate transparent PNGs by chaining this model's output as a base.
    - **fal-ai/image-to-image**: Use this model's output as the `image_url` input for a second pass (img2img) to refine details.

## Notes & gotchas
- **Cold Starts**: Although rare on FAL's "fast" endpoints, the first request after a period of inactivity might take 2-3 seconds longer as the model is loaded into VRAM.
- **Rate Limits**: Standard API accounts are subject to rate limits (check your FAL dashboard), typically around 10-20 concurrent requests.
- **Region Availability**: FAL serves requests from multiple global regions; however, LoRA paths must be publicly accessible URLs for the worker to download them.
- **Safety Checker**: The safety checker can sometimes be "over-aggressive" with certain artistic styles or skin-tone heavy images (like renaissance paintings). Switch to `v2` or adjust the prompt if you hit false positives.

## Sources
- [FAL.ai fast-sdxl API Docs](https://fal.ai/models/fal-ai/fast-sdxl/api)
- [Stability AI SDXL 1.0 Announcement](https://stability.ai/stable-diffusion)
- [SDXL Technical Report (ArXiv)](https://arxiv.org/abs/2307.01952)
- [Civitai SDXL Guide](https://civitai.com/articles/2246/sdxl-image-size-cheat-sheet)
