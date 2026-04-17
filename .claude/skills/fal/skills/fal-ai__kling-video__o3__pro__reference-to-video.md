---
name: fal-ai/kling-video/o3/pro/reference-to-video
display_name: Kling O3 Pro Reference to Video
category: image-to-video
creator: Kuaishou Technology (Kling AI)
fal_docs: https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video
original_source: https://klingai.com/
summary: A state-of-the-art multimodal video generation model that preserves character and object identity using multiple reference images and precise prompt control.
---

# Kling O3 Pro Reference to Video

## Overview
- **Slug:** `fal-ai/kling-video/o3/pro/reference-to-video`
- **Category:** Image-to-Video / Reference-to-Video
- **Creator:** [Kuaishou Technology](https://klingai.com/)
- **Best for:** Maintaining 100% character and object consistency across complex cinematic shots using multiple reference images.
- **FAL docs:** [fal-ai/kling-video/o3/pro/reference-to-video](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video)
- **Original source:** [Kling AI Official](https://klingai.com/)

## What it does
Kling O3 Pro Reference to Video (also known as Kling 3.0 Omni) is a breakthrough multimodal model that allows users to generate video by "binding" specific characters, objects, or styles to the generation process using reference images. Unlike standard image-to-video models that often "drift" or lose detail, the O3 Omni architecture acts as a "digital director" that remembers the features of @Element1 or @Element2 throughout the entire clip ([Kling AI User Guide](https://kling.ai/quickstart/klingai-video-o1-user-guide)). It supports multi-shot storyboarding, native audio generation, and high-fidelity physics ([WaveSpeed AI](https://wavespeed.ai/blog/posts/introducing-kwaivgi-kling-video-o1-reference-to-video-on-wavespeedai/)).

## When to use this model
- **Use when:** You need a specific character to perform multiple actions across different shots without their face or clothing changing.
- **Use when:** You are creating product commercials and need the product (e.g., a specific sneaker or bottle) to look identical in every frame.
- **Use when:** You want to precisely control the start and end frames of a transition.
- **Don't use when:** You just want a quick, "vibey" video from a single prompt; use [Kling V3 Pro Image-to-Video](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video) instead for simpler workflows.
- **Alternatives:** 
    - `fal-ai/kling-video/v3/pro/image-to-video`: Better for high-quality cinematic motion from a single image.
    - `fal-ai/veo3.1/first-last-frame-to-video`: Google's competitor, better for specific interpolation tasks but lacks the multi-element "binding" of Kling O3 ([WaveSpeed AI](https://wavespeed.ai/blog/posts/introducing-kwaivgi-kling-video-o1-reference-to-video-on-wavespeedai/)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/o3/pro/reference-to-video` (sync) / `https://queue.fal.run/fal-ai/kling-video/o3/pro/reference-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | Text description. Use `@Element1`, `@Element2` for elements and `@Image1`, `@Image2` for style/frame references. |
| `multi_prompt` | list | `null` | N/A | List of prompts for multi-shot generation. If provided, `prompt` is ignored. |
| `start_image_url` | string | `null` | URL | Image to use as the first frame. |
| `end_image_url` | string | `null` | URL | Image to use as the last frame. |
| `image_urls` | list<string> | `[]` | Max 4-7 | Reference images for style or appearance. Reference as `@Image1` in prompt. |
| `elements` | list | `[]` | N/A | List of `KlingV3ComboElementInput` objects (see below). Reference as `@Element1` in prompt. |
| `generate_audio` | boolean | `false` | `true`, `false` | Whether to generate synchronized native audio for the video. |
| `duration` | integer | `5` | `3` to `15` | Video duration in seconds. |
| `shot_type` | string | `"customize"` | `"customize"`, `"intelligent"` | `"intelligent"` automates angles; `"customize"` follows the prompt's storyboard logic exactly. |
| `aspect_ratio` | string | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"` | The frame aspect ratio. |

**KlingV3ComboElementInput Schema:**
- `frontal_image_url` (string, required): Clear front view of the character/object.
- `reference_image_urls` (list<string>): Additional angles (side, back) to improve consistency.

### Output
The output is a JSON object containing a `video` file reference:
```json
{
  "video": {
    "url": "https://v3b.fal.media/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 18468404
  }
}
```

### Example request
```json
{
  "prompt": "@Element1 walks through a neon-lit rain-soaked street, looking at the camera. Cinematic lighting, 35mm lens. Style should match @Image1.",
  "elements": [
    {
      "frontal_image_url": "https://example.com/character_front.png",
      "reference_image_urls": ["https://example.com/character_side.png"]
    }
  ],
  "image_urls": ["https://example.com/cyberpunk_style.png"],
  "duration": 10,
  "aspect_ratio": "16:9",
  "generate_audio": true
}
```

### Pricing
- **Audio Off:** $0.112 per second ($0.56 for 5s, $1.12 for 10s).
- **Audio On:** $0.14 per second ($0.70 for 5s, $1.40 for 10s).
Source: [FAL.ai Pricing](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video)

## API — via Original Source (BYO-key direct)
The model is available directly via the [Kling AI Global API](https://klingai.com/).
- **Endpoint:** `https://api.klingai.com/v1/videos/image-to-video` (Note: Requires Model ID `kling-v3-omni`).
- **Additional Parameters:** The native API supports **Trajectory Control** (passing X,Y coordinates for motion paths) and **Advanced Camera Control** (Pan/Tilt/Roll/Zoom with values from -10 to 10), which are currently less exposed on FAL's reference-to-video wrapper ([Kling AI User Guide](https://kling.ai/blog/kling-3-prompt-syntax-omni-reference-tags-video-physics)).
- **Auth:** Bearer Token (API Key).

## Prompting best practices
- **The Tag System:** You MUST use the tags `@Element1`, `@Element2`, etc., in the prompt for the model to "bind" the reference images to the subjects.
- **Structure:** Use the pattern: `[Subject @Element1] + [Action] + [Environment] + [Lighting/Style @Image1]`.
- **Reference Angles:** For characters, providing a front view AND a side view in the `elements` list significantly reduces facial distortion during turns ([Kling AI User Guide](https://klingai.com/quickstart/motion-control-user-guide)).
- **Cinematic Keywords:** Keywords like "handheld camera," "dolly zoom," or "shallow depth of field" work extremely well with the O3 Pro engine.
- **Bad Prompt:** "A man walking." (Lacks reference binding and detail).
- **Good Prompt:** "@Element1 (a futuristic explorer) slowly walks toward the glowing ruins in @Image1, looking back at the camera with an expression of awe. 8k, cinematic lighting."

## Parameter tuning guide
- **Duration (3-15s):** 10s-15s is the "Pro" sweet spot. For complex multi-shot logic, use 15s to give each shot enough time to develop.
- **Shot Type:** Use `"intelligent"` if you want the AI to choose the best cinematic angles for you. Use `"customize"` if your prompt contains specific camera instructions like "low angle" or "close-up."
- **Generate Audio:** Always set to `true` for a more immersive output, as Kling's native audio is procedurally generated to match the visual actions (e.g., footsteps in the rain) ([Kling AI User Guide](https://klingai.com/quickstart/klingai-video-3-omni-model-user-guide)).

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Reference Images` (List of Image URLs)
    - `Element Profiles` (List of Frontal + Side view images)
    - `Duration` (Number)
    - `Audio Toggle` (Boolean)
- **Outputs:**
    - `Video URL` (URL)
    - `Metadata` (Duration, Resolution)
- **Chain-friendly with:**
    - `fal-ai/flux/dev`: To generate the initial high-quality reference "character sheets."
    - `fal-ai/kling-video/o3/pro/video-to-video/reference`: To transform an existing video's motion while keeping the same @Element character.

## Notes & gotchas
- **Input Limit:** Total combined inputs (elements + reference images + start/end images) are typically capped at **7-9 items** depending on the specific provider ([WaveSpeed AI](https://wavespeed.ai/blog/posts/introducing-kwaivgi-kling-video-o1-reference-to-video-on-wavespeedai/)).
- **Resolution:** O3 Pro supports up to **1080p** resolution, but inference time can be 5-10 minutes during peak hours.
- **Queue Mode:** Highly recommended. The model often takes 120-300 seconds to generate a high-quality 10s clip.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video)
- [Kling AI Official User Guide (Feb 2026)](https://klingai.com/quickstart/klingai-video-3-omni-model-user-guide)
- [WaveSpeed AI - Kling O1/O3 Technical Analysis](https://wavespeed.ai/blog/posts/introducing-kwaivgi-kling-video-o1-reference-to-video-on-wavespeedai/)
- [EvoLink - Kling 3.0/O3 Pricing Benchmark](https://evolink.ai/blog/kling-3-o3-api-official-discount-pricing-developers)
