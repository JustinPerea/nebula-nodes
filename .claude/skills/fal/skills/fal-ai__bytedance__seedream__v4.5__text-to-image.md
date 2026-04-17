---
name: fal-ai/bytedance/seedream/v4.5/text-to-image
display_name: ByteDance Seedream 4.5 (Text-to-Image)
category: text-to-image
creator: ByteDance (Volcano Engine / BytePlus)
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image
original_source: https://seed.bytedance.com/en/seedream4_5, https://docs.byteplus.com/en/docs/ModelArk/1824121
summary: A next-generation 1.2B parameter 4K image generator by ByteDance featuring a unified architecture for superior text rendering and compositional consistency.
---

# ByteDance Seedream 4.5 (Text-to-Image)

## Overview
- **Slug:** `fal-ai/bytedance/seedream/v4.5/text-to-image`
- **Category:** text-to-image
- **Creator:** [ByteDance (Volcano Engine)](https://seed.bytedance.com/en/seedream4_5)
- **Best for:** High-fidelity 4K visuals with complex typography and professional composition.
- **FAL docs:** [fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image)
- **Original source:** [BytePlus Volcano Engine ModelArk](https://docs.byteplus.com/en/docs/ModelArk/1824121)

## What it does
Seedream 4.5 is ByteDance's state-of-the-art 1.2 billion parameter unified image generation and editing model. Unlike previous iterations, it uses a single architecture to handle both creation and modification tasks, resulting in significantly improved prompt adherence and spatial understanding. It is specifically engineered to solve two common AI pain points: legible typography (rendering clear, correct text on posters/logos) and multi-subject consistency. It supports native high-resolution output up to 4K (4096×4096) with professional-grade handling of materials like glass, metal, and cloth.

## When to use this model
- **Use when:** You need readable text within an image (posters, social media graphics, UI mockups); you require extremely high-resolution 4K outputs; or you are building complex compositions with multiple distinct subjects.
- **Don't use when:** You need ultra-fast "real-time" generation (latencies average 15s); you are on a strict budget (priced at $0.04/img); or you require an open-source model for local hosting.
- **Alternatives:** 
    - **Flux.1 [dev]:** Better for overall aesthetic variety and hyper-realism but lacks Seedream's specific 4K native scaling.
    - **DALL-E 3:** Easier to prompt for simple concepts but offers less control over exact typography and resolution.
    - **Seedream 4.0:** Cheaper alternative ($0.03) if 4K resolution and advanced editing consistency aren't required.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image` (sync) / `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text prompt used to generate the image. Supports long, descriptive natural language. |
| `image_size` | Enum / Object | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto_2K`, `auto_4K` | Preset sizes or a custom object with `width` and `height`. |
| `num_images` | integer | `1` | 1–15 | Number of separate model generations to be run. |
| `max_images` | integer | `1` | 1–15 | Number of images to return per generation (batching). |
| `seed` | integer | Random | 0–2^32 | Random seed for deterministic output. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns media as a data URI instead of a hosted URL. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Enables built-in content moderation filters. |

### Output
The API returns a JSON object containing a list of generated images and the seed used.
```json
{
  "images": [
    {
      "url": "https://fal.run/files/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png",
      "file_name": "seedream_output.png",
      "file_size": 123456
    }
  ],
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A professional tech product launch poster with bold typography, featuring a sleek smartphone on a neon gradient background, text: 'SEEDREAM 4.5', 4K, ultra detailed, cinematic lighting.",
  "image_size": "landscape_16_9",
  "num_images": 1,
  "sync_mode": false
}
```

### Pricing
- **FAL.ai:** $0.04 per image (approx. 25 images per $1.00).

## API — via Original Source (BYO-key direct)
The model is officially served via BytePlus Volcano Engine (International) or Volcano Engine (China).
- **Endpoint:** `https://api.byteplus.com/v1/images/generations` (Requires ModelArk access)
- **Model ID:** `seedream-4-5-251128`
- **Native Params:** Supports `quality` (`standard` or `hd`) and `response_format` (`url` or `b64_json`).
- **Direct Auth:** Bearer Token via BytePlus API Keys.
- **Link:** [BytePlus ModelArk Documentation](https://docs.byteplus.com/en/docs/ModelArk/1824121)

## Prompting best practices
- **Subject-First Structure:** Place the main subject and its actions at the very beginning of the prompt.
- **Natural Language:** Avoid "keyword soup." Use descriptive, full sentences (e.g., "A photographer capturing a sunset" instead of "photographer, sunset, 8k").
- **Explicit Text Instruction:** For typography, use the syntax `text: 'YOUR TEXT'` to help the model identify exact strings.
- **Quality Modifiers:** Explicitly include "4K", "high fidelity", "professional photography", or "sharp focus" for optimal results at higher resolutions.
- **Optimal Length:** Aim for **30–100 words**. Prompts under 15 words often result in generic outputs.

## Parameter tuning guide
- **Image Size (Custom):** For custom dimensions, ensure the total pixel count is between 3.7MP and 16.8MP. Dimensions must be between 1920px and 4096px on any axis for "HD" results.
- **Seed:** Use a fixed seed when iterating on prompts to see how small text changes affect the composition without changing the entire scene layout.
- **Safety Checker:** In controlled business environments, disabling the safety checker can sometimes prevent "false positive" blocks for non-explicit content that might trigger the default filter.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Aspect Ratio` (Dropdown/Enum)
    - `Seed` (Number)
    - `Batch Size` (Number)
- **Outputs:**
    - `Image URL` (Link)
    - `Seed Used` (Number)
- **Chain-friendly with:** 
    - **fal-ai/bytedance/seedream/v4.5/edit:** Use for follow-up refinements.
    - **fal-ai/face-swap:** To place a specific face onto the generated high-quality body/scene.
    - **fal-ai/esrgan:** For further upscaling 4K outputs to 8K.

## Notes & gotchas
- **Resolution Limit:** While the model supports up to 4K, generating at 4096×4096 significantly increases latency (up to 30-45 seconds).
- **Unified Logic:** The model "thinks" in terms of editing. Even in text-to-image mode, it treats your prompt as a set of instructions to create a "canvas."
- **Commercial Use:** Requires a FAL Partner agreement for full commercial rights on some tiered plans.

## Sources
- [FAL.ai Seedream 4.5 Docs](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image)
- [ByteDance Seed Official Site](https://seed.bytedance.com/en/seedream4_5)
- [BytePlus Volcano Engine ModelArk API Reference](https://docs.byteplus.com/en/docs/ModelArk/1824121)
- [xMode.ai Prompting Guide](https://xmode.ai/blog/seedream-prompting-guide)
