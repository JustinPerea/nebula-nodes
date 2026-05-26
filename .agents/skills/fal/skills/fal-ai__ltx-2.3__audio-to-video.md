---
name: fal-ai/ltx-2.3/audio-to-video
display_name: LTX-2.3 Audio-to-Video
category: audio-to-video
creator: Lightricks
fal_docs: https://fal.ai/models/fal-ai/ltx-2.3/audio-to-video
original_source: https://ltx.video/
summary: A high-fidelity DiT-based model that generates synchronized video from audio clips, supporting text and image-driven animation.
---

# LTX-2.3 Audio-to-Video

## Overview
- **Slug:** `fal-ai/ltx-2.3/audio-to-video`
- **Category:** audio-to-video
- **Creator:** [Lightricks](https://ltx.video/)
- **Best for:** Synchronizing high-fidelity video motion and character speech with an input audio track.
- **FAL docs:** [fal-ai/ltx-2.3/audio-to-video](https://fal.ai/models/fal-ai/ltx-2.3/audio-to-video)
- **Original source:** [Lightricks LTX Documentation](https://docs.ltx.video/welcome)

## What it does
LTX-2.3 Audio-to-Video is a DiT-based (Diffusion Transformer) foundation model designed to generate video content that is perfectly synchronized with an input audio file. Unlike traditional models that might generate audio for a video, this model uses the audio's rhythm, energy, and dialogue to drive character movement, camera motion, and scene transitions. It supports generating visuals from scratch via text prompts or animating a provided starting image to match the audio's temporal characteristics.

## When to use this model
- **Use when:** You have a specific audio track (voiceover, music, or ambient sound) and need visuals that react to it with accurate timing.
- **Don't use when:** You need long-form content (over 20 seconds) in a single pass or when precise text rendering within the video is required.
- **Alternatives:**
    - `fal-ai/ltx-2.3/text-to-video`: Better for general video generation without a specific audio driver.
    - `fal-ai/ltx-2.3/image-to-video`: Ideal for high-quality animation of a single static image without audio constraints.
    - `fal-ai/kling-video`: Offers longer durations and different motion styles, but lacks the specialized audio-to-motion synchronization of LTX-2.3.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ltx-2.3/audio-to-video` (sync) / `https://queue.fal.run/fal-ai/ltx-2.3/audio-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | *required* | URL | URL of the audio file (2-20 seconds). Supported formats: mp3, ogg, wav, m4a, aac. |
| `image_url` | string | Optional | URL | URL of an image to use as the first frame. Required if `prompt` is not provided. |
| `prompt` | string | Optional | Text | Description of the scene. Required if `image_url` is not provided. |
| `guidance_scale` | float | 5.0 / 9.0 | 1.0 - 50.0 | Controls prompt adherence. Defaults to 5 for text-only and 9 when an image is provided. |
| `aspect_ratio` | enum | `auto` | `auto`, `16:9`, `9:16` | The aspect ratio of the video. `auto` inherits from the input image. |

### Output
The output is a JSON object containing a `video` field with metadata and a downloadable URL.
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567,
    "width": 1280,
    "height": 720,
    "fps": 25,
    "duration": 9.0,
    "num_frames": 225
  }
}
```

### Example request
```json
{
  "audio_url": "https://example.com/audio.mp3",
  "prompt": "A close-up of a man speaking with intense emotion, cinematic lighting, shallow depth of field.",
  "aspect_ratio": "16:9"
}
```

### Pricing
- **Cost:** $0.10 per second of generated video ([FAL.ai](https://fal.ai/models/fal-ai/ltx-2.3/audio-to-video)).
- **Minimums:** Pay-per-second, no minimums.

## API — via Original Source (BYO-key direct)
Lightricks provides a direct API for the LTX model family.
- **Endpoint:** `https://api.ltx.video/v1/audio-to-video`
- **Auth method:** Bearer Token (API Key from [LTX Console](https://console.ltx.video/))
- **Additional parameters:**
    - `resolution`: Explicitly set resolution (e.g., `1920x1080`).
    - `model`: Specify `ltx-2-3-pro` or other variants.
- **Official docs:** [LTX API Reference](https://docs.ltx.video/api-documentation/api-reference/video-generation/audio-to-video)

## Prompting best practices
- **Cinematic Language:** Use specific cinematography terms like "slow dolly in," "handheld tracking," or "over-the-shoulder" to improve motion consistency ([Lightricks Blog](https://ltx.video/blog/how-to-prompt-for-ltx-2)).
- **Describe Audio Cues:** Explicitly mention audio elements in the prompt, e.g., "The character's lips move in sync with the dialogue."
- **Avoid Internal States:** Instead of "sad," use visual cues like "shoulders slumped, looking down, eyes watery."
- **Keep it Single-Paragraph:** Write prompts as a single flowing paragraph of 4-8 descriptive sentences.
- **Dialogue Handling:** For specific dialogue, you can place text between quotes in the prompt to help the model align lip-sync.

## Parameter tuning guide
- **Guidance Scale (CFG):**
    - **3.0 - 5.0:** Best for natural, photorealistic text-to-video results.
    - **7.0 - 12.0:** Use when animating an image to ensure the output remains faithful to the original source frame.
- **Aspect Ratio:** Use `auto` when providing an image to prevent distortion; otherwise, match the target platform (16:9 for desktop, 9:16 for social media).
- **Audio Duration:** Ensure your audio clip is exactly the length you want the video to be (up to 20s), as the model maps motion to the full duration of the provided audio.

## Node inputs/outputs
- **Inputs:**
    - `audio_url` (Audio Port/URL)
    - `image_url` (Image Port/URL - Optional)
    - `prompt` (String)
    - `guidance_scale` (Number)
- **Outputs:**
    - `video_url` (Video Port/URL)
    - `metadata` (JSON containing resolution and duration)
- **Chain-friendly with:**
    - `fal-ai/ltx-2.3/extend`: Use to lengthen the video after the initial 20s.
    - `fal-ai/ltx-2.3/retake`: Re-generate specific segments if the lip-sync or motion is slightly off.
    - `elevenlabs/speech`: Generate the input audio for high-quality voice-driven animation.

## Notes & gotchas
- **Divisibility Rule:** For local execution, dimensions must be divisible by 32 and frame counts by 8 + 1, though FAL's API handles most of this padding automatically ([Hugging Face](https://huggingface.co/Lightricks/LTX-2.3)).
- **Motion Limits:** Avoid extremely complex or chaotic physics (like juggling or fast twisting) as they can lead to visual artifacts.
- **Audio Quality:** When generating video without a clear speech component, the audio-to-motion mapping may be less precise.

## Sources
- [FAL.ai LTX-2.3 Audio-to-Video Docs](https://fal.ai/models/fal-ai/ltx-2.3/audio-to-video/api)
- [Official Lightricks LTX Documentation](https://docs.ltx.video/welcome)
- [LTX-2.3 Hugging Face Model Card](https://huggingface.co/Lightricks/LTX-2.3)
- [Lightricks Prompting Guide](https://ltx.video/blog/how-to-prompt-for-ltx-2)
- [LTX-2: Efficient Joint Audio-Visual Foundation Model (ArXiv)](https://huggingface.co/papers/2601.03233)
