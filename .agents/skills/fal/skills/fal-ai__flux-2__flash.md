---
name: fal-ai/flux-2/flash
display_name: FLUX.2 Flash
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2/flash
original_source: https://docs.bfl.ml/flux_2/flux2_overview
summary: A lightning-fast, high-fidelity text-to-image model by Black Forest Labs, optimized for sub-second generation with precise prompt following and 4MP output.
---

# FLUX.2 Flash

## Overview
- **Slug:** `fal-ai/flux-2/flash`
- **Category:** Text-to-Image
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** Ultra-fast, high-quality image generation where latency is critical (e.g., real-time apps, interactive design tools).
- **FAL docs:** [fal.ai/models/fal-ai/flux-2/flash](https://fal.ai/models/fal-ai/flux-2/flash)
- **Original source:** [docs.bfl.ml](https://docs.bfl.ml/flux_2/flux2_overview)

## What it does
FLUX.2 Flash is a speed-optimized variant of the state-of-the-art FLUX.2 [dev] model from [Black Forest Labs](https://bfl.ai/). It leverages timestep distillation to achieve sub-second inference times while maintaining the exceptional realism, sharp text rendering, and compositional accuracy of the base model. It is capable of generating images up to 4 megapixels (e.g., 2048x2048) and excels at following complex, natural language prompts and specific color requirements (via hex codes).

## When to use this model
- **Use when:** You need high-quality images in under a second; you require specific text to be rendered within an image; you are building an interactive "AI canvas" or real-time preview feature.
- **Don't use when:** You need the absolute maximum creative fidelity and nuanced detail offered by `flux-2/pro` or `flux-2/max`; you require fine-grained control over inference steps (use `flux-2/flex`).
- **Alternatives:**
    - `fal-ai/flux-2/pro`: Higher quality and better aesthetic finish, but slower and more expensive.
    - `fal-ai/flux-2/flex`: Offers manual control over inference steps (10-50) and guidance scale.
    - `fal-ai/flux-2/max`: BFL's flagship model with "grounding search" for real-time world knowledge.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2/flash` (Sync) / `https://queue.fal.run/fal-ai/flux-2/flash` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | **Required** | N/A | The description of the image to generate. Supports long, descriptive text. |
| `guidance_scale` | `float` | `2.5` | `0` to `20` | Measure of how closely the model sticks to the prompt. Higher values increase adherence but may reduce realism. |
| `image_size` | `enum/object` | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Preset dimensions. Also accepts an object `{ "width": int, "height": int }` (512-2048px). |
| `num_images` | `integer` | `1` | `1` to `4` | Number of images to generate per request. |
| `seed` | `integer` | Optional | N/A | Seed for reproducibility. If omitted, a random seed is used. |
| `enable_prompt_expansion` | `boolean` | `false` | `true`, `false` | If true, automatically expands the prompt for more detailed results. |
| `enable_safety_checker` | `boolean` | `true` | `true`, `false` | Enables/disables the built-in NSFW safety filter. |
| `output_format` | `string` | `png` | `jpeg`, `png`, `webp` | File format of the resulting image. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If true, returns media as a data URI and skips request history. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects, each containing:
    - `url`: The URL to the generated image.
    - `width`/`height`: Dimensions of the image.
    - `content_type`: Mime type (e.g., `image/png`).
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: A list of booleans indicating if any images were flagged.
- `timings`: Metadata about inference duration.

### Example request
```json
{
  "prompt": "A professional cinematic shot of a futuristic cyberpunk city at night, neon signs in Japanese, rain-slicked streets reflecting the light, 8k resolution, highly detailed.",
  "image_size": "landscape_16_9",
  "guidance_scale": 3.5,
  "output_format": "jpeg"
}
```

### Pricing
- **$0.005 per megapixel** ([FAL.ai Pricing](https://fal.ai/pricing)).
- A standard 1024x1024 (1MP) image costs $0.005.

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX.2 family, including the fast "klein" variant which corresponds to Flash.

- **Endpoint:** `https://api.bfl.ai/v1/flux-2-klein-4b`
- **Auth Method:** `x-key` header with BFL API Key.
- **Unique Parameters:**
    - `safety_tolerance`: Range `0` (strict) to `6` (permissive).
    - `prompt_upsampling`: Manual toggle for BFL's internal prompt enhancement.
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/flux_2/flux2_text_to_image)

## Prompting best practices
- **Be Descriptive:** FLUX.2 Flash handles long, complex prompts (up to 512 tokens) very well. Instead of "a car," use "a vintage 1960s red sports car parked on a cobblestone street in Rome at sunset."
- **Use Hex Codes:** You can specify exact colors using hex codes (e.g., "a logo with color #FF5733").
- **Specify Text:** Use double quotes for text you want rendered (e.g., `a neon sign that says "OPEN"`).
- **Compositional Control:** Mention camera angles (e.g., "low angle shot," "macro lens") and lighting ("soft volumetric lighting").
- **Prompt Structure:** Start with the subject, followed by the environment, lighting, and finally the style/medium.

## Parameter tuning guide
- **Guidance Scale:** Stick to the default `2.5` for most photorealistic results. Move to `3.5 - 5.0` if the model is ignoring specific parts of your prompt. Avoid going above `7.0` unless seeking a highly stylized/saturated look.
- **Image Size:** For the best composition, use one of the standard aspect ratio presets. If using custom sizes, ensure they are multiples of 8 or 16 for optimal performance.
- **Seed:** Always log the `seed` from the output if you want to perform "iterative prompting" (changing the prompt slightly while keeping the same seed to maintain composition).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Negative Prompt` (Not explicitly supported by FLUX, but can be simulated in the main prompt)
    - `Image Size` (Dropdown/Object)
    - `Guidance Scale` (Slider, 0-20)
    - `Seed` (Integer)
- **Outputs:**
    - `Image URL` (Image/URL)
    - `Seed Used` (Integer)
- **Chain-friendly with:**
    - `fal-ai/flux-2/flash/edit`: For performing image-to-image modifications on the output.
    - `fal-ai/upscaler`: To take the 4MP output and push it to 8K or beyond.

## Notes & gotchas
- **Max Resolution:** While the model supports up to 4MP, the recommended range for consistent quality is up to 2MP.
- **No Negative Prompt:** FLUX.2 is trained to follow positive instructions. Instead of saying "no people," say "an empty landscape."
- **Prompt Adherence:** Unlike FLUX.1, FLUX.2 Flash does not include automatic prompt upsampling by default on the FAL endpoint; what you type is exactly what the model processes.

## Sources
- [FAL.ai Flux 2 Flash Documentation](https://fal.ai/models/fal-ai/flux-2/flash/api)
- [Black Forest Labs FLUX.2 Overview](https://docs.bfl.ml/flux_2/flux2_overview)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [BFL Text-to-Image Integration Guide](https://docs.bfl.ml/flux_2/flux2_text_to_image)