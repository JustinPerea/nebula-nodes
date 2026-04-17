---
name: fal-ai/bytedance/seedream/v4/edit
display_name: Bytedance Seedream v4 Edit
category: image-to-image
creator: ByteDance (Seed Team)
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit
original_source: https://seed.bytedance.com/en/seedream4_0, https://docs.byteplus.com/en/docs/ModelArk/1824718
summary: A unified image creation and editing model by ByteDance featuring 4K resolution, multi-reference consistency, and 1.8-second 2K generation.
---

# Bytedance Seedream v4 Edit

## Overview
- **Slug:** `fal-ai/bytedance/seedream/v4/edit`
- **Category:** image-to-image / Image Editing
- **Creator:** [ByteDance Seed Team](https://seed.bytedance.com/en/seedream4_0)
- **Best for:** Professional image editing, multi-reference style/character blending, and high-resolution (up to 4K) visual creation with extreme speed.
- **FAL docs:** [fal.ai/models/fal-ai/bytedance/seedream/v4/edit](https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit)
- **Original source:** [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/1824718), [ByteDance Seed](https://seed.bytedance.com/en/seedream4_0)

## What it does
Bytedance Seedream 4.0 (V4) is a next-generation multimodal model that unifies text-to-image generation and image editing within a single Diffusion Transformer (DiT) architecture. It excels at "Precision Instruction Editing," allowing users to add, remove, or modify elements in an image using natural language while preserving the original features and quality. It is significantly faster than its predecessors, capable of generating 2K resolution images in approximately 1.8 seconds.

## When to use this model
- **Use when:** You need to perform complex edits on existing images (e.g., changing clothes, adding objects, altering backgrounds) while maintaining the original character or object consistency. It is also ideal for workflows requiring high-resolution (4K) outputs and rapid iteration.
- **Don't use when:** You need video generation (use [Seedance 2.0](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video)) or when you are working with extremely niche artistic styles that might be better served by fine-tuned LoRA models like FLUX.
- **Alternatives:** 
  - **FLUX.1 [dev] / [pro]:** Superior for pure text-to-image prompt adherence but lacks the unified "edit" architecture of Seedream.
  - **Seedream V4.5:** The successor to V4, offering 30-40% faster generation and better text rendering at a similar price point.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedream/v4/edit` (sync) / `https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | The text prompt used to edit the image. Supports English and Chinese. |
| `image_urls` | list<string> | (Required) | Max 10 | List of URLs of input images for editing. Up to 10 are allowed, though 6 is often the practical limit for fusion. |
| `image_size` | string/object | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`, `auto_2K`, `auto_4K` | The size of the generated image. Can also be an object: `{"width": 1280, "height": 720}`. |
| `num_images` | integer | `1` | 1-4 | Number of separate model generations to be run with the prompt. |
| `max_images` | integer | `1` | 1-15 | Enables multi-image generation (set to >1). Total images (inputs + outputs) cannot exceed 15. |
| `seed` | integer | (Random) | - | Random seed to control stochasticity. |
| `sync_mode` | boolean | `false` | - | If `true`, returns media as data URI and won't save in history. |
| `enable_safety_checker` | boolean | `true` | - | If set to true, the safety checker will be enabled. |
| `enhance_prompt_mode` | string | `standard` | `standard`, `fast` | Standard provides higher quality; fast is optimized for speed. |

### Output
The output is a JSON object containing a list of image objects and the seed used.
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
  "seed": 746406749
}
```

### Example request
```json
{
  "input": {
    "prompt": "Change the background to a futuristic cyberpunk city at night with neon lights.",
    "image_urls": ["https://example.com/source_image.jpg"],
    "image_size": "landscape_16_9"
  }
}
```

### Pricing
- **Cost:** $0.03 per image generation on [FAL.ai](https://fal.ai/pricing).
- **Note:** Pricing is normalized for 1MP images; higher resolutions (2K/4K) may be priced proportionally depending on the specific FAL implementation details.

## API — via Original Source (BYO-key direct)
ByteDance offers this model through its **BytePlus** (international) and **Volcengine Ark** (China) platforms under the name **Doubao-Seedream-4.0**.

- **Endpoint (BytePlus):** `https://ark.ap-southeast.bytepluses.com/api/v3/images/generations`
- **Endpoint (Volcengine):** `https://ark.cn-beijing.volces.com/api/v3/images/generations`
- **Auth Method:** Bearer Token (API Key)
- **Additional Parameters:**
  - `sequential_image_generation`: `auto` or `disabled` (controls group generation).
  - `watermark`: `true` or `false` (native ByteDance watermark).
  - `response_format`: `url` or `b64_json`.
- **Docs:** [BytePlus ModelArk Docs](https://docs.byteplus.com/en/docs/ModelArk/1824718)

## Prompting best practices
- **Direct Instructions:** Use active verbs like "Add," "Remove," "Replace," or "Change." For example, "Add a red scarf to the woman" works better than "a woman with a red scarf."
- **Reference Preservation:** If you want to keep parts of the image identical, state it: "Change the hair color to blue while keeping the facial features and clothes exactly the same."
- **Natural Language:** Seedream 4.0 is optimized for natural language. You don't need "comma-separated tags" as much as you do for older SDXL models.
- **Role Assignment:** When using multiple reference images, specify roles: "Use Image 1 for the character's face, Image 2 for the background architecture, and Image 3 for the color palette."
- **Avoid Vagueness:** Instead of "make it better," use "Increase the lighting contrast and sharpen the textures."

## Parameter tuning guide
- **Image Size:** Use `auto_4K` for the highest possible detail, but be aware it may increase inference time to 15-20 seconds compared to 1.8 seconds for 2K.
- **Max Images:** For "Storyboarding" or "Character Variations," set `max_images` to 4 or more and use the prompt "Generate a series of images showing different angles of this character."
- **Enhance Prompt Mode:** Use `standard` for complex creative edits where nuance is required. Use `fast` for simple changes like background color swaps.

## Node inputs/outputs
- **Inputs:**
  - `prompt` (String): The editing instruction.
  - `image_urls` (Array of Strings): Input image(s) to edit.
  - `image_size` (Enum/Object): Desired resolution.
- **Outputs:**
  - `images` (Array of Image Objects): The resulting edited image(s).
  - `seed` (Integer): The seed used for the result.
- **Chain-friendly with:** 
  - **FAL Flux Pro:** Generate a high-quality base image with Flux, then pass it to Seedream V4 Edit for specific modifications.
  - **Remove Background (FAL):** Use to isolate subjects before multi-image fusion in Seedream.

## Notes & gotchas
- **Resolution Limit:** While the model supports 4K, the minimum total image area required is 921,600 pixels (~960x960). Smaller inputs may be auto-resized.
- **Content Policy:** ByteDance enforces a strict safety filter; requests involving NSFW or prohibited public figures will be blocked with a safety error.
- **Reference Limit:** The total number of images (inputs + outputs) must not exceed 15 in a single request.

## Sources
- [FAL.ai Seedream V4 Edit Docs](https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit/api)
- [BytePlus ModelArk Official Documentation](https://docs.byteplus.com/en/docs/ModelArk/1824718)
- [ByteDance Seed Team Official Blog](https://seed.bytedance.com/en/blog/seedream-4-0-officially-released-beyond-drawing-into-imagination)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Volcengine Volcengine Official API Docs](https://www.volcengine.com/docs/6492/2172373)
