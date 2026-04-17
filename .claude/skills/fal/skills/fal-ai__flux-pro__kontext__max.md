---
name: fal-ai/flux-pro/kontext/max
display_name: FLUX.1 Kontext [max]
category: image-to-image
creator: Black Forest Labs (BFL)
fal_docs: https://fal.ai/models/fal-ai/flux-pro/kontext/max
original_source: https://docs.bfl.ml/api-reference/models/create-an-image-with-flux1-kontext-[max]-legacy-use-flux2-[pro]-for-editing
summary: A 12B parameter frontier image editing model by Black Forest Labs optimized for prompt adherence, typography, and visual consistency across edits.
---

# FLUX.1 Kontext [max]

## Overview
- **Slug:** `fal-ai/flux-pro/kontext/max`
- **Category:** Image-to-Image / In-Context Generation
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** High-fidelity image editing, character/style preservation, and precise typography.
- **FAL docs:** [fal.ai/models/fal-ai/flux-pro/kontext/max](https://fal.ai/models/fal-ai/flux-pro/kontext/max)
- **Original source:** [docs.bfl.ml](https://docs.bfl.ml/api-reference/models/create-an-image-with-flux1-kontext-[max]-legacy-use-flux2-[pro]-for-editing)

## What it does
FLUX.1 Kontext [max] is a state-of-the-art 12-billion parameter rectified flow transformer designed by [Black Forest Labs](https://docs.bfl.ml/quick_start/introduction). It specializes in "in-context" generation, allowing users to provide a reference image alongside a text prompt to perform precise edits or maintain character and style consistency across multiple scenes ([MindStudio](https://www.mindstudio.ai/blog/what-is-flux-1-kontext-max/)). Compared to the standard "Pro" version, the "Max" variant is optimized for maximum performance in prompt adherence and typographic rendering at the cost of slightly higher latency ([FAL.ai](https://fal.ai/models/fal-ai/flux-pro/kontext/max)).

## When to use this model
- **Use when:** You need to modify an existing image (e.g., adding a hat to a cat, changing a background) while keeping the subject's identity intact.
- **Use when:** Your design requires accurate rendering of complex text or specific typography within an image ([SiliconFlow](https://www.siliconflow.com/models/flux-1-kontext-max)).
- **Use when:** You want to use an image as a "style" or "character" reference for new generations without full fine-tuning.
- **Don't use when:** You need sub-second generation (consider `flux-pro/kontext` or `flux-schnell` for speed).
- **Alternatives:** 
    - `fal-ai/flux-pro/kontext`: Faster and cheaper version of the same architecture, suitable for iterative testing.
    - `fal-ai/flux-pro/v1.1`: The latest general-purpose Flux model; better for text-to-image but lacks native "Kontext" reference image features.
    - `fal-ai/flux-pro/redux`: A specialized model for style and object remixing that works similarly to Kontext but with different weighting.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pro/kontext/max` (sync) / `https://queue.fal.run/fal-ai/flux-pro/kontext/max` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The prompt to generate or edit an image from. |
| `image_url` | string | (required) | N/A | The reference image URL. Used as the basis for editing or style reference. |
| `seed` | integer | random | N/A | Seed for reproducible results. |
| `guidance_scale` | float | 3.5 | 1.0 - 20.0 | Classifier-Free Guidance (CFG) scale for prompt adherence. |
| `aspect_ratio` | enum | `1:1` | `21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:21` | The aspect ratio of the output image. |
| `num_images` | integer | 1 | 1 - 4 | Number of images to generate per request. |
| `output_format` | enum | `jpeg` | `jpeg, png` | Format of the generated image. |
| `safety_tolerance` | enum | `2` | `1, 2, 3, 4, 5, 6` | Level of NSFW filtering (1 = most strict, 6 = most permissive). |
| `enhance_prompt` | boolean | `false` | `true, false` | Whether to use an LLM to expand/improve the prompt for better quality. |
| `sync_mode` | boolean | `false` | `true, false` | If true, returns data URI immediately; otherwise provides a URL. |

### Output
The output is a JSON object containing a list of image objects.
```json
{
  "images": [
    {
      "url": "https://fal.media/files/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/jpeg"
    }
  ],
  "seed": 42,
  "has_nsfw_concepts": [false],
  "prompt": "Restyle to Claymation style",
  "timings": { "inference": 12.5 }
}
```

### Pricing
FAL.ai charges **$0.08 per image** for the Kontext [max] model ([Reddit Stats](https://www.reddit.com/r/FluxAI/comments/1l1bjs5/least_expensive_flux1_kontext_pro/), [PricePerToken](https://pricepertoken.com/image/author/flux)).

## API — via Original Source (BYO-key direct)
Black Forest Labs offers a direct API that exposes features not always present on third-party providers.
- **Endpoint:** `https://api.bfl.ai/v1/flux-kontext-max`
- **Auth method:** `x-key` header with a BFL API Key.
- **Exclusive Parameters:**
    - **Experimental Multiref:** Supports up to 4 reference images (`input_image`, `input_image_2`, `input_image_3`, `input_image_4`) for complex composition blending ([BFL Docs](https://docs.bfl.ml/api-reference/models/create-an-image-with-flux1-kontext-[max]-legacy-use-flux2-[pro]-for-editing)).
    - **Prompt Upsampling:** A native boolean flag for prompt enrichment.
    - **WebP Support:** Native output in `.webp` format.
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/)

*Note: BFL officially marks Kontext [max] as "legacy" and recommends the newer `FLUX.2 [PRO]` for editing workflows, though Kontext remains highly effective for character-specific tasks.*

## Prompting best practices
- **Be Conversational:** Flux models respond better to natural descriptive language than "tag-soup" prompts. Use "A woman sitting on a park bench" instead of "woman, park bench, photorealistic, 8k".
- **Typography:** To render text, use quotes and describe placement: "A neon sign that says 'NEON CITY' over a rainy street."
- **Edit Instructions:** When editing, clearly describe the delta: "Change the cat's fur color to blue" or "Replace the background with a futuristic Mars colony."
- **Reference Awareness:** Mention elements from the reference image to anchor the model: "Keep the woman from the image, but change her dress to a red velvet gown."
- **Example Good Prompt:** "A high-fashion editorial shot of the man in the reference image, now wearing a futuristic chrome suit, standing in the middle of Times Square at night, cinematic lighting, 8k."
- **Common Failure:** Vague prompts like "make it better" or "change everything" often lead to poor results. Be specific about what to keep and what to change.

## Parameter tuning guide
- **Guidance Scale (CFG):** Default is 3.5. Lower values (2.0-3.0) can lead to more "natural" and creative results, while higher values (5.0-7.0) force strict adherence to the text prompt, which is useful for typography but can occasionally introduce artifacts.
- **Aspect Ratio:** Choose the ratio that matches your source image for best "local editing" results. Mismatched ratios may lead to cropping or stretching during the latent encoding phase.
- **Safety Tolerance:** For creative/commercial work, setting this to `5` or `6` prevents over-aggressive filtering of benign images (like statues or medical concepts), though Hive-based filters for extreme content remain active ([Hugging Face](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)).

## Node inputs/outputs
- **Inputs:**
    - `Reference Image` (URL or Image data)
    - `Prompt` (String)
    - `Aspect Ratio` (Dropdown)
    - `Guidance Scale` (Slider, 1-20)
- **Outputs:**
    - `Generated Image` (Image URL)
    - `Seed` (Integer)
- **Chain-friendly with:**
    - `fal-ai/flux-pro/v1.1`: Use Kontext [max] to create a character reference, then pass that character into v1.1 for high-speed scene variations.
    - `fal-ai/face-swap`: Use Kontext to generate a consistent body and style, then refine the face with specialized face-swapping nodes.
    - `fal-ai/flux-lora-fast-training`: Train a LoRA on Kontext-generated images to lock in a style.

## Notes & gotchas
- **Legacy Status:** While extremely capable, BFL is shifting development to `FLUX.2`, which may eventually offer better performance for the same price ([BFL Docs](https://docs.bfl.ml/api-reference/models/create-an-image-with-flux1-kontext-[max]-legacy-use-flux2-[pro]-for-editing)).
- **Character Consistency:** While "Max" is excellent, consistency across very different poses may still require multiple reference images, which is currently only supported via the direct BFL API.
- **Latency:** Expect 10-20 seconds per generation. It is not suitable for real-time applications.

## Sources
- [FAL.ai Model Documentation](https://fal.ai/models/fal-ai/flux-pro/kontext/max)
- [Black Forest Labs API Reference](https://docs.bfl.ml/api-reference/models/create-an-image-with-flux1-kontext-[max]-legacy-use-flux2-[pro]-for-editing)
- [MindStudio Technical Review](https://www.mindstudio.ai/blog/what-is-flux-1-kontext-max/)
- [Hugging Face Model Card (Dev Variant)](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)
- [SiliconFlow Model Insights](https://www.siliconflow.com/models/flux-1-kontext-max)
