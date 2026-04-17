---
name: fal-ai/flux-pulid
display_name: PuLID Flux (fal-ai/flux-pulid)
category: image-to-image
creator: Yanze Wu (PuLID) / Black Forest Labs (FLUX.1) GitHub
fal_docs: https://fal.ai/models/fal-ai/flux-pulid
original_source: https://github.com/ToTheBeginning/PuLID/blob/main/docs/pulid_for_flux.md
summary: A tuning-free identity-preserving image generation model that applies a reference face to FLUX.1-dev outputs with high fidelity.
---

# PuLID Flux (fal-ai/flux-pulid)

## Overview
- **Slug:** `fal-ai/flux-pulid`
- **Category:** Image-to-Image / Identity Customization
- **Creator:** [Yanze Wu (PuLID)](https://github.com/ToTheBeginning/PuLID) / [Black Forest Labs (FLUX.1)](https://blackforestlabs.ai/)
- **Best for:** Photorealistic portrait generation with consistent identity from a single reference image without training.
- **FAL docs:** [fal.ai/models/fal-ai/flux-pulid](https://fal.ai/models/fal-ai/flux-pulid)
- **Original source:** [PuLID GitHub](https://github.com/ToTheBeginning/PuLID/blob/main/docs/pulid_for_flux.md)

## What it does
PuLID Flux (Pure and Lightning ID) is a state-of-the-art, tuning-free identity customization solution specifically adapted for the **FLUX.1-dev** model. It allows users to provide a single reference image of a person and generate new images of that person in various scenes, styles, and poses while maintaining high facial similarity ("ID fidelity"). Unlike LoRA training, which takes minutes, PuLID works instantly via inference. It uses a Transformer-based ID encoder and cross-attention blocks to inject facial features into the FLUX.1 DIT (Diffusion Transformer) blocks.

## When to use this model
- **Use when:** You need to place a specific person into a generated scene with high realism; you want to maintain character consistency across multiple generations without training a LoRA; you require fast, on-the-fly face-swapping with prompt control.
- **Don't use when:** You need non-human character consistency (it is trained on human faces); you are looking for absolute perfect likeness for complex accessories (glasses/tattoos sometimes lose detail); you need commercial rights for the base model (FLUX.1-dev is non-commercial).
- **Alternatives:** 
    - `fal-ai/flux-lora-fast-training`: Better for absolute perfect likeness if you have 10-20 photos and 5 minutes to train.
    - `fal-ai/face-swap`: Simpler 1:1 face replacement but offers less "integration" into the scene lighting and style compared to PuLID.
    - `fal-ai/flux/dev`: If identity doesn't matter and you just want general high-quality image generation.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pulid` (sync) / `https://queue.fal.run/fal-ai/flux-pulid` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | The text prompt describing the scene/action for the generated image. |
| `reference_image_url` | string | (Required) | - | URL of the reference image containing the face to be preserved. |
| `image_size` | string/obj | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Preset sizes or `{"width": X, "height": Y}`. |
| `num_inference_steps` | integer | `20` | 1-50 | Number of denoising steps. Higher = more detail but slower. |
| `guidance_scale` | float | `4.0` | 1.0-20.0 | Classifier-Free Guidance (CFG) scale for prompt adherence. |
| `seed` | integer | (Random) | - | For reproducible results. |
| `negative_prompt` | string | `""` | - | Concepts to exclude from the image. |
| `id_weight` | float | `1.0` | 0.0-2.0 | Strength of the identity preservation effect. |
| `start_step` | integer | `0` | 0 - `num_inference_steps` | Step to start inserting the ID features. Later steps preserve more of the original model's behavior. |
| `true_cfg` | float | `1.0` | 0.0-2.0 | Weight of the "True CFG" loss (specific to FLUX distilled models). |
| `max_sequence_length` | integer | `256` | `128`, `256`, `512` | Max length for the text prompt encoding. |
| `enable_safety_checker`| boolean | `true` | - | Filters NSFW content if enabled. |

### Output
The output is a JSON object containing a list of generated images and metadata:
```json
{
  "images": [
    {
      "url": "https://fal.run/...",
      "width": 1024,
      "height": 768,
      "content_type": "image/jpeg"
    }
  ],
  "timings": { "inference": 4.5 },
  "seed": 12345,
  "has_nsfw_concepts": [false],
  "prompt": "..."
}
```

### Example request
```json
{
  "prompt": "a professional headshot of a woman in a business suit, soft studio lighting",
  "reference_image_url": "https://example.com/my_face.jpg",
  "image_size": "portrait_4_3",
  "num_inference_steps": 28,
  "id_weight": 1.2
}
```

### Pricing
Billed per Megapixel (MP). 
- **Rate:** Approximately **$0.0333 per MP** ([FAL.ai source](https://fal.ai/models/fal-ai/flux-pulid)).
- Example: A standard 1024x1024 (1MP) image costs roughly **$0.033**.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary managed API provider for PuLID Flux. While the code is open-source, there is no single "Official PuLID Cloud API" with a separate key system besides community providers like FAL or Replicate. Developers can host their own instance using the [PuLID GitHub repository](https://github.com/ToTheBeginning/PuLID).
- **Native Auth:** N/A (Self-hosted or managed)
- **Repo:** [ToTheBeginning/PuLID](https://github.com/ToTheBeginning/PuLID)

## Prompting best practices
- **Focus on the Scene:** Since the identity is handled by the reference image, your prompt should focus heavily on the environment, lighting, and clothing (e.g., "sitting in a neon-lit cyberpunk cafe").
- **ID-Friendly Keywords:** Use descriptive terms for the person that match the reference loosely to help the model (e.g., "a man with short hair" if the reference has short hair) to avoid contradictory features.
- **Style Overriding:** PuLID Flux is excellent at "style transfer." You can prompt for "oil painting" or "3D render," and it will adapt the face to that style while keeping features recognizable.
- **Failure Mode — Masking:** If the reference image has a hand covering the face or heavy sunglasses, the model may struggle or replicate those artifacts. Use "clean" face photos.
- **Bad Prompt:** "A person." (Too vague, may result in generic output).
- **Good Prompt:** "A cinematic portrait of the person, high-resolution photography, soft bokeh background, wearing a vintage leather jacket."

## Parameter tuning guide
- **id_weight (0.8 - 1.2):** The "sweet spot." Set to 1.0 by default. If the face doesn't look like the person enough, bump to 1.2. If the face looks "fried" or artifacted, drop to 0.8.
- **num_inference_steps (20-30):** FLUX.1-dev works well at 20 steps. For PuLID, 28 steps often provide the best balance of facial detail and speed.
- **start_step (0-4):** Controls when the identity injection begins. Setting it to 0 (default) provides the strongest likeness. Increasing it to 4 can help if the identity is "overpowering" the prompt's requested style.
- **guidance_scale (3.5 - 5.0):** For photorealism, stick to 3.5. For more "stylized" or prompt-adherent images, use 5.0.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text): The scene description.
    - `Reference Image` (Image/URL): The source face.
    - `ID Weight` (Float): Similarity strength.
    - `Steps` (Int): Quality/Speed tradeoff.
- **Outputs:**
    - `Generated Image` (Image URL): The final result.
- **Chain-friendly with:**
    - `fal-ai/flux-upscaler`: Chain after PuLID for high-resolution 4K portraits.
    - `fal-ai/face-to-sticker`: Use the PuLID output as a base to create consistent character stickers.

## Notes & gotchas
- **Model Version:** FAL typically uses the latest stable PuLID-FLUX (v0.9.1 as of late 2024), which improved similarity over v0.9.0.
- **License:** Uses FLUX.1-dev as the base, which is **Non-Commercial**. Check your specific use case.
- **Aspect Ratio:** Performance is best at standard ratios (1:1, 4:3, 16:9). Extremely long/thin aspect ratios may cause face distortions.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/flux-pulid)
- [PuLID Official GitHub & Technical Docs](https://github.com/ToTheBeginning/PuLID/blob/main/docs/pulid_for_flux.md)
- [PuLID ArXiv Paper](https://arxiv.org/abs/2404.16022)
- [FAL.ai Pricing API](https://fal.ai/pricing)