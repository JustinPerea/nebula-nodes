---
name: fal-ai/ideogram/v3
display_name: Ideogram v3.0
category: text-to-image
creator: Ideogram AI
fal_docs: https://fal.ai/models/fal-ai/ideogram/v3
original_source: https://ideogram.ai
summary: State-of-the-art text-to-image model specializing in exceptional typography, graphic design, and photorealistic accuracy.
---

# Ideogram v3.0

## Overview
- **Slug:** `fal-ai/ideogram/v3`
- **Category:** Text-to-Image
- **Creator:** [Ideogram AI](https://ideogram.ai)
- **Best for:** Design-heavy graphics and images requiring perfect text rendering.
- **FAL docs:** [fal.ai/models/fal-ai/ideogram/v3](https://fal.ai/models/fal-ai/ideogram/v3)
- **Original source:** [developer.ideogram.ai](https://developer.ideogram.ai)

## What it does
Ideogram v3 is a state-of-the-art text-to-image model renowned for its industry-leading typography and graphic design capabilities. It excels at rendering complex, legible text within images—ranging from long sentences to intricate font styles—while maintaining high-fidelity photorealism and creative flexibility. It is specifically optimized for commercial design, social media assets, and branding [Ideogram Documentation](https://developer.ideogram.ai/ideogram-api/api-overview).

## When to use this model
- **Use when:** You need accurate text rendering (posters, logos, t-shirts), complex layouts, or precise character consistency.
- **Don't use when:** You need high-speed, low-cost "placeholder" images (use SDXL or Flux Lightning) or if you are generating simple textures without text.
- **Alternatives:**
    - **[Flux.1 [pro]](https://fal.ai/models/fal-ai/flux-pro):** Similar quality but slightly different aesthetic; often better for "raw" photography.
    - **[Recraft V3](https://fal.ai/models/fal-ai/recraft-v3):** Excellent for vector-style designs and clean SVGs.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ideogram/v3` (sync) / `https://queue.fal.run/fal-ai/ideogram/v3` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | The primary description of the image to generate. |
| `negative_prompt` | string | "" | - | Description of elements to exclude from the image. |
| `image_size` | string/obj | `square_hd` | `square`, `landscape_16_9`, `portrait_4_3`, etc. | Resolution of the image. Can also pass `{"width": X, "height": Y}`. |
| `rendering_speed` | string | `BALANCED` | `TURBO`, `BALANCED`, `QUALITY` | Determines the quality-vs-speed tradeoff. |
| `expand_prompt` | boolean | `true` | `true`, `false` | Whether to use Ideogram's "MagicPrompt" to enhance your input. |
| `style` | string | `AUTO` | `AUTO`, `GENERAL`, `REALISTIC`, `DESIGN`, `FICTION` | The visual direction of the generation. |
| `style_preset` | string | - | `80S_ILLUSTRATION`, `ART_DECO`, etc. | A specific artistic aesthetic to apply. |
| `color_palette` | object/str | - | `EMBER`, `FRESH`, `JUNGLE`, etc. | A named preset or custom RGB list to guide the color scheme. |
| `image_urls` | list[str] | [] | - | A list of image URLs to use as style references (max 10MB total). |
| `style_codes` | list[str] | [] | - | 8-character hex codes representing specific Ideogram styles. |
| `num_images` | integer | 1 | 1 - 4 | Number of images to generate per request. |
| `seed` | integer | - | 0 - 2147483647 | Seed for reproducible results. |
| `sync_mode` | boolean | `false` | - | If `true`, returns data URI instead of a hosted URL. |

### Output
The API returns a JSON object containing:
- `images`: A list of file objects, each with a `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for the generation.

### Example request
```json
{
  "prompt": "A cinematic poster for a movie titled \"THE SILENT GALAXY\" featuring a lone astronaut looking at a neon nebula.",
  "image_size": "landscape_16_9",
  "rendering_speed": "QUALITY",
  "style": "DESIGN",
  "expand_prompt": true
}
```

### Pricing
Billed per image generated, based on the `rendering_speed` tier [FAL.ai Learn](https://fal.ai/learn/tools/ai-image-generators):
- **TURBO:** $0.03 per image
- **BALANCED:** $0.06 per image
- **QUALITY:** $0.09 per image

## API — via Original Source (BYO-key direct)
Ideogram offers a direct API for developers [Ideogram Developer Docs](https://developer.ideogram.ai/api-reference/api-reference/generate-v3):
- **Endpoint:** `https://api.ideogram.ai/v1/ideogram-v3/generate`
- **Auth:** Header `Api-Key: <YOUR_KEY>`
- **Differences:** The native API supports generating up to **8 images** per request and offers specialized endpoints for `character-reference` and `layerize-text` (SVG-like text layers).

## Prompting best practices
- **Quote your text:** For best results, wrap text in quotation marks: `A neon sign that says "OPEN LATE"`.
- **Use Layout Verbs:** Ideogram responds well to spatial cues: `centered`, `bottom-aligned`, `curved above`, `stacked vertically` [CrePal Guide](https://crepal.ai/blog/aiimage/ideogram-prompt-tips/).
- **Specify Font Styles:** Don't just say "text"; use descriptors like `bold sans-serif`, `elegant cursive`, or `vintage slab serif`.
- **Style Anchors:** Use a single strong style anchor (e.g., `Vector flat illustration`) rather than a string of conflicting adjectives.
- **Example Good Prompt:** `"A high-quality product photo of a coffee bag. Text on the bag reads 'MORNIN\\' BREW' in a rustic font. Background: a cozy wooden kitchen counter, shallow depth of field, 8k resolution."`
- **Example Bad Prompt:** `"Coffee bag with text, make it look good and professional with words written on it."` (Too vague; lacks text quotes and layout cues).

## Parameter tuning guide
- **MagicPrompt (expand_prompt):** Keep this `ON` (default) for creative or short prompts. Turn it `OFF` if you have a highly technical prompt and want the model to follow it literal-word-for-literal-word.
- **Style Type:**
    - `DESIGN`: Essential for logos, posters, and any graphic where layout matters more than photorealism.
    - `REALISTIC`: Use for photography; it reduces "illustration" artifacts.
- **Rendering Speed:** Use `TURBO` for quick iterations or brainstorming; switch to `QUALITY` for final renders where text legibility in small details is critical.
- **Color Palettes:** Use the `color_palette` parameter instead of listing colors in the prompt to ensure a cohesive "branded" look.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Negative Prompt` (Text)
    - `Aspect Ratio` (Dropdown)
    - `Style Image` (Image/URL)
    - `Seed` (Integer)
- **Outputs:**
    - `Generated Image` (Image URL)
    - `Seed used` (Integer)
- **Chain-friendly with:**
    - **[Remove Background](https://fal.ai/models/fal-ai/bria/background-removal):** Perfect for turning Ideogram logos into transparent assets.
    - **[Magnific Upscaler](https://fal.ai/models/fal-ai/magnific-upscaler):** To take Ideogram's design concepts to print-ready 4k/8k resolutions.

## Notes & gotchas
- **Text Limits:** While industry-leading, very long paragraphs (50+ words) may still occasionally contain minor character swaps.
- **Non-Latin Characters:** Ideogram v3 performs best with the Latin alphabet. Cyrillic, Kanji, or Arabic may have lower accuracy [Ideogram Docs](https://docs.ideogram.ai/using-ideogram/prompting-guide/2-prompting-fundamentals/text-and-typography).
- **Ephemeral Links:** Image URLs returned by the API are typically temporary. Download or re-host them immediately for persistent use.

## Sources
- [FAL.ai Ideogram v3 Documentation](https://fal.ai/models/fal-ai/ideogram/v3/api)
- [Ideogram Official API Documentation](https://developer.ideogram.ai/api-reference/api-reference/generate-v3)
- [Ideogram MagicPrompt Guide](https://docs.ideogram.ai/using-ideogram/generation-settings/magic-prompt)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
