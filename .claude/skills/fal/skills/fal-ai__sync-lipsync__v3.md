---
name: fal-ai/sync-lipsync/v3
display_name: sync-3 Lipsync
category: video-to-video
creator: Sync Labs
fal_docs: https://fal.ai/models/fal-ai/sync-lipsync/v3
original_source: https://sync.so/docs/models/sync-3
summary: A studio-grade, 16B-parameter lipsync model that provides 4K native output and handles extreme angles and obstructions.
---

# sync-3 Lipsync

## Overview
- **Slug:** `fal-ai/sync-lipsync/v3`
- **Category:** Video-to-Video / Lipsync
- **Creator:** [Sync Labs](https://sync.so/)
- **Best for:** Professional-grade video dubbing with extreme facial angles, occlusions, and 4K native resolution.
- **FAL docs:** [fal-ai/sync-lipsync/v3](https://fal.ai/models/fal-ai/sync-lipsync/v3)
- **Original source:** [Sync.so Documentation](https://sync.so/docs/models/sync-3)

## What it does
`sync-3` is a generational leap in AI lip synchronization, utilizing a 16-billion-parameter architecture (32x larger than its predecessor) to "understand" entire performances rather than processing isolated frames. It maps facial structure, lighting, and movement across a global spatial window, allowing it to preserve the original speaker's emotional cadence and even naturally open silent lips to match speech. Unlike previous models that stitched independent snippets, `sync-3` generates all frames at once for flawless temporal consistency.

## When to use this model
- **Use when:** You need studio-grade quality for cinematic close-ups, profile shots, or scenes where the face is partially obscured (e.g., by hands, microphones, or scarves). It is ideal for 4K production workflows and professional localization.
- **Don't use when:** You are doing low-resolution batch processing where cost is the primary concern, or for extremely long videos where a lower-tier model like `lipsync-2` might suffice.
- **Alternatives:** 
    - `fal-ai/sync-lipsync/v2-pro`: High quality with diffusion-based super-resolution, but less robust with obstructions.
    - `fal-ai/sync-lipsync/v2`: Faster and more affordable for general use cases.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sync-lipsync/v3` (sync) / `https://queue.fal.run/fal-ai/sync-lipsync/v3` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | string | (required) | URL | The URL of the source video containing the speaker. |
| `audio_url` | string | (required) | URL | The URL of the target audio to sync the lips to. |
| `sync_mode` | enum | `cut_off` | `cut_off`, `loop`, `bounce`, `silence`, `remap` | Defines how to handle duration mismatches between video and audio. |

### Output
The output is a JSON object containing a `video` file reference:
```json
{
  "video": {
    "url": "https://fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567,
    "width": 3840,
    "height": 2160,
    "fps": 25,
    "duration": 15.5
  }
}
```

### Example request
```json
{
  "video_url": "https://example.com/source_video.mp4",
  "audio_url": "https://example.com/target_audio.mp3",
  "sync_mode": "cut_off"
}
```

### Pricing
- **Cost:** ~$8.00 per minute of video processed ($0.133 per second).
- Pricing is based on the duration of the processed video.

## API — via Original Source (BYO-key direct)
Sync Labs provides a native API with advanced features.
- **Endpoint:** `https://api.sync.so/v2/generate`
- **Auth method:** API Key via `X-API-KEY` header.
- **Native features:** Supports "Active Speaker Detection" and direct integration with Adobe Premiere via a plugin.
- **Official Docs:** [Sync.so API Reference](https://sync.so/docs/api-reference)

## Prompting best practices (Input Media Tips)
Since this is a video-to-video model, "prompting" refers to the quality of the input assets:
- **Clean Audio:** Use noise-free audio. The model maps phonemes to mouth movements; background noise or music can lead to "mushy" lip sync.
- **High Resolution:** While `sync-3` has built-in super-resolution, starting with 1080p or 4K footage ensures the best preservation of skin texture and teeth.
- **Natural Motion:** The model works best when the speaker has some natural head movement or facial expression, as it uses these cues to ground the synthetic lip movements.
- **Lighting:** Avoid extreme shadows on the mouth area. Even lighting allows the model's "spatial reasoning" to better map the facial geometry.

## Parameter tuning guide
- **sync_mode:**
    - `cut_off` (Default): Use when you want the output to end as soon as the shortest input finishes.
    - `loop`: Ideal for short "talking head" clips where you want the character to keep talking for a longer audio duration.
    - `bounce`: Useful for creating a seamless loop by playing the video forward and then backward.
    - `remap`: Use if you want to time-stretch the video to perfectly match the audio duration (best for small differences).

## Node inputs/outputs
- **Inputs:**
    - `Video URL`: The source footage.
    - `Audio URL`: The target speech.
- **Outputs:**
    - `Video URL`: The final synced video.
- **Chain-friendly with:**
    - `fal-ai/kling-video`: Generate high-quality AI video first, then use `sync-3` to add custom dialogue.
    - `fal-ai/veo3`: Pair with Google's Veo for high-fidelity avatar generation.
    - `elevenlabs`: Use for high-quality TTS audio as the input for `audio_url`.

## Notes & gotchas
- **Silent Lip Opening:** `sync-3` can open the lips of a speaker who is silent in the original video, but for the most realistic "speaker-style" match, it is better if the speaker is already talking in the source.
- **Automatic Handling:** Features like "Obstruction Detection" and "Spatial Reasoning" are handled natively in `sync-3`, so there are no manual toggles for these (unlike in older versions).
- **Max Duration:** Large jobs (over 2-3 minutes) should always use the `queue` mode to avoid timeout errors.

## Sources
- [FAL.ai sync-3 Documentation](https://fal.ai/models/fal-ai/sync-lipsync/v3/api)
- [Sync.so Official Model Page](https://sync.so/docs/models/sync-3)
- [WaveSpeedAI Technical Specs](https://wavespeed.ai/blog/posts/introducing-sync-lipsync-3-on-wavespeedai/)
- [Sync Labs Lipsync Comparison](https://sync.so/docs/models/lipsync)
