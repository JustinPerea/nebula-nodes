---
name: xai/grok-imagine-image
display_name: Grok Imagine Image
category: text-to-image
creator: xAI
fal_docs: https://fal.ai/models/xai/grok-imagine-image
original_source: https://docs.x.ai/developers/model-capabilities/images/generation
summary: High-fidelity image generation model by xAI, optimized for aesthetic quality, text rendering, and high-resolution output up to 2K.
---

# Grok Imagine Image

## Overview
- **Slug:** `xai/grok-imagine-image`
- **Category:** Text-to-Image
- **Creator:** [xAI](https://x.ai)
- **Best for:** High-aesthetic artistic generations, precise text rendering in images, and high-resolution (2K) commercial assets.
- **FAL docs:** [fal.ai/models/xai/grok-imagine-image](https://fal.ai/models/xai/grok-imagine-image)
- **Original source:** [xAI Developer Docs](https://docs.x.ai/developers/model-capabilities/images/generation)

## What it does
Grok Imagine Image is a state-of-the-art text-to-image model developed by xAI. It is designed to generate highly aesthetic, high-fidelity images with a strong emphasis on prompt adherence and visual quality. The model excels at rendering legible text within images and offers flexibility through a wide range of supported aspect ratios and high-resolution output options (up to 2048px).

## When to use this model
- **Use when:** You need high-quality artistic or photorealistic images with specific aspect ratios for social media, or when your prompt includes text that needs to be rendered accurately.
- **Don't use when:** You require ultra-fast "latent" style previews (use `fast-sdxl` or similar) or if you need deep 8K+ upscaling natively within the generation step.
- **Alternatives:** 
    - **Flux.1 [dev]:** Better for complex human anatomy and extremely long, descriptive prompts.
    - **Stable Diffusion 3.5:** Good for general purpose and broad community support.
    - **Imagen 4 Fast:** Comparable pricing ($0.02) with higher throughput limits.

## API — via FAL.ai
**Endpoint:** `https://fal.run/xai/grok-imagine-image` (sync) / `https://queue.fal.run/xai/grok-imagine-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | Text description of the desired image. Supports detailed aesthetic descriptions. |
| `num_images` | integer | `1` | `1` to `4` | Number of images to generate per request. |
| `aspect_ratio` | enum | `1:1` | `2:1, 20:9, 19.5:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:19.5, 9:20, 1:2` | The layout of the generated image. |
| `resolution` | enum | `1k` | `1k, 2k` | `1k` for standard resolution (~1MP), `2k` for high resolution (~4MP/2048px). |
| `output_format` | enum | `jpeg` | `jpeg, png, webp` | The file format of the generated image. |
| `sync_mode` | boolean | `false` | `true, false` | If `true`, returns media as a data URI and omits output from request history. |

### Output
The API returns a JSON object containing a list of generated images and a revised prompt.

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
  "revised_prompt": "An enhanced version of your input prompt used for generation."
}
```

### Example request
```json
{
  "prompt": "A futuristic city skyline at night with neon lights, cinematic lighting, 8k resolution, highly detailed, cyberpunk aesthetic.",
  "aspect_ratio": "16:9",
  "resolution": "2k",
  "output_format": "png"
}
```

### Pricing
- **Standard (1K):** $0.02 per image.
- **High Res (2K):** Priced proportionally based on megapixel count (approximately $0.08 per image).
- *Note: Pricing is pay-per-use with no minimums.* [FAL Pricing](https://fal.ai/pricing)

## API — via Original Source (BYO-key direct)
xAI provides a direct API for Grok Imagine Image which is OpenAI-compatible.

- **Endpoint:** `https://api.x.ai/v1/images/generations`
- **Auth Method:** Bearer Token (`XAI_API_KEY`)
- **Native Parameters:** 
    - `model`: `"grok-imagine-image"`
    - `n`: Number of images (equivalent to `num_images`)
    - `response_format`: `"url"` or `"b64_json"`
- **Direct Docs:** [xAI Image Generation API](https://docs.x.ai/developers/model-capabilities/images/generation)

## Prompting best practices
- **Be Descriptive:** Grok responds well to atmospheric and stylistic keywords (e.g., "soft cinematic lighting," "macro photography," "minimalist vector art").
- **Text Rendering:** To include text, use double quotes within the prompt, e.g., `A neon sign that says "Grok"`.
- **Negative Prompting:** While not a separate field, you can use phrases like "no watermarks," "no blur," or "simple background" within the main prompt to guide the model.
- **Revised Prompt:** Pay attention to the `revised_prompt` in the output; it reveals how the model interpreted your instructions and can help you iterate.
- **Example Good Prompt:** `"A clean poster design with bold white text saying 'CREATE FASTER' centered on a dark blue gradient background, modern typography, minimal style."`
- **Example Bad Prompt:** `"fast create"` (Too vague; lacks style and layout context).

## Parameter tuning guide
- **Resolution (1k vs 2k):** Use `1k` for rapid prototyping and iteration. Switch to `2k` only for final outputs to manage costs and generation time.
- **Aspect Ratio:** Match the `aspect_ratio` to your target platform (e.g., `9:16` for TikTok/Reels, `16:9` for presentations) to avoid AI-generated "black bars" or awkward cropping.
- **Output Format:** Use `webp` for web applications to save bandwidth, or `png` for high-quality printing and post-processing.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Aspect Ratio` (Dropdown)
    - `Resolution` (Toggle: 1k/2k)
    - `Format` (Dropdown: jpeg/png/webp)
- **Outputs:**
    - `Image URL` (Image/URL)
    - `Revised Prompt` (Text)
- **Chain-friendly with:**
    - `xai/grok-imagine-video/image-to-video`: Animate your generated image.
    - `fal-ai/upscaler`: Further increase resolution for large-scale prints.
    - `fal-ai/face-swap`: For character consistency across scenes.

## Notes & gotchas
- **Safety Filter:** Content deemed in violation of xAI's terms will not generate an image, but the request may still be charged.
- **Rate Limits:** Standard tier on xAI direct API allows up to 300 RPM, but FAL.ai manages its own concurrency limits based on your account tier.
- **Prompt Modification:** The model automatically "enhances" prompts; if you want strict adherence, try to be as explicit as possible about the composition.

## Sources
- [FAL.ai Grok Imagine Image](https://fal.ai/models/xai/grok-imagine-image)
- [xAI Developer Documentation](https://docs.x.ai/developers/model-capabilities/images/generation)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Imagine.Art Grok Overview](https://www.imagine.art/blogs/grok-imagine-overview)