---
name: fal-ai/flux/dev/image-to-image
display_name: FLUX.1 [dev] Image-to-Image
category: image-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux/dev/image-to-image
original_source: https://blackforestlabs.ai/
summary: A high-performance 12B parameter transformer model for professional-grade image-to-image transformations and style transfers.
---

# FLUX.1 [dev] Image-to-Image

## Overview
- **Slug:** `fal-ai/flux/dev/image-to-image`
- **Category:** Image-to-Image
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** High-fidelity style transfers, character-consistent modifications, and artistic restyling of existing images.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/flux/dev/image-to-image)
- **Original source:** [BFL Documentation](https://docs.bfl.ml/)

## What it does
FLUX.1 [dev] Image-to-Image is a state-of-the-art 12-billion parameter rectified flow transformer designed specifically for transforming existing images based on text prompts. Unlike traditional image-to-image models that often lose structural integrity, this model excels at preserving the core composition of the input while applying complex style transfers, character modifications, and atmospheric changes. It represents the "open-weight" sibling of FLUX.1 [pro], offering competitive prompt adherence and visual quality suitable for professional workflows.

## When to use this model
- **Use when:** You need to change the style of an image (e.g., photo to oil painting), modify specific elements (e.g., change a shirt color), or create variations of a character while keeping the pose and background stable.
- **Don't use when:** You need sub-second generation (use `FLUX.1 [schnell]`) or the absolute highest quality and detail available in the suite (use `FLUX.1 [pro]`).
- **Alternatives:** 
  - `fal-ai/flux-pro/v1.1/image-to-image`: Superior detail and 4MP support.
  - `fal-ai/flux/schnell/image-to-image`: Faster, but lower prompt adherence and fewer inference steps.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux/dev/image-to-image` (sync) / `https://queue.fal.run/fal-ai/flux/dev/image-to-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (Required) | URL | The source image to be transformed. |
| `prompt` | string | (Required) | Text | Natural language description of the desired transformation. |
| `strength` | float | `0.95` | `0.0` to `1.0` | Controls how much the model changes the input image. `1.0` ignores the input mostly; `0.1` makes minimal changes. |
| `num_inference_steps` | integer | `40` | `1` to `50` | Number of denoising steps. Higher values (28-40) are recommended for [dev]. |
| `guidance_scale` | float | `3.5` | `1.5` to `5.0` | Controls stickiness to the prompt. Lower values are more "creative." |
| `seed` | integer | random | Any integer | Seed for reproducible results. |
| `num_images` | integer | `1` | `1` to `4` | Number of images to generate per request. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | Format of the resulting image. |
| `enable_safety_checker`| boolean | `true` | `true`, `false` | Filters NSFW content from results. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns data URI directly (no history). |
| `acceleration` | enum | `none` | `none`, `regular`, `high`| Speed optimizations for inference. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects with `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: Boolean flags for each generated image.
- `timings`: Detailed breakdown of processing time.

### Example request
```json
{
  "image_url": "https://example.com/input.jpg",
  "prompt": "A cinematic oil painting of a cyberpunk city, vibrant neon lights, heavy brushstrokes",
  "strength": 0.85,
  "num_inference_steps": 30,
  "guidance_scale": 3.5,
  "output_format": "png"
}
```

### Pricing
- **Cost:** $0.03 per megapixel per generation.
- **Billing:** Rounded up to the nearest megapixel. For example, a 1024x1024 (~1MP) image costs $0.03.

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX model suite.
- **Endpoint:** `https://api.bfl.ai/v1/flux-dev`
- **Unique Parameters:**
  - `image_prompt`: Supports base64 encoded images directly in the body.
  - `prompt_upsampling`: An optional boolean to automatically enhance the user's prompt for better results.
  - `safety_tolerance`: A range from `0` (most strict) to `6` (least strict) for moderation.
- **Auth Method:** `x-key` header with a BFL API Key.
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/)

## Prompting best practices
- **Use Natural Language:** FLUX was trained on high-quality descriptive captions. Instead of keyword "word salad," use full sentences: *"A high-resolution photo of a man in a red suit standing in a rainy Tokyo street."*
- **Explicit Spatial Relationships:** The model understands positioning very well. Use phrases like *"in the background,"* *"positioned to the left of,"* or *"partially obscured by."*
- **Style Overrides:** If the strength is high (>0.8), be very descriptive about the new style. If strength is low (<0.5), focus the prompt on the *changes* you want to see rather than the base image.
- **Avoid "White Background" in Dev:** A known quirk of the [dev] variant is that the phrase "white background" can sometimes lead to blurry or artifacted results. Use "plain studio background" or "minimalist background" instead.

## Parameter tuning guide
- **Strength (The Magic Slider):** 
  - `0.1 - 0.4`: Subtle touch-ups or color grading changes.
  - `0.5 - 0.7`: Significant changes (changing clothes, hair, or adding accessories) while keeping the person/face structure.
  - `0.8 - 1.0`: Complete restyling or "hallucinating" a new image over the old composition.
- **Steps:** 28 is the official "sweet spot" for [dev], though 40 is FAL's default for higher quality. Going above 50 provides diminishing returns.
- **Guidance Scale:** Stick to `3.5` for most use cases. If the model isn't following the prompt's color or specific object requests, bump to `4.5`. If the image looks "burnt" or over-sharpened, drop to `2.5`.

## Node inputs/outputs
- **Inputs:** 
  - `Image` (URL or File): The base image.
  - `Prompt` (String): The instruction.
  - `Strength` (Float): The transformation intensity.
- **Outputs:** 
  - `Result Image` (URL): The generated image.
  - `Seed` (Integer): For chaining to maintain consistency.
- **Chain-friendly with:** 
  - `fal-ai/flux-lora-fast-training`: Use image-to-image with a custom LoRA for consistent character headswaps.
  - `fal-ai/bria/background-removal`: Clean the input image before restyling for a professional product-shot look.

## Notes & gotchas
- **Max Resolution:** Officially supports up to 2.0 megapixels (e.g., 1440x1440). While some local implementations push to 4MP, FAL's API is optimized for the 1MP - 2MP range.
- **Aspect Ratio:** It is highly flexible with aspect ratios, but performance is best when the target resolution matches the aspect ratio of the input image.
- **Queue Mode:** For production apps, always use the `/queue` endpoint to handle the 15-30 second generation time without timing out.

## Sources
- [FAL.ai FLUX.1 [dev] API Docs](https://fal.ai/models/fal-ai/flux/dev/image-to-image/api)
- [Black Forest Labs Official API Reference](https://docs.bfl.ml/api-reference/models/generate-an-image-with-flux1-[dev])
- [Hugging Face Model Card](https://huggingface.co/black-forest-labs/FLUX.1-dev)
