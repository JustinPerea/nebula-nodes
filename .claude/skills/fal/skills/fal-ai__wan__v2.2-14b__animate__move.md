---
name: fal-ai/wan/v2.2-14b/animate/move
display_name: Wan-2.2 Animate Move (14B)
category: image-to-video
creator: Alibaba (Tongyi Lab)
fal_docs: https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/move
original_source: https://github.com/Wan-Video/Wan2.1, https://huggingface.co/Wan-AI/Wan2.2-Animate-14B
summary: A high-fidelity character animation model by Alibaba that replicates expressions and movements from reference videos onto static images using a Mixture-of-Experts architecture.
---

# Wan-2.2 Animate Move (14B)

## Overview
- **Slug:** `fal-ai/wan/v2.2-14b/animate/move`
- **Category:** Image-to-Video / Character Animation
- **Creator:** Alibaba (Tongyi Lab)
- **Best for:** Animating static characters with precise facial expressions and body movements from a reference video.
- **FAL docs:** [fal.ai/models/fal-ai/wan/v2.2-14b/animate/move](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/move)
- **Original source:** [Hugging Face (Wan-AI)](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B) | [GitHub (Wan-Video)](https://github.com/Wan-Video/Wan2.1)

## What it does
Wan-Animate is a cutting-edge video foundation model that specializes in **unified character animation and replacement**. The "Animate Move" variant allows users to take a single character image and a driving reference video to generate a high-fidelity animation where the character precisely replicates the performer'\''s movements and facial expressions. It utilizes a **Mixture-of-Experts (MoE)** architecture (27B total parameters, 14B active per step) to balance high capacity with inference efficiency, significantly outperforming competitors like Runway Act-two in motion complexity and identity stability.

## When to use this model
- **Use when:** You need to animate a static character (avatar, product mascot, or real person) using a specific performance as a guide.
- **Use when:** You want to maintain high identity consistency throughout a clip (avoiding "facial drift").
- **Don'\''t use when:** You need generic text-to-video generation without a reference performer.
- **Don'\''t use when:** The input subject is heavily occluded or the motion is extremely abstract/non-human.
- **Alternatives:** 
    - `fal-ai/wan/v2.2-14b/animate/replace`: Similar but focused on swapping a character inside an existing video environment.
    - `fal-ai/kling-video/v1.5/gen-video`: A high-quality general I2V model, but lacks explicit performance-driving from a reference video.
    - `fal-ai/luma-dream-machine`: Excellent for cinematic I2V but less focused on precise character "puppets."

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/wan/v2.2-14b/animate/move` (sync) / `https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/move` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | string | (required) | URI | URL of the input reference video containing the motion to replicate. |
| `image_url` | string | (required) | URI | URL of the static character image to be animated. |
| `guidance_scale` | float | `1` | 1.0 - 20.0 | Classifier-free guidance scale. Higher values increase prompt adherence but may lower quality. |
| `resolution` | string | `480p` | `480p`, `580p`, `720p` | Resolution of the generated video. |
| `seed` | integer | random | 0 - 2^32 | Random seed for reproducibility. |
| `num_inference_steps`| integer | `20` | 1 - 50 | Number of sampling steps. Higher is slower but potentially higher quality. |
| `enable_safety_checker` | boolean | `true` | true/false | If true, checks input data for safety. |
| `enable_output_safety_checker` | boolean | `false` | true/false | If true, checks generated video for safety. |
| `shift` | float | `5` | 1.0 - 10.0 | Temporal shift value. Adjusts the "speed" or timing of the generated frames. |
| `video_quality` | string | `high` | `low`, `medium`, `high`, `maximum` | Overall visual quality vs file size trade-off. |
| `video_write_mode` | string | `balanced` | `fast`, `balanced`, `small` | Optimizes for speed, file size, or a balance of both. |
| `return_frames_zip` | boolean | `false` | true/false | If true, returns a ZIP of individual frames. |
| `use_turbo` | boolean | `true` | true/false | Applies quality enhancement for faster generation. |

### Output
The output returns a JSON object containing the generated video file, the auto-generated prompt used by the model, and the seed.
```json
{
  "video": {
    "url": "https://v3b.fal.media/...",
    "content_type": "video/mp4"
  },
  "prompt": "The character in the image is performing a dance...",
  "seed": 1416721728
}
```

### Pricing
Billed per "video second" at a rate of 16 frames per second:
- **720p:** $0.08 / second
- **580p:** $0.06 / second
- **480p:** $0.04 / second

## API — via Original Source (BYO-key direct)
Alibaba offers this model via their **DashScope** (Alibaba Cloud) platform. 
- **Endpoint:** `https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis` (Note: specific sub-endpoints for Wan-Animate exist in DashScope SDKs).
- **Direct Access:** Users can access the 14B and 5B versions via DashScope with an API Key.
- **Parameters:** The native API supports additional low-level control over frame rate and specific Mixture-of-Experts routing parameters (High-Noise vs Low-Noise эксперт thresholds) not fully exposed in the simplified FAL interface.
- **Official Docs:** [Alibaba Cloud DashScope Documentation](https://help.aliyun.com/product/2711612.html)

## Prompting best practices
- **Over-specify the Scene:** Since Wan uses an MoE architecture, it can "improvise" cinematic details if the prompt is vague. Use 80-120 words to describe the background, lighting, and camera behavior.
- **Use Action Intensity Keywords:** To get faster or more aggressive motion, include words like `"intense"`, `"fast movement"`, `"rocketing"`, or `"dynamic"`.
- **Camera Language:** The model responds exceptionally well to technical camera terms. Use `"static camera"`, `"slow zoom out"`, `"tracking shot"`, or `"eye-level medium shot"`.
- **Match Framing:** For the best results, ensure your input character image and the reference video have similar framing (e.g., both are headshots or both are full-body).
- **Identity Consistency:** If the face drifts, add `"portrait focus"`, `"locked facial features"`, or `"consistent identity"` to the prompt.

## Parameter tuning guide
- **Shift (1.0 - 10.0):** The sweet spot is **5.0**. Increasing this to 8.0+ can help with faster, more exaggerated motion, while 3.0 or lower is better for subtle, slow-burn expressions.
- **Guidance Scale (1.0 - 6.0):** For most character animations, a lower scale like **1.0 to 3.0** is recommended to maintain realistic textures. Higher scales (7+) can cause over-saturation and "crunchy" artifacts.
- **Steps (20 - 30):** 20 steps is sufficient for most "Turbo" runs. Go up to **40-50** only if you disable `use_turbo` for maximum fidelity.
- **Resolution:** 720p is the recommended standard for cinematic output. Use 480p for rapid prototyping or "previz."

## Node inputs/outputs
- **Inputs:**
    - `image`: The character to be animated.
    - `video`: The motion source (performer).
    - `prompt` (optional): Additional text to guide style/lighting.
- **Outputs:**
    - `video`: The final MP4 animation.
    - `frames_zip` (optional): For frame-by-frame post-processing.
- **Chain-friendly with:**
    - `fal-ai/flux-pro/v1.1`: Generate the initial character image.
    - `fal-ai/foley-audio`: Generate synchronized sound effects for the resulting movement.
    - `fal-ai/face-swap`: For secondary identity refinement if the character has extreme features.

## Notes & gotchas
- **Temporal Stability:** While Wan 2.2 is excellent, extremely fast head turns or subject occlusions in the reference video can still cause identity glitches.
- **Commercial Use:** The model is released under **Apache 2.0**, meaning it is free for commercial use both via API and if you run the weights locally.
- **Aspect Ratio:** The model typically resizes the character image to match the reference video. It is best to crop your character image to the same aspect ratio as your reference video before uploading.

## Sources
- [FAL.ai Model Docs](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/move/api)
- [Wan-AI Hugging Face](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B)
- [Alibaba Tongyi Lab News](https://comfyui-wiki.com/en/news/2025-09-19-wan22-animate)
- [Technical Paper: Wan-Animate](https://arxiv.org/abs/2509.14055)