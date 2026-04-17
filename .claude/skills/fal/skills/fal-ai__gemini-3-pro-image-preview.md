---
name: fal-ai/gemini-3-pro-image-preview
display_name: Gemini 3 Pro Image (Nano Banana Pro)
category: text-to-image
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/gemini-3-pro-image-preview
original_source: https://ai.google.dev/gemini-api/docs/image-generation
summary: Google's flagship reasoning-based image model capable of 4K resolution, precise text rendering, and real-world grounding.
---

# Gemini 3 Pro Image (Nano Banana Pro)

## Overview
- **Slug:** `fal-ai/gemini-3-pro-image-preview`
- **Category:** Text-to-Image
- **Creator:** [Google DeepMind](https://deepmind.google/)
- **Best for:** Complex scenes requiring logical reasoning, precise text rendering, and high-resolution 4K output.
- **FAL docs:** [FAL.ai Gemini 3 Pro Image Docs](https://fal.ai/models/fal-ai/gemini-3-pro-image-preview)
- **Original source:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/image-generation)

## What it does
Gemini 3 Pro Image (internally codenamed "Nano Banana Pro") is Google's state-of-the-art image generation model. Unlike traditional diffusion models that rely purely on pattern matching, Gemini 3 Pro utilizes a transformer-based architecture integrated with LLM reasoning (the "World Simulator" engine). It "thinks" through prompts for 3-5 seconds to plan physics, lighting, and layout before rendering. It excels at rendering legible text, complex spatial relationships, and grounded content using Google Search.

## When to use this model
- **Use when:** You need sharp, accurate text within images, complex infographics, or scenes where physical accuracy (refractions, lighting) is critical. Use it when 4K resolution is required for production.
- **Don't use when:** You need instant "real-time" generation (it has a mandatory reasoning delay) or if you are looking for highly stylized "AI-art" aesthetics that ignore realism.
- **Alternatives:** 
  - **Flux.1 [pro]:** Better for raw photorealism and artistic versatility but lacks the same level of logical reasoning for text and diagrams.
  - **Gemini 3.1 Flash Image:** A faster, cheaper version of the same architecture, better for quick prototyping or social media assets.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gemini-3-pro-image-preview` (sync) / `https://queue.fal.run/fal-ai/gemini-3-pro-image-preview` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | The text description of the image to generate. Supports complex, multi-paragraph descriptions. |
| `num_images` | integer | 1 | 1 - 4 | The number of images to generate per request. |
| `seed` | integer | Random | N/A | Seed for reproducible generations. |
| `aspect_ratio` | enum | `1:1` | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16` | The aspect ratio of the output image. |
| `output_format` | enum | `jpeg` | `jpeg`, `png`, `webp` | File format for the generated images. |
| `safety_tolerance` | enum | `1` | `1`, `2`, `3`, `4`, `5`, `6` | Safety level for content moderation (1 is most strict). Only available via API. |
| `resolution` | enum | `1K` | `1K`, `2K`, `4K` | Output resolution. `1K` (1024px), `2K` (2048px), `4K` (4096px). |
| `enable_web_search`| boolean | `false` | `true`, `false` | Enables Google Search grounding to verify facts and pull real-world info (e.g., current weather, logos). |
| `limit_generations`| boolean | `false` | `true`, `false` | Experimental: Ignores "number of images" instructions in the prompt to force exactly 1 output. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the media as a data URI immediately. |

### Output
The API returns a JSON object containing a list of image objects and a generated description.
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
  "description": "A high-fidelity image showing..."
}
```

### Example request
```json
{
  "prompt": "A professional infographic for a designer coffee shop called 'Nano Banana'. The background is a clean orange wall. The center features a high-end espresso machine with steam rising. To the right, a menu board lists 'Latte', 'Mocha', and 'Espresso' in a bold serif font.",
  "resolution": "4K",
  "aspect_ratio": "16:9",
  "enable_web_search": true
}
```

### Pricing
- **Base Price:** ~$0.0398 per image (at 1MP resolution).
- **Resolution Scaling:** Pricing is proportional to megapixels (MP). 4K images (16MP) are significantly more expensive than 1K images (1MP). [FAL Pricing](https://fal.ai/pricing).

## API — via Original Source (BYO-key direct)
Google offers this model via the **Gemini API** and **Vertex AI**.
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`
- **Native-only Params:** 
  - `media_resolution`: Options for `low`, `medium`, or `high` processing of input images.
  - `thought_signatures`: Used in multi-turn editing to maintain consistency.
  - `response_modalities`: Allows toggling between `TEXT` and `IMAGE` outputs.
- **Auth:** OAuth2 or API Key via [Google AI Studio](https://aistudio.google.com/).
- **Official Docs:** [Google Gemini Image Docs](https://ai.google.dev/gemini-api/docs/image-generation).

## Prompting best practices
- **Be Descriptive:** Because the model "reasons," it handles long, structural descriptions better than short keywords. Explain the *logic* of the scene.
- **Explicit Text:** To get text right, put it in quotes and specify the font style (e.g., "The words 'Happy Birthday' in a glowing neon script").
- **Leverage Grounding:** Use `enable_web_search` for specific real-world references, like "The current flag of Japan" or "An infographic of today's weather in London."
- **Avoid Over-Prompting Style:** The model defaults to high-fidelity realism. If you want a specific artistic style (e.g., "Impressionist oil painting"), state it early and clearly.

## Parameter tuning guide
- **Resolution:** Use `1K` for testing and `4K` only for final production assets. The cost increases sharply with resolution.
- **Enable Web Search:** Turn this ON for educational or data-driven content. Turn it OFF for purely creative/fictional scenes to save latency and potential artifacts from irrelevant search results.
- **Safety Tolerance:** Increase to `6` for creative freedom in professional contexts (if allowed by your use case), but keep at `1` for public-facing apps.

## Node inputs/outputs
- **Inputs:** `Prompt` (Text), `Resolution` (Select), `Aspect Ratio` (Select), `Web Search` (Boolean), `Seed` (Integer).
- **Outputs:** `Image URL` (URL), `Metadata Description` (Text).
- **Chain-friendly with:** 
  - **Flux.1 [tools]:** Generate a high-reasoning image here, then pass to Flux for artistic re-styling.
  - **Llama 3.1 405B:** Use an LLM to expand a simple user idea into a 3-paragraph "reasoning-friendly" prompt for Gemini.

## Notes & gotchas
- **Reasoning Delay:** Expect a 3-5 second "thought" period before the image starts generating. This is a feature of the model's architecture, not a network lag.
- **Text Accuracy:** While best-in-class, text rendering is approximately 80% accurate for complex phrases. Double-check results.
- **Region Restrictions:** Some features (like Search Grounding) may have differing availability based on the API provider's region.

## Sources
- [FAL.ai Gemini 3 Pro Image Page](https://fal.ai/models/fal-ai/gemini-3-pro-image-preview)
- [Google AI for Developers Documentation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Google Cloud Vertex AI Model Card](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)
- [FAL.ai Pricing Schedule](https://fal.ai/pricing)
