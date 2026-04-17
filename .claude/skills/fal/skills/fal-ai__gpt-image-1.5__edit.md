---
name: fal-ai/gpt-image-1.5/edit
display_name: GPT Image 1.5 Edit
category: image-to-image
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/gpt-image-1.5/edit
original_source: https://openai.com/index/new-chatgpt-images-is-here/
summary: OpenAI's state-of-the-art natively multimodal model for precise, high-fidelity image editing and natural language modifications.
---

# GPT Image 1.5 Edit

## Overview
- **Slug:** `fal-ai/gpt-image-1.5/edit`
- **Category:** Image-to-Image / Image Editing
- **Creator:** [OpenAI](https://openai.com)
- **Best for:** Precise local edits, object insertion/removal, and high-fidelity style transfers while preserving original composition.
- **FAL docs:** [fal-ai/gpt-image-1.5/edit](https://fal.ai/models/fal-ai/gpt-image-1.5/edit)
- **Original source:** [OpenAI Image Generation Guide](https://developers.openai.com/api/docs/guides/image-generation)

## What it does
GPT Image 1.5 Edit is OpenAI's flagship image-to-image model, succeeding GPT Image 1. It is a natively multimodal model that understands both text and visual inputs simultaneously, allowing for extremely precise modifications to existing images. It excels at maintaining the "identity" of the original image—such as lighting, composition, and facial likeness—while applying complex edits described in natural language. Compared to previous generations, it is significantly faster (up to 4x) and offers 20% lower token costs for API users.

## When to use this model
- **Use when:** You need to add or remove specific objects, change the background of a photo while keeping the subject identical, or apply high-fidelity text rendering within an existing image.
- **Don't use when:** You want a completely random creative transformation that ignores the source structure (use a standard text-to-image model for that).
- **Alternatives:** 
  - `fal-ai/gpt-image-1`: The predecessor, useful if you need the older `input_fidelity` behavior.
  - `fal-ai/flux/pro/image-to-image`: Better for artistic style transfers and specific "FLUX" aesthetics.
  - `fal-ai/gpt-image-1-mini`: A faster, more cost-effective version for simple edits where high fidelity isn't critical.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gpt-image-1.5/edit` (sync) / `https://queue.fal.run/fal-ai/gpt-image-1.5/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | - | The instruction for the edit (e.g., "Add a red hat to the person"). |
| `image_urls` | list<string> | (required) | - | List of URLs for the source images to be edited. |
| `image_size` | enum | `auto` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | The output dimensions. `auto` matches the input aspect ratio. |
| `background` | enum | `auto` | `auto`, `transparent`, `opaque` | Defines the background of the generated image. |
| `quality` | enum | `high` | `low`, `medium`, `high` | Higher quality improves detail but increases cost and latency. |
| `input_fidelity`| enum | `high` | `low`, `high` | `high` preserves source details (faces/logos) more strictly. |
| `num_images` | integer | `1` | 1-4 | Number of variations to generate. |
| `output_format` | enum | `jpeg` | `jpeg`, `png`, `webp` | File format for the resulting image. |
| `sync_mode` | boolean | `false` | - | If `true`, returns the image as a data URI immediately. |
| `mask_image_url`| string | `null` | - | Optional mask URL to define the specific area for editing (in-painting). |
| `openai_api_key`| string | `null` | - | Required if using the "Bring Your Own Key" (BYOK) mode. |

### Output
The API returns an `ImageResponse` object:
```json
{
  "images": [
    {
      "url": "https://fal.run/storage/...",
      "content_type": "image/jpeg",
      "file_name": "edit_1.jpg",
      "file_size": 1048576,
      "width": 1024,
      "height": 1024
    }
  ],
  "usage": { // Only in BYOK mode
    "total_tokens": 3500,
    "input_tokens_details": { "image_tokens": 3050, "text_tokens": 50 }
  }
}
```

### Example request
```json
{
  "prompt": "Change the coffee mug to a green tea cup with steam rising.",
  "image_urls": ["https://example.com/original_scene.jpg"],
  "quality": "high",
  "image_size": "1024x1024"
}
```

### Pricing
Pricing is consumption-based per image, plus token costs for text and image processing:
- **Base Image Cost:**
  - **Low Quality:** ~$0.009 (1024x1024) to $0.013 (other sizes)
  - **Medium Quality:** ~$0.034 to $0.051
  - **High Quality:** ~$0.133 to $0.200
- **Token Costs:**
  - **Input Text:** $0.005 / 1K tokens
  - **Input Image:** $0.008 / 1K tokens (one 1024x1024 image is ~135-3050 tokens depending on fidelity)
  - **Output Text:** $0.010 / 1K tokens (used for internal reasoning)

## API — via Original Source (BYO-key direct)
OpenAI provides a direct REST API for this model.
- **Endpoint:** `POST https://api.openai.com/v1/images/edits`
- **Auth:** `Authorization: Bearer $OPENAI_API_KEY`
- **Native Parameters:** Uses `multipart/form-data` with `image` (binary file), `mask` (binary file), `prompt`, `n`, `size`, and `model="gpt-image-1.5"`.
- **Note:** OpenAI's direct API typically returns a URL or `b64_json` depending on the `response_format` parameter.

## Prompting best practices
- **Be Explicit about Preservation:** If you want to keep everything but one element, say "Keep the person and the background identical, but change the shoes to red sneakers."
- **Use Visual Anchors:** Describe the scene context before the edit. "A woman sitting at a desk [Scene Anchor] -> Change the laptop to a vintage typewriter [Edit]."
- **Text Rendering:** GPT Image 1.5 is excellent at text. Wrap text in quotes for better accuracy: "Change the sign to say 'Welcome Home' in a cursive neon font."
- **Avoid Buzzwords:** Don't use "8K" or "ultra-HD." Instead, use descriptive quality cues like "visible fabric texture," "natural skin pores," or "soft cinematic lighting."
- **Negative Constraints:** Use the prompt to exclude unwanted elements. "Remove the telephone pole and the wires, leaving a clear blue sky."

## Parameter tuning guide
- **`quality`:** Use `low` for rapid prototyping or thumbnail-sized edits. Switch to `high` for final production assets or images requiring fine text/faces.
- **`input_fidelity`:** Keep at `high` for brand assets, logos, or portrait photography where the subject's identity must not shift. Use `low` if you want the model to creatively "re-draw" the scene in a new style or layout.
- **`background`:** Set to `transparent` when you need an asset for design software (like Figma or Photoshop) to avoid manual background removal later.

## Node inputs/outputs
- **Inputs:**
  - `Source Image` (URL/File): The base image for editing.
  - `Mask Image` (Optional URL/File): Area to focus the edit on.
  - `Edit Prompt` (String): Natural language instructions.
  - `Quality Tier` (Select): low/medium/high.
- **Outputs:**
  - `Edited Image` (URL): The resulting image.
  - `Metadata` (Object): Width, height, and token usage stats.
- **Chain-friendly with:**
  - **Before:** `fal-ai/gpt-image-1.5` (Text-to-Image) to generate the base scene.
  - **After:** `fal-ai/magnific-upscaler` to enhance the final edited result for high-resolution print.

## Notes & gotchas
- **Max Input:** You can provide up to 16 images in some contexts, but for simple edits, a single source image is best.
- **Region:** Available globally via FAL.ai.
- **Content Policy:** Subject to OpenAI's safety filters (no NSFW, no violent content, restricted political figures).

## Sources
- [FAL.ai GPT Image 1.5 Edit Documentation](https://fal.ai/models/fal-ai/gpt-image-1.5/edit/api)
- [OpenAI "New ChatGPT Images" Announcement](https://openai.com/index/new-chatgpt-images-is-here/)
- [OpenAI Developer Guide: Image Generation](https://developers.openai.com/api/docs/guides/image-generation)
- [FAL.ai GPT Image 1.5 Prompting Guide](https://fal.ai/learn/devs/gpt-image-1-5-prompt-guide)
