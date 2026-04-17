---
name: fal-ai/gpt-image-1.5
display_name: GPT-Image 1.5
category: text-to-image
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/gpt-image-1.5
original_source: https://openai.com/index/new-chatgpt-images-is-here/
summary: OpenAI's state-of-the-art multimodal image generation and editing model with superior prompt adherence and text rendering.
---

# GPT-Image 1.5

## Overview
- **Slug:** `fal-ai/gpt-image-1.5`
- **Category:** Text-to-Image / Image-to-Image (Editing)
- **Creator:** [OpenAI](https://openai.com/)
- **Best for:** High-fidelity production assets, precise branding preservation, and complex text rendering.
- **FAL docs:** [fal-ai/gpt-image-1.5](https://fal.ai/models/fal-ai/gpt-image-1.5)
- **Original source:** [OpenAI Platform](https://developers.openai.com/api/docs/guides/image-generation)

## What it does
GPT-Image 1.5 is OpenAI's second-generation flagship image model, released in December 2025 as the successor to GPT-Image 1 (and the underlying tech for DALL-E 3). It is a natively multimodal transformer-based diffusion model that treats images and text as tokens within the same architecture. This allows for unprecedented "reasoning" over visual composition, enabling the model to follow complex spatial instructions, render legible small-font text, and perform targeted "region-aware" edits while preserving identities and logos ([EvoLink.ai](https://evolink.ai/blog/gpt-image-1-5-guide-features-comparison-access)).

## When to use this model
- **Use when:** You need accurate text inside images (infographics, UI mockups, posters), precise preservation of brand logos, or iterative editing of existing images without changing the overall composition ([OpenAI Developers](https://developers.openai.com/api/docs/guides/image-generation)).
- **Don't use when:** You need extremely high-resolution print outputs (>2K) or are looking for highly stylized "artistic artifacts" that traditional diffusion models produce; GPT-Image 1.5 leans heavily toward photographic and logical realism.
- **Alternatives:** 
    - **Flux.1 [pro]:** Better for raw aesthetic quality and "vibe," though GPT-Image 1.5 generally beats it on complex text and instruction following.
    - **Stable Diffusion 3.5:** Offers more "artistic" control and local fine-tuning capabilities, but lacks the native multimodal reasoning of GPT-Image.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gpt-image-1.5` (Sync) / `https://queue.fal.run/fal-ai/gpt-image-1.5` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | Max 2000 chars | The prompt for image generation or editing. |
| `image_size` | `enum` | `1024x1024` | `1024x1024`, `1536x1024`, `1024x1536` | Aspect ratio of the generated image. |
| `background` | `enum` | `auto` | `auto`, `transparent`, `opaque` | Background type. `transparent` requires `png` or `webp`. |
| `quality` | `enum` | `medium` | `low`, `medium`, `high` | Tradeoff between speed and detail. `high` provides max fidelity. |
| `num_images` | `integer` | `1` | `1-4` | Number of images to generate. |
| `output_format` | `enum` | `jpeg` | `jpeg`, `png`, `webp` | File format for the output. |
| `image_urls` | `list<string>` | `[]` | Up to 16 URLs | (Edit mode only) Reference images for the model to use. |
| `input_fidelity` | `enum` | `low` | `low`, `high` | Controls how strictly the model preserves the input image details. |
| `mask_image_url` | `string` | `null` | Public URL | (Edit mode only) Defines specific areas of the image to modify. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If true, returns data URI directly. |

### Output
The output is a JSON object containing a list of `images` with their URLs and metadata.
```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png",
      "file_name": "example.png",
      "file_size": 1048576
    }
  ],
  "usage": {
    "total_tokens": 4500,
    "input_tokens_details": { "text_tokens": 50, "image_tokens": 3050 },
    "output_tokens_details": { "text_tokens": 200, "image_tokens": 1200 }
  }
}
```

### Pricing
GPT-Image 1.5 uses a hybrid token + per-image pricing model on FAL.ai ([FAL.ai Pricing](https://fal.ai/pricing)):
- **Text Tokens:** $0.005 / 1K input, $0.010 / 1K output.
- **Image Generation (1024x1024):** 
    - **Low Quality:** $0.009 / image
    - **Medium Quality:** $0.034 / image
    - **High Quality:** $0.133 / image
- **Large Sizes (1536x1024 / 1024x1536):** Cost increases by approximately 50%.

## API — via Original Source (BYO-key direct)
OpenAI offers a direct API endpoint for GPT-Image 1.5 ([OpenAI Docs](https://developers.openai.com/api/docs/guides/image-generation)):
- **Endpoint:** `https://api.openai.com/v1/images/generations`
- **Model ID:** `gpt-image-1.5` or `gpt-image-1.5-lite`.
- **Unique Params:** `moderation` (`auto`, `low`) and `action` (`auto`, `generate`, `edit`).
- **Auth:** Standard OpenAI Bearer Token.

## Prompting best practices
- **Be Explicit about Layout:** Use directional keywords like "in the bottom-left corner" or "centered in the background." The model's multimodal reasoning handles spatial relationships significantly better than SDXL or Flux ([EvoLink.ai](https://evolink.ai/blog/gpt-image-1-5-guide-features-comparison-access)).
- **Text within Quotes:** For text rendering, use double quotes: `a neon sign that says "OPEN 24 HOURS" in a retro script`.
- **Preserve Identity:** When editing, if you want to keep a person's face identical, use `input_fidelity="high"` and mention "preserve facial features" in the prompt.
- **Avoid Over-Prompting:** GPT-Image 1.5 uses the same "rewriting" logic as DALL-E 3; simple, descriptive sentences often work better than comma-separated keyword soup.
- **Example Good Prompt:** "A professional studio shot of a glass perfume bottle on a marble slab. The label on the bottle should clearly read 'ELIXIR'. Soft golden hour light coming from the top right. Minimalist white background."
- **Example Bad Prompt:** "perfume, bottle, marble, 'ELIXIR', 8k, ultra realistic, trending on artstation, masterpiece, hyperdetailed." (The model ignores many of these quality "hacks" and may hallucinate a generic bottle).

## Parameter tuning guide
- **Quality Setting:** Use `low` for rapid prototyping (8-10s) and `high` for final production assets (15-20s). `medium` is the sweet spot for most web-use cases ([Higgsfield](https://higgsfield.ai/blog/GPT-Image-1.5-by-OpenAI-is-on-Higgsfield-A-Complete-Guide)).
- **Input Fidelity:** Set to `high` for brand-critical work (logos, product packaging) or character consistency. Set to `low` when you want the model to creatively reimagine the reference image (e.g., "turn this photo into a watercolor painting").
- **Background:** Use `transparent` directly if you need to overlay the image on a UI; this avoids the need for a separate background removal step, although it works best on simple subjects.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Reference Image` (Image URL - Optional for editing)
    - `Mask` (Image URL - Optional for targeted inpainting)
    - `Quality` (Selection)
- **Outputs:**
    - `Result Image` (Image URL)
    - `Token Usage` (Object/JSON)
- **Chain-friendly with:**
    - **Segment Anything (SAM):** Use SAM to generate a mask, then feed to GPT-Image 1.5 for precise object swapping.
    - **Magnific AI / Upscalers:** Since GPT-Image 1.5 maxes at 1.5K, chain it with an upscaler for print-ready 4K/8K files.

## Notes & gotchas
- **Accumulated Error:** After 6-8 consecutive edit passes on the same image, quality and "identity" often begin to degrade as pixel artifacts compound ([EvoLink.ai](https://evolink.ai/blog/gpt-image-1-5-guide-features-comparison-access)).
- **Safety Filters:** OpenAI's filters are active. Using `moderation="low"` (if supported by your API tier) can reduce false-positive refusals on "edgy" but safe creative work.
- **Resolution Cap:** Does not natively support resolutions higher than 1536px in any dimension.

## Sources
- [FAL.ai GPT-Image 1.5 Model Page](https://fal.ai/models/fal-ai/gpt-image-1.5)
- [OpenAI Developer Documentation](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI "New ChatGPT Images" Announcement](https://openai.com/index/new-chatgpt-images-is-here/)
- [EvoLink.ai GPT-Image 1.5 Technical Guide](https://evolink.ai/blog/gpt-image-1-5-guide-features-comparison-access)
- [Lumenfall Provider Comparison](https://lumenfall.ai/models/openai/gpt-image-1.5/providers)