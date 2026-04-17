---
name: fal-ai/nano-banana-pro
display_name: Nano Banana Pro (Gemini 3 Pro Image)
category: text-to-image
creator: Google (DeepMind)
fal_docs: https://fal.ai/models/fal-ai/nano-banana-pro
original_source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image
summary: Google's flagship multimodal image generation and editing model featuring advanced reasoning, 4K resolution, and industry-leading text rendering.
---

# Nano Banana Pro (Gemini 3 Pro Image)

## Overview
- **Slug:** `fal-ai/nano-banana-pro`
- **Category:** Text-to-Image / Image-to-Image (Editing)
- **Creator:** [Google DeepMind](https://deepmind.google/)
- **Best for:** Complex creative briefs requiring advanced reasoning, accurate text rendering, and high-fidelity 4K output.
- **FAL docs:** [fal.ai/models/fal-ai/nano-banana-pro](https://fal.ai/models/fal-ai/nano-banana-pro)
- **Original source:** [Google Vertex AI Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)

## What it does
Nano Banana Pro (officially **Gemini 3 Pro Image**) is Google's state-of-the-art multimodal foundation model designed for professional-grade image generation and editing. Unlike traditional diffusion models that rely on keyword matching, Nano Banana Pro uses advanced reasoning to interpret complex, conversational instructions, making it exceptionally good at understanding relationships between objects, lighting, and composition. It features industry-leading text rendering capabilities, character consistency for up to 5 people, and the ability to integrate real-time information via Google Search grounding.

## When to use this model
- **Use when:** You need accurate text inside an image, complex scene reasoning (e.g., "a cat sitting on a blue chair to the left of a red table"), professional marketing assets, or 4K high-resolution outputs.
- **Don't use when:** You need the absolute fastest generation speed or are performing simple iterations where the lower-cost original [Nano Banana](https://fal.ai/models/fal-ai/nano-banana) ($0.039/image) would suffice.
- **Alternatives:** 
    - **[Flux Kontext Pro](https://fal.ai/models/fal-ai/flux-pro/kontext):** Better for specific artistic styles and open-source fine-tuning flexibility.
    - **[Seedance 2.0](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video):** If your workflow requires high-quality video generation rather than static images.
    - **[Original Nano Banana](https://fal.ai/models/fal-ai/nano-banana):** For high-speed, low-cost preview generations.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana-pro` (sync) / `https://queue.fal.run/fal-ai/nano-banana-pro` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text prompt to generate an image from. Supports conversational natural language. |
| `num_images` | integer | `1` | 1-4 | The number of images to generate per request. |
| `seed` | integer | random | N/A | The seed for the random number generator to ensure reproducibility. |
| `aspect_ratio` | Enum | `1:1` | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16` | The aspect ratio of the generated image. |
| `output_format` | Enum | `jpeg` | `jpeg`, `png`, `webp` | The file format of the generated image. |
| `safety_tolerance` | Enum | `4` | `1, 2, 3, 4, 5, 6` | API Only. Moderation level. 1 is most strict (blocks most), 6 is least strict. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns media as a data URI immediately. |
| `resolution` | Enum | `1K` | `1K`, `2K`, `4K` | Output resolution. 4K incurs a 2x cost multiplier. |
| `limit_generations` | boolean | `false` | `true`, `false` | Experimental. Disregards prompt instructions about the number of images to generate, limiting to 1. |
| `enable_web_search` | boolean | `false` | `true`, `false` | Enables Google Search grounding for real-world factual accuracy (e.g., current weather, scores). |

### Output
The API returns an object containing:
- `images`: A list of `ImageFile` objects.
    - `url`: Publicly accessible download URL.
    - `content_type`: MIME type (e.g., `image/png`).
    - `file_name`: Auto-generated filename.
    - `file_size`: Size in bytes.
    - `width`/`height`: Dimensions in pixels.
- `description`: A detailed text description of the generated visuals, useful for accessibility or metadata.

### Example request
```json
{
  "prompt": "A professional infographic showing the history of space travel with clear dates and descriptions of major milestones like Apollo 11 and the ISS. High-contrast design, 4K resolution.",
  "aspect_ratio": "16:9",
  "resolution": "4K",
  "enable_web_search": true
}
```

### Pricing
- **Standard:** $0.15 per image.
- **4K Resolution:** $0.30 per image (2x base rate).
- **Web Search:** Additional $0.015 per request.
- Approximately 7 standard generations per $1.00. [FAL Pricing](https://fal.ai/pricing)

## API — via Original Source (BYO-key direct)
Google offers a native API through Vertex AI and Google AI Studio.
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`
- **Auth:** Bearer token or `x-goog-api-key`.
- **Exclusive Features:** 
    - **Thought Signatures:** Preserves "thinking" context for multi-turn conversational edits.
    - **Native Grounding:** Direct integration with `google_search` tool for real-time data.
    - **Direct Editing:** Native support for the `edit_image` task type without a separate endpoint.
- **Documentation:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image-preview)

## Prompting best practices
- **Be Conversational:** Instead of "man dog park high res," use "A photo of a golden retriever playing with a young man in Central Park, focused on the dog's joyful expression, cinematic lighting."
- **Describe Intent:** The model understands semantic nuance. Use keywords like "1960s aesthetic" or "cyberpunk mood" to influence color, grain, and composition simultaneously.
- **Explicit Text:** If you want text, place it in quotes: "A bakery storefront with a sign that says 'Boulangerie Banana' in elegant gold calligraphy."
- **Multi-Turn Editing:** Use the `/edit` endpoint for successive changes: "Now change the dog to a black lab and make the grass greener."
- **Grounding:** For current events, use `enable_web_search`: "Generate a chart showing yesterday's NVIDIA stock performance."

## Parameter tuning guide
- **Resolution (1K/2K/4K):** Use 1K for rapid prototyping. Switch to 4K for final production assets; it significantly improves texture detail and text legibility but doubles the cost.
- **Safety Tolerance:** For creative projects that might trigger false positives (like "a battle scene"), increase the tolerance to `5` or `6`. Use `1` for strictly safe enterprise applications.
- **Enable Web Search:** Only toggle `true` when the prompt depends on real-world facts. It adds a small cost and slight latency but ensures accuracy for data visualizations.
- **Num Images:** Set to `4` during the "creative direction" phase to see multiple interpretations of your prompt before settling on one seed.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (string)
    - `Image URL` (optional, for editing)
    - `Aspect Ratio` (dropdown)
    - `Resolution` (dropdown)
    - `Enable Web Search` (boolean)
- **Outputs:**
    - `Image URL` (url)
    - `Description` (string)
- **Chain-friendly with:**
    - **[Flux LoRA Training](https://fal.ai/models/fal-ai/flux-lora-fast-training):** Use Nano Banana Pro to generate high-quality base images/captions for training.
    - **[Claude 3.5 Sonnet](https://fal.ai/models/fal-ai/claude-3.5-sonnet):** Use an LLM to expand simple user ideas into the complex conversational prompts that Nano Banana Pro thrives on.

## Notes & gotchas
- **Watermarking:** Outputs include Google's [SynthID](https://deepmind.google/technologies/synthid/) digital watermarking. A visible watermark may be applied for non-Ultra subscribers.
- **Reasoning Latency:** Due to its foundation model architecture, it is slower than standard diffusion models. Expect 5-15 seconds for a 4K generation.
- **Commercial Use:** Enabled through the FAL.ai partnership agreement.

## Sources
- [FAL.ai Nano Banana Pro Docs](https://fal.ai/models/fal-ai/nano-banana-pro/api)
- [Google Gemini 3 Pro Image Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Google AI for Developers Blog](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image-preview)
