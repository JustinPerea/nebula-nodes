---
name: fal-ai/kling-video/v3/standard/image-to-video
display_name: Kling Video v3 Standard (Image-to-Video)
category: image-to-video
creator: Kling AI (Kuaishou)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video
original_source: https://klingai.com/
summary: A top-tier image-to-video model with cinematic visuals, fluid motion, native audio generation, and custom element support.
---

# Kling Video v3 Standard (Image-to-Video)

## Overview
- **Slug:** `fal-ai/kling-video/v3/standard/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [Kling AI (Kuaishou)](https://klingai.com/)
- **Best for:** Cinematic video generation from a static image with high motion consistency and native synchronized audio.
- **FAL docs:** [fal-ai/kling-video/v3/standard/image-to-video](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video)
- **Original source:** [Kling AI Official Website](https://klingai.com/)

## What it does
Kling Video v3 Standard is the latest generation of image-to-video technology, designed to transform static images into high-quality, cinematic videos. It excels in maintaining visual consistency from the source image while introducing fluid, realistic motion. A standout feature is its **native audio generation**, which creates soundscapes and voices synchronized with the video content without requiring external audio models.

## When to use this model
- **Use when:** You have a high-quality character or scene image and want to bring it to life with professional-grade cinematography, or when you need a video with matching ambient sound or dialogue.
- **Don't use when:** You need ultra-fast, low-cost generation (consider older versions like v1.6) or when you require very long durations beyond 15 seconds in a single shot.
- **Alternatives:** 
  - **[Kling v3 Pro](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video):** Higher quality and resolution, but more expensive.
  - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Excellent for physics but may have different aesthetic properties.
  - **[Runway Gen-3 Alpha](https://fal.ai/models/fal-ai/runway-gen3):** Strong competitor for cinematic control.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v3/standard/image-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `start_image_url` | `string` | *Required* | Valid image URL | The source image to be animated into a video. |
| `prompt` | `string` | `null` | Max 2500 chars | Describes the desired motion, lighting, and cinematic style. |
| `multi_prompt` | `list` | `null` | - | List of prompts for multi-shot video generation (storyboarding). |
| `duration` | `enum` | `5` | `3, 4, 5, ..., 15` | The duration of the generated video in seconds. |
| `generate_audio` | `boolean` | `true` | `true, false` | Whether to generate native audio (ambient or voice) for the video. |
| `end_image_url` | `string` | `null` | Valid image URL | Optional image to guide the final frame of the video. |
| `elements` | `list` | `[]` | - | Characters or objects to include for consistency (using image sets). |
| `shot_type` | `string` | `""` | - | Required if `multi_prompt` is used to define transition logic. |
| `negative_prompt` | `string` | `""` | - | Things to avoid in the generation (e.g., "blur, watermark"). |
| `cfg_scale` | `float` | `0.5` | `0.0 - 1.0` | Guidance scale; how closely to follow the text prompt. |

### Output
The output is a JSON object containing a `video` field.
```json
{
  "video": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "kling_v3.mp4",
    "file_size": 3149129
  }
}
```

### Example request
```json
{
  "prompt": "The camera slowly pans across the landscape as the wind gently ruffles the character's hair. Cinematic lighting, 4k, hyper-realistic.",
  "start_image_url": "https://example.com/character_portrait.jpg",
  "duration": 5,
  "generate_audio": true,
  "cfg_scale": 0.5
}
```

### Pricing
FAL.ai bills this model based on the output duration:
- **Audio Off:** $0.084 per second.
- **Audio On:** $0.126 per second.
- **Voice Control Add-on:** $0.154 per second (when using specific voice IDs).
*For a standard 5-second video with audio, the estimated cost is **$0.63**.*

## API — via Original Source (BYO-key direct)
Kling AI provides a native API platform for enterprise and developer use.
- **Endpoint:** `https://api.klingai.com/v1/video/image-to-video`
- **Auth Method:** Access Key and Secret Key based authentication.
- **Additional Features:** The native API sometimes offers "Ultra" mode (60fps) and longer batch processing that might not be fully exposed on aggregators.
- **Official Docs:** [Kling AI API Documentation](https://klingai.com/document-api/quickStart/userManual)

## Prompting best practices
- **Cinematic Keywords:** Use specific camera movements like "Dolly zoom," "Slow pan," or "Low angle" to guide the DiT architecture.
- **Lighting & Atmosphere:** Describe lighting in detail ("Golden hour," "Volumetric fog," "Rim lighting") as v3 is highly responsive to atmospheric cues.
- **Motion Verbs:** Use active verbs like "Swaying," "Exploding," "Flowing" rather than static descriptions.
- **Avoid Over-Prompting:** Since the start image provides the structure, the prompt should focus on *what changes* rather than describing the scene from scratch.
- **Bad Prompt:** "A video of a woman standing." (Too vague, leads to generic motion).
- **Good Prompt:** "Subtle facial expression changes, woman smiles gently as the background bokeh shifts slightly. 35mm film style."

## Parameter tuning guide
- **CFG Scale (0.5):** Unlike image models, video models often use lower CFG values. Keep it around 0.5 for the best balance of motion and prompt adherence. Increase to 0.7+ only if the model is ignoring specific stylistic requests.
- **Duration (5-10s):** For high-action scenes, shorter durations (5s) often yield more stable physics. Longer durations (10-15s) are best for slow-moving, atmospheric shots.
- **End Image:** If the video feels aimless, provide an `end_image_url` to force a specific narrative arc between the two frames.

## Node inputs/outputs
- **Inputs:**
  - `start_image`: The primary visual reference.
  - `motion_prompt`: Text describing the action.
  - `audio_toggle`: Boolean to enable/disable sound.
- **Outputs:**
  - `video_url`: The link to the generated MP4.
  - `metadata`: Duration, resolution, and file size information.
- **Chain-friendly with:**
  - **[Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** To generate the initial high-quality start image.
  - **[Remove Background](https://fal.ai/models/fal-ai/modnet):** To clean up assets before animating.
  - **[Upscaler](https://fal.ai/models/fal-ai/aura-sr):** To bring the 1080p output to 4K.

## Notes & gotchas
- **Safety Filters:** Kling has a very strict content policy; prompts involving celebrities or suggestive content will be blocked at the API level.
- **Aspect Ratio:** The aspect ratio is typically inherited from the `start_image_url`. Ensure your input image matches your desired output (16:9, 9:16, or 1:1).
- **Watermarking:** Requests via FAL.ai are generally unwatermarked for commercial use, but check your specific billing tier.

## Sources
- [FAL.ai Kling v3 Documentation](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video)
- [Kling AI Official API Reference](https://klingai.com/document-api/quickStart/userManual)
- [Technical Report (Kling-Foley)](https://arxiv.org/abs/2506.19774)
