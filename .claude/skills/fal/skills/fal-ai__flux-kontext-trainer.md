---
name: fal-ai/flux-kontext-trainer
display_name: Flux Kontext Trainer
category: training
creator: Black Forest Labs (BFL)
fal_docs: https://fal.ai/models/fal-ai/flux-kontext-trainer
original_source: https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev
summary: A specialized LoRA trainer for the FLUX.1 Kontext [dev] model, enabling custom image-to-image editing and character consistency workflows.
---

# Flux Kontext Trainer

## Overview
- **Slug:** `fal-ai/flux-kontext-trainer`
- **Category:** Training
- **Creator:** [Black Forest Labs (BFL)](https://bfl.ai/)
- **Best for:** Training custom LoRAs to extend the in-context image editing capabilities of FLUX.1 Kontext.
- **FAL docs:** [fal.ai/models/fal-ai/flux-kontext-trainer](https://fal.ai/models/fal-ai/flux-kontext-trainer)
- **Original source:** [Hugging Face - black-forest-labs/FLUX.1-Kontext-dev](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)

## What it does
The **Flux Kontext Trainer** is a specialized service for fine-tuning Low-Rank Adaptation (LoRA) weights for the **FLUX.1 Kontext [dev]** model ([fal.ai Blog](https://blog.fal.ai/announcing-flux-1-kontext-dev-inference-training/)). Unlike standard LoRA trainers that focus on static concepts or styles, this trainer is designed to teach the model how to perform specific *transformations* or maintain *identity consistency* across image-to-image edits ([Black Forest Labs](https://bfl.ai/announcements/flux-1-kontext)). It utilizes a unique "start/end" image pair training methodology to learn the relationship between an original image and its edited counterpart based on text instructions ([fal.ai](https://fal.ai/models/fal-ai/flux-kontext-trainer/api)).

## When to use this model
- **Use when:** You need to train a model to perform a specific, consistent edit (e.g., "apply this specific character's face to any image" or "transform any object into a specific branded style").
- **Don't use when:** You just want to generate new images from text (use `fal-ai/flux-pro` or `fal-ai/flux-dev`). If you want to train a static style or person without the "editing" context, use `fal-ai/flux-lora-fast-training`.
- **Alternatives:** 
    - `fal-ai/flux-lora-fast-training`: Best for general styles/characters from static images ([fal.ai](https://fal.ai/models/fal-ai/flux-lora-fast-training)).
    - `fal-ai/flux-pro/kontext`: The pre-trained inference version for general-purpose editing ([fal.ai](https://fal.ai/models/fal-ai/flux-pro/kontext)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-kontext-trainer` (sync) / `https://queue.fal.run/fal-ai/flux-kontext-trainer` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_data_url` | `string` | *Required* | URL | A ZIP file containing pairs of images named `INDEX_start.EXT` and `INDEX_end.EXT` (e.g., `0001_start.jpg`, `0001_end.jpg`). |
| `steps` | `integer` | `1000` | 500 - 4000 | The number of training steps. More steps lead to stronger concept adherence but risk overfitting. |
| `learning_rate` | `float` | `0.0001` | 1e-6 - 1e-3 | Controls how much the weights are adjusted per step. Standard for LoRA is around `1e-4` ([Oxen.ai](https://ghost.oxen.ai/how-to-fine-tune-a-flux-1-dev-lora-with-code-step-by-step/)). |
| `default_caption` | `string` | *Required* | Text | The fallback instruction used if individual `.txt` files (e.g., `0001.txt`) are missing in the ZIP. |
| `output_lora_format` | `string` | `fal` | `fal`, `comfy` | Dictates the weight naming scheme for compatibility. |

### Output
The output is a JSON object containing the results of the training job:
- `diffusers_lora_file`: A `File` object containing the URL to the trained `.safetensors` LoRA weights.
- `config_file`: A `File` object containing the configuration needed to run inference with the LoRA.

### Example request
```json
{
  "image_data_url": "https://example.com/dataset.zip",
  "steps": 1000,
  "learning_rate": 0.0001,
  "default_caption": "Change the hair to broccoli haircut.",
  "output_lora_format": "fal"
}
```

### Pricing
- **Base Rate:** $2.50 per 1000-step training run ([fal.ai](https://fal.ai/models/fal-ai/flux-kontext-trainer)).
- **Scaling:** Cost scales linearly with steps ($0.0025 per step).
- **Minimum:** 500 steps ($1.25).

## API — via Original Source (BYO-key direct)
Black Forest Labs (BFL) is the primary creator of the FLUX architecture. While BFL offers inference APIs (e.g., `https://api.bfl.ai/v1/flux-pro-1.1-kontext`), they do not currently expose a public *training* API for Kontext on their official dashboard as a standalone service ([BFL Docs](https://docs.bfl.ai/kontext/kontext_overview)). FAL.ai acts as the primary managed service for training these LoRAs. For local training, BFL provides a reference implementation on GitHub ([Hugging Face](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)).

## Prompting best practices
1. **Establish the Reference:** Explicitly name the subject from the "start" image (e.g., "The woman with short black hair...").
2. **Specify the Change:** Use clear action verbs (e.g., "...now wearing a space suit").
3. **Preserve Identity:** Explicitly tell the model what *not* to change (e.g., "...while maintaining her exact facial features and the background composition").
4. **Use Quotes for Text:** If editing text, use the format `Replace 'old text' with 'new text'` ([BFL Prompt Guide](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)).
5. **Direct Verbs:** "Transform" implies a heavy rework; "Change" or "Modify" are better for subtle tweaks ([Replicate Blog](https://replicate.com/blog/flux-kontext)).

## Parameter tuning guide
- **Steps:** 1000 steps is the sweet spot for most datasets ([fal.ai](https://fal.ai/models/fal-ai/flux-lora-fast-training)). If the edit isn't showing up, increase to 2000. If the image starts looking "fried" (high-contrast artifacts), decrease steps.
- **Learning Rate:** Stick to `0.0001` (`1e-4`). Going higher (e.g., `2e-4`) can speed up learning but makes training unstable. Lowering it (e.g., `5e-5`) helps with subtle style nuances ([Modal Blog](https://modal.com/blog/fine-tuning-flux-style-lora)).
- **Default Caption:** This is your "trigger instruction." Make sure it matches the intent of the training data precisely.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Dataset ZIP`: URL to the zipped image pairs.
  - `Steps`: Number of training iterations.
  - `Learning Rate`: Training sensitivity.
  - `Instruction`: Default text prompt describing the edit.
- **Outputs:**
  - `LoRA Model`: The trained weights for use in inference nodes.
  - `Config`: Metadata for the model.
- **Chain-friendly with:** 
  - `fal-ai/flux-pro/kontext`: Use your trained LoRA as an adapter on this model for high-quality inference.
  - `fal-ai/flux-lora`: Standard node for applying LoRAs during generation.

## Notes & gotchas
- **Dataset Structure:** Crucial. If images aren't named `_start` and `_end` correctly, training will likely fail or learn nothing ([fal.ai](https://fal.ai/models/fal-ai/flux-kontext-trainer/api)).
- **Commercial Use:** The `FLUX.1 Kontext [dev]` model itself has a non-commercial license; commercial use requires explicit licensing from Black Forest Labs ([BFL Docs](https://docs.bfl.ai/kontext/kontext_overview)).
- **Safety:** FAL.ai applies safety filters to both input and output images. Violative datasets will be blocked.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/flux-kontext-trainer)
- [FAL.ai API Documentation](https://fal.ai/models/fal-ai/flux-kontext-trainer/api)
- [Black Forest Labs Official Documentation](https://docs.bfl.ai/kontext/kontext_overview)
- [BFL Prompting Guide for Kontext](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- [Hugging Face Model Card](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)
