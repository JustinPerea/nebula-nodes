---
name: fal-ai/wan/v2.2-14b/animate/replace
display_name: Wan-2.2 Animate Replace (14B)
category: video-to-video
creator: Alibaba Cloud (Tongyi Lab)
fal_docs: https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace
original_source: https://huggingface.co/Wan-AI/Wan2.2-Animate-14B, https://www.alibabacloud.com/help/en/model-studio/use-video-generation
summary: Unified AI model for character replacement in existing videos with high motion fidelity and temporal consistency.
---

# Wan-2.2 Animate Replace (14B)

## Overview
- **Slug:** `fal-ai/wan/v2.2-14b/animate/replace`
- **Category:** Video-to-Video / Character Animation
- **Creator:** [Alibaba Cloud (Tongyi Lab)](https://www.alibabacloud.com/)
- **Best for:** Seamlessly replacing a person or character in an existing video with a new identity from a static image while preserving the original motion, lighting, and environment.
- **FAL docs:** [fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace)
- **Original source:** [Hugging Face Model Card](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B), [Alibaba Cloud DashScope](https://www.alibabacloud.com/help/en/model-studio/use-video-generation)

## What it does
Wan-2.2 Animate Replace is a specialized 14-billion parameter video-to-video model designed for high-fidelity character substitution. Unlike basic face-swapping, this model replaces the entire subject (body, clothing, and features) within a source clip. It leverages a Mixture-of-Experts (MoE) architecture to achieve professional-grade results, ensuring that the new character follows the reference motion perfectly while automatically matching the original scene's lighting, shadows, and color tones for seamless integration.

## When to use this model
- **Use when:**
    - You need to swap a performer in a video with a virtual idol, 3D character, or different person.
    - You want to change a character's outfit or "skin" while keeping their dance or action identical.
    - Professional-grade film post-production or high-end social media content creation.
- **Don't use when:**
    - You want to generate a video from scratch (use [Wan-2.2 T2V](https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video) instead).
    - You only have a text prompt and no reference video.
- **Alternatives:**
    - **Wan-2.2 Animate Move:** For animating a static image based on motion from a video but generating a *new* background (Animation mode).
    - **LivePortrait:** Better for fast, lightweight facial animation/talking heads, but lacks full-body replacement.
    - **Kling 2.5 Turbo:** High-quality general I2V, but lacks specific character-replacement "anchor" logic.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/wan/v2.2-14b/animate/replace` (sync) / `https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | `string` | *(Required)* | URL | The source video containing the motion you want to keep. |
| `image_url` | `string` | *(Required)* | URL | The reference image of the character you want to insert. |
| `guidance_scale` | `float` | `1.0` | 1.0 - 20.0 | Classifier-free guidance scale. Higher values increase prompt/image adherence but may lower quality. |
| `resolution` | `enum` | `"480p"` | `"480p"`, `"580p"`, `"720p"` | Resolution of the generated video. |
| `num_inference_steps` | `integer` | `20` | 1 - 50 | Number of sampling steps. Higher values improve quality but increase latency/cost. |
| `seed` | `integer` | `null` | Any integer | Random seed for reproducibility. |
| `shift` | `float` | `5.0` | 1.0 - 10.0 | Shift value for the video denoising schedule. |
| `video_quality` | `enum` | `"high"` | `"low"`, `"medium"`, `"high"`, `"maximum"` | Output encoding quality level. |
| `video_write_mode` | `enum` | `"balanced"` | `"fast"`, `"balanced"`, `"small"` | Speed vs. file size optimization for the output MP4. |
| `enable_safety_checker` | `boolean` | `true` | `true`, `false` | Whether to check input data for safety. |
| `enable_output_safety_checker` | `boolean` | `true` | `true`, `false` | Whether to check generated output for safety. |
| `return_frames_zip` | `boolean` | `false` | `true`, `false` | If true, returns a ZIP of per-frame lossless images. |

### Output
The API returns a JSON object containing:
- `video`: An object with the `url` to the generated MP4 file.
- `prompt`: The auto-generated text prompt used internally by the model.
- `seed`: The seed used for the generation.
- `frames_zip`: (Optional) URL to the ZIP file of frames if requested.

### Example request
```json
{
  "video_url": "https://example.com/source_motion.mp4",
  "image_url": "https://example.com/new_character.jpg",
  "resolution": "720p",
  "num_inference_steps": 30,
  "guidance_scale": 5.0
}
```

### Pricing
FAL.ai bills this model based on **video seconds** calculated at 16 frames per second:
- **720p:** $0.08 per video second
- **580p:** $0.06 per video second
- **480p:** $0.04 per video second

*Note: Total billed seconds = (Total Frames / 16). For example, a 5-second video at 30 fps (150 frames) is billed as 9.375 "video seconds".*

## API — via Original Source (BYO-key direct)
The model is hosted on Alibaba's **DashScope** platform (Model Studio).
- **Endpoint:** `https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/generation`
- **Auth:** `Authorization: Bearer <DASHSCOPE_API_KEY>`
- **Direct API Advantages:** May support longer durations or higher batching; native integration with Alibaba OSS.
- **Official Docs:** [Alibaba Cloud Model Studio Docs](https://www.alibabacloud.com/help/en/model-studio/use-video-generation)

## Prompting best practices
- **Describe the Subject:** Even though an image is provided, a short text prompt describing the new character (e.g., "a futuristic silver robot") helps the model maintain consistency.
- **Describe the Action:** Reinforce the motion in the video (e.g., "performing a breakdance") to ensure the model focuses on temporal alignment.
- **Lighting Keywords:** Use tokens like "cinematic lighting," "natural shadows," or "rim lighting" to help the model blend the character better.
- **Failure Mode:** If the character "flickers," try increasing the `num_inference_steps` to 30+.
- **Bad Prompt:** "Change him." (Too vague).
- **Good Prompt:** "A detailed 3D stylized character with blue hair, wearing a white hoodie, performing a slow walk, cinematic lighting, 8k resolution."

## Parameter tuning guide
- **Resolution:** Always test with `480p` first to save cost before committing to a `720p` final render.
- **Guidance Scale:** Keep between `1.0` and `5.0` for photorealistic results. Pushing to `10.0+` is useful for highly stylized or non-human characters (e.g., turning a person into a cartoon).
- **Shift:** This affects the motion "weight." A value of `5.0` is the default; lower values can result in more static outputs, while higher values may cause motion artifacts.
- **Steps:** `20` is usually sufficient for a quick preview. For production quality, `30-40` steps provide significantly better character consistency.

## Node inputs/outputs
- **Inputs:**
    - `Source Video` (URL/File)
    - `New Character Image` (URL/File)
    - `Resolution` (Select)
    - `Sampling Steps` (Integer)
- **Outputs:**
    - `Generated Video` (URL)
    - `Lossless Frames` (ZIP URL)
- **Chain-friendly with:**
    - **Remove Background:** Use to clean the source video before replacement.
    - **ElevenLabs Video Dubbing:** To add voice to the newly animated character.
    - **Topaz AI / Magnific:** To upscale the 720p output to 4K.

## Notes & gotchas
- **Character Count:** This model works best with a single prominent character. Multiple people in a scene may cause identity leakage or failed replacement.
- **Occlusion:** If the character goes behind an object in the source video, the model might struggle to re-generate the occluded parts realistically.
- **Commercial Use:** This model is released under the **Apache 2.0** license, making it very friendly for commercial applications.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace)
- [Wan-AI Hugging Face Repository](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B)
- [Alibaba Cloud Official Technical Blog](https://www.alibabacloud.com/blog/wan2-2-s2v-ai-video-generation-from-static-images-on-alibaba-cloud_602508)
- [FAL.ai Pricing Documentation](https://fal.ai/pricing)