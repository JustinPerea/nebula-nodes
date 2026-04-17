---
name: fal-ai/kling-video/v2.1/master/text-to-video
display_name: Kling 2.1 Master (Text-to-Video)
category: text-to-video
creator: Kuaishou AI Team (Kling AI)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video
original_source: https://klingai.com/document-api/apiReference/model/textToVideo
summary: The premium endpoint for Kling 2.1, delivering 1080p cinematic video generation with unparalleled motion fluidity and professional-grade prompt adherence.
---

# Kling 2.1 Master (Text-to-Video)

## Overview
- **Slug:** `fal-ai/kling-video/v2.1/master/text-to-video`
- **Category:** text-to-video
- **Creator:** [Kuaishou AI Team](https://klingai.com/)
- **Best for:** Ultra-realistic cinematic video generation with complex motion and high prompt fidelity.
- **FAL docs:** [fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video](https://fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video)
- **Original source:** [klingai.com](https://klingai.com/document-api/apiReference/model/textToVideo)

## What it does
Kling 2.1 Master is the high-tier "Master" version of Kuaishou's Kling video generation model. It produces 1080p high-definition videos from text prompts, characterized by advanced physical world simulation, fluid motion, and professional-grade cinematic aesthetics. Compared to the "Standard" or "Pro" versions, the Master model prioritizes output quality and motion accuracy over generation speed, making it suitable for high-end creative production.

## When to use this model
- **Use when:** You need the absolute highest quality video output available in the Kling ecosystem, with realistic physics and detailed textures.
- **Don't use when:** You need fast previews (use Kling Turbo instead) or the lowest possible cost (use Kling 2.1 Standard).
- **Alternatives:** 
  - **[Kling 2.6 Pro](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video):** Better at native audio integration and faster, though with slightly different motion characteristics.
  - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Comparable quality with different artistic "flavors."
  - **[Hailuo MiniMax](https://fal.ai/models/fal-ai/minimax-video):** Excellent for character consistency and human movement.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v2.1/master/text-to-video` (Sync) / `https://queue.fal.run/fal-ai/kling-video/v2.1/master/text-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 2500 chars | The text description of the video to generate. |
| `duration` | string | `5` | `5`, `10` | The duration of the generated video in seconds. |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16`, `1:1` | The aspect ratio of the video frame. |
| `negative_prompt`| string | `""` | Max 2500 chars | Things you do NOT want to see in the video. |
| `cfg_scale` | float | `0.5` | `0.0 - 1.0` | Classifier-Free Guidance scale. Higher values follow prompt more strictly but may degrade quality. |

### Output
The API returns a JSON object containing a `video` object with a public URL.
```json
{
  "video": {
    "url": "https://fal.ai/files/...",
    "content_type": "video/mp4",
    "file_name": "kling_video.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "Golden sunlight bathes the bustling street market, illuminating the vendor's deft hands as they knead vibrant dough, the flour dusting the air like a soft, ethereal snow; the sizzle of the seasoned meat, a rhythmic counterpoint to the chatter of the crowd, creates a symphony of sights and sounds.",
  "duration": "5",
  "aspect_ratio": "16:9"
}
```

### Pricing
- **$1.40** per 5-second video.
- **$0.28** for every additional second.
- Prices are based on the Master tier; Pro and Standard tiers are cheaper but offer lower quality.

## API — via Original Source (BYO-key direct)
Kling AI offers a direct API platform for developers.
- **Endpoint:** `https://api-beijing.klingai.com/v1/videos/text2video` (Global endpoints may vary)
- **Auth method:** Bearer Token (API Key)
- **Direct Advantages:** Access to advanced `camera_control` objects (horizontal, vertical, pan, tilt, roll, zoom) not always fully exposed in third-party wrappers, and `multi_shot` storyboarding (up to 6 shots).
- **Official Docs:** [Kling AI Developer Portal](https://klingai.com/document-api/apiReference/model/textToVideo)

## Prompting best practices
- **Sensory Details:** Use evocative language for lighting ("golden hour," "bioluminescent") and textures ("rough calloused hands," "viscous lava").
- **Dynamic Action:** Describe motion clearly using verbs like "swirling," "coaxing," "exploding down," or "plunging."
- **Camera Movement:** Even if not using the camera parameters, describe the shot type ("extreme close-up," "aerial sweeping vista") in the prompt.
- **Complexity is OK:** Kling 2.1 Master thrives on long, descriptive prompts (up to 2500 characters). Don't be afraid to describe a full scene.
- **Avoid Over-negation:** Use the `negative_prompt` field for specific unwanted elements rather than including "no [object]" in the main prompt.

## Parameter tuning guide
- **Duration (5 vs 10):** 5s is safer for complex physics; 10s allows for longer narrative arcs but may experience drift toward the end.
- **CFG Scale:** 0.5 is the recommended default for "Master" models to allow the model's internal aesthetics to shine. Increase toward 1.0 only if the model is ignoring specific requested objects.
- **Aspect Ratio:** Choose `16:9` for cinematic/YouTube content and `9:16` for TikTok/Reels/Shorts.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (Text)
  - `Negative Prompt` (Text)
  - `Duration` (Dropdown: 5, 10)
  - `Aspect Ratio` (Dropdown: 16:9, 9:16, 1:1)
  - `CFG Scale` (Slider: 0-1)
- **Outputs:**
  - `Video URL` (URL)
  - `Content Type` (String)
- **Chain-friendly with:**
  - **[ElevenLabs TTS](https://fal.ai/models/fal-ai/elevenlabs/tts):** To generate a voiceover for the video.
  - **[Kling Lipsync](https://fal.ai/models/fal-ai/kling-video/lipsync/text-to-video):** To synchronize generated audio with the video output.
  - **[Flux.1 Dev](https://fal.ai/models/fal-ai/flux/dev):** To create a reference image first, then use Kling Image-to-Video for better character control.

## Notes & gotchas
- **Safety Filters:** The model has strict content filters regarding violence, sexual content, and political figures. Requests triggering these will fail and return a safety error.
- **Processing Time:** Generations typically take 3-5 minutes. Always use the `queue` mode for production applications.
- **URL Expiry:** Files hosted on FAL.ai or Kling's direct API are temporary (Kling cleans them after 30 days). Always download and store results in your own storage (e.g., S3).

## Sources
- [FAL.ai Kling 2.1 Master Page](https://fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video)
- [Kling AI Official API Documentation](https://klingai.com/document-api/apiReference/model/textToVideo)
- [FAL.ai Pricing Page](https://fal.ai/pricing)