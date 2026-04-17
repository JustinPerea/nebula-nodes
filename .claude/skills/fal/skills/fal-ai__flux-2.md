---
name: fal-ai/flux-2
display_name: FLUX.2 [dev]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2
original_source: https://bfl.ai/blog/flux-2
summary: A 32B parameter frontier-quality text-to-image model with advanced typography and multi-reference capabilities.
---

# FLUX.2 [dev]

## Overview
- **Slug:** `fal-ai/flux-2`
- **Category:** Text-to-Image
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** High-fidelity photorealistic generation and precise typography.
- **FAL docs:** [fal-ai/flux-2](https://fal.ai/models/fal-ai/flux-2)
- **Original source:** [Black Forest Labs Blog](https://bfl.ai/blog/flux-2) | [Official BFL Docs](https://docs.bfl.ml/flux_2/flux2_overview)

## What it does
FLUX.2 [dev] is a state-of-the-art 32-billion parameter rectified flow transformer model. It integrates a **Mistral-3 24B vision-language model** to provide exceptional prompt following and real-world semantic understanding. Beyond standard generation, it excels at rendering complex typography, maintaining character consistency through multi-reference inputs (up to 10 images), and producing high-resolution output up to 4 megapixels. It is the "open-weight" foundation of the FLUX.2 family, designed for developers and artists who require advanced control and high-quality results without the restrictions of closed-source models.

## When to use this model
- **Use when:** You need photorealistic images with sharp, readable text (UI mockups, posters).
- **Use when:** You are performing multi-reference editing where multiple source images must be combined into a coherent scene.
- **Use when:** You want to use custom hex color codes for brand consistency.
- **Don't use when:** You need sub-second "real-time" generation (consider `flux-2-klein` instead).
- **Don't use when:** You are on a extremely tight budget and don't need the 32B parameter level of detail.
- **Alternatives:** 
    - [FLUX.2 [pro]](https://fal.ai/models/fal-ai/flux-2-pro): Higher quality, zero-config production variant.
    - [FLUX.2 [flex]](https://fal.ai/models/fal-ai/flux-2-flex): Offers more granular control over steps and guidance.
    - [FLUX.2 [klein]](https://fal.ai/models/fal-ai/flux-2-klein): Optimized for speed (sub-second inference).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2` (sync) / `https://queue.fal.run/fal-ai/flux-2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The text description of the image to generate. Supports natural language and structured JSON. |
| `guidance_scale` | float | `2.5` | 1.0 - 20.0 | Measure of how strictly the model sticks to the prompt. Lower (2.5-3.5) for realism, higher for stylization. |
| `seed` | integer | random | N/A | Seed for reproducible generations. |
| `num_inference_steps` | integer | `28` | 1 - 50 | Number of denoising steps. 28 is the recommended "sweet spot" for Dev. |
| `image_size` | enum/object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Predefined aspect ratios or custom `{ width, height }` (512-2048px). |
| `num_images` | integer | `1` | 1 - 4 | Number of images to generate in a single request. |
| `acceleration` | enum | `none` | `none`, `regular`, `high` | Inference acceleration level. |
| `enable_prompt_expansion` | boolean | `false` | true/false | If true, automatically expands the prompt for better aesthetic results. |
| `enable_safety_checker` | boolean | `true` | true/false | Filters NSFW content if enabled. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | File format of the resulting image. |
| `sync_mode` | boolean | `false` | true/false | If true, returns media as data URI immediately. |

### Output
The output is a JSON object containing:
- `images`: A list of `ImageFile` objects containing the `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: A list of booleans indicating if the images triggered the safety filter.
- `timings`: Metadata about the generation time.

### Example request
```json
{
  "prompt": "A cinematic shot of a futuristic cyberpunk city with a neon sign that says 'FAL.AI' in crisp, bold typography. Rain-slicked streets reflecting the lights, 8k resolution, photorealistic.",
  "image_size": "landscape_16_9",
  "guidance_scale": 3.5,
  "num_inference_steps": 28,
  "enable_safety_checker": true
}
```

### Pricing
- **Cost:** $0.012 per Megapixel (MP) on FAL.ai.
- A standard 1024x1024 (1MP) image costs approximately **$0.012**.
- Higher resolutions (e.g., 2MP at 2048x1024) scale proportionally to **$0.024**.

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX.2 family.
- **Endpoint:** `https://api.bfl.ai/v1/flux-2-dev` (refer to [BFL API Reference](https://docs.bfl.ml/api-reference/))
- **Parameters:** Similar to FAL but includes `safety_tolerance` (0-6) and `prompt_upsampling` instead of `enable_prompt_expansion`.
- **Auth method:** Header `x-key: YOUR_BFL_API_KEY`.
- **Link to official docs:** [Black Forest Labs API Docs](https://docs.bfl.ml/quick_start/get_started)

## Prompting best practices
- **Natural Language:** Unlike older models, FLUX.2 prefers long, descriptive sentences over comma-separated tags. Describe the lighting, camera angle, and textures in detail.
- **No Negative Prompts:** The architecture is guidance-distilled and does not support negative prompts. Instead of saying "no blur," say "sharp focus" or "highly detailed."
- **HEX Color Codes:** You can specify exact colors (e.g., "The character wears a jacket in #FF5733") to maintain brand consistency.
- **Typography:** To get the best text, wrap the text in quotes and describe its placement: "A cafe sign that reads 'FLUX CAFE' in a handwritten font."
- **Failure Mode:** Vague prompts like "a dog" may produce generic results. Be specific: "A golden retriever puppy sitting in a sunlit meadow, high-detail fur texture."

## Parameter tuning guide
- **Steps (28):** This is the optimized default. Reducing to 15-20 can speed up generation for drafts, while increasing to 40+ may add minor details at a significant latency cost.
- **Guidance Scale (2.5 - 3.5):** The "sweet spot" for photorealistic results. If you go above 7.0, colors may become oversaturated and the image will look "over-cooked."
- **Prompt Expansion:** Turn this OFF if you have a very specific technical prompt or are using JSON-structured prompts. Turn it ON for creative exploration when you want the AI to "fill in the blanks."

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Image Size` (Dropdown/String)
    - `Guidance Scale` (Number)
    - `Steps` (Number)
    - `Seed` (Number)
    - `Output Format` (Dropdown)
- **Outputs:**
    - `Image URL` (Link)
    - `Seed` (Number)
    - `NSFW Flag` (Boolean)
- **Chain-friendly with:**
    - [fal-ai/flux-lora-fast-training](https://fal.ai/models/fal-ai/flux-lora-fast-training): Use FLUX.2 images to train custom style/character LoRAs.
    - [fal-ai/kling-video](https://fal.ai/models/fal-ai/kling-video): Pipe the generated image into an image-to-video workflow.

## Notes & gotchas
- **Non-Commercial:** The [dev] weights are typically released under a non-commercial license (FLUX.2-dev NCL) when used locally; however, FAL.ai provides a commercial-use wrapper for their API.
- **VRAM Requirements:** If running locally, this model requires ~80GB of VRAM (32B model + 24B VLM). API usage is highly recommended to avoid hardware bottlenecks.
- **Prompt Length:** Supports up to 512 tokens for the text encoder.

## Sources
- [FAL.ai FLUX.2 Documentation](https://fal.ai/models/fal-ai/flux-2)
- [Black Forest Labs Official Site](https://bfl.ai/)
- [BFL Documentation Portal](https://docs.bfl.ml/flux_2/flux2_overview)
- [Hugging Face Model Card](https://huggingface.co/black-forest-labs/FLUX.2-dev)