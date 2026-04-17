---
name: fal-ai/bytedance/seedance/v1/pro/text-to-video
display_name: Seedance 1.0 Pro (Text-to-Video)
category: text-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video
original_source: https://docs.byteplus.com/en/docs/ModelArk/2291680
summary: High-fidelity text-to-video model from ByteDance with professional motion control and native multi-shot storytelling capabilities.
---

# Seedance 1.0 Pro (Text-to-Video)

## Overview
- **Slug:** `fal-ai/bytedance/seedance/v1/pro/text-to-video`
- **Category:** text-to-video
- **Creator:** [ByteDance](https://seed.bytedance.com/en/)
- **Best for:** Cinematic multi-shot video generation with complex character motion and professional camera control.
- **FAL docs:** [fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video](https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video)
- **Original source:** [BytePlus Ark Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## What it does
Seedance 1.0 Pro is an advanced video foundation model developed by ByteDance (the creators of TikTok/Douyin) designed for high-fidelity video synthesis. It excels at maintaining character consistency and spatial coherence across complex action sequences. Key strengths include its native support for **multi-shot storytelling** (generating distinct cuts within a single prompt) and its ability to follow precise filmmaking terminology for camera movements ([arXiv](https://arxiv.org/abs/2506.09113)).

## When to use this model
- **Use when:** You need professional-grade motion (walking, dancing, complex manual tasks) or cinematic sequences that require multiple camera angles in one generation.
- **Don't use when:** You need instant results (use Seedance 1.0 Lite or Fast versions instead) or when real-time interactivity is required.
- **Alternatives:** 
    - **Luma Dream Machine:** Better for surreal transitions but sometimes less controllable.
    - **Kling 2.5/3.0:** Stronger at hyper-realistic human physics but may vary in prompt adherence for specific camera keywords ([fal.ai](https://fal.ai/models)).
    - **Sora (OpenAI):** High quality but often less accessible via BYO-key APIs compared to Seedance ([BytePlus](https://docs.byteplus.com)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedance/v1/pro/text-to-video` (sync) / `https://queue.fal.run/fal-ai/bytedance/seedance/v1/pro/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The text prompt describing the scene, subject, action, and style. |
| `aspect_ratio` | enum | `16:9` | `21:9, 16:9, 4:3, 1:1, 3:4, 9:16` | The aspect ratio of the generated video. |
| `resolution` | enum | `1080p` | `480p, 720p, 1080p` | Output quality. 480p is faster for drafting; 1080p is best for final production. |
| `duration` | enum | `5` | `2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12` | Video length in seconds. |
| `camera_fixed` | boolean | `false` | `true, false` | If true, locks the camera position so only the subject moves. |
| `seed` | integer | `-1` | -1 to 2^32 | Controls randomness. Use the same seed to reproduce results. |
| `enable_safety_checker` | boolean | `true` | `true, false` | Filters for sensitive or non-compliant content. |
| `num_frames` | integer | `null` | N/A | Overrides duration if specified. |

### Output
The API returns a JSON object containing a `video` object with the hosted URL and a `seed`.
```json
{
  "video": {
    "url": "https://fal.run/storage/v1/files/...",
    "content_type": "video/mp4",
    "file_name": "generated_video.mp4",
    "file_size": 123456
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "Professional chef in white uniform chopping vegetables with smooth rhythmic movements, static medium shot, modern commercial kitchen, warm overhead lighting, photorealistic style.",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "duration": 5
}
```

### Pricing
FAL.ai bills Seedance 1.0 Pro based on video tokens (resolution × FPS × duration).
- **Estimated Cost:** ~$0.62 per 1080p 5-second video.
- **Rate:** $2.50 per 1 million video tokens ([fal.ai](https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video)).

## API — via Original Source (BYO-key direct)
ByteDance provides direct access via the **BytePlus Ark** platform. This native API offers advanced features not always exposed in wrapper services.
- **Endpoint:** `https://ark.ap-southeast.bytepluses.com/api/v3`
- **Model ID:** `dreamina-seedance-2-0-260128` (latest)
- **Extra Features:**
    - **Multimodal Reference:** Input Image + Video + Audio to inherit specific styles or lip-sync.
    - **Video Extension/Editing:** Native "Inpainting" to change specific objects in a video.
    - **Audio Gen:** Option to generate synchronized audio/background music simultaneously (`generate_audio: true`).
- **Auth:** Bearer Token via `ARK_API_KEY`.
- **Docs:** [BytePlus Ark Content Generation](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## Prompting best practices
- **The 6-Part Framework:** Structure prompts as: `[Subject] + [Motion] + [Environment] + [Camera] + [Lighting] + [Style]`.
- **Use "Shot Cut":** To generate multi-shot videos, use the keyword "shot cut" between descriptions. Example: "A man running on a beach. [Shot Cut] Close up of his feet hitting the sand."
- **Camera Verbs:** Use specific filmmaking terms: *Truck Left, Pan Right, Crane Up, Orbit, Dolly In*.
- **Temporal Markers:** Use "first," "then," "followed by" to sequence actions.
- **Example Good Prompt:** "Close-up shot of a vintage typewriter. The keys hit the paper rapidly, then the camera pulls back to reveal a writer in a dimly lit 1940s office with smoke swirling in the lamplight, noir aesthetic, 4k."

## Parameter tuning guide
- **Resolution:** Use **480p** for rapid iteration of movement and composition. Switch to **1080p** only once the motion is confirmed, as it consumes significantly more credits.
- **Camera Fixed:** Toggle this to **True** when you want to create "talking head" or "product showcase" videos where the background must remain absolutely static.
- **Duration:** Seedance excels at 5-8 second clips. For 10+ seconds, ensure the prompt describes enough action to fill the time, or the AI may "freeze" the motion towards the end.

## Node inputs/outputs
- **Inputs:**
    - `prompt`: Text (Main descriptive input).
    - `seed`: Number (For reproducibility).
    - `aspect_ratio`: Dropdown (Format control).
- **Outputs:**
    - `video_url`: URL (The generated file).
    - `seed`: Number (The actual seed used).
- **Chain-friendly with:**
    - **ElevenLabs:** Use for high-quality voiceovers for the generated footage.
    - **Flux 1.1 Pro:** Generate a high-quality reference image first, then use Seedance's Image-to-Video mode (if available in the node) for perfect character consistency.

## Notes & gotchas
- **Safety Filter:** Seedance has strict safety filters; prompts involving celebrities or sensitive political content may return a 422 error or a black video ([fal.ai](https://fal.ai/legal/terms-of-service)).
- **Bilingual:** The model natively understands both Chinese and English prompts.
- **Audio:** The standard FAL `text-to-video` slug does not generate audio; use a separate audio model or the BytePlus native API for synchronized sound.

## Sources
- [FAL.ai Model Card](https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/text-to-video)
- [BytePlus Ark Official Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)
- [Seedance 1.0 Technical Report (arXiv)](https://arxiv.org/abs/2506.09113)
- [VEED Prompting Guide](https://www.veed.io/learn/seedance-1-0-prompts)
