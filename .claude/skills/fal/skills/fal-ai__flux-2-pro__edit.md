---
name: fal-ai/flux-2-pro/edit
display_name: FLUX.2 [pro] Edit
category: image-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2-pro/edit
original_source: https://docs.bfl.ml/flux_2/flux2_image_editing
summary: A state-of-the-art multi-reference image editor powered by a 24B parameter flow transformer, capable of precise object manipulation and color control via natural language.
---

# FLUX.2 [pro] Edit

## Overview
- **Slug:** `fal-ai/flux-2-pro/edit`
- **Category:** Image-to-Image / Image Editing
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** High-precision, multi-reference image manipulation using natural language instructions.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/flux-2-pro/edit)
- **Original source:** [Black Forest Labs Documentation](https://docs.bfl.ml/flux_2/flux2_image_editing)

## What it does
FLUX.2 [pro] Edit is a production-grade image editing model engineered for high-precision, multi-reference workflows. It allows users to execute complex modifications—such as replacing backgrounds, combining elements from multiple photos, or adjusting specific colors—using simple natural language commands rather than manual masking ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)). Built on a latent flow transformer architecture integrated with a 24B parameter vision-language model (Mistral-3), it excels at understanding spatial relationships and fine-grained contextual details ([AI.cc](https://www.ai.cc/flux2-pro-edit/)). The model supports output resolutions up to 4 megapixels and can ingest up to 9 input reference images simultaneously to create composite scenes with remarkable structural consistency ([FAL.ai](https://fal.ai/models/fal-ai/flux-2-pro/edit)).

## When to use this model
- **Use when:** You need to combine specific elements from multiple source images (e.g., "Put the person from Image 1 in the setting of Image 2").
- **Use when:** You require precise brand color matching using hex codes.
- **Use when:** You want to maintain consistent character appearances across different edited scenes.
- **Don't use when:** You need sub-second generation; for high-speed, lower-cost iterations, consider the `flux-2-klein` or `flux-2-turbo` variants ([FAL.ai](https://fal.ai/learn/biz/flux-2-turbo-vs-flux-2-which-model-should-you-choose)).
- **Alternatives:** 
    - `fal-ai/flux-2-max/edit`: The highest quality tier with maximum precision for character consistency.
    - `fal-ai/flux-2-klein/edit`: A faster, cost-optimized version for high-volume tasks.
    - `fal-ai/flux-1.1-pro`: Better for pure text-to-image generation from scratch without reference images.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2-pro/edit` (Sync) / `https://queue.fal.run/fal-ai/flux-2-pro/edit` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The natural language description of the edit to be applied. Supports up to 32K tokens. |
| `image_urls` | list<string> | *Required* | Max 9 URLs | A list of publicly accessible URLs for the reference images to be edited or combined. |
| `image_size` | string/object | `"auto"` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | The size of the generated image. Can also be an object: `{"width": 1024, "height": 1024}`. |
| `seed` | integer | null | Any integer | The seed for reproducibility. If null, a random seed is used. |
| `safety_tolerance` | integer | `2` | 1 (strict) to 5 (permissive) | The level of safety filtering for generated content. Available via API calls. |
| `enable_safety_checker` | boolean | `true` | true/false | Whether to enable the built-in safety filter to block violative content. |
| `output_format` | string | `"jpeg"` | `jpeg`, `png` | The file format of the resulting image. |
| `sync_mode` | boolean | `false` | true/false | If true, returns a data URI directly and skips request history storage. |

### Output
The API returns a JSON object containing the generated images and the seed used.
```json
{
  "images": [
    {
      "url": "https://fal.run/storage/images/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/jpeg"
    }
  ],
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "The person from image 1 is sitting on the sofa from image 2, with the lighting style of image 3.",
  "image_urls": [
    "https://example.com/person.jpg",
    "https://example.com/room.jpg",
    "https://example.com/lighting_ref.jpg"
  ],
  "image_size": "square_hd"
}
```

### Pricing
Pricing is megapixel-based and rounded up to the nearest megapixel per image ([FAL.ai](https://fal.ai/pricing)):
- **First Megapixel of Output:** $0.03
- **Additional Megapixels (Input or Output):** $0.015 per MP
- *Example:* A 1024x1024 (1MP) generation with one 1024x1024 (1MP) input image costs **$0.045** ($0.03 output + $0.015 input).

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a native API for direct integration.

- **Endpoint:** `https://api.bfl.ai/v1/flux-2-pro` (or `/v1/flux-2-pro-preview` for latest updates).
- **Auth Method:** Bearer Token (BFL API Key).
- **Exclusive Features:**
    - Supports `input_image` through `input_image_8` as separate fields rather than a list.
    - Native support for `webhook_url` and `webhook_secret` in the request body for asynchronous processing ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)).
    - Flexible resolution control with `width` and `height` parameters directly.
- **Official Docs:** [BFL API Reference](https://docs.bfl.ml/api-reference/)

## Prompting best practices
- **Explicit Indexing:** Refer to images by their index for precise control. Use phrases like "the object in image 1" or "the background from image 2" ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)).
- **Natural Descriptions:** The 24B parameter model understands complex semantics. Instead of keywords, use descriptive sentences: "Change the texture of the wooden table to polished marble."
- **Color Control:** Use Hex codes for absolute precision: "Change the logo color to #FF5733."
- **Pose Guidance:** Mention the source of a pose explicitly: "Apply the pose of the character in image 2 to the person in image 1."
- **Failure Mode:** Avoid vague prompts like "make it better." The model needs specific instructions on what to add, remove, or modify.
- **Good Prompt:** "Replace the coffee mug in image 1 with the ornate ceramic teapot from image 2, maintaining the steam and table reflection."
- **Bad Prompt:** "Fix image 1 using image 2."

## Parameter tuning guide
- **Safety Tolerance:** Set to `1` for commercial applications with zero tolerance for suggestive content, or `5` for creative workflows that require more flexibility with artistic nudity or abstract concepts ([FAL.ai](https://fal.ai/models/fal-ai/flux-2-pro/edit/api)).
- **Image Size:** Use `"auto"` to let the model determine the best dimensions based on the primary reference image, preventing unwanted cropping or stretching.
- **Resolution Override:** While the model supports up to 4MP, the "sweet spot" for quality and consistency is 1MP to 2MP (e.g., 1024x1024 or 1536x1536) ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)).

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Primary Image URL` (String)
    - `Reference Image URLs` (List)
    - `Seed` (Integer)
    - `Output Resolution` (Enum/Object)
- **Outputs:**
    - `Edited Image URL` (Image)
    - `Seed Used` (Integer)
- **Chain-friendly with:**
    - `fal-ai/flux-1.1-pro`: Generate a high-quality base image, then pass it to Edit for refinements.
    - `fal-ai/remove-background`: Clean up a reference object before inserting it into a scene via the Edit model.
    - `fal-ai/sharpness-upscaler`: Upscale the 4MP output of the Edit model to professional 8K resolutions.

## Notes & gotchas
- **Multi-Image Limit:** While the playground supports 10 images, the API is generally optimized for up to 9 total images (9 MP total input) ([AI.cc](https://www.ai.cc/flux2-pro-edit/)).
- **Resolution Clipping:** Input images exceeding 4MP are automatically resized while preserving aspect ratio ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)).
- **Alignment:** Non-aligned dimensions are cropped to the next smaller multiple of 16 pixels. For pixel-perfect results, ensure inputs are multiples of 16 ([Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_image_editing)).
- **Signed URLs:** Resulting image URLs from FAL/BFL may expire after a short duration (typically 10 minutes), so they should be downloaded or transferred to persistent storage immediately.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/flux-2-pro/edit)
- [Black Forest Labs Official Documentation](https://docs.bfl.ml/flux_2/flux2_image_editing)
- [Black Forest Labs Pricing](https://bfl.ai/pricing)
- [AI.cc Technical Specifications](https://www.ai.cc/flux2-pro-edit/)
- [Hugging Face: Black Forest Labs Card](https://huggingface.co/black-forest-labs)