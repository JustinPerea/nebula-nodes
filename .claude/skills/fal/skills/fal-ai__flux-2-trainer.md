---
name: fal-ai/flux-2-trainer
display_name: FLUX.2 [dev] Trainer
category: training
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2-trainer
original_source: https://bfl.ai/blog/flux-2
summary: A professional LoRA fine-tuning model for Black Forest Labs' FLUX.2 [dev], optimized for character, style, and object specialization.
---

# FLUX.2 [dev] Trainer

## Overview
- **Slug:** `fal-ai/flux-2-trainer`
- **Category:** Training / LoRA Fine-Tuning
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** Creating highly specialized image generation adapters (LoRAs) for specific people, brands, or artistic styles.
- **FAL docs:** [fal.ai/models/fal-ai/flux-2-trainer](https://fal.ai/models/fal-ai/flux-2-trainer)
- **Original source:** [Black Forest Labs FLUX.2 Announcement](https://bfl.ai/blog/flux-2)

## What it does
The **FLUX.2 [dev] Trainer** is a specialized endpoint for fine-tuning the 32B parameter FLUX.2 [dev] model using Low-Rank Adaptation (LoRA). It allows users to upload a dataset of images and train a lightweight "patch" (LoRA) that captures a specific visual identity, character, or style. The resulting weights can be plugged into FLUX.2 inference models to generate consistent, brand-aligned, or character-specific imagery with state-of-the-art precision in textures, lighting, and text rendering.

## When to use this model
- **Use when:** You need to generate a specific person (influencer, model), a unique product, or a proprietary brand style that isn't present in the base model's knowledge.
- **Don't use when:** You want a general-purpose image; use the base `fal-ai/flux-2-dev` or `fal-ai/flux-2-pro` instead.
- **Alternatives:**
  - `fal-ai/flux-2-trainer/edit`: Optimized for image-to-image "transformation" training (e.g., "turn this photo into a watercolor").
  - `fal-ai/flux-lora-fast-training`: A faster, more cost-effective trainer for FLUX.1 models.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-2-trainer` (sync) / `https://queue.fal.run/fal-ai/flux-2-trainer` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_data_url` | `string` | *Required* | Valid URL | A URL to a `.zip` archive containing your training images. The zip can also include `.txt` files with captions for each image (e.g., `image1.jpg` and `image1.txt`). |
| `steps` | `integer` | `1000` | `100` - `10000` | Total number of training steps. Higher steps increase specialization but increase cost and risk of overfitting. |
| `learning_rate` | `float` | `0.00005` | `1e-6` - `1e-3` | The rate at which the model learns. Too high may crash training; too low may result in the model not learning the subject. |
| `default_caption` | `string` | *Required* | Text | The caption used for images that don't have a corresponding `.txt` file in the zip. Should include a unique trigger word. |
| `output_lora_format` | `enum` | `fal` | `fal`, `comfy` | Dictates the naming scheme and structure of the output weights for compatibility. |

### Output
The output is a JSON object containing references to the trained weights:
```json
{
  "diffusers_lora_file": {
    "url": "https://fal.run/storage/v1/files/...",
    "content_type": "application/octet-stream",
    "file_name": "pytorch_lora_weights.safetensors",
    "file_size": 4404019
  },
  "config_file": {
    "url": "https://fal.run/storage/v1/files/...",
    "content_type": "application/json",
    "file_name": "config.json",
    "file_size": 1234
  }
}
```

### Example request
```json
{
  "image_data_url": "https://example.com/my_dataset.zip",
  "steps": 1000,
  "learning_rate": 0.00005,
  "default_caption": "a photo of TOK person",
  "output_lora_format": "fal"
}
```

### Pricing
- **Cost:** Approximately **$0.008 per step**.
- **Standard Run (1000 steps):** **$8.00**.
- Billed via FAL.ai credits.

## API — via Original Source (BYO-key direct)
Black Forest Labs (BFL) provides a managed API for inference but primarily supports FLUX.2 [dev] and [klein] training via **open-weight checkpoints** on [Hugging Face](https://huggingface.co/black-forest-labs/FLUX.2-dev). 
- **Direct API:** BFL does not currently offer a public "training-as-a-service" API endpoint for LoRAs; FAL.ai is the primary cloud-based API surface for this model's training.
- **Local Training:** Developers can use the BFL reference inference code and `diffusers` library to train locally on NVIDIA GPUs (minimum 24GB VRAM recommended for 32B dev).

## Prompting best practices
- **Trigger Words:** Always include a unique, non-existent word in your `default_caption` (e.g., `sks`, `ohwx`, `TOK`) so the model has a specific token to associate with your training data.
- **Descriptive Dataset:** If your dataset contains a person in different outfits, your captions should describe the outfits so the model learns the *person* separately from the *clothes*.
- **Consistency is Key:** Ensure images in the `.zip` are high quality (1024x1024 or higher) and consistently represent the target subject or style.
- **Bad Prompting:** Using common words as trigger words (e.g., "a photo of man") will "dilute" the model's existing knowledge of men rather than creating a specific one.

## Parameter tuning guide
- **Steps:** For a single person/subject, 800–1200 steps is usually sufficient. For a complex artistic style, 1500–2000 steps may be needed.
- **Learning Rate:** If the output images look "burned" or distorted, lower the learning rate. If the model doesn't look like the subject at all after 1000 steps, consider a slightly higher rate (e.g., `0.0001`).
- **Dataset Size:** Aim for 15–30 high-quality images. While FLUX.2 can train on as few as 1 image, more diversity (different angles, lighting) produces a more flexible LoRA.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Dataset ZIP (URL)`: The training data source.
  - `Trigger Caption`: The primary description/trigger word.
  - `Training Steps`: Complexity of the run.
- **Outputs:**
  - `LoRA Weights (Safetensors)`: The resulting model file.
  - `Config JSON`: Meta-information for the LoRA.
- **Chain-friendly with:** 
  - `fal-ai/flux-2-dev`: To test the trained LoRA immediately.
  - `fal-ai/flux-pro/kontext`: For advanced multi-reference generation using your new LoRA.

## Notes & gotchas
- **Async Required:** Training runs typically take 5–15 minutes. Use the **Queue Mode** (`fal.queue.submit`) and webhooks to avoid timeout errors.
- **Overfitting:** Too many steps or too high a learning rate will make the model "unflexible," where it can only generate the exact images from the training set.
- **Zip Structure:** Ensure images are in the root of the `.zip` file, not nested in multiple folders.

## Sources
- [FAL.ai Flux 2 Trainer API](https://fal.ai/models/fal-ai/flux-2-trainer/api)
- [Black Forest Labs FLUX.2 VAE Blog](https://bfl.ai/blog/flux-2)
- [Hugging Face FLUX.2 [dev] Model Card](https://huggingface.co/black-forest-labs/FLUX.2-dev)
