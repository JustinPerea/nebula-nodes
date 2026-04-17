---
name: fal-ai/flux-pro/v1.1
display_name: FLUX1.1 [pro]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-pro/v1.1
original_source: https://blackforestlabs.ai/
summary: State-of-the-art flagship text-to-image model by Black Forest Labs, featuring 10x faster speeds, exceptional prompt adherence, and photorealistic output.
---

# FLUX1.1 [pro]

## Overview
- **Slug:** `fal-ai/flux-pro/v1.1`
- **Category:** Text-to-Image
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** High-speed, professional-grade photorealistic image generation with complex prompt adherence.
- **FAL docs:** [fal-ai/flux-pro/v1.1](https://fal.ai/models/fal-ai/flux-pro/v1.1)
- **Original source:** [Black Forest Labs Documentation](https://docs.bfl.ml/flux_models/flux_1_1_pro)

## What it does
FLUX1.1 [pro] is the flagship "next-generation" model from [Black Forest Labs](https://blackforestlabs.ai/), the team behind the original Stable Diffusion. It is designed to be **10x faster** than the original FLUX.1 [pro] while delivering superior image quality, composition, and artistic fidelity ([fal.ai](https://fal.ai/models/fal-ai/flux-pro/v1.1)). It utilizes a 12-billion parameter rectified flow transformer architecture to produce high-resolution images that excel in text rendering, anatomical accuracy, and photorealism ([MindStudio](https://www.mindstudio.ai/blog/what-is-flux-1-1-pro/)).

## When to use this model
- **Use when:** You need the highest possible quality for commercial work, accurate text within images, or extremely fast generation times (~4-5 seconds).
- **Don't use when:** You are on a very tight budget (use `FLUX.1 [schnell]` or `FLUX.2 [klein]` for lower costs) or need open-weight models for local deployment.
- **Alternatives:** 
    - **FLUX.1 [pro]:** The previous flagship; slower but very reliable.
    - **FLUX.1 [dev]:** Open-weight version suitable for LoRA training and non-commercial fine-tuning.
    - **FLUX.1 [ultra]:** Higher resolution (up to 4MP) and "Raw" mode for even deeper photorealism ([Black Forest Labs](https://docs.bfl.ml/flux_models/flux_1_1_pro_ultra_raw)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pro/v1.1` (Sync) / `https://queue.fal.run/fal-ai/flux-pro/v1.1` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | The description of the image you want to generate. |
| `image_size` | enum/object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{width: int, height: int}` | The size of the generated image. Custom sizes can be passed as an object. |
| `seed` | integer | Random | N/A | Used for reproducibility. Same seed and prompt yield the same result. |
| `num_images` | integer | `1` | `1-4` | Number of images to generate per request. |
| `guidance_scale` | float | `3.5` | `1.0 - 20.0` | Measure of how strictly the model follows the prompt (CFG). |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, media is returned as a data URI and not saved in history. |
| `output_format` | enum | `jpeg` | `jpeg`, `png` | Format of the generated image. |
| `safety_tolerance` | integer | `2` | `1, 2, 3, 4, 5, 6` | Level of safety filtering (1 = strictest, 6 = most permissive). |
| `enhance_prompt` | boolean | `false` | `true`, `false` | Whether to use an LLM to expand/refine the prompt for better results. |

### Output
The API returns a JSON object containing:
- `images`: A list of image objects, each with a `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: A list of booleans indicating if NSFW content was detected.
- `timings`: Detailed breakdown of inference time.

### Example request
```json
{
  "prompt": "A cinematic shot of a futuristic neon city under heavy rain, high detail, 8k resolution, photorealistic",
  "image_size": "landscape_16_9",
  "guidance_scale": 3.5,
  "output_format": "jpeg"
}
```

### Pricing
- **FAL.ai:** Approximately **$0.04 per megapixel** ([fal.ai](https://fal.ai/pricing)). Standard 1MP images (1024x1024) cost ~$0.04.
- **Black Forest Labs API:** **$0.04 per image** ([Black Forest Labs](https://docs.bfl.ml/flux_models/flux_1_1_pro)).

## API — via Original Source (BYO-key direct)
**Creator:** Black Forest Labs
- **Endpoint:** `https://api.bfl.ai/v1/flux-pro-1.1`
- **Auth Method:** Bearer Token (API Key)
- **Additional Parameters:** Supports `webhook_url` and `webhook_secret` for asynchronous status updates ([Black Forest Labs Docs](https://docs.bfl.ml/flux_models/flux_1_1_pro)).
- **Link:** [BFL API Reference](https://docs.bfl.ml/api-reference/get-the-users-credits)

## Prompting best practices
- **Be Descriptive:** FLUX excels at following long, descriptive natural language prompts. Instead of keywords like "8k, masterpiece," use full sentences describing textures, lighting, and camera angles.
- **Text Rendering:** To include text, put the text in quotes (e.g., `a neon sign that says "FLUX 1.1"`). The model is remarkably good at spelling.
- **Raw Mode Logic:** While "Raw" mode is a specific feature of the [Ultra variant](https://bfl.ai/models/flux-pro-ultra), you can simulate it in Pro 1.1 by using keywords like "unprocessed," "DSLR photography," and "natural skin textures."
- **Avoid Over-Prompting:** Don't crowd the prompt with contradictory style tokens. The model has a strong internal understanding of "photorealistic."

## Parameter tuning guide
- **Guidance Scale (CFG):**
    - **3.5 (Default):** The "sweet spot" for most prompts, balancing creativity with adherence.
    - **1.5 - 2.5:** Better for abstract or highly artistic/dreamy results.
    - **5.0+:** Use for strict compliance with very complex layout instructions, though it may introduce artifacts.
- **Safety Tolerance:**
    - Setting this to `5` or `6` allows for more edgy/artistic content that might otherwise be blocked, but use with caution.
- **Image Size:** 
    - Standard resolutions (e.g., 1024x768) are generated fastest. Extreme aspect ratios may occasionally result in "doubling" of subjects.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Image Size` (Dropdown/Enum)
    - `Seed` (Integer/Random)
    - `Guidance Scale` (Slider)
    - `Enhance Prompt` (Toggle)
- **Outputs:**
    - `Image URL` (Link)
    - `NSFW Flag` (Boolean)
    - `Seed` (Integer - to pass to subsequent nodes)
- **Chain-friendly with:**
    - **Upscaler Nodes:** Pair with `fal-ai/aura-sr` or `fal-ai/esrgan` for 4k+ output.
    - **LLM Prompt Expanders:** Use a `GPT-4o` or `Claude` node to generate the descriptive prompts FLUX loves.
    - **Image-to-Image:** Use the output as a base for `fal-ai/flux-pro/v1/redux` for style transfer.

## Notes & gotchas
- **Signed URLs:** Result URLs from the BFL API are typically signed and expire after **10 minutes** ([Black Forest Labs](https://docs.bfl.ml/flux_models/flux_1_1_pro)). FAL.ai-hosted URLs usually persist longer depending on your storage settings.
- **Speed:** FLUX 1.1 [pro] is significantly faster than the previous version; if your workflow times out, ensure your client handles the 4.5-second inference window properly.

## Sources
- [FAL.ai FLUX 1.1 [pro] Documentation](https://fal.ai/models/fal-ai/flux-pro/v1.1)
- [Black Forest Labs Official Docs](https://docs.bfl.ml/flux_models/flux_1_1_pro)
- [MindStudio Analysis of FLUX 1.1 Pro](https://www.mindstudio.ai/blog/what-is-flux-1-1-pro/)
- [Siray Blog Pricing Benchmarks](https://blog.siray.ai/flux-1-1-pro/)