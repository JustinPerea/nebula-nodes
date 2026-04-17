---
name: fal-ai/recraft/v4/text-to-image
display_name: Recraft V4 (Standard)
category: text-to-image
creator: Recraft AI
fal_docs: https://fal.ai/models/fal-ai/recraft/v4/text-to-image
original_source: https://www.recraft.ai/docs
summary: A design-centric text-to-image model optimized for brand systems, precise color control, and professional composition.
---

# Recraft V4 (Standard)

## Overview
- **Slug:** `fal-ai/recraft/v4/text-to-image`
- **Category:** text-to-image
- **Creator:** [Recraft AI](https://www.recraft.ai/)
- **Best for:** Professional design, brand-consistent visuals, and precise color-controlled image generation.
- **FAL docs:** [fal-ai/recraft/v4/text-to-image](https://fal.ai/models/fal-ai/recraft/v4/text-to-image)
- **Original source:** [Recraft AI Documentation](https://www.recraft.ai/docs)

## What it does
Recraft V4 is a "design-grade" generative model rebuilt from the ground up to prioritize visual taste over generic stock-photo aesthetics ([Recraft AI](https://www.recraft.ai/docs/recraft-models/recraft-V4)). It excels at maintaining balanced composition, cohesive lighting, and intentional detail across a wide range of formats ([FAL.ai](https://fal.ai/models/fal-ai/recraft/v4/text-to-image)). Unlike general-purpose models, Recraft V4 is specifically tuned for professional workflows, offering native RGB color palette control and superior handling of typographic hierarchy and graphic design logic ([Recraft Blog](https://www.recraft.ai/blog/prompt-engineering-guide)).

## When to use this model
- **Use when:** You need brand-consistent imagery with specific hex/RGB colors, high-quality graphic design layouts, or clean vector-like raster illustrations.
- **Don't use when:** You need high-fidelity human anatomy in complex action poses or ultra-realistic "messy" photography that exceeds the model's curated design aesthetic.
- **Alternatives:** 
    - **[Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** Better for complex prompt adherence and hyper-realistic human details, but lacks native color palette control.
    - **[Recraft V4 Pro](https://fal.ai/models/fal-ai/recraft/v4/pro/text-to-image):** Use when you need 4MP (2048px) resolution for print-ready assets; the standard V4 is limited to 1MP (1024px).
    - **[DALL-E 3](https://fal.ai/models/fal-ai/dalle-3):** Better for general creative concepts but more restrictive and less customizable for professional designers ([Recraft Blog](https://www.recraft.ai/blog/best-dall-e-alternatives)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/recraft/v4/text-to-image` (sync) / `https://queue.fal.run/fal-ai/recraft/v4/text-to-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | Max 10,000 chars | The text description of the image. Supports long, structured prompts. |
| `image_size` | `enum/object` | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{ "width": int, "height": int }` | Defines output resolution and aspect ratio. Default is 1024x1024. |
| `colors` | `array` | `[]` | List of `{ "r": int, "g": int, "b": int }` | An array of preferred RGB colors to guide the generation palette. |
| `background_color` | `object` | `null` | `{ "r": int, "g": int, "b": int }` | The preferred background color for the generated image. |
| `enable_safety_checker` | `boolean` | `true` | `true`, `false` | If enabled, filters for NSFW/restricted content. |

### Output
The output is a JSON object containing a list of generated image metadata.
```json
{
  "images": [
    {
      "url": "https://fal.run/files/...",
      "content_type": "image/png",
      "file_name": "generated_image.png",
      "file_size": 272628
    }
  ]
}
```

### Example request
```json
{
  "prompt": "Minimalist brand identity mockup on a marble surface, matte black business card with gold foil logo, realistic lighting",
  "image_size": "landscape_16_9",
  "colors": [
    {"r": 0, "g": 0, "b": 0},
    {"r": 255, "g": 215, "b": 0}
  ]
}
```

### Pricing
- **Cost:** $0.04 per image ([FAL.ai](https://fal.ai/recraft-v4)).

## API — via Original Source (BYO-key direct)
Recraft AI provides a native REST API that is compatible with the OpenAI Python client library.

- **Endpoint:** `https://external.api.recraft.ai/v1/images/generations`
- **Auth Method:** Bearer Token (`Authorization: Bearer RECRAFT_API_TOKEN`)
- **Extra Parameters:**
    - `model`: Choose between `recraftv4`, `recraftv4_pro`, `recraftv4_vector`.
    - `response_format`: Supports `url` or `b64_json`.
    - `style_id`: Use a previously created custom style as a reference.
- **Official Docs:** [Recraft API Reference](https://www.recraft.ai/docs/api-reference/getting-started)

## Prompting best practices
- **Interpretive Mode:** For early-stage exploration, use short prompts (3-6 words). The model will fill in the missing structural details with its internal design logic ([Recraft AI](https://www.recraft.ai/docs/prompt-engineering-guide/prompting-with-recraft-v4)).
- **Architectural Control:** For precise results, use a structured prompt moving from "Core Concept" to "Environment" to "Lighting" to "Camera/Depth" ([Recraft AI](https://www.recraft.ai/docs/prompt-engineering-guide/prompting-with-recraft-v4)).
- **Text Rendering:** Place all required text in "quotation marks." Recraft V4 is exceptionally strong at rendering legible, stylistically integrated text.
- **Brand Constraints:** For logo or vector-style outputs, explicitly define "Line discipline" (e.g., "consistent stroke, no shadows") and "Shape logic" (e.g., "geometric symmetry") ([Recraft AI](https://www.recraft.ai/docs/prompt-engineering-guide/prompting-with-recraft-v4)).
- **Avoid Quality Stacking:** Don't stack generic adjectives like "ultra-detailed" or "8k." Instead, use concrete technical terms like "matte plastic texture" or "cinematic 3D render" ([Recraft AI](https://www.recraft.ai/docs/prompt-engineering-guide/prompting-with-recraft-v4)).

## Parameter tuning guide
- **Colors Parameter:** This is the most impactful setting for brand work. Providing 2-3 specific RGB values will force the model to build the entire scene around that palette, ensuring it fits into existing brand systems.
- **Image Size:** Use the aspect ratio enums (like `portrait_16_9`) for social media assets or custom dimensions for specific UI components. Standard V4 is optimized for 1MP output; exceeding this significantly in custom dimensions may reduce quality.
- **Safety Checker:** While enabled by default, developers can disable it via the API for specific non-commercial use cases, though this is restricted on the FAL playground ([FAL.ai](https://fal.ai/models/fal-ai/recraft/v4/text-to-image)).

## Node inputs/outputs
- **Inputs:**
    - `prompt` (String): The visual description.
    - `colors` (Array): Brand palette guidance.
    - `image_size` (Enum/Object): Resolution selection.
- **Outputs:**
    - `image_url` (URL): Direct link to the hosted PNG.
    - `content_type` (String): Mime type.
- **Chain-friendly with:**
    - **[fal-ai/recraft/v4/text-to-vector](https://fal.ai/models/fal-ai/recraft/v4/text-to-vector):** Use for generating icons or logos that need to be truly scalable (SVG).
    - **[fal-ai/creative-upscale](https://fal.ai/models/fal-ai/creative-upscale):** Enhance the 1MP output to much higher resolutions for large-format displays.
    - **[fal-ai/remove-background](https://fal.ai/models/fal-ai/remove-background):** Perfect for product photography or icon generation where a transparent asset is needed.

## Notes & gotchas
- **Resolution Limit:** The standard V4 model is capped at ~1MP (1024x1024). For 2048x2048 output, you must use the `pro` endpoint.
- **V4 Maturity:** As of early 2026, some legacy features like "Style Creation" and "Artistic Level Control" are still being migrated from V3 to V4 ([Recraft AI](https://www.recraft.ai/docs/recraft-models/recraft-V4)).
- **Public URLs:** FAL.ai hosted files are typically ephemeral. Ensure you download or transfer the files to persistent storage if needed for your app.

## Sources
- [FAL.ai Recraft V4 API Docs](https://fal.ai/models/fal-ai/recraft/v4/text-to-image/api)
- [Recraft AI Official Documentation](https://www.recraft.ai/docs)
- [Recraft V4 Announcement & Product Page](https://www.recraft.ai/recraft-v4)
- [Recraft Prompt Engineering Guide](https://www.recraft.ai/docs/prompt-engineering-guide/introduction)
