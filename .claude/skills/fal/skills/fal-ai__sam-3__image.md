---
name: fal-ai/sam-3/image
display_name: SAM 3 (Segment Anything Model 3)
category: vision
creator: Meta AI
fal_docs: https://fal.ai/models/fal-ai/sam-3/image
original_source: https://github.com/facebookresearch/sam3, https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/
summary: Meta's unified foundation model for open-vocabulary object detection, segmentation, and tracking across images and videos.
---

# SAM 3 (Segment Anything Model 3)

## Overview
- **Slug:** `fal-ai/sam-3/image`
- **Category:** Image Segmentation / Object Detection
- **Creator:** [Meta AI Research](https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/)
- **Best for:** Precise, open-vocabulary object isolation and multi-instance segmentation using natural language or visual examples.
- **FAL docs:** [fal.ai/models/fal-ai/sam-3/image](https://fal.ai/models/fal-ai/sam-3/image)
- **Original source:** [GitHub - facebookresearch/sam3](https://github.com/facebookresearch/sam3)

## What it does
SAM 3 (Segment Anything Model 3) is Meta's third-generation vision foundation model that unifies object detection, segmentation, and tracking into a single architecture. Unlike its predecessors, SAM 3 introduces **Promptable Concept Segmentation (PCS)**, allowing users to segment all instances of a specific concept (e.g., "all yellow school buses") using short text phrases or visual exemplar images. It effectively bridges the gap between geometric segmentation (SAM 1/2) and semantic understanding, functioning as a "universal scissors" that understands what it is cutting.

## When to use this model
- **Use when:** You need to isolate specific objects from an image for editing, product photography, or automated annotation; when you want to find "all instances" of an object using a text description rather than clicking each one; or when you need high-precision masks for complex scenes.
- **Don't use when:** You need full-scene panoptic segmentation without specific prompts (though it can be used as a backbone, it excels at prompt-driven tasks); or when you are working with extremely low-resolution images where semantic features are lost.
- **Alternatives:** 
    - **SAM 2 (`fal-ai/sam2`):** Better if you only need click-based segmentation without text support and want slightly lower latency for simple tasks.
    - **Flux.1 Fill / Inpainting models:** Better if your goal is to *replace* the object rather than just extract it.
    - **Tripo3D / Rodin:** Use these if you need to convert the segmented image into a 3D mesh (SAM 3D variants are related but focus on reconstruction).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sam-3/image` (Synchronous) / `https://queue.fal.run/fal-ai/sam-3/image` (Asynchronous/Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | *Required* | URL | The URL of the image to be segmented. Supports JPEG, PNG, WebP, GIF, AVIF. |
| `prompt` | `string` | `""` | Noun phrases | Natural language text prompt (e.g., "wheel", "red car", "striped cat"). |
| `point_prompts` | `list` | `[]` | List of `{x, y, label, object_id}` | Manual points for interactive refinement. Label 1 for foreground, 0 for background. |
| `box_prompts` | `list` | `[]` | List of `{x_min, y_min, x_max, y_max, object_id}` | Bounding box coordinates to guide segmentation. |
| `apply_mask` | `boolean` | `true` | `true, false` | If true, returns the original image with the mask overlayed. |
| `sync_mode` | `boolean` | `false` | `true, false` | If true, media is returned as a data URI for real-time applications. |
| `output_format` | `string` | `"png"` | `jpeg, png, webp` | The file format for the generated masks/images. |
| `return_multiple_masks` | `boolean` | `false` | `true, false` | Whether to return individual masks for each detected instance. |
| `max_masks` | `integer` | `3` | `1 - 32` | Maximum number of masks to return when `return_multiple_masks` is enabled. |
| `include_scores` | `boolean` | `false` | `true, false` | Whether to include confidence scores in the metadata. |
| `include_boxes` | `boolean` | `false` | `true, false` | Whether to include bounding boxes for each mask in the metadata. |

### Output
The output is a JSON object containing:
- `image`: An [Image Object] (URL, width, height) representing the primary segmented mask or overlay.
- `masks`: A list of [Image Objects] for each segmented instance.
- `metadata`: A list of `MaskMetadata` including `index`, `score`, and `box` (normalized `[cx, cy, w, h]`).
- `scores`: (Optional) Flat list of confidence scores.
- `boxes`: (Optional) Flat list of normalized bounding boxes.

### Example request
```json
{
  "image_url": "https://example.com/photo.jpg",
  "prompt": "yellow school bus",
  "apply_mask": true,
  "return_multiple_masks": true,
  "max_masks": 10,
  "include_scores": true
}
```

### Pricing
- **Cost:** $0.005 per request.
- **Value:** 200 requests per $1.00.

## API — via Original Source (BYO-key direct)
Meta AI releases SAM 3 as an open-source project. There is no direct "Meta API" for public pay-per-use consumption.
- **Official Repo:** [facebookresearch/sam3](https://github.com/facebookresearch/sam3)
- **Deployment:** Users can host the model themselves on AWS, GCP, or local H200/A100 GPUs using the provided inference code.
- **Inference Speed:** Approximately 30ms per image on an H200 GPU for 100+ objects.

## Prompting best practices
- **Use Simple Noun Phrases:** SAM 3 is optimized for atomic visual concepts like "striped cat" or "blue backpack." Avoid complex reasoning like "the car that is parked near the tree."
- **Use Exemplars for Rare Objects:** If an object is hard to describe with text, provide a `box_prompt` or a reference image (Exemplar Prompting) to show the model exactly what to look for.
- **Negative Clicks for Refinement:** Use `point_prompts` with `label: 0` to exclude unwanted background areas that the model might mistakenly include.
- **Combine Text and Visuals:** Use a text prompt to find all instances (e.g., "windows") and then use a box prompt to focus the model's attention on a specific area if needed.
- **Avoid Ambiguity:** Instead of "tool," use "hammer" or "wrench" to get more specific segmentation masks.

## Parameter tuning guide
- **`max_masks`:** If your image contains many small objects (e.g., a crowd of people), increase this toward 32. Keep it low (3-5) for simple subjects to reduce output payload.
- **`apply_mask`:** Set to `false` if you only need the alpha channel/binary mask for further processing in a node-like workflow (e.g., passing to an Inpainting node).
- **`include_scores`:** Essential for automated workflows; use the score to filter out "hallucinated" masks with low confidence (e.g., < 0.5).
- **`output_format`:** Use `webp` for web-based apps to save bandwidth or `png` if you need lossless masks for high-end design work.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image` (File/URL)
    - `Text Prompt` (String)
    - `Visual Prompts` (Points/Boxes array)
    - `Configuration` (JSON for max_masks, apply_mask, etc.)
- **Outputs:**
    - `Segmented Image` (The overlay)
    - `Mask List` (Array of isolated PNGs)
    - `Metadata` (JSON containing boxes and confidence scores)
- **Chain-friendly with:**
    - **Flux.1 [dev] / [schnell] (via Inpainting):** Pass the generated mask to an inpainting node to remove or replace objects.
    - **Tripo3D:** Pass the isolated object image to generate a 3D model.
    - **Llama 3.2 Vision:** Use Llama to generate the "Noun Phrase" prompts for SAM 3 based on complex user instructions (the "SAM 3 Agent" workflow).

## Notes & gotchas
- **Text Constraints:** While SAM 3 is open-vocabulary, it is not a "reasoning" model. It performs best with visual descriptions (color, shape, category) rather than functional descriptions ("something to sit on").
- **Commercial Use:** Meta permits broad commercial use, but check the [official license](https://github.com/facebookresearch/sam3/blob/main/LICENSE) for restrictions regarding military or hazardous applications.
- **Video vs. Image:** The `fal-ai/sam-3/image` endpoint is optimized for single-frame processing. For temporal tracking across a video file, use the dedicated video-centric endpoints if available.

## Sources
- [FAL.ai SAM 3 Model Page](https://fal.ai/models/fal-ai/sam-3/image)
- [Meta AI Research: SAM 3 - Segment Anything with Concepts](https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/)
- [SAM 3 Technical Report (arXiv:2511.16719)](https://arxiv.org/abs/2511.16719)
- [Meta AI Blog Post](https://ai.meta.com/blog/segment-anything-model-3/)
