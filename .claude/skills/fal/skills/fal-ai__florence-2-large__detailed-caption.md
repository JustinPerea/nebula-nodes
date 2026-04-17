---
name: fal-ai/florence-2-large/detailed-caption
display_name: Florence-2 Large | Detailed Caption
category: vision
creator: Microsoft
fal_docs: https://fal.ai/models/fal-ai/florence-2-large/detailed-caption
original_source: https://huggingface.co/microsoft/Florence-2-large
summary: An advanced vision foundation model from Microsoft optimized for generating comprehensive, detailed descriptions of images.
---

# Florence-2 Large | Detailed Caption

## Overview
- **Slug:** `fal-ai/florence-2-large/detailed-caption`
- **Category:** Vision / Image-to-Text
- **Creator:** [Microsoft](https://huggingface.co/microsoft)
- **Best for:** Generating highly detailed, descriptive captions for images to be used in accessibility, asset tagging, or as prompts for generative AI.
- **FAL docs:** [fal-ai/florence-2-large/detailed-caption](https://fal.ai/models/fal-ai/florence-2-large/detailed-caption)
- **Original source:** [Microsoft Florence-2-large on HuggingFace](https://huggingface.co/microsoft/Florence-2-large)

## What it does
Florence-2 is a unified vision foundation model that uses a prompt-based approach to handle various vision tasks. This specific FAL.ai implementation is pre-configured for the **Detailed Caption** task. It takes an image URL as input and returns a rich, descriptive text string that covers the primary subjects, background elements, lighting, and composition of the image.

## When to use this model
- **Use when:** You need more than just a one-sentence summary; you require a "rich" description that captures nuances in a scene.
- **Use when:** You are building a "reverse-prompting" workflow for Stable Diffusion or Flux.
- **Don't use when:** You need object detection (bounding boxes) or segmentation—use the specific Florence-2 task-specific endpoints on FAL for those.
- **Alternatives:** 
    - `fal-ai/florence-2-large/more-detailed-caption`: For even more exhaustive, granular detail.
    - `fal-ai/florence-2-large/caption`: For brief, one-sentence summaries.
    - `fal-ai/qwen-image`: A competitive multimodal VLM.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/florence-2-large/detailed-caption` (sync) / `https://queue.fal.run/fal-ai/florence-2-large/detailed-caption` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (Required) | Valid URL | The URL of the image to be processed. Supports jpg, jpeg, png, webp, gif, avif. |

### Output
The output is a JSON object containing the model's textual analysis.
```json
{
  "results": "string"
}
```

### Example request
```json
{
  "image_url": "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/transformers/tasks/car.jpg"
}
```

### Pricing
FAL.ai bills this model based on compute time. According to the [FAL model page](https://fal.ai/models/fal-ai/florence-2-large/detailed-caption), the cost is approximately **$0 per compute second** (often effectively free or fractional cents due to the model's high efficiency and small footprint of 0.77B parameters).

## API — via Original Source (BYO-key direct)
FAL.ai is the primary API surface for this model. Microsoft provides the weights and architecture open-source on [HuggingFace](https://huggingface.co/microsoft/Florence-2-large), but does not maintain a direct, public "Bring Your Own Key" API endpoint. Users wishing to run this natively must host it via `transformers` on their own GPU infrastructure.

## Prompting best practices
Since this FAL endpoint is pre-configured for detailed captions, you do not provide a text prompt. To get the best results:
1. **Image Quality:** Ensure the image is clear and well-lit. High-resolution images allow the model to see smaller details.
2. **Focus:** If the image is cluttered, the model will attempt to describe everything; use cropped images if you want a detailed caption of a specific subject.
3. **Aspect Ratios:** The model is robust but performs best on standard aspect ratios (1:1, 4:3, 16:9).

## Parameter tuning guide
This specific endpoint is simplified and does not expose internal model parameters like `num_beams` or `max_new_tokens`. It is designed for "plug-and-play" captioning.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image URL` (string): The source image.
- **Outputs:**
    - `Caption` (string): The detailed textual description.
- **Chain-friendly with:**
    - `fal-ai/flux/dev`: Feed the caption into Flux to generate variations of the original image.
    - `fal-ai/flux-lora-fast-training`: Use captions as the "trigger text" or metadata for training new LoRAs.
    - `LLM Nodes`: Pass the caption to an LLM to generate SEO tags or alt-text.

## Notes & gotchas
- **Max File Size:** While not strictly limited by the API schema, very large files may timeout during the download phase.
- **Task Specificity:** This endpoint *only* does detailed captioning. If you need OCR or Object Detection, you must switch to a different FAL Florence-2 model slug.
- **Base vs Large:** This uses the "Large" (0.77B) version of Florence-2, which is significantly more accurate than the "Base" (0.23B) version.

## Sources
- [FAL.ai Florence-2 Detailed Caption Documentation](https://fal.ai/models/fal-ai/florence-2-large/detailed-caption)
- [Microsoft Florence-2 HuggingFace Collection](https://huggingface.co/collections/microsoft/florence-6669f44df0d87d9c3bfb76de)
- [HuggingFace Transformers Florence-2 Documentation](https://huggingface.co/docs/transformers/model_doc/florence2)