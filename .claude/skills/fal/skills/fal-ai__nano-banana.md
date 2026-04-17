---
name: fal-ai/nano-banana
display_name: Nano Banana (Gemini 2.5 Flash Image)
category: text-to-image
creator: Google
fal_docs: https://fal.ai/models/fal-ai/nano-banana
original_source: https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/
summary: Google's lightning-fast multimodal reasoning model for high-fidelity image generation and semantic editing.
---

# Nano Banana (Gemini 2.5 Flash Image)

## Overview
- **Slug:** fal-ai/nano-banana
- **Category:** Text-to-Image / Image-to-Image
- **Creator:** [Google](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)
- **Best for:** Rapid, high-fidelity image generation with deep semantic understanding and native text rendering.
- **FAL docs:** [fal.ai/models/fal-ai/nano-banana](https://fal.ai/models/fal-ai/nano-banana)
- **Original source:** [Google Developers Blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)

## What it does
Nano Banana (internally known as **Gemini 2.5 Flash Image**) is a state-of-the-art image generation and editing model developed by Google. Unlike traditional diffusion models that process prompts as bags of words, Nano Banana leverages Gemini's multimodal reasoning architecture to "think" about scene composition, spatial relationships, and lighting before rendering. It excels at rendering accurate text within images, following complex instructions, and performing semantic edits without the need for manual masks or layers.

## When to use this model
- **Use when:** You need high-speed generation (under 10 seconds), legible text/typography in images, or complex scene reasoning that usually trips up standard diffusion models.
- **Don't use when:** You need extreme "raw" photorealism (consider [Flux 1.1 Pro](https://fal.ai/models/fal-ai/flux-pro/v1.1)) or very specific artist-style mimicry that smaller fine-tuned models handle better.
- **Alternatives:** 
    - [fal-ai/flux-pro/v1.1](https://fal.ai/models/fal-ai/flux-pro/v1.1): Better for hyper-realistic textures.
    - [fal-ai/nano-banana-pro](https://fal.ai/models/fal-ai/nano-banana-pro): The higher-tier version (Gemini 3 Pro) with even deeper reasoning for complex layouts.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana` (sync) / `https://queue.fal.run/fal-ai/nano-banana` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text prompt to generate an image from. Supports natural language. |
| `num_images` | integer | 1 | 1 - 4 | The number of images to generate per request. |
| `seed` | integer | random | Any integer | Seed for reproducible results. |
| `aspect_ratio` | enum | `1:1` | `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16` | The output image aspect ratio. |
| `output_format` | enum | `png` | `jpeg`, `png`, `webp` | File format of the resulting image. |
| `safety_tolerance` | enum | `4` | `1, 2, 3, 4, 5, 6` | API only. Content moderation level. `1` is strict (more blocks), `6` is permissive. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns data as a Base64 URI directly in the response. |
| `limit_generations` | boolean | `false` | `true`, `false` | Experimental: Ignores "generate multiple" instructions in the prompt to ensure only 1 image is returned. |

### Output
The output returns a JSON object containing a list of `images` and a `description`.
- `images`: A list of objects containing `url`, `width`, `height`, and `content_type`.
- `description`: A text description of the generated image, often detailing what the model attempted to render.

### Example request
```json
{
  "prompt": "A professional photo of a futuristic cafe with a neon sign that says 'GEMINI CAFE'. A barista is serving a glowing blue latte.",
  "aspect_ratio": "16:9",
  "num_images": 1
}
```

### Pricing
- **Cost:** ~$0.039 per image ([fal.ai pricing](https://fal.ai/pricing)).
- **Rate:** Approximately 25 images per $1.00.

## API — via Original Source (BYO-key direct)
The model is available via Google's native API surfaces:
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`
- **Auth method:** API Key or OAuth2 via Google Cloud / Vertex AI.
- **Extra capabilities:** The native API supports **multimodal inputs** where you can pass up to 14 reference images alongside a prompt for multi-image fusion and semantic editing.
- **Official docs:** [Google AI Studio / Gemini API](https://ai.google.dev/gemini-api/docs/image-generation)

## Prompting best practices
- **Be Conversational:** Since the model is based on Gemini's LLM core, it understands long, descriptive sentences better than comma-separated keywords. Instead of "dog, swimming, pool, high quality", use "An action shot of a black lab swimming in an inground suburban swimming pool."
- **Typography:** To get text right, use quotes and describe the style. Example: "A vintage travel poster for Mars with the text 'Visit the Red Planet' in bold Art Deco font."
- **Semantic Editing:** When using the editing mode (if available via node), simply describe the change: "Keep the car but change the background from a city street to a winding mountain road at sunset."
- **Avoid "Keyword Stuffing":** Terms like "8k", "masterpiece", or "highly detailed" are less effective here than in Stable Diffusion; focus on describing the *actual* details of the scene.

## Parameter tuning guide
- **Aspect Ratio:** Choose the ratio that matches your layout early; the model's spatial reasoning adapts its "thinking" phase to the frame dimensions.
- **Safety Tolerance:** If your prompts are being blocked for non-violating content (e.g., medical or historical contexts), try increasing the `safety_tolerance` to `5` or `6`.
- **Seed:** Use a fixed seed when iterating on a specific composition to keep the layout stable while you tweak the wording of the prompt.

## Node inputs/outputs
- **Inputs:** 
    - `Prompt` (Text)
    - `Aspect Ratio` (Dropdown)
    - `Image Count` (Number)
- **Outputs:** 
    - `Image URL` (Image/URL)
    - `Description` (Text)
- **Chain-friendly with:** 
    - `fal-ai/flux-lora`: Use Nano Banana to generate a base scene with text, then use Flux for style transfer.
    - `fal-ai/vision-model`: Pass the output image and its `description` to a vision model for automated captioning or tagging.

## Notes & gotchas
- **Watermarking:** All outputs include an invisible **SynthID** digital watermark, identifying them as AI-generated per Google's safety policy.
- **Text Limits:** While excellent at text, it can still struggle with very long paragraphs or rare scripts. Keep in-image text to a few words for best results.
- **Queue Mode:** For batch generations or during high load, use the `/queue` endpoint to avoid timeout errors.

## Sources
- [fal.ai Model Page](https://fal.ai/models/fal-ai/nano-banana)
- [Google Developers Announcement](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/)
- [Google AI Studio Documentation](https://ai.google.dev/gemini-api/docs/image-generation)
- [fal.ai Pricing Table](https://fal.ai/pricing)