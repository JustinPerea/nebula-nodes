---
name: fal-ai/pika/v2.2/image-to-video
display_name: Pika 2.2 Image-to-Video
category: image-to-video
creator: Pika Labs
fal_docs: https://fal.ai/models/fal-ai/pika/v2.2/image-to-video
original_source: https://pika.art
summary: A high-fidelity image-to-video model capable of generating up to 10-second cinematic clips in 1080p resolution.
---

# Pika 2.2 Image-to-Video

## Overview
- **Slug:** `fal-ai/pika/v2.2/image-to-video`
- **Category:** image-to-video
- **Creator:** [Pika Labs](https://pika.art)
- **Best for:** Creating short, high-resolution cinematic video clips from static images with precise motion control.
- **FAL docs:** [fal.ai/models/fal-ai/pika/v2.2/image-to-video](https://fal.ai/models/fal-ai/pika/v2.2/image-to-video)
- **Original source:** [pika.art](https://pika.art)

## What it does
Pika 2.2 is an advanced video generation model that transforms static images into dynamic, high-definition videos. It specializes in maintaining visual consistency from a source image while animating it based on natural language prompts. Key improvements in version 2.2 include better motion sharpness, support for full 1080p resolution, and extended clip durations of up to 10 seconds. It is designed to be "playful yet cinematic," offering a range of motion effects like zooms and pans that can be directed via text.

## When to use this model
- **Use when:** You have a high-quality base image (e.g., from Midjourney or Flux) and want to add professional-grade cinematic movement.
- **Use when:** You need specific clip lengths of exactly 5 or 10 seconds for social media or short-form content.
- **Don't use when:** You need high temporal stability for complex human movements (like dancing or walking), as the model can sometimes suffer from "drifting" or limb instability.
- **Alternatives:** 
    - `fal-ai/kling-video`: Generally higher benchmark scores for temporal consistency.
    - `fal-ai/luma-dream-machine`: Excellent for realistic physics and 3D consistency.
    - `fal-ai/runway-gen3`: Superior for complex scene transitions and character consistency.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/pika/v2.2/image-to-video` (sync) / `https://queue.fal.run/fal-ai/pika/v2.2/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (Required) | URL | The source image to use as the first frame of the video. |
| `prompt` | string | (Required) | Text | Description of the desired motion and scene changes. |
| `negative_prompt` | string | "" | Text | Elements to exclude from the generation (e.g., "blur, distorted, low quality"). |
| `resolution` | string | "720p" | `720p`, `1080p` | The vertical resolution of the output video. |
| `duration` | integer | 5 | `5`, `10` | The length of the generated video in seconds. |
| `seed` | integer | Random | 0 - 2^32 | Used to reproduce specific generations or iterate on a motion path. |

### Output
The API returns a JSON object containing a `video` file object.
```json
{
  "video": {
    "url": "https://fal.run/files/...",
    "content_type": "video/mp4",
    "file_name": "pika_v2_2.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "input": {
    "image_url": "https://example.com/start_frame.png",
    "prompt": "The camera slowly zooms in on the character's eyes as they spark with magic, cinematic lighting, 4k",
    "resolution": "1080p",
    "duration": 10
  }
}
```

### Pricing
Pricing on FAL.ai is based on resolution and duration:
- **5-second video at 720p:** ~$0.20 per call.
- **5-second video at 1080p:** ~$0.45 per call.
*Note: Prices are subject to change based on FAL's compute-based billing.*

## API — via Original Source (BYO-key direct)
Pika Labs provides a direct API surface primarily through their web platform and developer portal at [pika.art](https://pika.art).
- **Endpoint:** `https://api.pika.art/v1/...` (Note: access is often restricted to Pro/Enterprise tiers).
- **Unique Features:** The native API supports **Pikaframes**, allowing users to specify both a **start frame** and an **end frame** image to precisely control the transition.
- **Auth method:** Bearer Token.

## Prompting best practices
- **Motion Cues are Mandatory:** Use explicit camera directions like "slow dolly zoom," "pan left to right," or "handheld camera shake."
- **Describe the Change:** Instead of just describing the scene, describe the *transformation*. Example: "The static water begins to ripple and reflect the sunset."
- **Style Tokens:** To avoid the "CGI look," use tokens like `raw film footage`, `cinematic`, `35mm lens`, or `natural lighting`.
- **Avoid Over-complicating:** Pika 2.2 can struggle with too many simultaneous actions. Focus on 1-2 primary movements per clip.
- **Good Prompt:** "A majestic lion standing on a rock, the wind blowing through its mane, slow cinematic zoom into its face, hyper-realistic, 8k."
- **Bad Prompt:** "Lion on a rock." (Too vague, leads to minimal or random motion).

## Parameter tuning guide
- **Resolution (1080p):** Always use 1080p for final exports. Use 720p for rapid prototyping to save costs.
- **Duration (10s):** The 10-second mode is excellent for slow-burn cinematic shots but increases the risk of "morphing" artifacts toward the end. If the motion is simple, 10s is safe; for complex action, stick to 5s.
- **Negative Prompt:** Use this to fix common issues like "morphing, flickering, extra limbs, floating objects."

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image URL`: The starting visual.
    - `Prompt`: The director's instructions.
    - `Resolution`: Quality toggle.
- **Outputs:**
    - `Video URL`: The final MP4 link.
- **Chain-friendly with:**
    - `fal-ai/flux/pro`: Generate the perfect starter image first.
    - `fal-ai/pika/v2.2/pikaffects`: Apply specialized physics effects (like "crumble" or "melt") to the generated video.

## Notes & gotchas
- **Temporal Instability:** Independent benchmarks (e.g., Curious Refuge) have noted that Pika 2.2 can be unstable with human subjects, often causing characters to change shape or objects to flicker.
- **Aspect Ratio:** Ensure your input image matches the intended video aspect ratio (16:9, 9:16, etc.) to avoid stretching or black bars.
- **Content Policy:** Pika has strict filters against NSFW and copyrighted characters (likeness of real people).

## Sources
- [FAL.ai Pika 2.2 Documentation](https://fal.ai/models/fal-ai/pika/v2.2/image-to-video/api)
- [Pika Labs Official Site](https://pika.art)
- [Adobe Firefly Pika 2.2 Integration Guide](https://helpx.adobe.com/firefly/web/firefly-video-editor/generate-videos/generate-videos-with-pika-22.html)
- [Curious Refuge Pika 2.2 Benchmark](https://curiousrefuge.com/blog/pika-22-ai-video-generator-review)
