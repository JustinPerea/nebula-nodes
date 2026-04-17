---
name: fal-ai/flux-2-max
display_name: FLUX.2 [max]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2-max
original_source: https://bfl.ai/
summary: The most capable FLUX.2 model for professional-grade photorealistic image generation and editing, featuring real-time web-grounded search.
---

# FLUX.2 [max]

## Overview
- **Slug:** `fal-ai/flux-2-max`
- **Category:** Text-to-Image / Image Editing
- **Creator:** [Black Forest Labs](https://bfl.ai)
- **Best for:** Professional-grade, high-fidelity image generation and editing where maximum realism and real-time knowledge (grounding) are required.
- **FAL docs:** [https://fal.ai/models/fal-ai/flux-2-max](https://fal.ai/models/fal-ai/flux-2-max)
- **Original source:** [https://docs.bfl.ml/flux_2/flux2_overview](https://docs.bfl.ml/flux_2/flux2_overview)

## What it does
FLUX.2 [max] is the flagship model in the FLUX.2 family, designed for professional workflows that demand unmatched photorealism and strict adherence to complex prompts. It utilizes a 32-billion parameter rectified flow transformer architecture paired with a 24B vision-language model (Mistral-3), enabling a massive context window for nuanced understanding. Its standout feature is **Grounding Search**, which allows the model to perform real-time web searches to accurately visualize trending products, current events, or contemporary styles that were not part of its original training data.

## When to use this model
- **Use when:** You need the highest possible quality for final production assets, accurate rendering of human features (hands, faces), or need to visualize something that happened very recently (via grounding search).
- **Don't use when:** You need sub-second, real-time generation (use [FLUX.2 klein](https://fal.ai/models/fal-ai/flux-2-klein-4b)) or when you are on a tight budget for high-volume testing.
- **Alternatives:** 
    - **[FLUX.2 pro](https://fal.ai/models/fal-ai/flux-2-pro):** Better balance of speed and cost for production at scale.
    - **[FLUX.2 flex](https://fal.ai/models/fal-ai/flux-2-flex):** Offers granular control over inference steps and guidance scale.
    - **[FLUX.2 klein](https://fal.ai/models/fal-ai/flux-2-klein-9b):** Extremely fast for real-time applications.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2-max` (sync) / `https://queue.fal.run/fal-ai/flux-2-max` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | Text description of the image to generate. Supports long, detailed briefs. |
| `image_size` | enum/object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Predefined aspect ratios or custom `{ "width": int, "height": int }`. |
| `seed` | integer | random | - | Seed for deterministic generation. |
| `safety_tolerance` | integer | `2` | `1` (strict) to `5` (permissive) | Adjusts the strictness of the safety filter. |
| `enable_safety_checker` | boolean | `true` | - | Whether to filter out potentially sensitive or unsafe content. |
| `output_format` | enum | `jpeg` | `jpeg`, `png` | The file format of the generated image. |
| `sync_mode` | boolean | `false` | - | If `true`, returns a Base64 data URI instead of a hosted URL. |

### Output
The API returns a JSON object containing a list of generated images and the seed used.
```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 1024,
      "height": 768,
      "content_type": "image/jpeg"
    }
  ],
  "seed": 123456789
}
```

### Example request
```json
{
  "prompt": "A futuristic city street at night, neon signs reflecting in puddles, cinematic lighting, 8k resolution.",
  "image_size": "landscape_16_9",
  "output_format": "png"
}
```

### Pricing
Pricing is based on megapixel (MP) output:
- **First 1 MP:** $0.07
- **Each additional 1 MP:** $0.03
(Example: A 4MP image would cost approximately $0.16)

## API — via Original Source (BYO-key direct)
Black Forest Labs (BFL) provides a direct API for the FLUX model family.
- **Endpoint:** `https://api.bfl.ai/v1/flux-2-max`
- **Auth Method:** `x-key` header with a BFL API Key.
- **Key Benefits:** Direct access to the newest weights, potentially lower latency for high-tier users, and support for additional BFL parameters like `prompt_upsampling`.
- **Additional Parameters:** 
    - `prompt_upsampling`: Automatically enhances short prompts using a VLM.
    - `multi_reference`: Supports up to 10 input images for style/character consistency (compared to FAL's standard input).
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/api-reference/flux-2-text-to-image)

## Prompting best practices
- **Front-load the Subject:** FLUX.2 pays the most attention to the first 20-30 words. Start with the main subject and its core action.
- **Be Visually Descriptive:** Instead of "cool car," use "a vintage red 1960s Ferrari GT, sunlight glinting off the polished chrome bumper, parked on a dusty Tuscan road."
- **Use Hex Codes:** For brand accuracy or specific color palettes, reference hex codes directly (e.g., "a logo with #FF5733 orange accents").
- **Describe What You Want (No Negative Prompts):** FLUX.2 does not support negative prompts. Instead of "no people," say "an empty, desolate landscape."
- **Leverage Grounding:** Mention current events or specific trending products by name to trigger the grounding search capability for accuracy.

## Parameter tuning guide
- **Resolution:** For professional assets, target **2MP to 4MP** (e.g., 2048x2048). Note that higher resolutions take longer and cost more.
- **Safety Tolerance:** Set to `1` for safe enterprise apps, or `4-5` for artistic workflows where common human forms might be incorrectly flagged by stricter filters.
- **Seed:** Always log your seeds. Because FLUX.2 [max] follows prompts so precisely, small prompt tweaks with the same seed yield highly consistent editing results.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Image Size` (Dropdown/String)
    - `Seed` (Integer)
    - `Safety Tolerance` (Number)
    - `Output Format` (Dropdown)
- **Outputs:**
    - `Image URL` (URL)
    - `Seed Used` (Integer)
- **Chain-friendly with:** 
    - `fal-ai/flux-2-pro` (for rapid iteration before a final [max] render)
    - `fal-ai/flux-subject-training` (to use custom characters in [max] via reference)

## Notes & gotchas
- **Max Resolution:** Officially supports up to 4MP. Dimensions must be multiples of 16.
- **Negative Prompts:** Again, these are ignored. Using words like "distorted" in a negative context may actually introduce distortion.
- **Grounding Latency:** Grounded generation may take slightly longer (up to 10 seconds) as the model performs an internal web search.

## Sources
- [FAL.ai Flux 2 Max Documentation](https://fal.ai/models/fal-ai/flux-2-max)
- [Black Forest Labs Official Documentation](https://docs.bfl.ml/flux_2/flux2_overview)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Together AI Flux 2 Max Reference](https://www.together.ai/models/flux-2-max)
