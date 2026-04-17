---
name: fal-ai/flux-pro/v1.1-ultra
display_name: FLUX 1.1 [pro] ultra
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra
original_source: https://bfl.ai/flux-1-1-ultra/, https://docs.bfl.ml/flux_models/flux_1_1_pro_ultra_raw
summary: FLUX 1.1 [pro] ultra is a state-of-the-art text-to-image model by Black Forest Labs, capable of generating high-fidelity 4MP (2K) images with professional-grade realism and prompt adherence.
---

# FLUX 1.1 [pro] ultra

## Overview
- **Slug:** `fal-ai/flux-pro/v1.1-ultra`
- **Category:** text-to-image
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** Ultra-high-resolution professional photography, detailed architectural renderings, and high-fidelity commercial assets.
- **FAL docs:** [fal.ai/models/fal-ai/flux-pro/v1.1-ultra](https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra)
- **Original source:** [bfl.ai/flux-1-1-ultra/](https://bfl.ai/flux-1-1-ultra/)

## What it does
FLUX 1.1 [pro] ultra is a cutting-edge text-to-image generator that delivers professional-grade visuals at up to 4 megapixels (2K resolution). Developed by Black Forest Labs, it employs a 12-billion parameter transformer architecture with rectified flow matching to achieve superior prompt adherence and photorealism. The "Ultra" mode is specifically tuned for high-detail, polished outputs, while a "Raw" mode provides a more natural, unedited camera aesthetic.

## When to use this model
- **Use when:**
    - You need high-resolution output (4MP) for print or large-scale digital displays.
    - Extreme detail and professional lighting are required.
    - Accurately rendering text within images is a priority.
    - You need fast generation times (~10 seconds) for high-resolution assets.
- **Don't use when:**
    - 1MP resolution is sufficient for your use case (standard FLUX 1.1 [pro] is more cost-effective).
    - You are performing low-fidelity rapid prototyping (FLUX Schnell is better).
- **Alternatives:**
    - **FLUX 1.1 [pro]:** Ideal for standard 1MP output at a lower cost ($0.04 - $0.05 per image).
    - **FLUX.1 Kontext [pro]:** Best for in-context image editing and style transfer.
    - **AuraFlow:** A cheaper open-weight alternative for high-volume, lower-resolution tasks.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pro/v1.1-ultra` (sync) / `https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text description of the image to generate. |
| `seed` | integer | random | N/A | For deterministic results. Same seed/prompt produces the same image. |
| `sync_mode` | boolean | `false` | `true`, `false` | If `true`, returns media as a base64 data URI. |
| `num_images` | integer | `1` | 1-4 | Number of images to generate per request. |
| `output_format` | string | `jpeg` | `jpeg`, `png` | The file format of the generated image. |
| `safety_tolerance` | integer | `2` | 1-6 | 1 is strictest, 6 is most permissive. (API only) |
| `enhance_prompt` | boolean | `false` | `true`, `false` | Automatically improves the prompt for better visual results. |
| `image_url` | string | `null` | N/A | Reference image URL for image-to-image or redux tasks. |
| `image_prompt_strength` | float | `0.1` | 0.0 to 1.0 | Controls how much the reference image influences the output. |
| `aspect_ratio` | string | `16:9` | `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21` | The desired aspect ratio for the output. |
| `raw` | boolean | `false` | `true`, `false` | Set to `true` for a more natural, photographic "camera" look. |

### Output
The API returns a JSON object containing a list of image objects.
```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 2048,
      "height": 2048,
      "content_type": "image/jpeg"
    }
  ],
  "timings": {
    "inference": 10.5
  },
  "seed": 12345,
  "has_nsfw_concepts": [false],
  "prompt": "..."
}
```

### Example request
```json
{
  "prompt": "Extreme close-up of a single tiger eye, direct frontal view. Detailed iris and pupil. Sharp focus on eye texture and color. Natural lighting to capture authentic eye shine and depth. The word 'FLUX' is painted over it in big, white brush strokes with visible texture.",
  "aspect_ratio": "16:9",
  "raw": false
}
```

### Pricing
- **Cost per image:** $0.06
- **Normalization:** Billed per image regardless of resolution (up to 4MP).

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for enterprise and developer use.
- **Endpoint:** `https://api.bfl.ai/v1/flux-pro-1.1-ultra`
- **Auth method:** `x-key` header with BFL API Key.
- **Additional parameters:** Supports polling via `polling_url` for async results.
- **Official docs:** [docs.bfl.ml](https://docs.bfl.ml/flux_models/flux_1_1_pro_ultra_raw)

## Prompting best practices
- **Be Descriptive:** The model has 12B parameters; it thrives on specific details regarding texture, lighting, and composition.
- **Text Rendering:** Specify exact text in quotes (e.g., "The word 'FLUX' written in chalk") for high-accuracy placement.
- **Lighting Cues:** Use terms like "cinematic lighting," "soft window light," or "golden hour" to leverage the model's sophisticated rendering engine.
- **Avoid Negative Prompts:** FLUX models generally respond better to positive descriptions of what *should* be there rather than what should *not*.
- **Style Tokens:** For Ultra mode, use keywords like "professional photography," "8k resolution," or "unreal engine 5" for a polished look. For Raw mode, use "candid," "shot on 35mm film," or "unprocessed" to maintain realism.

## Parameter tuning guide
- **`raw` (Boolean):** Toggle `true` for authentic-looking photography where skin textures and lighting aren't overly "AI-smooth." Keep `false` for marketing and highly stylized art.
- **`image_prompt_strength` (0.0-1.0):** Use low values (0.1-0.3) to keep the reference image as a subtle style guide. Higher values (0.7+) will force the model to closely replicate the layout and colors of the source.
- **`aspect_ratio`:** Selecting the correct ratio before generation is critical as the model is natively trained on variable resolutions.

## Node inputs/outputs
- **Inputs:**
    - `prompt` (String)
    - `image_url` (Image/URL)
    - `aspect_ratio` (Enum)
    - `raw` (Boolean)
- **Outputs:**
    - `image` (Image/URL)
    - `seed` (Integer)
- **Chain-friendly with:**
    - **Upscalers:** While 4MP is high, pairing with an ESRGAN node can push resolution even further for print.
    - **LLM Prompt Expanders:** Use a GPT-4 or Claude node to expand simple user prompts into the detailed descriptions FLUX excels at.

## Notes & gotchas
- **Safety Filter:** The model has built-in content safety filters. If a prompt is flagged, it may return a "has_nsfw_concepts" warning or fail.
- **Region:** Available globally via FAL.ai's serverless infrastructure.
- **Rate Limits:** Subject to standard FAL.ai account limits (check dashboard for specific tier).

## Sources
- [FAL.ai Flux Pro v1.1 Ultra API](https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra/api)
- [Black Forest Labs Official Documentation](https://docs.bfl.ml/flux_models/flux_1_1_pro_ultra_raw)
- [BFL Blog Announcement](https://bfl.ai/flux-1-1-ultra/)
- [MindStudio Technical Overview](https://www.mindstudio.ai/blog/what-is-flux-1-1-pro-ultra/)
