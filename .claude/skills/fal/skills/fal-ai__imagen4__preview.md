---
name: fal-ai/imagen4/preview
display_name: Imagen 4 (Preview)
category: text-to-image
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/imagen4/preview
original_source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate
summary: Google's flagship text-to-image model featuring state-of-the-art photorealism, fine-detail rendering, and exceptional typography.
---

# Imagen 4 (Preview)

## Overview
- **Slug:** `fal-ai/imagen4/preview`
- **Category:** Text-to-Image
- **Creator:** [Google DeepMind](https://deepmind.google/technologies/imagen-3/)
- **Best for:** High-fidelity photorealistic images, intricate textures, and accurate text rendering within images.
- **FAL docs:** [fal.ai/models/fal-ai/imagen4/preview](https://fal.ai/models/fal-ai/imagen4/preview)
- **Original source:** [Google Vertex AI Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate)

## What it does
Imagen 4 is Google's most advanced image generation model, designed to deliver exceptional visual quality with a focus on photorealism, lighting, and composition ([Google DeepMind](https://deepmind.google/technologies/imagen-3/)). It excels at rendering fine details—such as fabric textures, water droplets, and fur—and has made significant breakthroughs in typography, allowing it to generate crisp, legible text within images ([TechCrunch](https://techcrunch.com/2025/05/20/imagen-4-is-googles-newest-ai-image-generator/)). As a "preview" model on FAL.ai, it showcases the next generation of Google's vision technology before full general availability ([Replicate Blog](https://replicate.com/blog/google-imagen-4)).

## When to use this model
- **Use when:** You need high-end photorealism, professional-grade marketing assets, or images requiring specific, legible text (e.g., posters, logos, signage).
- **Don't use when:** You need ultra-fast, low-cost iterations (consider the `fast` variant) or if you are working with extremely abstract or contradictory prompts that might confuse the model's adherence logic ([Eachlabs](https://www.eachlabs.ai/ai-models/imagen4-preview/llms.txt)).
- **Alternatives:**
  - **Flux 1.1 [pro]:** Better for diverse artistic styles and open-weights flexibility.
  - **Imagen 3:** More established, potentially more stable for general tasks but with lower detail fidelity.
  - **Imagen 4 (Fast):** Optimized for speed and cost-efficiency at $0.04/image ([FAL.ai Pricing](https://fal.ai/pricing)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/imagen4/preview` (sync) / `https://queue.fal.run/fal-ai/imagen4/preview` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | Detailed text description of the image. Supports up to ~150-200 words. |
| `num_images` | integer | 1 | 1 - 4 | Number of images to generate in a single request. |
| `seed` | integer | - | - | For reproducible results. Same seed + same prompt = same image. |
| `aspect_ratio` | enum | `1:1` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4` | Control the output dimensions. |
| `output_format` | enum | `jpeg` | `jpeg`, `png`, `webp` | File format for the generated image. |
| `safety_tolerance` | enum | `2` | 1 (strict) - 6 (lenient) | Content moderation level. Available via API only. |
| `sync_mode` | boolean | `false` | - | If `true`, returns data URI instead of URL. |
| `resolution` | enum | `1K` | `1K`, `2K` | Output resolution. 2K offers up to 2048x2048 fidelity. |

### Output
The API returns a JSON object containing a list of image objects and a natural language description of the generated content.

```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/jpeg"
    }
  ],
  "description": "A detailed description of the generated scene..."
}
```

### Example request
```json
{
  "input": {
    "prompt": "An intimate close-up of a vintage 1960s kitchen, warm soft sunlight filtering through, a package of 'All-Purpose Flour' on a speckled countertop, exceptional typography, photorealistic style.",
    "aspect_ratio": "16:9",
    "num_images": 1,
    "resolution": "2K"
  }
}
```

### Pricing
- **Standard (this model):** $0.05 per image ([FAL.ai](https://fal.ai/models/fal-ai/imagen4/preview)).
- **Fast:** $0.04 per image.
- **Ultra:** $0.06 per image.

## API — via Original Source (BYO-key direct)
Google offers Imagen 4 through **Vertex AI** and the **Gemini API**.
- **Endpoint:** `https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION}/publishers/google/models/imagen-4.0-generate-001:predict`
- **Auth method:** Google Cloud Service Account (OAuth 2.0 Bearer Token).
- **Extra Parameters:** Native Google API supports `personGeneration` (toggle for human subjects), `upscale` (built-in 2x/4x upscaling), and `watermark` (SynthID digital watermarking) ([Google Cloud Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate)).
- **Official Docs:** [Vertex AI Imagen Overview](https://cloud.google.com/vertex-ai/docs/generative-ai/image/overview)

## Prompting best practices
- **The "Brief" Approach:** Imagen 4 responds best to structured prompts following a "Subject + Context + Style + Detail" framework ([AtLabs](https://www.atlabs.ai/blog/imagen-4-prompting-guide)).
- **Direct Typography:** To render text, use quotes and specify placement (e.g., `"a storefront sign that says 'The Bakery' in elegant script font"`). Limit text to 25 characters for best results ([Kittl Blog](https://www.kittl.com/blogs/how-google-imagen-4-fixes-the-text-problem-in-ai-art-ais/)).
- **Photography Keywords:** Start prompts with `"A photo of..."` to trigger the model's advanced realistic rendering engine ([Google Prompt Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/img-gen-prompt-guide)).
- **Avoid "No":** Instead of saying "no clouds," describe the positive state like "clear blue sky" ([AtLabs](https://www.atlabs.ai/blog/imagen-4-prompting-guide)).
- **Conciseness:** Keep prompts under 150 words. Overly long prompts can cause "instruction leakage" where parts of the prompt text appear literally in the image ([Kittl Blog](https://www.kittl.com/blogs/how-google-imagen-4-fixes-the-text-problem-in-ai-art-ais/)).

## Parameter tuning guide
- **Resolution (1K vs 2K):** Use 1K for rapid prototyping and 2K for final assets. 2K significantly enhances texture clarity but may take slightly longer to generate ([Eachlabs](https://www.eachlabs.ai/ai-models/imagen4-preview/llms.txt)).
- **Aspect Ratio:** Match the aspect ratio to your final layout (e.g., 9:16 for TikTok/Reels) to avoid awkward cropping artifacts.
- **Safety Tolerance:** Set to `1` for strictly corporate/safe environments or `6` for more creative, boundary-pushing artistic concepts (within content policy).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `prompt` (String): The core creative instruction.
  - `aspect_ratio` (String): Selection of standard dimensions.
  - `seed` (Number): For versioning and control.
  - `resolution` (String): Toggle for quality.
- **Outputs:**
  - `image_url` (URL): The resulting image link.
  - `revised_prompt` (String): The model's internal description/expansion of the scene.
- **Chain-friendly with:**
  - **fal-ai/upscaler:** To take 2K outputs to 4K or 8K.
  - **fal-ai/face-swap:** For personalization of generated human subjects.
  - **fal-ai/background-remover:** For isolating products generated with high fidelity.

## Notes & gotchas
- **Preview Status:** As a preview model, parameters and behavior may shift as Google refines the weights ([Replicate Blog](https://replicate.com/blog/google-imagen-4)).
- **Watermarking:** All outputs are invisibly watermarked with **Google SynthID** to identify them as AI-generated ([Google Developers Blog](https://developers.googleblog.com/announcing-imagen-4-fast-and-imagen-4-family-generally-available-in-the-gemini-api/)).
- **Rate Limits:** While FAL provides high concurrency, the underlying Google API may have region-specific quotas.

## Sources
- [FAL.ai Imagen 4 Model Page](https://fal.ai/models/fal-ai/imagen4/preview)
- [Google Vertex AI Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate)
- [TechCrunch Announcement](https://techcrunch.com/2025/05/20/imagen-4-is-googles-newest-ai-image-generator/)
- [AtLabs Prompting Guide](https://www.atlabs.ai/blog/imagen-4-prompting-guide)
- [Kittl Typography Guide](https://www.kittl.com/blogs/how-google-imagen-4-fixes-the-text-problem-in-ai-art-ais/)
