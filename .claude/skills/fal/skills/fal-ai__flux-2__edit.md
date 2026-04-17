---
name: fal-ai/flux-2/edit
display_name: FLUX.2 [dev] Edit
category: image-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2/edit
original_source: https://blackforestlabs.ai/
summary: A 32B parameter image-to-image editor from Black Forest Labs supporting multi-reference editing and natural language control.
---

# FLUX.2 [dev] Edit

## Overview
- **Slug:** `fal-ai/flux-2/edit`
- **Category:** Image Editing
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** Precise image-to-image editing using natural language and multiple reference images.
- **FAL docs:** [fal.ai/models/fal-ai/flux-2/edit](https://fal.ai/models/fal-ai/flux-2/edit)
- **Original source:** [docs.bfl.ml/flux_2/flux2_image_editing](https://docs.bfl.ml/flux_2/flux2_image_editing)

## What it does
FLUX.2 [dev] Edit is a 32-billion parameter rectified flow transformer model designed for advanced image-to-image editing. It allows users to modify existing images using natural language instructions and can combine elements from up to 8 reference images (on FAL) or 6 (recommended on Dev) into a single cohesive output. The model excels at maintaining photorealism, rendering readable text, and following complex spatial instructions while preserving the identity and style of reference objects.

## When to use this model
- **Use when:** You need to perform complex edits on an existing image, such as changing a character's clothes, swapping backgrounds, or merging elements from multiple photos into one scene.
- **Don't use when:** You need zero-configuration production output (use `flux-2-pro/edit`) or if you require the absolute highest quality for professional assets (use `flux-2-max/edit`).
- **Alternatives:** 
    - `fal-ai/flux-2-pro/edit`: Better for production-scale workflows with zero config.
    - `fal-ai/flux-2-max/edit`: The flagship model for maximum precision and grounding.
    - `fal-ai/flux-2-flex`: Offers more granular control over steps and guidance for generation.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2/edit` (sync) / `https://queue.fal.run/fal-ai/flux-2/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | Required | The text description of the desired edits. Supports up to 32K tokens. |
| `image_urls` | list<string> | - | Required (Max 4 on FAL) | The URLs of the images for editing. At least one base image is required. |
| `guidance_scale` | float | `2.5` | 1.0 - 20.0 | Measure of how closely the model sticks to the prompt. |
| `seed` | integer | random | Any integer | Seed for reproducible generations. |
| `num_inference_steps`| integer | `28` | 1 - 50 | Number of denoising steps. Higher values take longer but can be higher quality. |
| `image_size` | object/enum | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{width, height}` | Target output dimensions (512-2048px). |
| `num_images` | integer | `1` | 1 - 4 | Number of output images to generate. |
| `acceleration` | enum | `none` | `none`, `regular`, `high` | Acceleration level for inference. |
| `enable_prompt_expansion`| boolean | `false` | `true`, `false` | Automatically expands the prompt for better aesthetic results. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Filters for NSFW content. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | File format of the resulting image. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns data URI directly. |

### Output
The output is a JSON object containing:
- `images`: A list of `ImageFile` objects containing `url`, `width`, `height`, and `content_type`.
- `timings`: Metadata about inference duration.
- `seed`: The seed used for the generation.
- `has_nsfw_concepts`: Boolean flags indicating if the images triggered the safety filter.

### Example request
```json
{
  "prompt": "Change the background to a sunset beach and make the subject wear a tuxedo.",
  "image_urls": [
    "https://example.com/original_subject.jpg"
  ],
  "guidance_scale": 3.5,
  "num_inference_steps": 28,
  "image_size": "square_hd",
  "output_format": "jpeg"
}
```

### Pricing
- **Base Cost:** $0.012 per megapixel (MP) of output.
- **Reference Cost:** $0.012 per MP of input images (resized to 1MP).
- *Example:* A 1024x1024 generation with one 1MP reference image costs approximately **$0.024** ($0.012 input + $0.012 output). [FAL Pricing](https://fal.ai/pricing)

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX.2 family.

- **Endpoint:** `https://api.bfl.ai/v1/flux-2-dev`
- **Auth method:** Header `x-key: <YOUR_BFL_API_KEY>` or `Authorization: Bearer <KEY>`.
- **Parameters:**
    - `input_image`: Primary image to edit (Base64 or URL).
    - `input_image_2` through `input_image_8`: Up to 7 additional reference images.
    - `safety_tolerance`: 0-6 range (FAL maps this to a boolean).
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/flux_2/flux2_image_editing)

## Prompting best practices
- **Reference by Index:** Use "image 1", "image 2" in your prompt to refer to specific input images (e.g., "Put the hat from image 2 on the person in image 1").
- **Natural Language:** Describe changes as if talking to a human (e.g., "Replace the car with a red futuristic motorcycle while keeping the shadows the same").
- **Hex Colors:** Use hex codes for precise color control (e.g., "Change the tie color to #FF5733").
- **Be Specific:** Instead of "change the background", try "change the background to a misty pine forest at dawn with volumetric lighting".
- **Avoid Over-Prompting:** Don't overload the prompt with technical jargon; focus on describing the visual state change.

## Parameter tuning guide
- **Steps (28):** The default 28 steps is the optimized "sweet spot" for the Dev model. 40-50 steps can improve fine details like hair or text but doubles inference time.
- **Guidance Scale (2.5-3.5):** 2.5 is standard for creative freedom. Push to 3.5-5.0 if the model is ignoring specific parts of your prompt, but avoid 7.0+ as it can cause over-saturation.
- **Image Size:** Always match the aspect ratio of your primary input image to avoid stretching or awkward cropping.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:** 
    - `Prompt` (Text)
    - `Base Image` (Image/URL)
    - `Reference Images` (List of Image/URL)
    - `Steps` (Number)
    - `Guidance` (Number)
- **Outputs:**
    - `Edited Image` (Image URL)
    - `Seed` (Number)
- **Chain-friendly with:** 
    - `fal-ai/flux-lora-fast-training`: Use trained LoRAs for consistent characters before editing.
    - `fal-ai/foley-v1`: Generate sound effects based on the edited scene.
    - `fal-ai/vinu-v1/image-to-video`: Animate the edited result.

## Notes & gotchas
- **Megapixel Billing:** Both input and output resolution affect cost.
- **Reference Limit:** FAL officially supports 4 images in the standard edit schema, though the BFL engine supports up to 8.
- **Safety Filter:** Highly restrictive by default; can be disabled via `enable_safety_checker: false` if your account permissions allow.
- **Input Scaling:** Input images are typically resized to 1MP (1024x1024 equivalent) for the [dev] variant to manage memory.

## Sources
- [FAL.ai model page](https://fal.ai/models/fal-ai/flux-2/edit)
- [Black Forest Labs Official Docs](https://docs.bfl.ml/flux_2/flux2_image_editing)
- [BFL Dashboard / API Portal](https://dashboard.bfl.ai/)
- [Hugging Face Model Card](https://huggingface.co/black-forest-labs/FLUX.2-dev)
