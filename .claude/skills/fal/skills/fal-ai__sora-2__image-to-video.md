---
name: fal-ai/sora-2/image-to-video
display_name: Sora 2 Image-to-Video
category: text-to-video
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/sora-2/image-to-video
original_source: https://openai.com/sora
summary: OpenAI's state-of-the-art video generation model capable of animating images with physics-aware motion and synchronized audio.
---

# Sora 2 Image-to-Video

## Overview
- **Slug:** `fal-ai/sora-2/image-to-video`
- **Category:** image-to-video
- **Creator:** [OpenAI](https://openai.com/)
- **Best for:** Cinematic, physics-aware animation of still images with high temporal consistency and synchronized audio.
- **FAL docs:** [fal-ai/sora-2/image-to-video](https://fal.ai/models/fal-ai/sora-2/image-to-video)
- **Original source:** [OpenAI Sora](https://openai.com/sora)

## What it does
Sora 2 Image-to-Video is a state-of-the-art generative model from OpenAI that transforms a static image into a dynamic video clip. It is renowned for its ability to simulate complex physical interactions—like fluid dynamics, momentum, and character consistency—while maintaining high fidelity to the source image. Unlike many competitors, Sora 2 includes synchronized audio generation, allowing it to produce lip-synced dialogue and context-aware ambient sounds directly from the visual content.

## When to use this model
- **Use when:** You need high-quality, cinematic motion that respects the laws of physics. It is excellent for character-driven stories, product showcases, and realistic environmental animations.
- **Don't use when:** You need ultra-long videos (currently limited to 20 seconds on FAL) or if you are on a tight budget, as its per-second pricing is higher than many "turbo" alternatives.
- **Alternatives:** 
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Better for complex human actions and longer durations at a lower price point.
    - **[Veo 3.1](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video):** Google's flagship video model, strong at following specific stylistic instructions.
    - **[Wan 2.5](https://fal.ai/models/fal-ai/wan-25-preview/text-to-video):** A high-performance open-source alternative that offers competitive quality for a fraction of the cost.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sora-2/image-to-video` (sync) / `https://queue.fal.run/fal-ai/sora-2/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | - | Detailed description of the motion and audio desired in the video. |
| `image_url` | string | (Required) | - | URL of the image to be used as the starting frame. |
| `resolution` | string | `auto` | `auto`, `720p` | Output resolution. `auto` matches the source image aspect ratio. |
| `aspect_ratio` | string | `auto` | `auto`, `9:16`, `16:9` | Desired aspect ratio for the output video. |
| `duration` | integer | `4` | `4, 8, 12, 16, 20` | Length of the generated video in seconds. |
| `model` | string | `sora-2` | `sora-2`, `sora-2-2025-12-08`, `sora-2-2025-10-06` | Specific model version to use for generation. |
| `character_ids` | list<string> | `[]` | - | Up to two character IDs for consistent character representation. |
| `detect_and_block_ip` | boolean | `false` | - | If enabled, checks for known intellectual property in the prompt/image. |
| `delete_video` | boolean | `true` | - | If true, deletes the video after generation for privacy; prevents remixing. |

### Output
The API returns a JSON object containing the generated video details:
- `video`: A `VideoFile` object with `url`, `content_type`, `width`, `height`, `fps`, and `duration`.
- `video_id`: A unique identifier for the generated clip.
- `thumbnail`: A URL to a preview image of the video.
- `spritesheet`: A URL to a grid of preview frames.

### Example request
```json
{
  "input": {
    "prompt": "A cinematic tracking shot of the woman walking through a neon-lit Tokyo street, heavy rain reflecting off the asphalt, synchronized sound of footsteps and rain.",
    "image_url": "https://example.com/source-image.jpg",
    "duration": 8,
    "resolution": "720p"
  }
}
```

### Pricing
- **Standard:** $0.10 per second of video generated.
- **Pro:** $0.30/s for 720p and $0.50/s for 1080p (via the `/pro` endpoint variants).

## API — via Original Source (BYO-key direct)
OpenAI provides a native **Videos API** for Sora 2.
- **Endpoint:** `https://api.openai.com/v1/videos`
- **Auth method:** Bearer Token (OpenAI API Key).
- **Additional Parameters:** Supports `remix_video_id` to reuse the structure/motion of a previous video, which is not always exposed in standard FAL wrappers.
- **Official Docs:** [OpenAI Video Generation Guide](https://developers.openai.com/api/docs/guides/video-generation)
- **Note:** OpenAI's native Sora 2 API is slated for deprecation in late 2026 as newer models take its place.

## Prompting best practices
- **Describe Motion, Not Just Subjects:** Use verbs like "swirling," "gliding," or "erupting" to guide the animation.
- **Specify Audio Cues:** Since Sora 2 generates audio, mention specific sounds like "the crunch of gravel" or "soft jazz playing in the background."
- **Camera Direction:** Include camera instructions like "slow zoom-in," "handheld shake," or "low-angle pan" to enhance the cinematic feel.
- **Physics-Aware Prompts:** Describe interactions (e.g., "the water ripples as the hand touches it") to leverage the model's physics engine.
- **Avoid Over-Detailing the Subject:** Since the image provides the visual base, focus your prompt on what *changes* or *moves*.
- **Example Good Prompt:** "A majestic dragon slowly opens its eyes and exhales a puff of smoke, low-frequency rumbling sound, close-up shot."
- **Example Bad Prompt:** "A dragon sitting on a rock." (Too static, no motion instructions).

## Parameter tuning guide
- **Duration (4-20s):** Start with 4s for rapid testing. Long durations (16s+) are more prone to slight "drift" in character consistency but offer the most immersive results.
- **Resolution (`auto`):** It is generally best to leave resolution on `auto` so the model doesn't warp your source image to fit a specific aspect ratio.
- **Model Version:** Use the default `sora-2` for the latest improvements; use dated snapshots (e.g., `sora-2-2025-10-06`) only if you need to replicate a specific previous result.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `image_url` (Image): The source image.
    - `prompt` (String): The motion/audio description.
    - `duration` (Number): Desired length.
- **Outputs:**
    - `video_url` (Video): The final rendered clip.
    - `thumbnail_url` (Image): A static preview.
- **Chain-friendly with:**
    - **[Flux Pro](https://fal.ai/models/fal-ai/flux-pro):** Use Flux to generate a high-fidelity starting image, then pipe the URL into Sora 2.
    - **[Remove Background](https://fal.ai/models/fal-ai/bria/background-removal):** Clean up images before animating to avoid background artifacts.

## Notes & gotchas
- **Safety Filters:** The `detect_and_block_ip` flag is aggressive; prompts involving famous copyrighted characters or celebrities will often be blocked.
- **Pricing:** Billed by output duration. A failed generation typically does not incur costs, but "completed" videos with artifacts will still be charged.
- **Queue Mode:** Highly recommended for durations over 8 seconds, as generation can take 30-120 seconds.

## Sources
- [FAL.ai Sora 2 Documentation](https://fal.ai/models/fal-ai/sora-2/image-to-video)
- [OpenAI Official Sora Page](https://openai.com/sora)
- [Microsoft Azure OpenAI Sora 2 Reference](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/video-generation)
- [FAL.ai Pricing Page](https://fal.ai/pricing)