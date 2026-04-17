---
name: fal-ai/kling-video/v3/standard/text-to-video
display_name: Kling Video v3 Standard (Text-to-Video)
category: text-to-video
creator: Kuaishou (Kling AI)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video
original_source: https://klingai.com/document-api/apiReference/model/textToVideo
summary: A state-of-the-art text-to-video model by Kuaishou featuring cinematic quality, multi-shot storyboard control, and native audio-visual synchronization.
---

# Kling Video v3 Standard (Text-to-Video)

## Overview
- **Slug:** `fal-ai/kling-video/v3/standard/text-to-video`
- **Category:** Text-to-Video
- **Creator:** [Kuaishou (Kling AI)](https://klingai.com/)
- **Best for:** Cinematic, narrative-driven videos with synchronized audio and complex camera movements.
- **FAL docs:** [fal-ai/kling-video/v3/standard/text-to-video](https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video)
- **Original source:** [Kling AI Official API Documentation](https://klingai.com/document-api/apiReference/model/textToVideo)

## What it does
Kling Video v3 Standard is a premier text-to-video generation model capable of producing high-fidelity video clips up to 15 seconds long from natural language descriptions. It stands out by integrating a **3D spatio-temporal joint attention mechanism** for fluid, realistic motion and a **3D VAE** for crisp 720p/1080p visuals ([Maginative](https://www.maginative.com/article/kuaishou-unveils-kling-a-text-to-video-model-to-challenge-openais-sora/)). Key features include native audio generation (dialogue and SFX synced to the video), multi-shot storyboard control (up to 6 shots in one generation), and strong character/element consistency ([Kling AI](https://kling.ai/quickstart/klingai-video-3-model-user-guide)).

## When to use this model
- **Use when:** You need high-quality narrative content, commercials, or short films where character consistency and synchronized audio are critical.
- **Don't use when:** You need rapid, low-cost iterations (consider smaller/faster models like `bytedance/seedance-2.0`) or when strictly real-time generation is required.
- **Alternatives:** 
    - `fal-ai/kling-video/v2.6/standard/text-to-video`: Better for simpler prompts with fewer elements.
    - `fal-ai/luma-dream-machine`: High quality but different motion dynamics.
    - `fal-ai/veo3.1`: Google's top-tier competitor for cinematic text-to-video.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v3/standard/text-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | 0-2500 chars | The core text description. Required if `multi_prompt` is not used. |
| `duration` | enum | `5` | `3` to `15` | Total video length in seconds. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `1:1` | Output frame dimensions. |
| `generate_audio`| boolean | `true` | `true`, `false` | Enables native audio (voices, ambient sound). |
| `negative_prompt`| string | `""` | 0-2500 chars | Elements to exclude (e.g., "blurry", "watermark"). |
| `cfg_scale` | float | `0.5` | `0.0` to `1.0` | How strictly the model follows the prompt. |
| `shot_type` | enum | `customize`| `customize`, `intelligent` | Method for multi-shot generation. |
| `multi_prompt` | array | - | Up to 6 shots | List of `prompt` and `duration` objects for storyboarding. |

### Output
The output is a JSON object containing a `video` file object:
```json
{
  "video": {
    "url": "https://storage.googleapis.com/.../out.mp4",
    "content_type": "video/mp4",
    "file_name": "out.mp4",
    "file_size": 6797486
  }
}
```

### Example request
```json
{
  "prompt": "Cinematic wide shot of a futuristic neon city in the rain, hyper-realistic, 8k.",
  "duration": 5,
  "aspect_ratio": "16:9",
  "generate_audio": true,
  "cfg_scale": 0.5
}
```

### Pricing
Pricing is calculated based on generation time and features ([fal.ai](https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api)):
- **Standard (Audio Off):** ~$0.084 per second.
- **Standard (Audio On):** ~$0.126 per second.
- **Voice Control Enabled:** ~$0.154 per second.
*(Example: A 5s video with audio on costs ~$0.63)*.

## API — via Original Source (BYO-key direct)
The native Kling AI API offers more granular control than the FAL wrapper.
- **Endpoint:** `https://api.singapore.klingai.com/v1/videos/text2video`
- **Auth:** `Authorization: Bearer <API_KEY>`
- **Additional Parameters:**
    - `camera_control`: Granular controls for `horizontal`, `vertical`, `pan`, `tilt`, `roll`, and `zoom` (Value range: `[-10, 10]`).
    - `mode`: Allows switching between `std` (standard) and `pro` (professional/high-quality) within the same endpoint.
    - `watermark_info`: Toggle for including/excluding watermarks.
    - `external_task_id`: Pass-through ID for user tracking.
- **Docs:** [Kling AI Developer Documentation](https://klingai.com/document-api/apiReference/model/textToVideo)

## Prompting best practices
- **The 4-Part Formula:** Structure prompts as **[Subject] + [Action] + [Context] + [Style]**. For example: "A black-suited agent (Subject) slams his hand on a mahogany desk (Action) in a dimly lit interrogation room (Context), cinematic lighting, high tension (Style)" ([VEED.io](https://www.veed.io/learn/kling-ai-prompting-guide)).
- **Cinematic Intent:** Use director-level keywords like "tracking shot", "POV", "macro close-up", or "low-angle reveal". The model is optimized for filmmaking terminology ([fal.ai Blog](https://blog.fal.ai/kling-3-0-prompting-guide/)).
- **Audio Anchoring:** When using audio, use character labels in brackets: `[Character A: Man]: "I can't believe it."`. Describe the action first, then the dialogue to ensure visual sync ([fal.ai Blog](https://blog.fal.ai/kling-3-0-prompting-guide/)).
- **Negative Prompting:** Do not use the words "no" or "not". Simply list the keywords to avoid: `blurry, distorted face, bad anatomy, text, watermark` ([Pollo AI](https://pollo.ai/hub/kling-ai-best-negative-prompts)).
- **Element Binding:** If continuing a scene, refer back to established elements precisely to maintain consistency (e.g., "<<<element_1>>>").

## Parameter tuning guide
- **CFG Scale:** Keep at `0.5` for the best balance. Higher values (up to `0.8`) increase prompt adherence but can introduce artifacts; lower values (below `0.4`) allow the model more creative freedom and often smoother motion.
- **Duration:** 5-10 seconds is the "sweet spot" for motion consistency. 15-second clips are possible but may drift in complex scenes.
- **Multi-shot Storyboarding:** Use `customize` shot type for total control over pacing. Each shot should be at least 1-2 seconds long for the model to establish movement.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Text
    - `Negative Prompt`: Text
    - `Duration`: Number
    - `Aspect Ratio`: Dropdown
    - `Audio Toggle`: Boolean
    - `CFG Scale`: Number (0-1)
- **Outputs:**
    - `Video`: URL
    - `Audio`: URL (embedded in MP4)
- **Chain-friendly with:**
    - `fal-ai/kling-video/v3/standard/image-to-video`: To continue a generated video from a final frame.
    - `fal-ai/kling-video/v3/standard/motion-control`: To apply specific trajectories to subjects.
    - `fal-ai/kling-video/v3/standard/video-effects`: For post-generation stylization (e.g., "squish", "jelly press").

## Notes & gotchas
- **Billing:** You are charged per second of *requested* duration, not just generated video.
- **Language:** While multi-language is supported (Chinese, English, Spanish, etc.), use lowercase for standard English speech and uppercase only for acronyms to help the TTS engine ([fal.ai](https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api)).
- **Character Limit:** Individual shot prompts are limited to 512 characters, while the main prompt can be 2500 characters.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api)
- [Official Kling AI Documentation](https://klingai.com/document-api/apiReference/model/textToVideo)
- [Kling 3.0 Model User Guide](https://kling.ai/quickstart/klingai-video-3-model-user-guide)
- [fal.ai Blog - Kling 3.0 Prompting](https://blog.fal.ai/kling-3-0-prompting-guide/)
- [VEED.io Prompting Guide](https://www.veed.io/learn/kling-ai-prompting-guide)
- [Maginative - Kling Technical Report](https://www.maginative.com/article/kuaishou-unveils-kling-a-text-to-video-model-to-challenge-openais-sora/)
