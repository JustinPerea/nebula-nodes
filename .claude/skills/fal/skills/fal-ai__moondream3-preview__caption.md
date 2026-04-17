---
name: fal-ai/moondream3-preview/caption
display_name: Moondream3 Preview [Caption]
category: vision
creator: Moondream AI (M87 Labs)
fal_docs: https://fal.ai/models/fal-ai/moondream3-preview/caption
original_source: https://moondream.ai/
summary: A high-efficiency 9B Mixture-of-Experts vision language model capable of high-speed image captioning and visual reasoning.
---

# Moondream3 Preview [Caption]

## Overview
- **Slug:** `fal-ai/moondream3-preview/caption`
- **Category:** Vision / Image-to-Text
- **Creator:** [Moondream AI (M87 Labs)](https://moondream.ai/)
- **Best for:** Fast, high-quality image captioning with a balance of detail and inference speed.
- **FAL docs:** [fal.ai/models/fal-ai/moondream3-preview/caption](https://fal.ai/models/fal-ai/moondream3-preview/caption)
- **Original source:** [moondream.ai](https://moondream.ai/) / [Hugging Face Model Card](https://huggingface.co/moondream/moondream3-preview)

## What it does
Moondream 3 is a state-of-the-art vision language model (VLM) utilizing a Mixture-of-Experts (MoE) architecture with 9 billion total parameters and 2 billion active parameters per token. It is designed to deliver "frontier-level" visual reasoning—surpassing many larger models in specific benchmarks—while maintaining a speed and cost profile suitable for real-time applications. The captioning variant specifically excels at generating descriptive text for images at varying lengths (short, normal, or long) while understanding complex scene contexts.

## When to use this model
- **Use when:** You need high-speed image descriptions for accessibility, SEO, or content moderation. It is particularly effective for real-world visual reasoning tasks that require more than just simple tagging.
- **Don't use when:** You need ultra-high resolution processing beyond the model's native multi-crop channel concatenation limits, or if you require the absolute highest level of creative prose found in much larger models like GPT-4o or Claude 3.5 Sonnet.
- **Alternatives:** 
    - **[LLaVA-v1.6](https://fal.ai/models/fal-ai/llava-v1.6):** A popular open-source VLM; Moondream3 is generally faster due to its MoE architecture.
    - **[Qwen-VL-Max](https://fal.ai/models/fal-ai/qwen-vl-max):** Often provides higher detail but may come with higher latency.
    - **[JoyCaption](https://fal.ai/models/fal-ai/joy-caption):** Specifically tuned for high-quality, descriptive captions for image generation prompts.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/moondream3-preview/caption` (sync) / `https://queue.fal.run/fal-ai/moondream3-preview/caption` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | *Required* | N/A | URL of the image to be processed. Supports public URLs and base64 data URIs. |
| `length` | `string` | `normal` | `short`, `normal`, `long` | Desired length of the generated caption. |
| `temperature` | `float` | `0` | `0.0` to `1.0` | Sampling temperature. Higher values (e.g., 0.8) increase randomness; lower values make output more deterministic. |
| `top_p` | `float` | `Not set` | `0.0` to `1.0` | Nucleus sampling probability mass. |

### Output
The output is a JSON object containing:
- `output`: `string` - The generated caption text.
- `finish_reason`: `string` - Indicates why generation stopped (e.g., "stop").
- `usage_info`: `object` - Contains token usage and timing statistics:
    - `input_tokens`: `integer`
    - `output_tokens`: `integer`
    - `prefill_time_ms`: `float`
    - `decode_time_ms`: `float`
    - `ttft_ms`: `float` (Time to first token)

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/falserverless/example_inputs/moondream-3-preview/caption_in.jpg",
  "length": "normal",
  "temperature": 0.2
}
```

### Pricing
- **Input Tokens:** $0.4 per million tokens [fal.ai](https://fal.ai/models/fal-ai/moondream3-preview/caption/playground).
- **Output Tokens:** $3.5 per million tokens [fal.ai](https://fal.ai/models/fal-ai/moondream3-preview/caption/playground).

## API — via Original Source (BYO-key direct)
Moondream offers a direct Cloud API at `https://api.moondream.ai/v1`. Users can bring their own API keys from the [Moondream Dashboard](https://moondream.ai/).
- **Endpoint:** `https://api.moondream.ai/v1/caption`
- **Auth Method:** Bearer Token (API Key)
- **Extra Features:** Moondream's native API often includes lower pricing ($0.3/M input, $2.5/M output) and supports advanced features like `stream: true` and image encoding caching for repeated queries on the same image [Moondream Pricing](https://moondream.ai/pricing).
- **Official Docs:** [docs.moondream.ai](https://docs.moondream.ai/)

## Prompting best practices
- **Be Specific about Length:** Use the `length` parameter rather than trying to force length via natural language prompts, as the model is natively tuned for these three tiers.
- **Context is King:** While this is a captioning endpoint, if you need specific details (like "describe only the background"), use the `moondream3-preview/query` endpoint instead.
- **Avoid Ambiguity:** Provide high-quality images. While Moondream3 is robust, very low-resolution images may lead to hallucinations in fine details like text or small background objects.
- **Example Good Prompt (Query variant):** "What is written on the sign in the background?" vs **Bad Prompt:** "Describe the sign."

## Parameter tuning guide
- **`length`:** Set to `short` for quick tagging or summaries; `long` for detailed alt-text or deep scene analysis.
- **`temperature`:** Set to `0` for consistent, factual captions. Increase to `0.7`+ if you want more varied or "creative" descriptions of the same image.
- **`top_p`:** Usually works best when left at default or set slightly below `1.0` (e.g., `0.9`) to filter out low-probability tokens when using a higher temperature.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `image` (File/URL)
    - `caption_length` (Dropdown: short, normal, long)
    - `creativity` (Float Slider: 0 to 1)
- **Outputs:**
    - `caption_text` (String)
    - `token_usage` (Object)
- **Chain-friendly with:**
    - **[Flux.1 [Dev]](https://fal.ai/models/fal-ai/flux/dev):** To generate image-to-image prompts by first captioning an image.
    - **[Moondream3 [Detect]](https://fal.ai/models/fal-ai/moondream3-preview/detect):** To get both a description and precise bounding boxes for objects in the same workflow.

## Notes & gotchas
- **Preview Status:** As of April 2026, Moondream3 is in "preview," meaning the architecture and weights may undergo updates.
- **Token Usage:** Every image consumes approximately 729 tokens due to the vision encoding process [Moondream Pricing](https://moondream.ai/pricing).
- **Rate Limits:** Check your FAL.ai tier for specific rate limits; however, Moondream is designed for high-concurrency "real-world" applications.

## Sources
- [FAL.ai Moondream3 Documentation](https://fal.ai/models/fal-ai/moondream3-preview/caption/api)
- [Moondream Official Website](https://moondream.ai/)
- [Hugging Face Model Card - Moondream3 Preview](https://huggingface.co/moondream/moondream3-preview)
- [Moondream Pricing and Token Info](https://moondream.ai/pricing)
