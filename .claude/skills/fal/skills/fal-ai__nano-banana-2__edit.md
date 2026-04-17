---
name: fal-ai/nano-banana-2/edit
display_name: Nano Banana 2 [Edit]
category: image-to-image
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/nano-banana-2/edit
original_source: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image-preview
summary: Google's Gemini 3.1 Flash-powered image editor for high-speed, mask-free semantic transformations and multi-image compositing.
---

# Nano Banana 2 [Edit]

## Overview
- **Slug:** `fal-ai/nano-banana-2/edit`
- **Category:** Image-to-Image / Image Editing
- **Creator:** [Google DeepMind](https://deepmind.google/models/gemini/)
- **Best for:** Fast, semantic image transformations and multi-image compositing without manual masking.
- **FAL docs:** [fal.ai/models/fal-ai/nano-banana-2/edit](https://fal.ai/models/fal-ai/nano-banana-2/edit)
- **Original source:** [Google AI Studio / Vertex AI](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image-preview)

## What it does
Nano Banana 2 [Edit] is powered by Google's **Gemini 3.1 Flash Image** architecture. It allows users to modify existing images or combine multiple reference images using natural language instructions. Unlike traditional inpainting models, it uses multimodal reasoning to understand the "intent" of an edit—such as "change the man's shirt to blue"—and automatically identifies the relevant pixels to modify while preserving the rest of the scene's lighting, depth, and character consistency. It is optimized for "Flash" speeds, typically delivering results in 5–10 seconds.

## When to use this model
- **Use when:** You need to perform complex edits (object swapping, background replacement, character modification) without drawing masks. It is ideal for iterative design where speed is a priority.
- **Don't use when:** You require the absolute highest artistic fidelity for studio-grade production (use [Nano Banana Pro](https://fal.ai/models/fal-ai/nano-banana-pro/edit) instead).
- **Alternatives:**
    - **Nano Banana Pro Edit:** Better for high-fidelity reasoning but slower and more expensive ($0.15/image).
    - **FLUX.1 [dev] Image-to-Image:** Better for strict structural adherence to a single image but lacks the multi-image compositing and "thinking" reasoning of Nano Banana 2.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana-2/edit` (sync) / `https://queue.fal.run/fal-ai/nano-banana-2/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The natural language description of the edit to be performed. |
| `image_urls` | list<string> | (required) | Max 14 | URLs of the images to use as reference. Can be used for single image editing or multi-image compositing. |
| `num_images` | integer | 1 | 1 - 4 | The number of output variations to generate per request. |
| `seed` | integer | random | N/A | Seed for reproducible results. |
| `aspect_ratio` | enum | `auto` | `auto`, `1:1`, `16:9`, `4:3`, `3:2`, `21:9`, `4:5`, etc. | Output aspect ratio. Supports extreme ratios like `4:1` and `1:8`. |
| `resolution` | enum | `1K` | `0.5K`, `1K`, `2K`, `4K` | Native output resolution. Higher resolutions may increase cost. |
| `output_format` | enum | `jpeg` | `jpeg`, `png`, `webp` | File format of the resulting images. |
| `thinking_level` | enum | `null` | `minimal`, `high` | Enables reasoning-guided generation. `high` allows the model to "plan" more complex edits. |
| `enable_web_search` | boolean | `false` | `true`, `false` | Grounds the edit in real-time web data for factual accuracy (e.g., "add the latest iPhone model"). |
| `safety_tolerance` | enum | `4` | 1 (strict) - 6 (lenient) | Content moderation sensitivity level. |
| `limit_generations` | boolean | `true` | `true`, `false` | Experimental: Limits the model to exactly 1 generation if the prompt implies multiple. |

### Output
The output is a JSON object containing a list of generated images and a text description of the changes.
```json
{
  "images": [
    {
      "url": "https://fal.run/.../image.png",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png"
    }
  ],
  "description": "A man wearing a blue shirt, modified from the original image while preserving background and lighting."
}
```

### Example request
```json
{
  "prompt": "Change the man's shirt to a professional white button-down and replace the background with a modern office.",
  "image_urls": ["https://example.com/original_photo.jpg"],
  "resolution": "1K",
  "thinking_level": "high"
}
```

### Pricing
- **Base Rate:** Approximately **$0.0398 per 1MP image**.
- **Resolution Scaling:** 2K and 4K outputs are billed proportionally (4K is typically 2x - 4x the cost of 1K).
- **Billing Metric:** Billed per image generated (sync) or per request (queue).

## API — via Original Source (BYO-key direct)
The model is natively available via Google Cloud Vertex AI and Google AI Studio.
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
- **Auth:** API Key or OAuth2 via Google Cloud.
- **Direct Features:** Native support for interleaved text/image inputs and much larger token windows (up to 1M tokens) for multi-document/multi-image context.
- **Docs:** [Google Gemini API Reference](https://ai.google.dev/gemini-api/docs/models/gemini)

## Prompting best practices
- **Be Semantic, Not Technical:** Say "change the car to a vintage Porsche" instead of "replace pixels at center with car model." The model understands objects.
- **Reference Preservation:** If you want to keep everything but one element, explicitly state it: "Change the sky to a sunset but keep the buildings exactly as they are."
- **Multi-Image Guidance:** When using multiple `image_urls`, specify which image is which in the prompt (e.g., "Take the character from Image 1 and place them in the environment of Image 2").
- **Leverage Thinking:** For complex transformations involving multiple steps, use `thinking_level: high` to allow the model to reason about spatial relationships and lighting consistency.
- **Avoid Negative Prompts:** Instead of "no trees," use "clear the horizon of all trees and vegetation."

## Parameter tuning guide
- **`thinking_level`:** Use `high` for edits that change the "physics" or "logic" of a scene (e.g., "make the water flow upwards"). Use `minimal` for simple color swaps to save on latency.
- **`resolution`:** Start at `1K` for iteration. Switch to `4K` only for final exports, as it significantly increases processing time.
- **`enable_web_search`:** Essential for branded content or current events. If you ask the model to "add the current Ferrari F1 car," enabling web search ensures the model looks up the latest livery.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Image URLs` (List of Image/URL)
    - `Reference Images` (Optional List for workflows)
- **Outputs:**
    - `Edited Image(s)` (Image URL)
    - `Model Thoughts` (Text - if thinking is enabled)
    - `Scene Description` (Text)
- **Chain-friendly with:**
    - **Vision LLMs:** Use a model like `fal-ai/any-vision` to describe an image first, then pass that description + edit instructions to Nano Banana 2.
    - **Upscalers:** Pair with `fal-ai/aura-sr` for 8K+ final results from a 2K Nano Banana output.

## Notes & gotchas
- **Watermarking:** All outputs include **SynthID** digital watermarking and C2PA metadata as per Google's safety standards.
- **Masking:** This model does *not* support traditional alpha masks or grayscale masks. It is entirely prompt-driven.
- **Subject Limit:** While it can maintain character consistency, it is officially optimized for up to **5 people** in a single scene.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/nano-banana-2/edit)
- [Google DeepMind Nano Banana 2 Announcement](https://blog.google/innovation-and-ai/technology/ai/nano-banana-2/)
- [Google AI Developer Documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image-preview)
- [FAL.ai Pricing Table](https://fal.ai/pricing)