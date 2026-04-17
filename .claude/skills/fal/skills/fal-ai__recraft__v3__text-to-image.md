---
name: fal-ai/recraft/v3/text-to-image
display_name: Recraft V3
category: text-to-image
creator: Recraft AI
fal_docs: https://fal.ai/models/fal-ai/recraft/v3/text-to-image
original_source: https://www.recraft.ai/docs/api-reference/endpoints
summary: A state-of-the-art text-to-image model specializing in accurate long-form text rendering and scalable vector art generation.
---

# Recraft V3

## Overview
- **Slug:** `fal-ai/recraft/v3/text-to-image`
- **Category:** Text-to-Image
- **Creator:** [Recraft AI](https://www.recraft.ai/)
- **Best for:** Professional-grade design assets, logos with precise text, and scalable vector illustrations.
- **FAL docs:** [fal.ai/models/fal-ai/recraft/v3/text-to-image](https://fal.ai/models/fal-ai/recraft/v3/text-to-image)
- **Original source:** [recraft.ai/docs/api-reference](https://www.recraft.ai/docs/api-reference/endpoints)

## What it does
Recraft V3 (internally known as "Red Panda") is a top-tier image generation model that consistently ranks at the top of industry leaderboards (e.g., Hugging Face/Artificial Analysis) for its unprecedented accuracy in rendering long, complex text and its native ability to output scalable vector graphics (SVG). Unlike many diffusion models that struggle with spelling and anatomical consistency, Recraft V3 excels at professional design tasks, including brand-consistent illustrations and high-fidelity photorealistic portraits.

## When to use this model
- **Use when:** You need to include specific, legible text in an image (e.g., posters, UI mockups, apparel designs).
- **Use when:** You require scalable assets like logos or icons that must be exported in vector format.
- **Use when:** You need strict adherence to a specific brand color palette.
- **Don't use when:** You are looking for fast, low-cost "sketch" generations (standard models like SDXL are cheaper).
- **Alternatives:** 
    - **[Flux.1 Dev](https://fal.ai/models/fal-ai/flux/dev):** Better for raw photorealism and artistic "vibe" but lacks native vector output.
    - **[Ideogram 2.0](https://fal.ai/models/fal-ai/ideogram/v2):** Strong competitor for text rendering, but doesn't offer the same vector design focus.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/recraft/v3/text-to-image` (sync) / `https://queue.fal.run/fal-ai/recraft/v3/text-to-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | - | Required | The description of the image. For text rendering, wrap text in quotes (e.g., 'a sign that says "Open Now"'). |
| `image_size` | `enum/object` | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Preset sizes or an object `{"width": 1024, "height": 768}`. Must be multiples of 32. |
| `style` | `enum` | `realistic_image` | `any`, `realistic_image`, `digital_illustration`, `vector_illustration`, `realistic_image/b_and_w`, `realistic_image/hard_flash`, `realistic_image/hdr`, `realistic_image/natural_light`, `realistic_image/studio_portrait`, `realistic_image/enterprise` | Controls the visual aesthetic. Vector styles cost 2x more. |
| `colors` | `array` | `[]` | List of `{"r": int, "g": int, "b": int}` | A list of preferred colors to maintain brand consistency. |
| `style_id` | `string` | - | Optional | ID of a custom style reference previously created. |
| `enable_safety_checker` | `boolean` | `true` | `true`, `false` | Enables/disables the content safety filter. |
| `seed` | `integer` | - | - | Random seed for reproducible results. |

### Output
The API returns a JSON object containing a list of image files.
```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png"
    }
  ]
}
```

### Example request
```json
{
  "prompt": "A professional logo for a tech company called 'AETHER' featuring a minimalist eagle, vector style, navy blue and silver colors.",
  "style": "vector_illustration",
  "image_size": "square_hd",
  "colors": [
    {"r": 0, "g": 0, "b": 128},
    {"r": 192, "g": 192, "b": 192}
  ]
}
```

### Pricing
- **Standard:** $0.04 per image.
- **Vector Style:** $0.08 per image (due to the complexity of SVG generation).

## API — via Original Source (BYO-key direct)
Recraft AI provides a direct API for enterprise users.
- **Endpoint:** `https://external.api.recraft.ai/v1/images/generations`
- **Native Parameters not on FAL:**
    - `text_layout`: A powerful parameter for precise text positioning using bounding boxes (`bbox`) and specific font points.
    - `artistic_level`: Range `[0..5]` to adjust the "unconventionality" of the composition.
    - `negative_prompt`: Explicitly define what to exclude.
    - `response_format`: Choose between `url` and `b64_json`.
- **Auth method:** Bearer Token.
- **Link to official docs:** [Recraft AI Endpoints](https://www.recraft.ai/docs/api-reference/endpoints)

## Prompting best practices
- **Quote for Quality:** Always wrap the exact text you want to see in double quotes. Example: `A neon sign that says "LATE NIGHT VIBES"`.
- **Specify Spatial Layout:** Recraft V3 understands spatial positioning. Use phrases like "centered at the top," "on a banner in the background," or "etched into the wooden table."
- **Style Specificity:** If using `realistic_image`, add lighting modifiers like "studio portrait" or "natural light" for better results.
- **Vector Logic:** When using `vector_illustration`, keep prompts focused on clean lines and shapes. Avoid "hyper-realistic" or "detailed textures" which conflict with the vector aesthetic.
- **Failure Mode:** Forcing too much text (e.g., an entire paragraph) into a small image area may cause text to overlap. Use specific layouts or larger aspect ratios for heavy-text designs.

## Parameter tuning guide
- **Style Selection:**
    - Use `realistic_image/enterprise` for professional, clean product or corporate photography.
    - Use `vector_illustration` if you intend to use the asset in design software like Figma or Illustrator (export the URL and convert to SVG).
- **Colors Parameter:** If the model isn't adhering perfectly to your brand, reduce the number of colors in the `colors` array to just the 2-3 most dominant ones.
- **Artistic Level (Native API):** Set to `0` for standard, direct shots; set to `5` for "weird," high-fashion, or avant-garde compositions.

## Node inputs/outputs
- **Inputs:**
    - `prompt` (Text)
    - `style` (Dropdown)
    - `image_size` (Dropdown)
    - `colors` (Color List / RGB)
    - `seed` (Number)
- **Outputs:**
    - `image_url` (Image/URL)
- **Chain-friendly with:**
    - **[fal-ai/creative-upscaler](https://fal.ai/models/fal-ai/creative-upscaler):** To take a low-res Recraft concept and add hyper-detail.
    - **[fal-ai/bg-remover](https://fal.ai/models/fal-ai/image-background-remover):** Perfect for turning Recraft-generated icons into transparent assets.

## Notes & gotchas
- **Vector Cost:** Always remember that `vector_illustration` is billed at a higher rate on FAL.ai.
- **Text Length:** While SOTA, Recraft V3 still has limits. It is optimized for "mid-size" text (headlines, short phrases) rather than full book pages.
- **Safety Checker:** Setting `enable_safety_checker: false` is only supported via the API, not the FAL playground.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/recraft/v3/text-to-image/api)
- [Official Recraft AI API Reference](https://www.recraft.ai/docs/api-reference/endpoints)
- [Artificial Analysis Model Leaderboard](https://artificialanalysis.ai/models/recraft-v3)
