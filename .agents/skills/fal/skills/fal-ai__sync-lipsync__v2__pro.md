---
name: fal-ai/sync-lipsync/v2/pro
display_name: Sync Lipsync v2 Pro
category: video-to-video
creator: Sync Labs
fal_docs: https://fal.ai/models/fal-ai/sync-lipsync/v2/pro
original_source: https://sync.so/docs/models/lipsync
summary: Studio-grade AI lip synchronization model that uses diffusion-based super-resolution to align video mouth movements with new audio tracks while preserving fine facial details.
---

# Sync Lipsync v2 Pro

## Overview
- **Slug:** `fal-ai/sync-lipsync/v2/pro`
- **Category:** Video-to-Video
- **Creator:** [Sync Labs](https://sync.so/)
- **Best for:** Hyper-realistic visual dubbing and studio-grade lip synchronization for film, marketing, and localized content.
- **FAL docs:** [https://fal.ai/models/fal-ai/sync-lipsync/v2/pro](https://fal.ai/models/fal-ai/sync-lipsync/v2/pro)
- **Original source:** [https://sync.so/docs/models/lipsync](https://sync.so/docs/models/lipsync)

## What it does
Sync Lipsync v2 Pro is a state-of-the-art "zero-shot" video-to-video model designed to synchronize a person's lip movements in an existing video to match a new audio track. Unlike traditional models, it employs **diffusion-based super-resolution** to preserve high-fidelity details such as natural teeth, skin textures, and unique facial features. It is "zero-shot," meaning it does not require training or fine-tuning on a specific person's face to achieve realistic results across various languages and speaking styles.

## When to use this model
- **Use when:** You need professional-grade lip-syncing for high-resolution video (up to 4K via native API), multi-language dubbing where "uncanny valley" effects must be minimized, or when preserving the subject's unique dental and facial characteristics is critical.
- **Don't use when:** The input video is a static image (use an image-to-video model first), the face is heavily occluded (though it has some reasoning capabilities), or for real-time low-latency chat applications (consider faster, lower-quality models like `lipsync-1.9`).
- **Alternatives:**
    - **[Sync-3](https://sync.so/docs/models/sync-3):** Better for extreme angles, partial faces, and native 4K output with built-in obstruction detection.
    - **[lipsync-2](https://fal.ai/models/fal-ai/sync-lipsync/v2):** A faster version that balances quality and speed for general use but lacks the "Pro" super-resolution.
    - **[react-1](https://sync.so/docs/models/react):** Specialized for natural listener reactions and non-verbal cues.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sync-lipsync/v2/pro` (sync) / `https://queue.fal.run/fal-ai/sync-lipsync/v2/pro` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | `string` | *Required* | URL | The URL of the source video containing the person to be lip-synced. |
| `audio_url` | `string` | *Required* | URL | The URL of the audio file to which the lips should be synchronized. |
| `sync_mode` | `enum` | `cut_off` | `cut_off`, `loop`, `bounce`, `silence`, `remap` | Strategy to handle duration mismatches between video and audio. |

### Output
The output is a JSON object containing a reference to the generated video file.
```json
{
  "video": {
    "url": "https://fal.run/storage/outputs/...",
    "content_type": "video/mp4",
    "file_name": "sync_v2_pro_output.mp4",
    "file_size": 123456,
    "width": 1080,
    "height": 1920,
    "fps": 25.0,
    "duration": 10.5,
    "num_frames": 262
  }
}
```

### Example request
```json
{
  "video_url": "https://storage.googleapis.com/falserverless/example_inputs/sync_v2_pro_video_input.mp4",
  "audio_url": "https://storage.googleapis.com/falserverless/example_inputs/sync_v2_pro_audio_input.mp3"
}
```

### Pricing
- **FAL.ai:** Approximately **$5.00 per minute** of video generated.
- **Sync Labs (Direct):** Ranges from **$0.067 to $0.083 per second** of video ($4.00 - $5.00 per minute) depending on the plan.

## API — via Original Source (BYO-key direct)
Sync Labs provides a robust native REST API with additional features not always exposed on third-party providers.

- **Endpoint:** `https://api.sync.so/v2/generate`
- **Auth Method:** `x-api-key` header.
- **Additional Parameters:**
    - `temperature`: (0.0 to 1.0, default 0.5) Controls the expressiveness of lip movements.
    - `reasoning_enabled`: (`boolean`) Enhanced frame analysis for artifacts and complex edge cases.
    - `active_speaker_detection`: (`boolean`) Automatically targets only the speaking person in multi-person shots.
    - `outputFileName`: Custom naming for the generated file.
- **Official Docs:** [Sync Labs API Reference](https://sync.so/docs/api-reference)

## Prompting best practices
*Note: This is a video-to-video model; "prompting" refers to input selection and configuration.*
- **High-Quality Audio:** Ensure the input audio is clean, clear, and has minimal background noise. The model uses the audio waveform to drive phoneme movement.
- **Dynamic Input Video:** The model performs best when the person in the source video is already speaking or moving their face naturally. Avoid perfectly still "frozen" frames.
- **Head Orientation:** Front-facing or slight three-quarter views yield the highest accuracy. While "Pro" is robust, extreme profile views can still lead to distortion.
- **Lighting:** Consistent lighting on the face helps the diffusion model maintain skin texture and detail during the lip replacement process.

## Parameter tuning guide
- **`sync_mode`:** Use `remap` if you want the video to speed up or slow down to perfectly match the audio duration. Use `loop` for short video clips being synced to longer audio.
- **`temperature` (via Native API):** Set to `0.8` for highly emotive or energetic speech; lower to `0.3` for calm, formal narrations to prevent over-animation.
- **`reasoning_enabled` (via Native API):** Always keep this `true` for production-grade content to ensure the most consistent frame-to-frame stability.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Video URL` (File or Link)
    - `Audio URL` (File or Link)
    - `Sync Mode` (Dropdown)
- **Outputs:**
    - `Synced Video URL`
    - `Video Metadata` (Width, Height, Duration)
- **Chain-friendly with:**
    - **ElevenLabs TTS:** Generate high-quality voice clones first, then pass to Sync.
    - **Kling / Runway Gen-3:** Create a base video of a character, then use Sync to add dialogue.
    - **GPT-4o:** Use for script generation and translation before the TTS/Sync pipeline.

## Notes & gotchas
- **Max Duration:** Typically limited to 30 minutes per generation on standard plans.
- **Resolution:** While it can handle 4K inputs, the internal processing resolution may vary; use the native API's `sync-3` model for true 4K native output if required.
- **Wait Times:** As a "Pro" model using diffusion, generation can take several minutes; always use **Queue Mode** or **Webhooks** for a better user experience.

## Sources
- [FAL.ai Sync Lipsync v2 Pro Documentation](https://fal.ai/models/fal-ai/sync-lipsync/v2/pro)
- [Sync Labs Official Documentation](https://sync.so/docs/introduction)
- [Sync Labs Model Overview](https://sync.so/docs/models/lipsync)
- [Sync Labs API Reference](https://sync.so/docs/api-reference/api/generate-api/create)
- [Y Combinator Launch Page](https://www.ycombinator.com/launches/NBu-sync-we-built-the-most-natural-lipsync-model-in-the-world-again)