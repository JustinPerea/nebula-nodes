---
name: fal-ai/flux-pro/kontext
display_name: FLUX.1 Kontext [pro]
category: image-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-pro/kontext
original_source: https://bfl.ai/models/flux-kontext
summary: A unified model for high-fidelity in-context image generation and editing that preserves character and style consistency.
---

# FLUX.1 Kontext [pro]

## Overview
- **Slug:** `fal-ai/flux-pro/kontext`
- **Category:** Image-to-Image / Text-to-Image
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** Precise image editing, character consistency, and style-driven generation.
- **FAL docs:** [fal.ai/models/fal-ai/flux-pro/kontext](https://fal.ai/models/fal-ai/flux-pro/kontext)
- **Original source:** [bfl.ai/models/flux-kontext](https://bfl.ai/models/flux-kontext)

## What it does
FLUX.1 Kontext [pro] is a frontier multimodal model designed for "in-context" image generation and editing. Unlike traditional text-to-image models, it can process both a text prompt and a reference image simultaneously. This allows users to perform targeted local edits, maintain strict character consistency across different scenes, or transfer styles from one image to another—all while maintaining the signature high-quality aesthetics of the FLUX.1 family. It is optimized for speed, enabling iterative workflows where users can build upon previous edits in real-time ([Black Forest Labs](https://bfl.ai/models/flux-kontext)).

## When to use this model
- **Use when:**
    - You need to edit a specific part of an image (e.g., "change the car color to red") while keeping the background identical.
    - You want to generate a specific character in various environments or poses while maintaining their unique facial features and attire.
    - You want to apply the artistic style of one image to a new generated scene.
    - You need high-speed, professional-grade image editing for commercial applications ([fal.ai](https://fal.ai/models/fal-ai/flux-pro/kontext)).
- **Don't use when:**
    - You need extremely long multi-turn editing sessions (10+ turns), as visual artifacts may begin to accumulate.
    - The task requires deep "world knowledge" of obscure facts or specific historical niche details.
    - You are looking for a purely open-source model for commercial use without licensing (use the [dev] version for non-commercial research instead) ([Black Forest Labs](https://bfl.ai/announcements/flux-1-kontext)).
- **Alternatives:**
    - **fal-ai/flux-pro/v1.1**: Better for pure text-to-image with zero-shot prompt adherence.
    - **fal-ai/flux/dev**: The open-weights version, cheaper but lacks the native "Kontext" in-context editing optimization.
    - **fal-ai/flux-pro/redux**: Specifically focused on style and structure extraction from images, but Kontext offers more advanced local editing capabilities ([fal.ai](https://fal.ai/pricing)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pro/kontext` (sync) / `https://queue.fal.run/fal-ai/flux-pro/kontext` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The prompt describing the desired image or the changes to be made. |
| `image_url` | string | (required) | N/A | The URL of the reference image to be used for context or editing. |
| `seed` | integer | random | 0 to 2^32-1 | Set a seed for reproducible results. |
| `guidance_scale` | float | 3.5 | 1.0 to 20.0 | Controls how closely the model follows the prompt. |
| `aspect_ratio` | enum | `1:1` | `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21` | The aspect ratio of the output image. |
| `num_images` | integer | 1 | 1 to 4 | Number of images to generate per request. |
| `output_format` | enum | `jpeg` | `jpeg`, `png` | Format of the generated image file. |
| `safety_tolerance` | enum | `2` | `1` to `6` | Safety filter level (1: most strict, 5-6: most permissive). |
| `enhance_prompt` | boolean | `false` | `true`, `false` | Whether to automatically expand and improve the user's prompt. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the media as a data URI immediately. |

### Output
The output is a JSON object containing a list of image objects:
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
  "timings": { "inference": 1.23 },
  "seed": 12345678,
  "has_nsfw_concepts": [false],
  "prompt": "Change the car color to red"
}
```

### Example request
```json
{
  "prompt": "Change the woman's dress to a blue floral pattern, keep the background the same",
  "image_url": "https://example.com/original_photo.jpg",
  "guidance_scale": 3.5,
  "aspect_ratio": "1:1"
}
```

### Pricing
- **Cost:** $0.04 per image (standard 1MP resolution) ([fal.ai Pricing](https://fal.ai/pricing)).

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX.1 Kontext family.
- **Endpoint:** `https://api.bfl.ml/v1/flux-pro-kontext`
- **Auth method:** API Key (Bearer Token)
- **Pricing:** $0.08 per image (direct from BFL) ([BFL Documentation](https://docs.bfl.ml/kontext/kontext_overview)).
- **Notes:** The native BFL API may offer experimental parameters like specific "steps" control (defaulting to 28) and "raw" mode for less processed, more photographic results.

## Prompting best practices
- **Be Specific about Changes:** When editing, clearly state what stays and what changes. Use phrases like "keep the character identical but change the background to..."
- **Use Natural Language:** The model is optimized for natural instructions. Instead of "car, red, 4k", use "Change the color of the car to a vibrant cherry red."
- **Leverage Image Tokens:** If the prompt requires referring to the input image, use terms like "the person in the image" or "the existing object."
- **Avoid Prompt Bloat:** The model's context window is large, but concise, high-impact descriptors work better than long lists of synonyms.
- **Style Consistency:** To match a style, use "in the style of the provided image" followed by your text description.

## Parameter tuning guide
- **Guidance Scale (CFG):**
    - **2.5 - 3.5:** Sweet spot for photorealism and natural lighting.
    - **5.0 - 8.0:** Better for stylized art, illustrations, and strong adherence to complex text prompts.
- **Seed Management:** For iterative editing, always lock the `seed`. If you get a result you like but want a minor tweak, keep the same seed to ensure structural consistency.
- **Aspect Ratio:** Match the `aspect_ratio` to your `image_url` if you are doing local editing to prevent unwanted stretching or cropping ([Black Forest Labs](https://bfl.ai/announcements/flux-1-kontext)).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Text Prompt` (string): The editing instruction or generation description.
    - `Reference Image` (image/URL): The base image for context or editing.
    - `Seed` (integer): Control for reproducibility.
    - `Guidance Scale` (float): Prompt adherence control.
- **Outputs:**
    - `Generated Image` (image URL): The resulting edited or generated image.
    - `Used Seed` (integer): Useful for chaining and versioning.
- **Chain-friendly with:**
    - **fal-ai/flux-pro/v1.1**: Generate a base image, then feed it into Kontext for refinements.
    - **fal-ai/face-to-many**: Use a face-consistent output as a reference for Kontext scene generation.
    - **fal-ai/upscaler**: Chain the output of Kontext to a 4k upscaler for production-ready assets.

## Notes & gotchas
- **Resolution:** Pricing is based on 1MP. Images generated at higher resolutions (e.g., via custom width/height in the Pro API) are billed proportionally.
- **NSFW Filter:** The model includes a safety filter (controlled by `safety_tolerance`). If an image is blocked, the `has_nsfw_concepts` flag will be true, and the image URL may be blank or point to a placeholder.
- **Wait Times:** While Kontext is designed for speed, peak usage on the FAL network may require using the `queue` endpoint for requests taking longer than 30 seconds.

## Sources
- [FAL.ai FLUX.1 Kontext API Docs](https://fal.ai/models/fal-ai/flux-pro/kontext/api)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Black Forest Labs: Introducing FLUX.1 Kontext](https://bfl.ai/announcements/flux-1-kontext)
- [Black Forest Labs Official Documentation](https://docs.bfl.ml/kontext/kontext_overview)
- [arXiv: FLUX.1 Kontext Technical Report](https://arxiv.org/abs/2506.15742)
