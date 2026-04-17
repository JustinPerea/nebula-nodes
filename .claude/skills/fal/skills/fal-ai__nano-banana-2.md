---
name: fal-ai/nano-banana-2
display_name: Nano Banana 2 (Gemini 3.1 Flash Image)
category: text-to-image
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/nano-banana-2
original_source: https://ai.google.dev/gemini-api/docs/image-generation
summary: A high-speed, logical image generation model by Google featuring 4K resolution, web search grounding, and a multi-step 'thinking' process.
---

# Nano Banana 2 (Gemini 3.1 Flash Image)

## Overview
- **Slug:** `fal-ai/nano-banana-2`
- **Category:** Text-to-Image / Image Editing
- **Creator:** [Google DeepMind](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)
- **Best for:** High-speed, high-resolution (4K) image generation with logical spatial reasoning and real-time factuality.
- **FAL docs:** [fal.ai/models/fal-ai/nano-banana-2](https://fal.ai/models/fal-ai/nano-banana-2)
- **Original source:** [Google AI Studio / Vertex AI](https://ai.google.dev/gemini-api/docs/image-generation)

## What it does
Nano Banana 2 is the FAL-hosted implementation of **Gemini 3.1 Flash Image**, Google's state-of-the-art "Flash" tier image model ([Google Blog](https://blog.google/innovation-and-ai/technology/ai/nano-banana-2/)). Unlike traditional diffusion models, it utilizes a transformer-based architecture that can "think" through a prompt in multiple steps to ensure logical composition and spatial accuracy ([Google DeepMind](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)). It supports native 4K output, real-time web search grounding for current events, and extreme aspect ratios (up to 8:1) ([fal.ai](https://fal.ai/models/fal-ai/nano-banana-2/api)).

## When to use this model
- **Use when:** You need high-speed generation for production workflows, require 4K resolution for print or e-commerce, or need the model to "know" about current events via web search.
- **Don't use when:** You need extreme stylistic variety (FLUX often excels more in "vibe" diversity) or perfect character consistency across long sequences, which is still a known limitation ([Google DeepMind](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)).
- **Alternatives:** 
    - **fal-ai/nano-banana-pro:** Higher fidelity and better character consistency, but significantly slower and more expensive.
    - **fal-ai/flux-pro:** Better for artistic "vibes" and community-driven styles.
    - **fal-ai/kling-video:** If you need to animate the resulting image immediately.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/nano-banana-2` (sync) / `https://queue.fal.run/fal-ai/nano-banana-2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The text description of the image to generate. |
| `num_images` | integer | `1` | 1-4 | Number of images to generate per request. |
| `seed` | integer | random | N/A | Seed for reproducible results. |
| `aspect_ratio` | enum | `auto` | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `4:1`, `1:4`, `8:1`, `1:8` | Controls the framing. Supports extreme panoramic/tall ratios. |
| `resolution` | enum | `1K` | `0.5K`, `1K`, `2K`, `4K` | Output image resolution. |
| `thinking_level` | enum | `minimal` | `minimal`, `high` | Enables the model to generate internal logic steps before rendering. |
| `enable_web_search`| boolean | `false` | `true`, `false` | Allows the model to use Google Search to ground the image in real-world facts. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | File format for the output image. |
| `safety_tolerance` | enum | `1` | `1` to `6` | Safety filter level (1: Strict, 6: Lenient). Available via API only. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns data URIs instead of hosted URLs. |
| `limit_generations` | boolean | `true` | `true`, `false` | Experimental: Limits generation to 1 round to ignore prompt-injected counts. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects, each containing a `url`, `width`, `height`, and `content_type`.
- `description`: A detailed text description of the generated scene, useful for accessibility or chain-verification.

### Example request
```json
{
  "input": {
    "prompt": "A futuristic city skyline in 2050 with floating gardens and holographic advertisements, 4K, cinematic lighting",
    "resolution": "4K",
    "aspect_ratio": "16:9",
    "thinking_level": "high",
    "enable_web_search": true
  }
}
```

### Pricing
Pricing on FAL is based on resolution and features ([fal.ai pricing](https://fal.ai/learn/tools/ai-image-generators)):
- **0.5K (512px):** $0.06 / image
- **1K (Standard):** $0.08 / image
- **2K:** $0.12 / image
- **4K:** $0.16 / image
- **Web Search Grounding:** Additional $0.015 per request.

---

## API — via Original Source (BYO-key direct)
The model is natively available as **Gemini 3.1 Flash Image** through the Google Gemini API.

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
- **Auth:** Header `x-goog-api-key: $YOUR_API_KEY`
- **Native Advantages:** 
    - **Multi-modal Input:** Supports up to 1,000 input images for context-aware generation or editing ([Firebase docs](https://firebase.google.com/docs/ai-logic/models)).
    - **Iterative Editing:** Can be used in a chat-like structure to modify previously generated images.
    - **Search Grounding:** Direct integration with Google Search infrastructure.
- **Official Docs:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/image-generation)

---

## Prompting best practices
- **Use "Thinking" for Complexity:** If your scene involves specific spatial relationships (e.g., "a cat to the left of a blue lamp, behind a glass of water"), set `thinking_level` to `high`. This forces the model to layout the scene logically before drawing.
- **Web Search for News:** Use keywords like "current weather in [City]" or "the latest model of [Car]" and enable `enable_web_search` to get up-to-date visual details ([WaveSpeedAI](https://wavespeed.ai/blog/posts/nano-banana-2-google-best-image-generation-editing-model/)).
- **Prompt Structure:** It responds best to descriptive, natural language rather than keyword soup.
    - **Good:** "A wide-angle photo of a professional kitchen during the dinner rush, chefs in white coats plating dishes, steam rising from pots, warm orange lighting, 4K resolution."
    - **Bad:** "Kitchen, chef, cook, steam, 4k, ultra-hd, hyperreal."
- **Failure Modes:** It occasionally struggles with very small text or complex 3D reasoning (e.g., overlapping transparent objects) ([Google DeepMind](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)).

## Parameter tuning guide
- **`thinking_level`:** Use `minimal` for simple portraits or landscapes to save time/cost. Use `high` for infographics, architectural layouts, or scenes with 3+ distinct characters.
- **`resolution`:** 1K is sufficient for most social media. Always use 4K for print assets, as the model performs a native 4K pass rather than a simple upscale.
- **`safety_tolerance`:** If you find valid medical or historical prompts being blocked, try increasing this to 4 or 5 (API only).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Resolution` (Dropdown: 0.5K, 1K, 2K, 4K)
    - `Aspect Ratio` (Dropdown)
    - `Enable Search` (Boolean)
    - `Thinking Level` (Dropdown)
- **Outputs:**
    - `Image URL` (URL)
    - `Scene Description` (Text) - Great for feeding into a Vision LLM for "Chain of Verification."
- **Chain-friendly with:**
    - `fal-ai/vllm`: To expand a simple user prompt into a high-fidelity description before sending to Nano Banana.
    - `fal-ai/image-to-video`: To animate the 4K output into a cinematic clip.

## Notes & gotchas
- **Safety:** The model is strictly moderated by Google's safety filters; even at higher tolerance levels, it will refuse generating public figures or sensitive content ([Google DeepMind](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)).
- **Region Restrictions:** Some features like Search Grounding may be subject to regional availability depending on your API key's origin.

## Sources
- [FAL.ai Nano Banana 2 API Page](https://fal.ai/models/fal-ai/nano-banana-2/api)
- [Google DeepMind Gemini 3.1 Flash Image Model Card](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/)
- [Google AI for Developers - Image Generation Guide](https://ai.google.dev/gemini-api/docs/image-generation)
- [FAL.ai Learn - Pricing Comparison](https://fal.ai/learn/tools/ai-image-generators)
