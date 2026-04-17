---
name: fal-ai/kling-video/v2.6/pro/motion-control
display_name: Kling Video v2.6 Motion Control [Pro]
category: image-to-video
creator: Kling AI (Kuaishou Technology)
fal_docs: https://fal.ai/models/fal-ai/kling-video/v2.6/pro/motion-control
original_source: https://klingai.com
summary: High-fidelity motion transfer model that applies movements from a reference video to a static character image.
---

# Kling Video v2.6 Motion Control [Pro]

## Overview
- **Slug:** `fal-ai/kling-video/v2.6/pro/motion-control`
- **Category:** Image-to-Video / Motion Transfer
- **Creator:** [Kling AI (Kuaishou Technology)](https://klingai.com)
- **Best for:** Precise character animation using a reference video as a "digital puppet."
- **FAL docs:** [fal.ai/models/fal-ai/kling-video/v2.6/pro/motion-control](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/motion-control)
- **Original source:** [Kling AI Official Site](https://klingai.com), [Kie.ai (API Documentation)](https://docs.kie.ai/market/kling/motion-control)

## What it does
Kling Video v2.6 Motion Control is a specialized multimodal model that enables **precise motion transfer**. It takes a static **Reference Image** of a character and a **Motion Reference Video**, then "fuses" them to generate a video where the character performs the exact movements from the video. Unlike standard image-to-video models that guess movement from a text prompt, this model acts as a digital puppeteer, extracting skeletal articulation, weight transfer, and momentum from the reference footage and applying it to the character while preserving their visual identity [MindStudio](https://www.mindstudio.ai/blog/what-is-kling-2-6-pro-motion-control-video/).

## When to use this model
- **Use when:** You need a character to perform a specific, complex action (like a dance routine, martial arts, or precise hand gestures) that is difficult to describe via text.
- **Use when:** You have existing footage of a performance and want to "reskin" the actor as an AI-generated character.
- **Don't use when:** You want the AI to creatively invent a scene from a prompt alone; use a standard text-to-video or image-to-video model instead.
- **Alternatives:** 
    - `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`: Better for general cinematic shots where physics and reference videos aren't required.
    - `fal-ai/kling-video/v3.0/pro/motion-control`: The successor, offering improved facial consistency and 1080p output [Kling AI](https://kling.ai/quickstart/motion-control-user-guide).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kling-video/v2.6/pro/motion-control` (sync) / `https://queue.fal.run/fal-ai/kling-video/v2.6/pro/motion-control` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | null | N/A | Optional text describing the scene, background, or camera movement (especially useful in 'image' mode). |
| `image_url` | string | **Required** | URL | Publicly accessible URL of the character image. Support for JPG, PNG, WEBP, GIF, AVIF (max 10MB). |
| `video_url` | string | **Required** | URL | Publicly accessible URL of the motion reference video. Support for MP4, MOV, WEBM, M4V (max 100MB). |
| `character_orientation` | string | **Required** | `image`, `video` | Controls spatial interpretion. `video` mode follows the video's framing; `image` mode follows the image's framing. |
| `keep_original_sound` | boolean | `true` | `true`, `false` | Whether to retain the audio track from the reference video in the output. |

### Output
The output is a JSON object containing a `video` field with the generated file details.
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 35299865
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/character.png",
  "video_url": "https://example.com/dance_reference.mp4",
  "character_orientation": "video",
  "prompt": "Cinematic lighting, high detail"
}
```

### Pricing
Approximately **$0.112 per second** of generated video output [FAL Playground](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/motion-control/playground).

## API — via Original Source (BYO-key direct)
The model is hosted natively by Kling AI (Kuaishou) and accessible via their global API platform, **Kie.ai**.

- **Endpoint:** `https://api.kie.ai/api/v1/jobs/createTask`
- **Auth:** Bearer Token (API Key from [KlingAI.com](https://klingai.com))
- **Additional Parameters:** 
    - `mode`: Allows specifying resolution (e.g., "720p").
    - `callBackUrl`: Supports webhooks for asynchronous processing [The AI Journal](https://aijourn.com/kling-2-6-api-a-practical-text-to-video-and-image-to-video-api-with-native-audio-generation/).
- **Docs:** [docs.kie.ai](https://docs.kie.ai/market/kling/motion-control)

## Prompting best practices
- **The "Digital Puppeteer" Rule:** Ensure the character's pose and camera distance in the reference image roughly match the starting frame of the reference video. Large mismatches lead to warping.
- **Hand Clarity:** Use images where the character's hands are clearly visible if the motion involves complex finger articulation.
- **Environment Separation:** The prompt controls the *environment*, not the motion. Use the prompt to change the lighting, background, or weather (e.g., "dancing in a neon-lit rain-soaked street") while the video handles the dance [Higgsfield](https://higgsfield.ai/blog/Kling-2.6-Motion-Control-Full-Guide).
- **Face Focus:** For better identity preservation, use high-resolution portraits where the character is looking at the camera [Kling AI](https://kling.ai/quickstart/motion-control-user-guide).

## Parameter tuning guide
- **Character Orientation - `video`:**
    - **Use for:** Complex full-body choreography (e.g., breakdancing). 
    - **Behavior:** Forces the character in the image to adopt the spatial position and camera angle of the video. 
    - **Limit:** Max 30 seconds [ComfyUI Docs](https://docs.comfy.org/tutorials/partner-nodes/kling/kling-motion-control).
- **Character Orientation - `image`:**
    - **Use for:** Portrait animation and custom camera moves.
    - **Behavior:** Keeps the character's orientation from the input image. If the character moves toward the edge of the frame, the AI may automatically generate camera panning to keep them centered.
    - **Limit:** Max 10 seconds.
- **`keep_original_sound`:** Disable this if you plan to use a separate lip-syncing model or custom audio track later in your workflow.

## Node inputs/outputs
- **Inputs:**
    - `Prompt`: Text prompt for styling and environment.
    - `Reference Image`: Static character asset.
    - `Motion Video`: Movement blueprint.
    - `Orientation Mode`: `image` or `video`.
    - `Audio Toggle`: Enable/disable original sound.
- **Outputs:**
    - `Video URL`: The final MP4 output.
- **Chain-friendly with:**
    - `fal-ai/kling-video/v2.6/pro/lipsync`: To add custom speech to the generated character.
    - `fal-ai/flux/v1/dev`: To generate the initial high-quality character image for the "Reference Image" port.

## Notes & gotchas
- **Hallucination:** If a character's limbs are obscured in the image (e.g., hands in pockets) but required to move in the video, the AI will "hallucinate" the missing limbs, often causing 6-fingered glitches [Higgsfield](https://higgsfield.ai/blog/Kling-2.6-Motion-Control-Full-Guide).
- **Subject Count:** The model performs best with a single character. If multiple characters are present in the reference video, it will prioritize the largest one [Kling AI](https://kling.ai/quickstart/motion-control-user-guide).
- **Resolution:** Although Pro supports up to 1080p, the base generation resolution is often 720p, requiring an upscaler for cinema-grade results.

## Sources
- [FAL.ai Kling v2.6 Motion Control Docs](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/motion-control/api)
- [Kling AI Motion Control User Guide](https://klingai.com/quickstart/motion-control-user-guide)
- [ComfyUI Partner Nodes - Kling 2.6](https://docs.comfy.org/tutorials/partner-nodes/kling/kling-motion-control)
- [The AI Journal: Kling 2.6 API Review](https://aijourn.com/kling-2-6-api-a-practical-text-to-video-and-image-to-video-api-with-native-audio-generation/)
- [MindStudio Analysis: Kling 2.6 Pro](https://www.mindstudio.ai/blog/what-is-kling-2-6-pro-motion-control-video/)