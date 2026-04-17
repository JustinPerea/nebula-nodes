---
name: veed/lipsync
display_name: VEED Lipsync
category: video-to-video
creator: VEED.io
fal_docs: https://fal.ai/models/veed/lipsync
original_source: https://www.veed.io/tools/lip-sync-api
summary: A high-performance video-to-video model that remaps speaker lip movements to match any provided audio track with natural facial dynamics.
---

# VEED Lipsync

## Overview
- **Slug:** `veed/lipsync`
- **Category:** Video-to-Video / Lip Synchronization
- **Creator:** [VEED.io](https://www.veed.io/tools/lip-sync-api)
- **Best for:** Synchronizing an existing video of a person speaking with a new audio track (dubbing, localization, or rephrasing).
- **FAL docs:** [https://fal.ai/models/veed/lipsync](https://fal.ai/models/veed/lipsync)
- **Original source:** [https://www.veed.io/tools/lip-sync-api](https://www.veed.io/tools/lip-sync-api)

## What it does
VEED Lipsync is a specialized video-to-video model that analyzes facial movements in a source video and intelligently remaps the speaker's lip positions to perfectly align with a new audio track. Unlike simple animation tools, it handles natural mouth shapes (visemes), speech timing, and facial dynamics automatically, ensuring that the speaker appears to be naturally saying the new audio while maintaining their original authentic facial expressions and head movements.

## When to use this model
- **Use when:** You need to dub an existing video into a different language, swap out specific words/sentences in a recorded video without re-shooting, or create realistic lip-sync for AI-generated talking heads.
- **Don't use when:** You are starting from a static image (use [VEED Fabric 1.0](https://fal.ai/models/veed/fabric-1.0) instead) or when the speaker's face is heavily occluded or in a side profile, as this reduces synchronization quality.
- **Alternatives:** 
    - **[VEED Fabric 1.0](https://fal.ai/models/veed/fabric-1.0):** Best for Image-to-Video talking heads.
    - **[Sync Labs](https://fal.ai/models/fal-ai/sync-labs/lipsync):** Another high-fidelity lip-sync option with different performance characteristics.

## API — via FAL.ai
**Endpoint:** `https://fal.run/veed/lipsync` (sync) / `https://queue.fal.run/veed/lipsync` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | `string` | *(Required)* | URL / Base64 | The source video file containing the speaker. Supported: mp4, mov, webm, m4v, gif. |
| `audio_url` | `string` | *(Required)* | URL / Base64 | The new audio file to sync the lips to. Supported: mp3, ogg, wav, m4a, aac. |

### Output
The model returns a JSON object containing a `video` field with details about the generated file.

```json
{
  "video": {
    "url": "https://v3.fal.media/files/penguin/PsA4BJPGAojXKW2Qgztm4_tmpe_e1cgbq.mp4",
    "content_type": "video/mp4",
    "file_name": "lipsync_output.mp4",
    "file_size": 4404019
  }
}
```

### Example request
```json
{
  "video_url": "https://v3.fal.media/files/monkey/q1fDPhRPfjfsaRmbhTed4_influencer.mp4",
  "audio_url": "https://v3.fal.media/files/rabbit/Ql3ade3wEKlZXRQLRbhxm_tts.mp3"
}
```

### Pricing
- **Cost:** $0.40 per minute of video processed ([VEED Pricing](https://www.veed.io/api)).
- **Minimum charge:** $0.15 (equivalent to 5 seconds of audio) ([WaveSpeedAI](https://wavespeed.ai/models/veed/lipsync)).
- **Max duration:** Up to 5 minutes (300 seconds) ([VEED Docs](https://www.veed.io/tools/lip-sync-api)).

## API — via Original Source (BYO-key direct)
VEED provides a native API for its suite of tools, though the Lipsync API is primarily exposed via partners like FAL.ai for broad developer access.
- **Endpoint:** `https://api.veed.io/api/renders` (General render endpoint)
- **Auth method:** `Authorization: veed_test_xxxxxxxx`
- **Docs:** [VEED.io Developer Portal](https://www.veed.io/api)

## Prompting best practices
- **Clean Inputs:** Ensure the source video has a clear, well-lit view of the speaker's face. Minimal head movement and a front-facing perspective yield the best results.
- **High-Quality Audio:** Use clear, noise-free audio. The model maps phonemes to visemes; background noise or multiple speakers in the audio can confuse the lip-syncing engine.
- **Match Tone:** For the most realistic result, ensure the "energy" or emotion in the audio matches the speaker's facial expressions in the source video.
- **Avoid Occlusions:** Ensure the mouth area is not covered by hands, microphones, or heavy shadows.

## Parameter tuning guide
The VEED Lipsync model is designed for simplicity and currently does not expose complex tuning parameters like CFG or steps via the FAL.ai interface. The primary "tuning" happens in the preparation of assets:
- **Pre-flight Checks:** Validate the aspect ratio and face position in the video before submission.
- **Segmenting:** For videos longer than 5 minutes, split the video into segments, process each, and then stitch them together to stay within API limits.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Source Video` (URL or File)
    - `Target Audio` (URL or File)
- **Outputs:**
    - `Processed Video` (MP4 URL)
- **Chain-friendly with:**
    - **[ElevenLabs TTS](https://fal.ai/models/fal-ai/elevenlabs/tts):** Use to generate the high-quality audio track before syncing.
    - **[Remove Background (Video)](https://fal.ai/models/fal-ai/video-background-removal):** Use to clean up the source video before or after syncing.
    - **[Whisper](https://fal.ai/models/fal-ai/whisper):** To transcribe the original video for translation purposes before generating new audio.

## Notes & gotchas
- **Processing Time:** Generation typically takes 2 to 2.5 times the duration of the input video (e.g., a 1-minute video takes ~2 minutes to process).
- **Format Support:** Supports various aspect ratios (9:16, 16:9, 1:1) and maintains the original resolution and frame rate.
- **Queue Mode:** Highly recommended for production use due to the async nature of video generation.

## Sources
- [FAL.ai Lipsync Documentation](https://fal.ai/models/veed/lipsync)
- [VEED.io Lip Sync API Official Page](https://www.veed.io/tools/lip-sync-api)
- [VEED Fabric 1.0 Technical Report](https://www.veed.io/learn/fabric-1-0-api)
- [WaveSpeedAI Model Specs](https://wavespeed.ai/models/veed/lipsync)
