---
name: fal-ai/flux-lora-fast-training
display_name: FLUX LoRA Fast Training
category: training
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-lora-fast-training/api
original_source: https://docs.bfl.ml/
summary: High-speed training for custom FLUX LoRA models for styles, characters, and subjects.
---

# FLUX LoRA Fast Training

## Overview
- **Slug:** `fal-ai/flux-lora-fast-training`
- **Category:** Training / Text-to-Image
- **Creator:** [Black Forest Labs](https://docs.bfl.ml/) (Base Model) / [fal.ai](https://fal.ai/) (Training Service)
- **Best for:** Rapidly creating high-quality, personalized LoRA adapters for FLUX.1 models in minutes.
- **FAL docs:** [fal-ai/flux-lora-fast-training API](https://fal.ai/models/fal-ai/flux-lora-fast-training/api)
- **Original source:** [Black Forest Labs Documentation](https://docs.bfl.ml/flux_2/flux2_klein_training)

## What it does
The `flux-lora-fast-training` endpoint allows users to fine-tune a LoRA (Low-Rank Adaptation) model on a small dataset of images (as few as 4-30) at "blazing speeds," typically completing in just a few minutes. It is built on the [FLUX.1 model family](https://blackforestlabs.ai/) and is optimized for two primary use cases:
1. **Character/Subject Training:** Capturing the likeness of a specific person, animal, or object to generate them in any context.
2. **Style Training:** Learning the unique aesthetic, brushwork, or color palette of an artist or brand.

The service handles complex preprocessing tasks automatically, including [caption generation and segmentation masking](https://fal.ai/models/fal-ai/flux-lora-fast-training/api#about), ensuring that even beginners can achieve professional results with minimal effort.

## When to use this model
- **Use when:** You need to generate a specific person or unique brand style consistently across many different images.
- **Use when:** You want to avoid the high VRAM requirements and complexity of local LoRA training.
- **Don't use when:** You need a full foundation model; this creates a lightweight adapter file, not a standalone model.
- **Don't use when:** Your training data is low-resolution or inconsistent (results will be poor).
- **Alternatives:** 
  - [fal-ai/flux-lora](https://fal.ai/models/fal-ai/flux-lora): Use this to *run* the LoRAs you train here.
  - [fal-ai/flux/dev](https://fal.ai/models/fal-ai/flux/dev): Use this for high-quality generic generation without custom adapters.
  - [fal-ai/flux-pro](https://fal.ai/models/fal-ai/flux-pro): Use for the highest quality commercial output when custom training isn't required.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-lora-fast-training` (Sync) / `https://queue.fal.run/fal-ai/flux-lora-fast-training` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `images_data_url` | string | **Required** | URL | URL to a `.zip` archive containing training images. Recommend at least 4-30 high-res (1024px+) images. |
| `trigger_word` | string | `null` | String | A unique word (e.g., `sks`, `ohwx`) to associate with the subject in prompts. |
| `steps` | integer | `1000` | `1` to `10000` | Number of training steps. Higher steps increase accuracy but also cost and time. |
| `is_style` | boolean | `false` | `true`, `false` | Set to `true` for style training. Disables auto-captioning and segmentation for better aesthetic transfer. |
| `create_masks` | boolean | `true` | `true`, `false` | Automatically creates segmentation masks (e.g., for faces) to focus training. |
| `is_input_format_already_preprocessed` | boolean | `false` | `true`, `false` | Set to `true` if your dataset already includes manually crafted captions and masks. |
| `data_archive_format` | string | `null` | `zip`, `tar` | The archive format. Inferred from the URL if not provided. |

### Output
The API returns a JSON object containing links to the trained assets:
- `diffusers_lora_file`: A `File` object containing the `.safetensors` URL of the trained LoRA weights (Diffusers format).
- `config_file`: A `File` object containing the training configuration used.
- `debug_preprocessed_output`: (Optional) A `File` object containing the preprocessed images for troubleshooting.

### Example request
```json
{
  "images_data_url": "https://example.com/my_photos.zip",
  "trigger_word": "sks_person",
  "steps": 1000,
  "is_style": false,
  "create_masks": true
}
```

### Pricing
FAL.ai uses a transparent [pay-per-use pricing model](https://fal.ai/pricing):
- **Base Cost:** $2.00 per training run (standard for 1000 steps).
- **Scaling:** Costs scale linearly with the number of `steps`. A 2000-step run would cost approximately $4.00.
- **Commercial Rights:** The trained LoRA files are yours to keep and use for commercial purposes.

## API — via Original Source (BYO-key direct)
The base model and training architecture are designed by [Black Forest Labs](https://docs.bfl.ml/). While BFL provides the model weights for local training via [SimpleTuner](https://github.com/bghira/SimpleTuner) or [Kohya_ss](https://github.com/kohya-ss/sd-scripts), they do not offer a direct, serverless "Fast Training" API equivalent to FAL.ai's managed service. FAL.ai is the primary cloud provider for this optimized training pipeline.

## Prompting best practices
- **Include the Trigger Word:** Always place your `trigger_word` early in the prompt when using the LoRA (e.g., "A portrait of sks_person in space").
- **Combine with Descriptive Text:** For styles, use "in the style of [trigger_word]".
- **Balance Strength:** When using the trained LoRA in inference, start with a `lora_scale` of `1.0`. If the features are too strong/distorted, lower it to `0.8`; if the resemblance is weak, try `1.1` or `1.2`.
- **Failure Mode — Overfitting:** If the model only generates one exact pose from your training set, you likely used too many steps (`steps > 2000`) or too few training images.
- **Good Prompt:** "A realistic photo of sks_person wearing a tuxedo, cinematic lighting, 8k."
- **Bad Prompt:** "A photo of a person." (Missing the trigger word renders the LoRA useless).

## Parameter tuning guide
- **`steps`:** The most critical parameter. Use **1000** for a single character or simple style. Increase to **2000-3000** for complex styles or multiple subjects. Avoid exceeding 5000 unless you have a very large dataset (50+ images).
- **`is_style`:** Always set this to `true` if you are training an artistic aesthetic rather than a specific object. It tells the trainer to ignore specific object boundaries and focus on global patterns.
- **`create_masks`:** Keep this `true` for people/characters. It ensures the model prioritizes learning the face and body rather than the background.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Images Archive (URL)`: ZIP file of training data.
  - `Trigger Word`: Unique identifier string.
  - `Training Intensity`: Integer (mapping to `steps`).
  - `Training Mode`: Toggle (Style vs. Subject).
- **Outputs:**
  - `LoRA Weights (File)`: The resulting `.safetensors` file.
  - `Status Logs`: Real-time training progress.
- **Chain-friendly with:**
  - `fal-ai/flux-lora`: Connect the output weights directly to the `path` input of a Flux LoRA node for immediate generation.
  - `fal-ai/flux/dev`: As the base generation node.

## Notes & gotchas
- **Data Privacy:** Images uploaded to FAL are used for training your specific LoRA. Ensure you have the rights to the images you upload.
- **Regionality:** Training happens on high-end NVIDIA GPUs (H100/A100), ensuring sub-5-minute completion for standard runs.
- **Format:** The output is in [Diffusers format](https://huggingface.co/docs/diffusers/main/en/index). If you need it for ComfyUI or WebUI, you may need to convert the keys, though most modern UI tools support this format natively.

## Sources
- [FAL.ai Training Documentation](https://fal.ai/models/fal-ai/flux-lora-fast-training/api)
- [Black Forest Labs FLUX.2 Training Guide](https://docs.bfl.ml/flux_2/flux2_klein_training)
- [SimpleTuner Technical Notes](https://github.com/bghira/SimpleTuner)
- [Together AI LoRA Inference Guide](https://docs.together.ai/docs/quickstart-flux-lora)