---
name: fal-ai/flux-lora-portrait-trainer
display_name: Train Flux LoRAs For Portraits
category: training
creator: Black Forest Labs / fal.ai R&D
fal_docs: https://fal.ai/models/fal-ai/flux-lora-portrait-trainer/api
original_source: https://bfl.ml/
summary: A specialized FLUX LoRA training model optimized for high-fidelity portraits with vivid highlights and intricate facial details.
---

# Train Flux LoRAs For Portraits (fal-ai/flux-lora-portrait-trainer)

## Overview
- **Slug:** `fal-ai/flux-lora-portrait-trainer`
- **Category:** Training (Text-to-Image / LoRA)
- **Creator:** [Black Forest Labs](https://bfl.ml/) (Base Architecture) / [fal.ai](https://fal.ai/) (Optimized Training Pipeline)
- **Best for:** Creating highly photorealistic LoRA adapters for human portraits with professional lighting and high resemblance.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/flux-lora-portrait-trainer/api)
- **Original source:** [Black Forest Labs Official Site](https://bfl.ml/)

## What it does
The **FLUX Portrait Trainer** is a specialized fine-tuning pipeline designed to create Low-Rank Adaptation (LoRA) models on top of the FLUX.1 architecture. Unlike general-purpose trainers, this model is specifically tuned for human faces, focusing on capturing intricate details like skin texture, individual hair strands, and vivid highlights in the eyes ([fal.ai Blog](https://blog.fal.ai/introducing-the-flux-portrait-trainer/)). It leverages multi-resolution training to maintain resemblance even for smaller faces in a scene and provides superior prompt following for complex facial modifications ([fal.ai Blog](https://blog.fal.ai/introducing-the-flux-portrait-trainer/)).

## When to use this model
- **Use when:** You need to train a model on a specific person's face for consistent character generation, professional headshots, or stylized portraits with high fidelity.
- **Don't use when:** You are training for general styles (e.g., "watercolor painting"), objects, or environments where human facial resemblance is not the priority. For those, use the [FLUX LoRA Fast Training](https://fal.ai/models/fal-ai/flux-lora-fast-training) model.
- **Alternatives:** 
    - **fal-ai/flux-lora-fast-training:** Better for general style or object training; faster and cheaper but less optimized for facial likeness.
    - **fal-ai/flux-pro-trainer:** Offers more control for professional-grade, high-step training on larger datasets.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-lora-portrait-trainer` (Synchronous) / `https://queue.fal.run/fal-ai/flux-lora-portrait-trainer` (Asynchronous/Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `images_data_url` | string | *Required* | URL | A zip archive containing 10-20 high-quality portrait images. Can include text files for captions with the same filename as images. |
| `trigger_phrase` | string | `null` | String | A unique keyword (e.g., "SKS") to associate with the subject. If captions use `[trigger]`, this replaces it. |
| `learning_rate` | float | `0.00009` | 1e-6 to 1e-3 | Controls how much the model weights are adjusted. Lower rates are more stable; higher rates learn faster but risk artifacts. |
| `steps` | integer | `2500` | 1000 - 5000 | Number of training iterations. More steps usually increase resemblance but increase cost and risk overfitting. |
| `multiresolution_training` | boolean | `true` | true/false | Enables training on various resolutions, improving resemblance for faces at different distances. |
| `subject_crop` | boolean | `true` | true/false | Automatically crops images to focus on the subject's face/body during training. |
| `data_archive_format` | string | `null` | "zip", "tar" | The archive format of the dataset. Usually inferred from the URL. |
| `resume_from_checkpoint` | string | `""` | URL | URL to a previously trained checkpoint to continue training. |
| `create_masks` | boolean | `false` | true/false | Automatically generates segmentation masks for the subject to focus training on the person rather than the background. |

### Output
The API returns a JSON object containing the trained weights and metadata:
- **`diffusers_lora_file`**: An object containing the `url` to the `.safetensors` LoRA file, `content_type`, `file_name`, and `file_size`.
- **`config_file`**: An object containing the `url` to a JSON file describing the training parameters used.

### Example request
```json
{
  "images_data_url": "https://example.com/my_portraits.zip",
  "trigger_phrase": "sks person",
  "steps": 2500,
  "learning_rate": 0.00009,
  "multiresolution_training": true
}
```

### Pricing
The model is billed per training step:
- **Rate:** Approximately **$0.0024** per step ([fal.ai Playground](https://fal.ai/models/fal-ai/flux-lora-portrait-trainer/playground)).
- **Minimum:** A minimum of **1000 steps** is billed per run (approx. **$2.40** minimum).
- **Average Run:** A standard 2500-step run costs roughly **$6.00**.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary API surface for this specific optimized pipeline. While the underlying **FLUX.1-dev** model is created by Black Forest Labs, they do not offer a "Portrait Trainer" API directly. Users looking to run this locally can use tools like [ai-toolkit](https://github.com/ostris/ai-toolkit) or [ComfyUI Flux Trainer](https://github.com/kiand/comfyui-flux-trainer), though they will lack the specific multi-resolution and "bright highlights" optimizations proprietary to FAL.

## Prompting best practices
- **Use the Trigger Word:** Always include your `trigger_phrase` in the generation prompt (e.g., "A professional headshot of [trigger]").
- **Describe the Lighting:** The model excels at "bright highlights." Prompts like "dramatic studio lighting," "golden hour glow," or "soft rim lighting" yield exceptional results.
- **Detailed Face Prompts:** Since the model is optimized for details, use modifiers like "highly detailed eyes," "visible skin pores," and "individual eyelashes" to push the fidelity.
- **Negative Prompts (if using a UI):** Avoid generic negatives; instead, focus on preventing common LoRA artifacts like "oversaturation" or "cartoonish skin."
- **Example Good Prompt:** `"A high-fidelity 8k portrait of sks person in a dark suit, cinematic lighting, sharp focus on eyes with bright highlights, urban background blur."`

## Parameter tuning guide
1.  **Steps (1500-3000):** For most portraits, 2000-2500 steps provide the best balance of resemblance and flexibility. If the subject looks "baked" or unnatural, reduce steps.
2.  **Learning Rate (0.00007 - 0.0001):** If the model fails to learn the likeness after 2500 steps, slightly increase the learning rate. If the model produces artifacts, decrease it.
3.  **Subject Crop (Always On):** Keep `subject_crop: true` for portraits to ensure the model focuses on facial features rather than clothing or background details.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Dataset URL` (Zip file link)
    - `Trigger Phrase` (Text)
    - `Steps` (Number)
    - `Learning Rate` (Float)
    - `Enable Multi-Res` (Boolean)
- **Outputs:**
    - `LoRA Weights` (File/Link to .safetensors)
    - `Config JSON` (File/Link)
- **Chain-friendly with:**
    - `fal-ai/flux-lora`: Use the output of this trainer as a LoRA input for high-quality image generation.
    - `fal-ai/flux-pro`: For high-resolution base generation.
    - `fal-ai/face-to-face`: For further refinement of facial expressions.

## Notes & gotchas
- **Resemblance vs. Quality:** Over-training (too many steps) can make the face look identical to source photos but lose the ability to change clothes, poses, or lighting in prompts.
- **Dataset Diversity:** Use at least 10-15 images with varying backgrounds and lighting to ensure the model learns the *face*, not the *photo environment*.
- **Training Time:** Expect 15-30 minutes for a standard training run ([AI Superhero Blog](https://shmulc.substack.com/p/become-your-own-ai-superhero)).

## Sources
- [FAL.ai Portrait Trainer API](https://fal.ai/models/fal-ai/flux-lora-portrait-trainer/api)
- [Introducing the FLUX Portrait Trainer (fal.ai Blog)](https://blog.fal.ai/introducing-the-flux-portrait-trainer/)
- [Black Forest Labs FLUX Documentation](https://docs.bfl.ml/)
- [Eachlabs flux-lora-portrait-trainer Reference](https://www.eachlabs.ai/black-forest-labs/flux-lora/flux-lora-portrait-trainer)