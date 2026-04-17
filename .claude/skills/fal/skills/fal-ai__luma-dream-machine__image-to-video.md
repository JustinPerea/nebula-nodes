---
name: fal-ai/luma-dream-machine/image-to-video
display_name: Luma Dream Machine (Image to Video)
category: image-to-video
creator: Luma AI
fal_docs: https://fal.ai/models/fal-ai/luma-dream-machine/image-to-video
original_source: https://lumalabs.ai/dream-machine, https://docs.lumalabs.ai/docs/api
summary: A high-fidelity image-to-video model capable of generating realistic visuals with natural motion physics from static images.
---

# Luma Dream Machine (Image to Video)

## Overview
- **Slug:** `fal-ai/luma-dream-machine/image-to-video`
- **Category:** image-to-video
- **Creator:** [Luma AI](https://lumalabs.ai/)
- **Best for:** Generating high-quality, physically accurate cinematic video clips from static images.
- **FAL docs:** [FAL.ai Docs](https://fal.ai/models/fal-ai/luma-dream-machine/image-to-video)
- **Original source:** [Luma AI Dream Machine](https://lumalabs.ai/dream-machine), [Official API Docs](https://docs.lumalabs.ai/docs/api)

## What it does
Luma Dream Machine is a large-scale video generative model designed to create realistic visuals with natural, coherent motion. It can transform a single static image (or a pair of images for start/end frames) into a 5 to 9-second video clip. The model is particularly noted for its "natural motion physics," making it ideal for realistic scenes, character movement, and cinematic storytelling. It supports multiple aspect ratios and features a "loop" mode for seamless video backgrounds.

## When to use this model
- Use when: You need highly realistic motion that follows real-world physics (e.g., fluid movement, cloth simulation, human walking).
- Use when: You have a high-quality initial image and want to bring it to life without significant "hallucination" of new objects.
- Don't use when: You need extremely fast "instant" generation (consider Ray-Flash models instead).
- Don't use when: You need long-form narrative content (beyond 9 seconds per clip).
- Alternatives: 
    - `fal-ai/kling-video/v2.5-turbo`: Better for complex character consistency across longer scenes.
    - `fal-ai/veo3`: Google's high-end video model, often superior for specific artistic styles.
    - `fal-ai/luma-dream-machine/ray-2`: The successor model on FAL, offering improved motion and resolution scaling.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/luma-dream-machine/image-to-video` (sync) / `https://queue.fal.run/fal-ai/luma-dream-machine/image-to-video` (queue)

*Note: This specific endpoint is currently marked as deprecated on FAL.ai in favor of the newer `ray-2` endpoint, but its schema remains a standard for Luma image-to-video workflows.*

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | A descriptive text prompt guiding the motion and scene details. |
| `image_url` | string | (Required) | - | The URL of the initial image to start the video from. |
| `end_image_url` | string | null | - | Optional final image to end the video with. Used for "image-to-image" transitions. |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21` | The target aspect ratio for the generated video. |
| `loop` | boolean | `false` | `true`, `false` | Whether the video should loop (blending the end back to the beginning). |

### Output
The output is a JSON object containing the generated video file information.
```json
{
  "video": {
    "url": "https://fal.media/files/.../output.mp4",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "input": {
    "prompt": "A majestic tiger prowling through a snowy landscape, leaving paw prints on the white blanket",
    "image_url": "https://fal.media/files/koala/1oLY4Bjp4XdGBBTSSrG1E.jpeg",
    "aspect_ratio": "16:9"
  }
}
```

### Pricing
FAL.ai pricing for Luma models typically follows a per-clip structure:
- **Base Cost:** ~$0.50 per 5-second clip.
- **Duration Multiplier:** 9-second clips generally cost 2x ($1.00).
- **Resolution Multiplier:** Higher resolutions (720p, 1080p) may incur 2x or 4x cost multipliers depending on the specific model version (e.g., Ray 2).
- *Refer to the [FAL.ai Pricing Page](https://fal.ai/pricing) for the most current rates.*

## API — via Original Source (BYO-key direct)
**Luma AI Native API**
- **Endpoint:** `https://api.lumalabs.ai/dream-machine/v1/generations/video`
- **Auth method:** Bearer Token (API Key)
- **Official Docs:** [Luma API Reference](https://docs.lumalabs.ai/reference/creategeneration)
- **Additional Parameters:** 
    - `model`: Allows selecting specific versions like `ray-2` or `ray-flash-2`.
    - `callback_url`: For asynchronous webhook notifications.
    - `keyframes`: More granular control over frame references (`frame0`, `frame1`).

## Prompting best practices
- **Be Descriptive of Motion:** Don't just describe the scene; describe the *action*. Use verbs like "soaring," "prowling," "flowing," or "shimmering."
- **Camera Instructions:** Keywords like "slow zoom in," "cinematic pan," or "low-angle tracking shot" work well to guide the virtual camera.
- **Avoid Negative Prompts:** Luma generally responds better to positive descriptions of what *should* happen rather than what shouldn't.
- **Image-Prompt Synergy:** Ensure the prompt aligns with the content of the `image_url`. If the image is a still portrait, a prompt for a "high-speed car chase" will likely fail or cause artifacts.
- **Example Good Prompt:** "A serene cinematic drone shot of a misty mountain range at sunrise, slow forward movement, clouds rolling through the peaks."
- **Example Bad Prompt:** "The mountain moves." (Too vague, lacks motion characteristics).

## Parameter tuning guide
- **`loop`:** Set to `true` specifically for backgrounds or textures. It creates a seamless transition but may sometimes "squash" the motion to fit the loop timing.
- **`end_image_url`:** Use this when you need a specific transformation (e.g., a person aging or a building being constructed). It acts as a strong constraint on the final state of the video.
- **`aspect_ratio`:** Always match the aspect ratio to your intended output platform (e.g., `9:16` for TikTok/Shorts) early in the workflow, as re-cropping later may lose cinematic detail.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Initial Image` (Image/URL)
    - `End Image` (Image/URL - Optional)
    - `Aspect Ratio` (Dropdown)
    - `Loop` (Boolean)
- **Outputs:**
    - `Video URL` (URL)
- **Chain-friendly with:**
    - `fal-ai/flux/dev`: Generate the initial high-quality image first.
    - `fal-ai/minimax/speech-01`: Generate a voiceover to accompany the video.
    - `fal-ai/mmaudio-v2`: Generate synchronized sound effects for the video motion.

## Notes & gotchas
- **Safety Filters:** Luma has strict content moderation. Prompts containing NSFW, graphic violence, or hateful imagery will be flagged and return an error.
- **Physics Failures:** While generally excellent, the model can occasionally struggle with complex human anatomy in motion (e.g., hands with 6 fingers) or rapid intersections of objects.
- **Deprecated Endpoint:** On FAL, `luma-dream-machine/image-to-video` is considered a legacy endpoint. Developers should consider transitioning to the `ray-2` or `ray-flash-2` endpoints for better long-term support and improved quality.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/luma-dream-machine/image-to-video)
- [Luma AI Official API Reference](https://docs.lumalabs.ai/reference/creategeneration)
- [Luma AI Pricing & Plans](https://lumalabs.ai/api/pricing)
- [Luma AI Learning Hub](https://lumalabs.ai/learning-hub/content-moderation)
