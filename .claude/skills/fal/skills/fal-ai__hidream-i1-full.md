---
name: fal-ai/hidream-i1-full
display_name: HiDream-I1 Full
category: text-to-image
creator: HiDream.ai (Vivago.ai)
fal_docs: https://fal.ai/models/fal-ai/hidream-i1-full
original_source: https://github.com/HiDream-ai/HiDream-I1, https://vivago.ai/platform
summary: A massive 17B parameter sparse DiT model with Llama-3.1 reasoning for state-of-the-art prompt following and image quality.
---

# HiDream-I1 Full

## Overview
- **Slug:** `fal-ai/hidream-i1-full`
- **Category:** Text-to-Image
- **Creator:** [HiDream.ai](https://vivago.ai/)
- **Best for:** Complex scenes requiring high spatial accuracy, counting, and photorealistic detail.
- **FAL docs:** [FAL.ai/models/fal-ai/hidream-i1-full](https://fal.ai/models/fal-ai/hidream-i1-full)
- **Original source:** [HiDream-ai GitHub](https://github.com/HiDream-ai/HiDream-I1), [Vivago.ai Platform](https://vivago.ai/platform)

## What it does
HiDream-I1 Full is a state-of-the-art open-source image generation model with **17 billion parameters**. It utilizes a unique **Sparse Diffusion Transformer (DiT)** architecture combined with a dynamic **Mixture-of-Experts (MoE)** design, which allows it to maintain the reasoning power of a massive model while remaining computationally efficient [arXiv Technical Report](https://arxiv.org/abs/2505.22705). Its most distinctive feature is its "brain"—a hybrid text encoding system that includes **Llama-3.1-8B-Instruct** alongside T5 and CLIP encoders, giving it industry-leading prompt-following capabilities, particularly for spatial relationships (e.g., "to the left of") and complex logical instructions [Vidofy AI](https://vidofy.ai/en/models/hidream-i1).

## When to use this model
- **Use when:** You need high-fidelity images with complex compositions, multiple interacting subjects, or specific text rendering. It excels at benchmarks like GenEval where typical models struggle with counting and attribute binding [Hugging Face Paper](https://huggingface.co/papers/2505.22705).
- **Don't use when:** You need ultra-fast, real-time generation (use `hidream-i1-fast` instead) or when running on extremely low-VRAM hardware (though MoE helps, it is still a 17B parameter model).
- **Alternatives:** 
  - **Flux.1 [dev/pro]:** Similar high quality but uses a different dual-stream architecture; HiDream often follows complex logical prompts better due to the Llama-3.1 encoder.
  - **fal-ai/hidream-i1-fast:** The distilled 16-step version of this model, better for rapid iteration.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hidream-i1-full` (sync) / `https://queue.fal.run/fal-ai/hidream-i1-full` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | | The primary text description for the image. |
| `negative_prompt` | string | `""` | | Description of elements to exclude from the image. |
| `image_size` | string/object | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, or `{width: int, height: int}` | Output dimensions. Custom sizes supported. |
| `num_inference_steps`| integer | `50` | 15 - 100 | Number of denoising steps. 50 is recommended for the Full model. |
| `guidance_scale` | float | `5.0` | 1 - 20 | CFG scale; determines adherence to the prompt. |
| `seed` | integer | (random) | | Integer for reproducible results. |
| `num_images` | integer | `1` | 1 - 8 | Number of images to generate per request. |
| `enable_safety_checker`| boolean | `true` | | Filters out NSFW content. |
| `output_format` | enum | `jpeg` | `jpeg`, `png` | Format of the resulting image file. |
| `sync_mode` | boolean | `false` | | If true, returns data URI immediately without saving to history. |
| `loras` | list | `[]` | | List of LoRA weights to apply (path and scale). |

### Output
Returns a JSON object containing:
- `images`: A list of objects with `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for generation.
- `has_nsfw_concepts`: Boolean list indicating if any images were flagged.
- `timings`: Performance breakdown of the generation process.

### Example request
```json
{
  "input": {
    "prompt": "A cinematic shot of a futuristic neon city where a giant holographic koi fish swims through the skyscrapers, purple and cyan lighting, high detail, 8k",
    "image_size": "landscape_16_9",
    "num_inference_steps": 50,
    "guidance_scale": 5
  }
}
```

### Pricing
- **Cost:** $0.05 per megapixel [FAL.ai](https://fal.ai/models/fal-ai/hidream-i1-full).
- **Billing:** Pay-as-you-go based on total pixels generated.

## API — via Original Source (BYO-key direct)
The model is developed by **HiDream.ai** and is available via their **Vivago AI Developer Platform**.

- **Endpoint:** `https://www.vivago.ai/api-pub/gw/v3/image/txt2img/async`
- **Auth Method:** Bearer Token (obtained from the Vivago User Center).
- **Unique Parameters:**
  - `num`: Equivalent to `num_images`.
  - `external_id`: A custom string for client-side tracking (UUID recommended).
  - `notify_url`: Webhook URL for task completion notifications.
- **Docs:** [Vivago API Documentation](https://vivago.ai/doc/txt2img/request)

## Prompting best practices
- **Be Descriptive:** Since the model uses Llama-3.1, you can use natural language and complex sentences. Instead of just "cat," use "A fluffy orange tabby cat sitting on a velvet cushion."
- **Spatial Cues:** Use explicit spatial keywords like "on the left," "behind the main subject," or "centered in the foreground." The model's 4-encoder system is specifically designed to understand these [Vidofy AI](https://vidofy.ai/en/models/hidream-i1).
- **Style Tokens:** Works exceptionally well with style modifiers like "cyberpunk," "oil painting," "Ghibli style," or "8k photorealistic."
- **Logic Handling:** You can prompt for specific counts (e.g., "exactly three red apples") with higher success rates than Stable Diffusion or early Flux models.

## Parameter tuning guide
- **Steps:** 50 steps is the standard for the Full version. Reducing to 30 may slightly speed up generation with minor quality loss; going above 70 rarely yields noticeable benefits.
- **Guidance Scale (CFG):** 3.5 to 5.0 is the sweet spot for photorealism. Push to 7.0+ for highly stylized or abstract art to force the model into specific prompt patterns.
- **Image Size:** If using custom sizes, stick to multiples of 8 or 16 for better VAE compatibility.

## Node inputs/outputs
- **Inputs:**
  - `Prompt` (Text)
  - `Negative Prompt` (Text)
  - `Image Size` (Enum/Dimensions)
  - `Steps` (Integer)
  - `Seed` (Integer)
- **Outputs:**
  - `Image URL` (Link)
  - `Seed` (Integer)
  - `NSFW Flag` (Boolean)

## Notes & gotchas
- **Safety:** The model has a strict internal content policy; prompts that are explicitly violent or adult will return a "safety checker" trigger or a blank image.
- **License:** Released under the **MIT License**, making it extremely friendly for commercial integration and derivative works [GitHub](https://github.com/HiDream-ai/HiDream-I1).
- **Llama Weights:** For local use, it requires agreeing to the Llama-3.1 license on Hugging Face to download the text encoder components.

## Sources
- [FAL.ai HiDream-I1 Full Documentation](https://fal.ai/models/fal-ai/hidream-i1-full/api)
- [HiDream-I1 Technical Report (arXiv:2505.22705)](https://arxiv.org/abs/2505.22705)
- [Official HiDream-I1 GitHub Repository](https://github.com/HiDream-ai/HiDream-I1)
- [Vivago AI Developer Platform](https://vivago.ai/doc)
- [ComfyUI Native HiDream-I1 Guide](https://docs.comfy.org/tutorials/image/hidream/hidream-i1)