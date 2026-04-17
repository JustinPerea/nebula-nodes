---
name: fal-ai/gemini-25-flash-image
display_name: Gemini 2.5 Flash Image (Nano Banana)
category: text-to-image
creator: Google DeepMind
fal_docs: [FAL.ai Docs](https://fal.ai/models/fal-ai/gemini-25-flash-image)
original_source: [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image), [Google Cloud Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image)
summary: Google's high-speed, natively multimodal image generation and editing model with advanced character consistency and world knowledge.
---

# Gemini 2.5 Flash Image (Nano Banana)

## Overview
- **Slug:** `fal-ai/gemini-25-flash-image`
- **Category:** text-to-image / image-to-image
- **Creator:** [Google DeepMind](https://deepmind.google/)
- **Best for:** High-speed, instruction-heavy image generation and conversational editing.
- **FAL docs:** [fal.ai/models/fal-ai/gemini-25-flash-image](https://fal.ai/models/fal-ai/gemini-25-flash-image)
- **Original source:** [Google AI Studio](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)

## What it does
Gemini 2.5 Flash Image (internally codenamed "Nano Banana") is a natively multimodal model designed for rapid image generation and precise editing ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)). Unlike traditional diffusion models that treat text as secondary metadata, this model integrates image generation directly into the Gemini LLM framework, allowing it to "reason" about spatial relationships, text rendering, and world knowledge ([TheSequence](https://thesequence.substack.com/p/the-sequence-radar-711-flash-but)). It excels at maintaining character consistency across multiple generations, merging multiple input images into a single scene (fusion), and performing targeted local edits using natural language instructions instead of manual masking ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).

## When to use this model
- **Use when:** 
    - You need to generate images with complex, accurate text (e.g., UI mockups, signage, logos) ([DataNorth AI](https://datanorth.ai/blog/nano-banana-the-ultimate-guide-to-googles-image-generation-ai)).
    - You require "character consistency" for storytelling or brand assets across different scenes ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).
    - You want to perform precise edits like "remove the person in the background" or "change the car's color to matte black" via simple text prompts ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).
    - High-volume, low-latency workflows are a priority (generation typically under 2 seconds) ([DataNorth AI](https://datanorth.ai/blog/nano-banana-the-ultimate-guide-to-googles-image-generation-ai)).
- **Don't use when:**
    - You require pixel-perfect precision for highly complex backgrounds where "drift" might occur during multi-turn editing ([Milvus.io](https://milvus.io/ai-quick-reference/what-are-the-known-limitations-or-challenges-of-nano-banana)).
    - You need extremely high-resolution (4K+) artistic textures—while the Pro version supports 4K, the Flash version is optimized for efficiency around 1MP ([HeyPuter](https://developer.puter.com/ai/google/flash-image-2.5/)).
- **Alternatives:** 
    - **fal-ai/flux/schnell:** Better for raw artistic "vibes" and photorealism but lacks the conversational editing and character consistency features of Gemini.
    - **fal-ai/nano-banana-pro:** The "Pro" sibling model which prioritizes detail and 4K resolution over speed ([fal.ai Learn](https://fal.ai/learn/devs/nano-banana-1-vs-2)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gemini-25-flash-image` (Text-to-Image) / `https://fal.run/fal-ai/gemini-25-flash-image/edit` (Editing)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text description of the image or the edit instruction. |
| `image_urls` | list<string> | (required for edit) | N/A | URLs of images to use for image-to-image generation or editing. |
| `num_images` | integer | 1 | 1 - 4 | Number of images to generate per request. |
| `seed` | integer | random | N/A | Seed for random number generation to ensure reproducibility. |
| `aspect_ratio` | enum | 1:1 (T2I) / auto (Edit) | `21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16` | The desired frame dimensions. `auto` preserves input aspect ratio. |
| `output_format` | enum | webp | `jpeg, png, webp` | Format of the generated image file. |
| `safety_tolerance` | enum | 4 | `1, 2, 3, 4, 5, 6` | 1 is most strict (blocks most content); 6 is most permissive. |
| `sync_mode` | boolean | false | `true, false` | If true, returns media as base64 data URI directly in response. |
| `limit_generations` | boolean | false | `true, false` | Limits generation to 1 image regardless of prompt instructions. |

### Output
The output returns a JSON object containing the generated images and a descriptive summary.
- `images`: A list of `ImageFile` objects.
    - `url`: Publicly accessible download URL.
    - `width`/`height`: Dimensions of the generated image.
    - `content_type`: Mime type (e.g., `image/webp`).
- `description`: A text description of the generated results provided by the model.

### Example request (Text-to-Image)
```json
{
  "prompt": "A futuristic coffee shop on Mars with a view of the red landscape, accurate text on the sign reading 'RED BREW'",
  "aspect_ratio": "16:9",
  "num_images": 1
}
```

### Pricing
- **FAL.ai:** $0.039 per image ([fal.ai](https://fal.ai/models/fal-ai/gemini-25-flash-image)).
- **Google Cloud (BYO-Key):** ~$30.00 per 1 million output tokens, with each image consuming exactly 1290 tokens ($0.0387/image) ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).

## API — via Original Source (BYO-key direct)
The model is available natively through Google's developer platforms.
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`
- **Auth Method:** API Key (passed as a query parameter `?key=YOUR_KEY`) or OAuth2.
- **Extra Features:** Supports "Context Caching" and "System Instructions" for long-term consistency in multi-turn editing sessions ([Google Cloud Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image)).
- **Official Docs:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)

## Prompting best practices
- **Use Natural Language:** Unlike diffusion models (e.g., Stable Diffusion), avoid "keyword stuffing" like "8k, masterpiece, trending on artstation." Describe the scene in full sentences ([DataNorth AI](https://datanorth.ai/blog/nano-banana-the-ultimate-guide-to-googles-image-generation-ai)).
- **Be Specific for Edits:** For editing, identify the object and the change clearly: "Change the woman's red jacket to a blue denim jacket" ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).
- **Leverage World Knowledge:** You can reference famous landmarks or historical styles without describing them from scratch: "A portrait of a knight in the style of Rembrandt" ([TheSequence](https://thesequence.substack.com/p/the-sequence-radar-711-flash-but)).
- **Text Rendering:** Place text in quotes for better accuracy: "A neon sign that says 'Open 24/7' in a cyberpunk alleyway."

## Parameter tuning guide
- **Safety Tolerance:** If your prompt is being blocked by "Safety" filters, try increasing this to 5 or 6 (API only), but ensure you comply with Google's usage policies ([fal.ai API Schema](https://fal.ai/models/fal-ai/gemini-25-flash-image/api)).
- **Aspect Ratio:** Use `auto` for editing to avoid unintentional cropping or stretching of the source material.
- **Seed:** Set a fixed seed when iterating on a prompt to observe how small wording changes affect the composition.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Source Image` (Image/URL) - *Optional, for editing/fusion*
    - `Aspect Ratio` (Dropdown)
    - `Safety Level` (Number)
- **Outputs:**
    - `Image URL` (Image)
    - `Description` (Text)
- **Chain-friendly with:**
    - `fal-ai/flux-lora-fast-training`: Use Gemini to generate high-quality dataset descriptions for training a LoRA.
    - `fal-ai/veo`: Feed the generated consistent characters from Gemini into Veo for video generation.

## Notes & gotchas
- **SynthID Watermarking:** All images generated or edited with this model contain an invisible digital watermark ([Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).
- **Queue Mode:** For batch processing or high-concurrency apps, use the `/queue` endpoint on FAL to avoid timeouts.
- **Input Size:** Direct image uploads to the API are limited to 7MB per file (higher via Google Cloud Storage) ([Google Cloud Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image)).

## Sources
- [FAL.ai Gemini 2.5 Flash Image Model Page](https://fal.ai/models/fal-ai/gemini-25-flash-image)
- [Introducing Gemini 2.5 Flash Image - Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)
- [Gemini 2.5 Flash Image Technical Specs - Google Cloud Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image)
- [Nano Banana vs Nano Banana Pro Comparison - fal.ai Learn](https://fal.ai/learn/devs/nano-banana-1-vs-2)
- [The Sequence Radar: Inside Gemini 2.5 Flash Image](https://thesequence.substack.com/p/the-sequence-radar-711-flash-but)
- [Known Limitations of Nano Banana - Milvus.io](https://milvus.io/ai-quick-reference/what-are-the-known-limitations-or-challenges-of-nano-banana)
