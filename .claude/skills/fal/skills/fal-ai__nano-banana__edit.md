---
name: fal-ai/nano-banana/edit
display_name: Nano Banana [image-editing]
category: image-to-image
creator: Google (DeepMind)
fal_docs: https://fal.ai/models/fal-ai/nano-banana/edit
original_source: https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/
summary: Google's Gemini 2.5 Flash Image model for precise, mask-free semantic image editing using natural language.
---

# Nano Banana [image-editing]

## Overview
- **Slug:** `fal-ai/nano-banana/edit`
- **Category:** Image Editing (Image-to-Image)
- **Creator:** [Google DeepMind](https://deepmind.google/)
- **Best for:** High-speed, semantic image editing where you describe changes in plain English instead of using manual masks.
- **FAL docs:** [fal-ai/nano-banana/edit](https://fal.ai/models/fal-ai/nano-banana/edit)
- **Original source:** [Gemini 2.5 Flash Image (Official Announcement)](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)

## What it does
Nano Banana (officially **Gemini 2.5 Flash Image**) is a multimodal model from Google designed to natively understand and transform images. Unlike traditional image-to-image models that require manual masking or complex ControlNet setups, Nano Banana uses **semantic reasoning** to understand which parts of an image to modify based on your text instructions. It can add objects, change colors, remove backgrounds, or alter styles while preserving the core identity and consistency of the original scene.

## When to use this model
- **Use when:** You need to make precise local edits (e.g., "change the color of the shirt to blue") or global transformations (e.g., "make the weather look like a thunderstorm") without drawing masks.
- **Use when:** You want to blend multiple images together (e.g., "put this chair into this living room").
- **Don't use when:** You need extreme "Pro" level reasoning for highly complex technical diagrams; the [Nano Banana Pro](https://fal.ai/models/fal-ai/nano-banana-pro/edit) is better for high-fidelity reasoning and 4K output.
- **Alternatives:** 
    - [**Nano Banana Pro**](https://fal.ai/models/fal-ai/nano-banana-pro/edit): Higher quality, better text rendering, but slower and more expensive ($0.15/image).
    - [**FLUX.1 [dev] Image-to-Image**](https://fal.ai/models/fal-ai/flux/dev/image-to-image): Stronger artistic control and prompt adherence for stylistic transfers, but lacks the native "semantic editing" reasoning of Gemini.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana/edit` (sync) / `https://queue.fal.run/fal-ai/nano-banana/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | The prompt for image editing. Describe what you want changed or added. |
| `image_urls` | list<string> | (Required) | - | URLs of the source images. You can provide up to 3 images (FAL limit may vary, but Google supports 3). |
| `num_images` | integer | `1` | 1-4 | The number of output images to generate. |
| `seed` | integer | Random | - | Seed for the random number generator for reproducible results. |
| `aspect_ratio` | Enum | `auto` | `auto`, `1:1`, `16:9`, `9:16`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `21:9` | The target aspect ratio of the generated image. |
| `output_format` | Enum | `png` | `jpeg`, `png`, `webp` | The format of the generated image. |
| `safety_tolerance` | Enum | `4` | `1` (Strict) to `6` (Relaxed) | The safety tolerance level for content moderation. 1 blocks most; 6 is least strict. |
| `sync_mode` | boolean | `false` | - | If `true`, the media is returned as a data URI instead of a URL. |
| `limit_generations` | boolean | `false` | - | Experimental: Limits the model to exactly 1 generation round to avoid multi-image generation loops. |

### Output
The output returns a JSON object containing the edited images and a text description of the results.

```json
{
  "images": [
    {
      "url": "https://fal.run/output/image.png",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png",
      "file_name": "nano-banana-edit-output.png",
      "file_size": 123456
    }
  ],
  "description": "A detailed description of the edits performed..."
}
```

### Example request
```json
{
  "prompt": "change the man's jacket to a red leather jacket and make the background a snowy mountain range",
  "image_urls": ["https://example.com/original_photo.jpg"],
  "aspect_ratio": "3:2",
  "safety_tolerance": "4"
}
```

### Pricing
- **Standard Price:** $0.0398 per image (based on 1MP resolution).
- **Resolution Scaling:** Higher resolutions (e.g., 2K, 4K) are priced proportionally or via token usage on Google's native API. On FAL, this is the standard "Flash" tier pricing.

## API — via Original Source (BYO-key direct)
Google offers this model as **Gemini 2.5 Flash Image** through Google AI Studio and Vertex AI.

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`
- **Auth Method:** API Key or OAuth2 (Google Cloud).
- **Extra Parameters:** Native Google API supports `system_instruction` for setting persona/style and more granular `safetySettings`.
- **Link to official docs:** [Google Gemini API Docs](https://ai.google.dev/gemini-api/docs)

## Prompting best practices
- **Be Conversational:** Use natural language instructions. "Replace the cat with a tiger" works better than "tiger, high quality, 4k".
- **Identify Subjects:** If there are multiple objects, be specific. "Make the blue cup red" is better than "Change the color of the cup."
- **Preservation by Omission:** You don't need to say "Keep the background the same." The model defaults to preserving anything you don't explicitly ask to change.
- **Style Transfer:** You can provide a source image and a style reference image. Prompt: "Apply the brushstroke style of [Image 2] to the subject in [Image 1]."
- **Example Good Prompt:** "Keep the person exactly as they are, but change their office background to a beach at sunset with palm trees."
- **Example Bad Prompt:** "beach sunset palm trees office" (Lacks clear instruction on what to change and what to keep).

## Parameter tuning guide
- **`safety_tolerance`:** Set to `1` or `2` for public-facing apps where safety is paramount. Set to `5` or `6` for creative exploration or artistic "edge" cases that might trigger false positives.
- **`aspect_ratio`:** If using `auto`, the model will try to match the source image. Forcing an aspect ratio (like `16:9` on a `1:1` source) will cause the model to intelligently "outpaint" or extend the scene.
- **`seed`:** Use a fixed seed when iterating on a prompt to see how minor text changes affect the same base generation.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Source Images` (List of Image URLs)
    - `Aspect Ratio` (Dropdown)
- **Outputs:**
    - `Edited Image` (Image URL)
    - `Result Description` (Text)
- **Chain-friendly with:**
    - [**Nano Banana (Text-to-Image)**](https://fal.ai/models/fal-ai/nano-banana): Generate a base image, then pass it to the Edit node for refinements.
    - [**Upscaler**](https://fal.ai/models/fal-ai/creative-upscaler): Pass the edited 1K output to an upscaler for print-ready resolution.
    - [**Remove Background**](https://fal.ai/models/fal-ai/remove-background): Use before editing if you want to swap the subject into a completely different environment.

## Notes & gotchas
- **SynthID Watermarking:** All images edited with this model contain an invisible **SynthID watermark** from Google for AI transparency.
- **Mask-Free Limitation:** Because it doesn't use manual masks, it can sometimes "hallucinate" changes in areas you didn't specify if the prompt is too vague.
- **Maximum Images:** While the model is powerful at fusion, providing more than 3 reference images may lead to degraded reasoning or ignored inputs.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/nano-banana/edit)
- [Google Developers Blog: Introducing Gemini 2.5 Flash Image](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)
- [Google Cloud Vertex AI Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image)
- [FAL.ai Pricing](https://fal.ai/pricing)