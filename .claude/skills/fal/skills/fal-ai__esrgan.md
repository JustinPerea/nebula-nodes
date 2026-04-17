---
name: fal-ai/esrgan
display_name: Real-ESRGAN (Upscale Images)
category: image-to-image
creator: Xintao Wang (Tencent ARC Lab)
fal_docs: https://fal.ai/models/fal-ai/esrgan
original_source: https://github.com/xinntao/Real-ESRGAN
summary: A practical and powerful image restoration model designed to upscale images by simulating complex real-world degradations.
---

# Real-ESRGAN (Upscale Images)

## Overview
- **Slug:** `fal-ai/esrgan`
- **Category:** Image-to-Image / Super-Resolution
- **Creator:** [Xintao Wang](https://github.com/xinntao) (Tencent ARC Lab)
- **Best for:** Restoring and upscaling low-quality, noisy, or low-resolution images to high-definition.
- **FAL docs:** [fal-ai/esrgan](https://fal.ai/models/fal-ai/esrgan)
- **Original source:** [GitHub Repository](https://github.com/xinntao/Real-ESRGAN), [arXiv Research Paper](https://arxiv.org/abs/2107.10833)

## What it does
Real-ESRGAN is a practical image restoration and super-resolution model that extends the original ESRGAN (Enhanced Super-Resolution Generative Adversarial Network) architecture. While traditional SR models often fail on real-world images with complex noise, Real-ESRGAN uses a "high-order degradation modeling process" to better simulate and reverse real-world artifacts ([arXiv](https://arxiv.org/abs/2107.10833)). It can upscale images by up to 8x, remove noise, and significantly improve clarity in textures and facial features.

## When to use this model
- **Use when:** 
  - You have low-resolution photos that need to be enlarged for printing or high-res displays.
  - You need to clean up compressed JPEGs with visible artifacts.
  - You want to enhance anime/illustrations (using the specialized anime weights).
  - You are upscaling portraits and want to preserve or restore facial details.
- **Don't use when:** 
  - You require artistic re-imagining (use a Diffusion-based "Creative Upscaler" instead).
  - The image is already extremely high resolution (super-resolution has diminishing returns on 4K+ sources).
- **Alternatives:** 
  - `fal-ai/aura-sr`: A newer high-resolution upscaler often better for photorealistic detail.
  - `fal-ai/creative-upscaler`: Uses Stable Diffusion to add new details rather than just restoring existing ones.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/esrgan` (Sync) / `https://queue.fal.run/fal-ai/esrgan` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | *Required* | URL | The URL of the image you want to upscale. |
| `scale` | float | `2` | `1` to `8` | The multiplication factor for the resolution. |
| `model` | string | `RealESRGAN_x4plus` | `RealESRGAN_x4plus`, `RealESRGAN_x2plus`, `RealESRGAN_x4plus_anime_6B`, `RealESRGAN_x4_v3`, `RealESRGAN_x4_wdn_v3`, `RealESRGAN_x4_anime_v3` | Selects the specific model weights for different image types. |
| `face` | boolean | `false` | `true`, `false` | Enables specialized face restoration (likely GFPGAN or similar) for portraits. |
| `tile` | integer | `0` | `0` to `1000` | Tile size. Use `200`-`400` if you encounter "out of GPU memory" errors. `0` means no tiling. |
| `output_format` | string | `png` | `png`, `jpeg` | The file format of the resulting image. |

### Output
The output is a JSON object containing the upscaled image metadata:
```json
{
  "image": {
    "url": "https://fal.run/storage/...",
    "width": 2048,
    "height": 2048,
    "content_type": "image/png",
    "file_size": 4404019,
    "file_name": "upscaled_image.png"
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/photo.jpg",
  "scale": 4,
  "model": "RealESRGAN_x4plus",
  "face": true,
  "output_format": "png"
}
```

### Pricing
- **Cost:** ~$0.00111 per compute second ([FAL.ai Docs](https://fal.ai/models/fal-ai/esrgan/llms.txt)).
- A typical 4x upscale on a 512px image takes roughly 1-3 seconds, costing less than $0.005.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary hosted API service for this model. As an open-source research project, there is no official commercial "SaaS" API provided by the creators. Users can, however, self-host the model using the [official GitHub source code](https://github.com/xinntao/Real-ESRGAN).

## Prompting best practices
Real-ESRGAN is a non-generative restoration model and does not accept text prompts. Performance is entirely dependent on parameter selection and input quality:
- **Portrait Quality:** Always set `face: true` for any image containing a human face to avoid the "uncanny valley" or blurry skin textures.
- **Anime vs. Photo:** Use the `anime` model variants specifically for illustrations; the general `x4plus` model can cause unwanted realistic-texture artifacts on flat anime colors.
- **Denoising:** If your source image has heavy JPEG compression artifacts, use the `wdn` (Wide Denoising) variant to smooth out blockiness.
- **Input Aspect Ratio:** Ensure your input image is cropped correctly before upscaling; the model maintains the exact aspect ratio of the input.

## Parameter tuning guide
- **`scale` (Sweet Spot: 2.0 - 4.0):** While the model supports up to 8x, upscaling a tiny 128px image to 8x often produces "hallucinated" textures. 4x is generally the best balance of quality and fidelity.
- **`model`: `RealESRGAN_x4_v3`:** This is often faster than the `plus` version and works exceptionally well for general-purpose restoration with less "painterly" artifacting.
- **`tile` (The "Safe" Parameter):** If your request fails with a "CUDA Out of Memory" error (common when upscaling already large images to 4x/8x), set `tile` to `400`. This splits the image into smaller chunks for processing.

## Node inputs/outputs
- **Inputs:**
  - `Image`: The source image port.
  - `Scale`: Number input (1.0 to 8.0).
  - `Restore Faces`: Boolean toggle.
  - `Model Selector`: Dropdown of the enum values (Anime, General, Denoise).
- **Outputs:**
  - `Upscaled Image`: Image URL/File output.
- **Chain-friendly with:**
  - `fal-ai/flux/schnell`: Use Real-ESRGAN as a second step to upscale the 1024px output of Flux to 4K.
  - `fal-ai/remove-background`: Remove the background first, then upscale the subject for high-quality assets.
  - `fal-ai/face-swap`: Upscale the final result of a face swap to smooth out the blended edges.

## Notes & gotchas
- **Max Resolution:** Be cautious when trying to produce images over 8000px on either side; even with tiling, you may hit platform timeouts.
- **Transparency:** The model handles PNG transparency reasonably well, but some model variants may flatten the alpha channel to black or white.
- **Processing Time:** High `scale` values and `face: true` significantly increase the computation time per request.

## Sources
- [FAL.ai ESRGAN Documentation](https://fal.ai/models/fal-ai/esrgan/api)
- [Real-ESRGAN GitHub Repo](https://github.com/xinntao/Real-ESRGAN)
- [Real-ESRGAN: Training Real-World Blind Super-Resolution with Pure Synthetic Data (arXiv)](https://arxiv.org/abs/2107.10833)
- [FAL.ai Pricing Reference](https://fal.ai/models/fal-ai/esrgan/llms.txt)