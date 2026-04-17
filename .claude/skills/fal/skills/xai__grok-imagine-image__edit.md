---
name: xai/grok-imagine-image/edit
display_name: Grok Imagine Image Edit
category: image-to-image
creator: xAI
fal_docs: https://fal.ai/models/xai/grok-imagine-image/edit
original_source: https://docs.x.ai/developers/model-capabilities/images/generation
summary: A high-speed, precision image editing model by xAI that follows natural language instructions to modify existing images.
---

# Grok Imagine Image Edit

## Overview
- **Slug:** `xai/grok-imagine-image/edit`
- **Category:** Image-to-Image / Image Editing
- **Creator:** [xAI](https://x.ai)
- **Best for:** Precise, text-guided modifications to existing images with high fidelity and speed.
- **FAL docs:** [fal.ai/models/xai/grok-imagine-image/edit](https://fal.ai/models/xai/grok-imagine-image/edit)
- **Original source:** [xAI Documentation](https://docs.x.ai/developers/model-capabilities/images/generation)

## What it does
Grok Imagine Image Edit is xAI’s high-performance image-to-image model designed to apply targeted modifications to source images based on natural language instructions. It excels at maintaining the structural coherence of the original image while accurately executing commands like "change the background to a rainy city," "add a leather jacket," or "render this in a pencil sketch style." The model is particularly noted for its speed (often under 4 seconds) and its ability to render readable text within edited regions.

## When to use this model
- **Use when:** You need to iterate on an existing design, perform style transfers, swap backgrounds, or add/remove specific objects while preserving the original composition.
- **Don't use when:** You need extremely high-resolution (4K+) professional print output (maxes out at 2K) or when you need to generate entirely new scenes from scratch without a reference image (use `xai/grok-imagine-image` instead).
- **Alternatives:** 
    - **[FLUX.2 [pro] Edit](https://fal.ai/models/fal-ai/flux-2-flex):** Better for complex prompt adherence but usually more expensive and slower.
    - **[GPT Image 1.5 Edit](https://fal.ai/models/fal-ai/gpt-image-edit):** Often cheaper but may lack the same level of structural consistency as Grok.

## API — via FAL.ai
**Endpoint:** `https://fal.run/xai/grok-imagine-image/edit` (sync) / `https://queue.fal.run/xai/grok-imagine-image/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | Text description of the desired changes or the final scene. |
| `image_urls` | list<string> | N/A | Max 3 | A list of URLs for the source images to be edited. Supports up to 3 images for merging/editing. |
| `num_images` | integer | `1` | 1–10 | Number of images to generate per request. |
| `resolution` | string | `1k` | `1k`, `2k` | `1k` for standard resolution, `2k` for high resolution. |
| `output_format` | string | `jpeg` | `jpeg`, `png`, `webp` | The file format of the generated image. |
| `sync_mode` | boolean | `false` | `true`, `false` | If `true`, returns the media as a base64 data URI directly in the response. |

### Output
The output returns a JSON object containing a list of edited images and the revised prompt used for the generation.
```json
{
  "images": [
    {
      "url": "https://fal.run/output/...",
      "width": 1024,
      "height": 768,
      "content_type": "image/jpeg",
      "file_name": "output.jpg",
      "file_size": 154320
    }
  ],
  "revised_prompt": "An enhanced version of your prompt used internally for better results."
}
```

### Example request
```json
{
  "prompt": "Change the cat into a robotic cyberpunk cat with neon blue eyes",
  "image_urls": ["https://example.com/original-cat.jpg"],
  "resolution": "1k",
  "output_format": "png"
}
```

### Pricing
- **Cost per Image:** $0.022 total.
- **Breakdown:** $0.02 for the image output + $0.002 for the image input processing.
- Note: If multiple images are generated (via `num_images`), the cost scales per output image.

---

## API — via Original Source (BYO-key direct)
xAI provides a direct API that is largely compatible with the OpenAI SDK format.

- **Endpoint:** `https://api.x.ai/v1/images/edits`
- **Auth Method:** Bearer Token (`XAI_API_KEY`)
- **Native Parameters not on FAL:**
  - `aspect_ratio`: Supports specific strings like `"16:9"`, `"9:16"`, `"4:3"`, `"3:2"`, `"2:1"`, and `"auto"`.
  - `n`: Batch size (up to 10).
  - `image`: Accepts a single image object `{ "url": "...", "type": "image_url" }` in addition to the `image_urls` list.
  - `response_format`: `"url"` or `"b64_json"`.
- **Link to official docs:** [xAI Image Generation Docs](https://docs.x.ai/developers/model-capabilities/images/generation)

## Prompting best practices
- **Be Instructional:** Since this is an edit model, start with verbs like "Add," "Change," "Remove," or "Replace."
- **Mixing Elements:** Use the pipe symbol (`|`) to blend concepts. Example: `cat:1.0|robot:0.5` to create a cat with subtle robotic features.
- **Style Overrides:** Clearly specify the medium. Phrases like "Render as an oil painting" or "Detailed pencil sketch" work very well for style transfers.
- **Negative Weights:** You can use negative values for weights to suppress elements, though this is primarily for advanced users via the native API syntax.
- **Example Good Prompt:** "Change the background to a futuristic Mars colony with red sand and glass domes, maintaining the person in the foreground."
- **Example Bad Prompt:** "Mars" (Too vague; doesn't specify what to do with the existing image).

## Parameter tuning guide
- **Resolution (`1k` vs `2k`):** Use `1k` for rapid prototyping and $0.02 cost. Switch to `2k` only for final assets, as it may slightly increase latency.
- **`image_urls` Multi-Merge:** When providing multiple images, the model tries to "merge" them into the prompt's context. Ensure images have similar lighting or clear separation (e.g., subject in one, background in another) for the best results.
- **`num_images` (Batching):** Set this to `4` if you want to see variations of the same edit instruction to pick the best result in one go.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Source Image (URL)`: The original image to modify.
  - `Instruction (String)`: What to change.
  - `Resolution (Enum)`: 1k or 2k.
- **Outputs:**
  - `Edited Image (URL)`: The final result.
  - `Revised Prompt`: For debugging or chaining.
- **Chain-friendly with:**
  - **[Vision LLMs](https://fal.ai/models/fal-ai/llava-v1.5-7b):** Use a vision model to describe an image first, then use Grok Imagine Edit to modify it based on that description.
  - **[Upscalers](https://fal.ai/models/fal-ai/esrgan):** Pass the `1k` output to an ESRGAN or AuraSR node for 4K+ final resolution.

## Notes & gotchas
- **Safety Filters:** xAI is strict on content policy. If a request is flagged, you will still be charged for the generation even if the output is blocked or redacted.
- **Temporary URLs:** URLs returned by the xAI native API are temporary. FAL.ai usually hosts them longer, but it is best practice to download or upload to permanent storage immediately.
- **No Masking:** Unlike some Inpainting models, Grok Imagine Edit doesn't use a binary mask; it relies on text instructions to identify what to change. This makes it easier to use but sometimes less "surgical" than mask-based editing.

## Sources
- [FAL.ai Grok Imagine Edit Page](https://fal.ai/models/xai/grok-imagine-image/edit)
- [xAI Developer Documentation](https://docs.x.ai/developers/model-capabilities/images/generation)
- [xAI Model Pricing](https://docs.x.ai/developers/models)
- [LaoZhang AI Pricing Comparison](https://blog.laozhang.ai/en/posts/ai-image-api-pricing-comparison)