---
name: fal-ai/nano-banana-pro/edit
display_name: Google Nano Banana Pro [Edit]
category: image-to-image
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/nano-banana-pro/edit
original_source: https://deepmind.google/models/gemini-image/pro/
summary: State-of-the-art reasoning-driven AI image editor built on Gemini 3 Pro, capable of physics-aware scene manipulation and high-fidelity text rendering.
---

# Google Nano Banana Pro [Edit]

## Overview
- **Slug:** `fal-ai/nano-banana-pro/edit`
- **Category:** Image Editing
- **Creator:** [Google DeepMind](https://deepmind.google/models/gemini-image/pro/)
- **Best for:** Complex scene editing, precise text integration, and physics-aware image manipulation.
- **FAL docs:** [fal-ai/nano-banana-pro/edit](https://fal.ai/models/fal-ai/nano-banana-pro/edit)
- **Original source:** [Google DeepMind Nano Banana Pro](https://deepmind.google/models/gemini-image/pro/), [Google Cloud Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)

## What it does
Nano Banana Pro (also known as Gemini 3 Pro Image) is a reasoning-driven image generation and editing engine. Unlike traditional diffusion models, it "plans" scenes before rendering, allowing for superior spatial awareness, physics-accurate lighting, and flawless text rendering. It supports multi-image fusion (up to 14 images) and maintains high character consistency for up to 5 people.

## When to use this model
- **Use when:** You need to add precise text to images, perform complex localized edits (e.g., changing day to night), or maintain strict character consistency across a series of images. It is ideal for professional mockups, infographics, and storyboard creation.
- **Don't use when:** You need ultra-fast, low-cost generations for simple tasks.
- **Alternatives:**
    - `fal-ai/nano-banana`: Faster and cheaper, better for casual restoration or simple edits.
    - `fal-ai/flux-pro/kontext`: Excellent for high-fidelity prompt adherence but lacks the advanced "reasoning" and physics-aware editing of Nano Banana Pro.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana-pro/edit` (sync) / `https://queue.fal.run/fal-ai/nano-banana-pro/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | - | The prompt describing the desired edits or generation. |
| `image_urls` | list<string> | *Required* | - | URLs of the images to use for image-to-image or editing. Supports up to 14 images. |
| `num_images` | integer | `1` | 1-8 | Number of images to generate. |
| `seed` | integer | null | - | Seed for random number generation. |
| `aspect_ratio` | Enum | `auto` | `auto, 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16` | Aspect ratio of the output image. |
| `output_format` | Enum | `jpeg` | `jpeg, png, webp` | Format of the generated image. |
| `resolution` | Enum | `1K` | `1K, 2K, 4K` | Output resolution. |
| `safety_tolerance` | Enum | `2` | `1, 2, 3, 4, 5, 6` | Content moderation level (1: strict, 6: most permissive). API-only. |
| `enable_web_search` | boolean | `false` | - | Allows the model to use Google Search for grounding (e.g., generating accurate data for infographics). |
| `limit_generations`| boolean | `false` | - | Experimental: Limits output to 1 image regardless of prompt instructions. |
| `sync_mode` | boolean | `false` | - | Returns media as data URI directly if `True`. |

### Output
The API returns a JSON object containing:
- `images`: A list of `ImageFile` objects, each with a `url`, `width`, `height`, and metadata.
- `description`: A text description of the generated or edited images.

### Example request
```json
{
  "prompt": "Change the time of day to sunset and add the text 'Vacation Mode' in a sleek white font at the bottom center.",
  "image_urls": ["https://example.com/beach.jpg"],
  "resolution": "2K",
  "aspect_ratio": "16:9"
}
```

### Pricing
Approximately **$0.0398 per image** (based on 1MP normalization). Higher resolutions (2K/4K) are priced proportionally higher on FAL.ai.

## API — via Original Source (BYO-key direct)
Google offers direct access via the **Gemini API** in Google AI Studio and **Vertex AI**.
- **Endpoint (Vertex AI):** `https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION}/publishers/google/models/gemini-3-pro-image-preview:predict`
- **Native Parameters:**
    - `candidateCount`: Up to 4.
    - `groundingConfig`: Explicitly enable `google_search_retrieval`.
    - `thinking_config`: Toggle `include_thoughts` to see the model's reasoning process.
- **Auth:** OAuth2 or API Key (via Google AI Studio).
- **Docs:** [Google Vertex AI - Gemini 3 Pro Image](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)

## Prompting best practices
- **Be Descriptive about Lighting:** Since the model understands physics, use keywords like "volumetric lighting," "golden hour," "rim lighting," or "soft bokeh" to leverage its reasoning engine.
- **Text Control:** Specify the font style, color, and exact placement. Use quotes for the text you want rendered (e.g., `the word "NEON" in blue flickering tube lights`).
- **Multi-Turn Editing:** If using the model conversationally, reference previous edits (e.g., "Now make the car blue" after a background change).
- **Avoid Over-Prompting:** The model is highly intelligent; simple, clear instructions often yield better results than "keyword soup."

## Parameter tuning guide
- **Resolution (2K/4K):** Use 4K only for final production assets as it increases latency and cost. 1K is sufficient for most prototyping.
- **Safety Tolerance:** Level 1 is extremely strict; if your creative work is getting blocked, try moving to 3 or 4 while respecting content policies.
- **Enable Web Search:** Crucial for infographics. If you ask for a chart of "2024 GDP growth," the model will search for the actual data before rendering the image.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Text description of edit.
    - `Image List`: Source image(s) for editing.
    - `Resolution`: Select 1K, 2K, or 4K.
    - `Aspect Ratio`: Dropdown of supported ratios.
- **Outputs:**
    - `Image URL`: The primary edited image.
    - `Image Description`: AI-generated caption of the result.
- **Chain-friendly with:**
    - `fal-ai/flux-lora-fast-training`: Use Nano Banana Pro to generate high-quality base images for LoRA training.
    - `fal-ai/llavapro`: To analyze an image first and then pass the description to Nano Banana Pro for precise editing.

## Notes & gotchas
- **Safety Blocks:** The model has a robust built-in safety filter; prompts involving PII or non-consensual imagery will be blocked.
- **Thinking Signatures:** The model "thinks" before it acts, which can result in slightly higher latency compared to simple diffusion models.
- **Beta Status:** The 4K resolution and multi-turn conversational editing are currently in "Paid Preview" and may have stability changes.

## Sources
- [FAL.ai Docs](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api)
- [Google DeepMind Official Site](https://deepmind.google/models/gemini-image/pro/)
- [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image-preview)
- [Google Cloud Vertex AI Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)
- [Google Blog Announcement](https://blog.google/innovation-and-ai/products/nano-banana-pro/)