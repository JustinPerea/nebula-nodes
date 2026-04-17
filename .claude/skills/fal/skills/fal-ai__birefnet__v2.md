---
name: fal-ai/birefnet/v2
display_name: BiRefNet v2
category: image-to-image
creator: Zheng Peng et al. (Nankai University)
fal_docs: https://fal.ai/models/fal-ai/birefnet/v2
original_source: https://github.com/ZhengPeng7/BiRefNet
summary: A high-resolution background removal model using bilateral reference for pixel-perfect edge segmentation.
---

# BiRefNet v2

## Overview
- **Slug:** `fal-ai/birefnet/v2`
- **Category:** Image-to-Image / Background Removal
- **Creator:** [Zheng Peng et al. (Nankai University)](https://github.com/ZhengPeng7/BiRefNet)
- **Best for:** High-precision background removal and image matting for production-grade assets.
- **FAL docs:** [fal.ai/models/fal-ai/birefnet/v2](https://fal.ai/models/fal-ai/birefnet/v2)
- **Original source:** [GitHub - ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet)

## What it does
BiRefNet (Bilateral Reference Network) is a state-of-the-art model designed for **Dichotomous Image Segmentation (DIS)**. Unlike traditional segmentation models that use a single-pass approach, BiRefNet employs a **bilateral reference framework** that simultaneously analyzes global context and local fine details. This allows it to extract subjects with extreme precision, handling challenging elements like loose hair strands, semi-transparent fabrics, and complex object boundaries that standard background removers often blur or clip ([Research Paper](https://arxiv.org/abs/2403.04610)).

## When to use this model
- **Use when:** You need professional-grade transparency for e-commerce, portrait photography, or graphic design assets. It is particularly effective for high-resolution images (up to 2K+).
- **Don't use when:** You need real-time performance on mobile devices (it is compute-intensive) or when simple bounding-box-level segmentation is sufficient.
- **Alternatives:** 
    - **[fal-ai/modnet](https://fal.ai/models/fal-ai/modnet):** A faster, more lightweight matting model, but less accurate on complex edges.
    - **[fal-ai/sam-3](https://fal.ai/models/fal-ai/sam-3):** Best for general object segmentation and prompt-based selection (Segment Anything), but BiRefNet is more specialized for clean background removal.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/birefnet/v2` (Sync) / `https://queue.fal.run/fal-ai/birefnet/v2` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | — | Required | URL of the image to remove background from. Supports jpg, png, webp, gif, avif. |
| `model` | `enum` | `General Use (Light)` | See below | Specifies the model variant for specialized tasks. |
| `operating_resolution` | `enum` | `1024x1024` | `1024x1024`, `2048x2048`, `2304x2304` | The resolution for internal processing. Higher resolutions improve accuracy for high-res inputs. |
| `refine_foreground` | `boolean` | `true` | `true`, `false` | Whether to apply a refinement pass on the foreground using the estimated mask. |
| `output_mask` | `boolean` | `false` | `true`, `false` | If true, returns the alpha mask as a separate image in the response. |
| `mask_only` | `boolean` | `false` | `true`, `false` | If true, returns only the black-and-white mask. Skips foreground refinement for speed. |
| `output_format` | `enum` | `png` | `webp`, `png`, `gif` | Format of the resulting image. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If true, returns media as data URIs (base64) instead of hosted URLs. |

**Model Enum Values:**
- `General Use (Light)`: Standard BiRefNet (best for general speed/accuracy).
- `General Use (Light 2K)`: Optimized for 2K resolution (BiRefNet_lite-2K).
- `General Use (Heavy)`: Most accurate but slower variant (BiRefNet_lite).
- `Matting`: Specifically trained for fine-edge matting (BiRefNet-matting).
- `Portrait`: Optimized for human subjects (BiRefNet-portrait).
- `General Use (Dynamic)`: Dynamic resolution support (BiRefNet_dynamic).

### Output
The output is a JSON object containing the processed image and optionally the mask.
```json
{
  "image": {
    "url": "https://fal.run/output/...",
    "width": 1024,
    "height": 1024,
    "content_type": "image/png"
  },
  "mask_image": {
    "url": "https://fal.run/output/...",
    "width": 1024,
    "height": 1024,
    "content_type": "image/png"
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/product.jpg",
  "model": "General Use (Heavy)",
  "operating_resolution": "2048x2048",
  "refine_foreground": true,
  "output_mask": true
}
```

### Pricing
FAL.ai bills this model based on **compute time**.
- **Rate:** Approximately `$0.0003 to $0.0005 per compute second` (varies by GPU instance, e.g., A100 vs H100).
- Typical background removal for a 1MP image takes ~100ms-500ms, resulting in very low costs per call (under $0.001) ([fal.ai Pricing](https://fal.ai/pricing)).

## API — via Original Source (BYO-key direct)
FAL.ai is the primary commercial API surface. The original creator provides model weights and code for self-hosting but does not offer a standalone commercial API service.
- **Weights:** [Hugging Face Model Hub](https://huggingface.co/ZhengPeng7/BiRefNet)
- **Deployment:** Users can deploy their own instance via Hugging Face Inference Endpoints or local Python/ONNX environments.
- **Direct API:** No separate direct API exists outside of self-hosted Gradio/FastAPI wrappers.

## Prompting best practices
Since BiRefNet is an image-to-image segmentation model, "prompting" refers to the quality of the input image:
- **High Contrast:** Ensure the subject is distinct from the background. While BiRefNet is SOTA for complex scenes, high contrast yields the cleanest edges.
- **Lighting:** Even lighting on the subject helps the model distinguish foreground textures (like hair) from background shadows.
- **Resolution Match:** Set `operating_resolution` to match or exceed your input image's resolution for maximum detail retention.
- **Avoid Busy Backgrounds:** While the "Heavy" model handles complexity well, extremely cluttered backgrounds with similar textures to the foreground may cause minor artifacts.

## Parameter tuning guide
- **Model Selection:** Use `Portrait` for humans and `Matting` for objects with intricate edges (cages, hair, mesh). Use `Heavy` for low-contrast images where the subject blends into the background.
- **Operating Resolution:** **1024x1024** is the sweet spot for speed. Switch to **2048x2048** only for production assets where high-frequency edge detail (like individual hairs) is critical.
- **Refine Foreground:** Always keep this `true` unless you are doing a rapid batch process where edge softness is acceptable. It significantly cleans up the transition between the subject and the alpha channel.
- **Mask Only:** Use this for custom compositing workflows where you want to apply the mask yourself in tools like Photoshop or specialized node shaders.

## Node inputs/outputs
- **Inputs:**
    - `image_url` (File/URL)
    - `model` (Selection)
    - `operating_resolution` (Selection)
    - `refine_foreground` (Boolean)
- **Outputs:**
    - `image` (Processed Image with Alpha)
    - `mask_image` (Alpha Mask)
- **Chain-friendly with:**
    - **[fal-ai/flux/dev](https://fal.ai/models/fal-ai/flux/dev):** Generate an image, then use BiRefNet to extract the subject for a collage.
    - **[fal-ai/flux-lora](https://fal.ai/models/fal-ai/flux-lora-fast-training):** Prepare training datasets by automatically removing backgrounds from subject photos.

## Notes & gotchas
- **File Types:** While it supports GIFs, it typically processes them as static frames or returns a single image unless used with a specialized video endpoint.
- **Rate Limits:** standard FAL.ai rate limits apply based on your tier.
- **Commercial Use:** The weights are released under a permissive license (commercial use allowed), and FAL's endpoint is fully licensed for commercial applications.

## Sources
- [FAL.ai BiRefNet v2 Documentation](https://fal.ai/models/fal-ai/birefnet/v2/api)
- [BiRefNet GitHub Repository](https://github.com/ZhengPeng7/BiRefNet)
- [ArXiv: Bilateral Reference for High-Resolution Dichotomous Image Segmentation](https://arxiv.org/abs/2403.04610)
- [Hugging Face Model Card](https://huggingface.co/ZhengPeng7/BiRefNet)
