---
name: fal-ai/minimax/hailuo-2.3/standard/text-to-video
display_name: MiniMax Hailuo 2.3 [Standard] (Text to Video)
category: text-to-video
creator: MiniMax
fal_docs: https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video
original_source: https://platform.minimax.io/docs/api-reference/video-generation-intro
summary: A state-of-the-art text-to-video model by MiniMax offering cinematic motion, high realism, and advanced camera control.
---

# MiniMax Hailuo 2.3 [Standard] (Text to Video)

## Overview
- **Slug:** `fal-ai/minimax/hailuo-2.3/standard/text-to-video`
- **Category:** text-to-video
- **Creator:** [MiniMax](https://www.minimax.io/)
- **Best for:** Generating cinematic, high-fidelity videos with realistic human motion and precise camera control.
- **FAL docs:** [FAL.ai MiniMax Hailuo 2.3](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video)
- **Original source:** [MiniMax API Documentation](https://platform.minimax.io/docs/api-reference/video-generation-intro)

## What it does
MiniMax Hailuo 2.3 is an advanced video generation model that transforms text prompts into high-quality cinematic videos. It is specifically recognized for its breakthroughs in physical realism, fluid body movements, and expressive facial expressions. The model excels at maintaining visual coherence and following complex instructions, including specific camera maneuvers. While the "Standard" version on FAL is optimized for 768p resolution, it provides a professional-grade output suitable for storytelling, marketing, and creative experiments.

## When to use this model
- **Use when:** You need realistic human motion, cinematic quality, or specific camera movements (pans, tilts, zooms) that many other models struggle to execute precisely.
- **Don't use when:** You require 4K resolution (currently limited to 1080p natively and 768p on FAL Standard) or for extremely long-form single-shot narratives exceeding 10 seconds.
- **Alternatives:** 
    - **Luma Dream Machine:** Better for some surreal physics but often less consistent on specific camera commands.
    - **Kling 1.5:** Similar high-end quality, often slightly better at character consistency over multiple shots but different prompt adherence.
    - **Runway Gen-3 Alpha:** Strong industry standard, though pricing and prompt "feel" differ.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax/hailuo-2.3/standard/text-to-video` (sync) / `https://queue.fal.run/fal-ai/minimax/hailuo-2.3/standard/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | - | - | The text description of the scene. Supports [command] syntax for camera control. |
| `prompt_optimizer` | `boolean` | `true` | `true`, `false` | When enabled, the model automatically refines the user prompt for better visual results. |
| `duration` | `integer` | `6` | `6`, `10` | The length of the generated video in seconds. |

### Output
The output is a JSON object containing a `video` field with a temporary URL to the generated `.mp4` file.
```json
{
  "video": {
    "url": "https://fal.run/storage/..."
  }
}
```

### Example request
```json
{
  "prompt": "A cinematic tracking shot of a futuristic cyberpunk city at night with neon lights reflecting in rain puddles. [Tracking shot]",
  "prompt_optimizer": true,
  "duration": 6
}
```

### Pricing
- **6-second video:** $0.28 per generation.
- **10-second video:** $0.56 per generation.
(Based on [FAL.ai pricing](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video/api))

## API — via Original Source (BYO-key direct)
MiniMax provides a native API that exposes additional parameters and higher resolutions.

- **Endpoint:** `https://api.minimax.io/v1/video_generation`
- **Authentication:** Bearer API Key (found in MiniMax Account Management).
- **Extra Parameters:**
    - `resolution`: Supports `768P` (default) and `1080P`.
    - `fast_pretreatment`: Boolean to speed up the prompt optimization phase.
    - `callback_url`: For receiving asynchronous status updates via webhooks.
- **Official Docs:** [MiniMax Video Generation API](https://platform.minimax.io/docs/api-reference/video-generation-t2v)

## Prompting best practices
- **Camera Commands:** Use square brackets for precise camera control. Examples: `[Pan left]`, `[Zoom in]`, `[Truck right]`, `[Pedestal up]`, `[Shake]`, `[Tracking shot]`.
- **Combination:** You can combine up to 3 commands in one bracket, e.g., `[Pan left, Pedestal up]`.
- **Style Tokens:** The model responds well to cinematic keywords like "8k resolution," "cinematic lighting," "highly detailed," and specific film stock names.
- **Prompt Optimizer:** If you are a prompt engineering expert, set `prompt_optimizer: false` to prevent the model from altering your specific instructions.
- **Failure Modes:** Avoid extremely abstract concepts without visual anchors; the model works best when describing physical actions and tangible environments.

## Parameter tuning guide
- **`prompt_optimizer`:** Set to `true` for most users to get polished results. Set to `false` if you are using highly specific technical prompts or camera sequences that you don't want the AI to "hallucinate" over.
- **`duration`:** Use `6` for quick iterations and testing. Use `10` for final production assets, as the cost doubles and the model has more time to develop the scene motion.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Text Prompt`: Primary scene description.
    - `Duration`: Choice of 6 or 10 seconds.
    - `Optimize Prompt`: Toggle for automatic enhancement.
- **Outputs:**
    - `Video URL`: The resulting MP4 link.
- **Chain-friendly with:**
    - **Upscalers:** Pair with an AI Video Upscaler (like Topaz or a FAL-based upscaler) to push the 768p output to 4K.
    - **LLM Prompt Generators:** Use a GPT-4o node to generate descriptive, camera-rich prompts for MiniMax.

## Notes & gotchas
- **Resolution:** The "Standard" FAL slug is capped at 768p. If you need 1080p, you must use the native MiniMax API or check for a "Pro" FAL slug if available.
- **Commercial Use:** Generative content is generally available for commercial use, but check [MiniMax Terms of Service](https://www.minimax.io/legal/terms-of-service) for specific regional restrictions.
- **Asynchronous Nature:** Video generation typically takes 60–120 seconds. Always use the `queue` mode for stable integration in production apps.

## Sources
- [FAL.ai MiniMax Model Page](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video)
- [MiniMax Official API Docs](https://platform.minimax.io/docs/api-reference/video-generation-intro)
- [MiniMax Release Blog](https://www.minimax.io/news/minimax-hailuo-23)