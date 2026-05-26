---
name: fal-ai/gemini-25-flash-image/edit
display_name: Gemini 2.5 Flash Image Edit
category: image-to-image
creator: Google
fal_docs: https://fal.ai/models/fal-ai/gemini-25-flash-image/edit
original_source: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image
summary: A fast, natively multimodal image editing model capable of conversational refinement, object addition/removal, and high-quality text rendering.
---

# Gemini 2.5 Flash Image Edit

## Overview
- **Slug:** `fal-ai/gemini-25-flash-image/edit`
- **Category:** Image Editing
- **Creator:** [Google](https://deepmind.google/models/gemini-image/)
- **Best for:** Rapid, conversational image editing and multi-image composition.
- **FAL docs:** [https://fal.ai/models/fal-ai/gemini-25-flash-image/edit](https://fal.ai/models/fal-ai/gemini-25-flash-image/edit)
- **Original source:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)

## What it does
Gemini 2.5 Flash Image (codenamed **Nano Banana**) is a natively multimodal model designed for state-of-the-art speed and creative control. Unlike traditional diffusion models that use separate text-encoding stages, this model was trained from the ground up to process text and images in a unified step ([Google Developers](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)). It excels at following natural language instructions to add, remove, or modify elements in an existing image while maintaining the original style, lighting, and character consistency ([FAL.ai](https://fal.ai/models/fal-ai/gemini-25-flash-image/edit)).

## When to use this model
- **Use when:** You need fast, iterative edits to an image (e.g., "change the character's hat to a crown"), want to blend multiple reference images into a single scene, or require accurate text rendering within an image ([Google Developers](https://developers.googleblog.com/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)).
- **Don't use when:** You need high-resolution 4K output or extreme photorealistic subject consistency (use **Gemini 3 Pro Image** or **Flux** instead).
- **Alternatives:**
  - **fal-ai/nano-banana-pro/edit**: For higher 4K resolution and superior text rendering (94% accuracy).
  - **fal-ai/flux/edit**: For top-tier aesthetic quality and realism, though typically slower.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gemini-25-flash-image/edit` (sync) / `https://queue.fal.run/fal-ai/gemini-25-flash-image/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The natural language description of the edit or scene to generate. |
| `image_urls` | list<string> | *Required* | Max 3 urls | The URLs of the images to use for image-to-image generation or image editing. |
| `num_images` | integer | `1` | 1 - 10 | The number of images to generate per request. |
| `seed` | integer | Random | N/A | Seed for reproducible generations. |
| `aspect_ratio` | enum | `auto` | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16` | The aspect ratio of the output image. `auto` preserves input ratio. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | File format for the generated image. |
| `safety_tolerance` | enum | `4` | `1` to `6` | Content moderation strictness. 1 is most strict; 6 is least. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns media as a data URI and omits it from history. |
| `limit_generations` | boolean | `false` | `true`, `false` | Limits output to 1 generation regardless of prompt instructions. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects with the `url`, `width`, `height`, and `content_type` of the edited images.
- `description`: A textual description of the generated image(s), providing insight into how the model interpreted the prompt.

### Example request
```json
{
  "prompt": "make the man's car a convertible and change the background to the Amalfi Coast",
  "image_urls": ["https://example.com/original_car_photo.jpg"],
  "aspect_ratio": "16:9",
  "num_images": 1
}
```

### Pricing
FAL.ai charges a flat rate of **$0.039 per image** generated ([FAL.ai](https://fal.ai/models/fal-ai/gemini-25-flash-image/edit)).

## API — via Original Source (BYO-key direct)
Google offers the model directly via Google AI Studio and Vertex AI.

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`
- **Direct Features:**
  - **Batch API:** Offers a 50% discount ($0.0195/image) for requests that can be processed within 24 hours ([LaoZhang AI Blog](https://blog.laozhang.ai/en/posts/cheap-gemini-image-api)).
  - **Token-based Pricing:** $30.00 per 1 million output tokens (~1,290 tokens per image).
- **Auth Method:** API Key (AI Studio) or OAuth 2.0 (Vertex AI).
- **Link:** [Google AI Studio Documentation](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)

## Prompting best practices
- **Describe Scenes, Not Keywords:** Use narrative, descriptive paragraphs (e.g., "A golden retriever wearing a blue bowtie sitting on a porch") instead of comma-separated tags ([Google Developers](https://developers.googleblog.com/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)).
- **Think Like a Photographer:** Specify camera angles (wide-angle, macro), lens types (85mm portrait), and lighting (golden hour, neon glow) to guide the native multimodal understanding ([Cursor IDE](https://www.cursor-ide.com/blog/gemini-flash-image-prompting-guide)).
- **Semantic Negative Prompts:** Instead of saying "no cars," describe the scene positively: "An empty street with no signs of traffic" ([Google Developers](https://developers.googleblog.com/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)).
- **Text Rendering:** Be explicit about text content and font style. Template: `Create a logo for [Brand] with text "[TEXT]" in a [Style] font`.
- **Iterative Editing:** Leverage the model's memory for multi-turn editing. Start with a base image and send follow-up requests like "Now make the sky purple" to refine results incrementally ([DataCamp](https://www.datacamp.com/tutorial/gemini-2-5-flash-image-guide)).

## Parameter tuning guide
- **Safety Tolerance:** Set to `1` for brand-safe production environments. Higher values (5-6) allow for more creative freedom but carry a higher risk of triggering content filters ([FAL.ai](https://fal.ai/models/fal-ai/gemini-25-flash-image/edit/api#schema-input)).
- **Aspect Ratio:** Use `auto` when editing to prevent the model from stretching or cropping the original image.
- **Limit Generations:** Enable this in automated workflows to ensure the model doesn't over-generate images and blow your budget if a user prompt accidentally asks for "100 versions."

## Node inputs/outputs
- **Inputs:**
  - `prompt`: (String) Instruction for the edit.
  - `image_urls`: (List) The base image(s) to be edited or used as reference.
  - `aspect_ratio`: (Enum) Target dimensions.
- **Outputs:**
  - `images`: (List) URLs of the resulting images.
  - `description`: (String) The model's own description of what it created.
- **Chain-friendly with:**
  - **Gemini 1.5 Flash**: Use as a "Prompt Engineer" node to turn short user ideas into the rich narrative descriptions Gemini 2.5 Flash Image prefers.
  - **Remove Background Nodes**: To isolate subjects before passing them into the `image_urls` for composition.

## Notes & gotchas
- **Resolution Cap:** The standard Gemini 2.5 Flash Image (Nano Banana) is capped at **1024x1024** pixels. If you need 4K, you must upgrade to the "Pro" or "3.1 Flash" (Nano Banana 2) versions ([LaoZhang AI Blog](https://blog.laozhang.ai/en/posts/gemini-image-model-comparison)).
- **Input Limit:** While the API takes a list, the model is generally optimized for up to **3 reference images** at once.
- **Watermarking:** All output images include an invisible **SynthID digital watermark** to identify them as AI-generated ([Google Developers](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)).

## Sources
- [FAL.ai Gemini 2.5 Flash Image Edit Page](https://fal.ai/models/fal-ai/gemini-25-flash-image/edit)
- [Google Official Model Introduction](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)
- [Google AI for Developers Documentation](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)
- [LaoZhang AI Blog - Gemini Image Model Comparison](https://blog.laozhang.ai/en/posts/gemini-image-model-comparison)
- [Google DeepMind Model Overview](https://deepmind.google/models/gemini-image/)