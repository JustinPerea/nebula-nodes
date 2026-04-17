---
name: fal-ai/elevenlabs/dubbing
display_name: ElevenLabs Dubbing
category: audio-to-video
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/dubbing
original_source: https://elevenlabs.io/dubbing
summary: High-fidelity AI video and audio localization that preserves original voices, emotions, and timing across 30+ languages.
---

# ElevenLabs Dubbing

## Overview
- **Slug:** `fal-ai/elevenlabs/dubbing`
- **Category:** Audio/Video Localization (Dubbing)
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Automatically translating video or audio content into different languages while keeping the original speaker's voice and emotional nuance.
- **FAL docs:** [fal.ai/models/fal-ai/elevenlabs/dubbing](https://fal.ai/models/fal-ai/elevenlabs/dubbing)
- **Original source:** [ElevenLabs Dubbing Documentation](https://elevenlabs.io/docs/overview/capabilities/dubbing)

## What it does
ElevenLabs Dubbing is a state-of-the-art localization tool that translates audio and video content into 30+ languages. Unlike traditional dubbing, it uses advanced voice cloning to preserve the original speaker's unique vocal characteristics, tone, and emotional delivery. It automatically handles speech-to-text, translation, and text-to-speech alignment, ensuring that the new audio track matches the timing and lip-sync of the original video as closely as possible ([ElevenLabs](https://elevenlabs.io/docs/overview/capabilities/dubbing)).

## When to use this model
- **Use when:**
  - Localizing YouTube videos, corporate presentations, or educational content for a global audience.
  - You need to maintain "brand voice" across different languages by using the same speaker's character.
  - You require high-quality, human-like emotional expression in the translated audio.
- **Don't use when:**
  - You need real-time translation (this is an asynchronous, batch-processing model).
  - You have extremely complex multi-speaker overlap (more than 9 speakers) which can degrade quality.
- **Alternatives:**
  - **[fal-ai/elevenlabs/tts](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3):** Use if you just need to generate speech from text and don't need to match an existing video's timing or voices automatically.
  - **[fal-ai/elevenlabs/voice-changer](https://fal.ai/models/fal-ai/elevenlabs/voice-changer):** Use if you want to swap one voice for another in the same language.

## API — via FAL.ai
**Endpoints:** 
- `https://fal.run/fal-ai/elevenlabs/dubbing` (Sync)
- `https://queue.fal.run/fal-ai/elevenlabs/dubbing` (Queue/Async)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | `string` | `None` | URL | URL of the audio file to dub. Either `audio_url` or `video_url` must be provided. |
| `video_url` | `string` | `None` | URL | URL of the video file to dub. If both are provided, `video_url` takes priority. |
| `target_lang` | `string` | **Required** | ISO 639-1 (e.g., `es`, `fr`) | The target language code for the dubbing process. |
| `source_lang` | `string` | `None` | ISO 639-1 | Source language code. If omitted, the model will attempt to auto-detect the language. |
| `num_speakers` | `integer` | `None` | 0-10 | Number of unique speakers in the audio. Auto-detected if not provided. |
| `highest_resolution`| `boolean`| `true` | `true`, `false` | Whether to use the highest possible resolution for the output video. |

### Output
The output returns the dubbed media file and the confirmed target language.
```json
{
  "video": {
    "url": "https://fal.run/.../output.mp4",
    "content_type": "video/mp4",
    "file_name": "dubbed_video.mp4",
    "file_size": 1234567
  },
  "target_lang": "es"
}
```

### Example request
```json
{
  "video_url": "https://example.com/original_video.mp4",
  "target_lang": "fr",
  "source_lang": "en",
  "num_speakers": 1,
  "highest_resolution": true
}
```

### Pricing
- **FAL.ai Pricing:** Approximately **$0.90 per minute** of generated audio/video ([fal.ai/elevenlabs](https://fal.ai/elevenlabs)).
- Note: This is a pay-per-use model with no monthly minimums on FAL.

## API — via Original Source (BYO-key direct)
The creator, ElevenLabs, offers a direct REST API for users with their own API keys.

- **Endpoint:** `POST https://api.elevenlabs.io/v1/dubbing`
- **Auth Method:** `xi-api-key` header.
- **Additional Parameters:** 
  - `mode`: Allows selecting between "automatic" and "dubbing_studio" modes.
  - `watermark`: Boolean to include/remove watermark (availability depends on plan).
- **Official Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/dubbing/create)

## Prompting best practices
- **Clear Audio:** Ensure the source audio is clear of heavy background music or noise for better speaker isolation and translation accuracy.
- **Language Specificity:** Always provide the `source_lang` if known; auto-detection is good but explicit tagging reduces the chance of initial transcription errors.
- **Speaker Count:** If the video has multiple people, providing the exact `num_speakers` helps the diarization engine assign the correct cloned voices to the right people.
- **Avoid Overlap:** Highly overlapping speech (people talking over each other) is the most common failure mode for AI dubbing. Clean turn-taking produces the best results.

## Parameter tuning guide
- **`highest_resolution`:** Set to `true` for final production assets. Set to `false` during testing if you want to potentially reduce processing time or bandwidth (though FAL pricing is usually duration-based).
- **`num_speakers`:** If the output voices sound mixed up, manually set this to the correct number of people present in the file.
- **`target_lang`:** Ensure you use the correct ISO 639-1 code. Using `es` for Spanish, `ja` for Japanese, etc.

## Node inputs/outputs
- **Inputs:**
  - `Video/Audio URL`: The source media.
  - `Target Language`: The destination language code.
  - `Speaker Count`: (Optional) Manual hint for diarization.
- **Outputs:**
  - `Dubbed Media`: The final localized video or audio file.
- **Chain-friendly with:**
  - **[fal-ai/kling-video](https://fal.ai/models/fal-ai/kling-video):** Create a video, then pass it to ElevenLabs Dubbing to add a localized voiceover.
  - **[fal-ai/elevenlabs/speech-to-text](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text):** Use to generate a transcript for review before dubbing.

## Notes & gotchas
- **Max Duration:** The ElevenLabs API supports files up to **2.5 hours** and **1GB** in size ([ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/dubbing)).
- **Processing Time:** Dubbing is a multi-step process (Transcription -> Translation -> Voice Synthesis -> Video Re-encoding). It typically takes 1-2x the duration of the source video to process. Always use the **Queue Mode** for production workflows.
- **Commercial Use:** Content generated via ElevenLabs on FAL.ai is generally licensed for commercial use, but check your specific FAL tier or ElevenLabs plan for details regarding attribution requirements.

## Sources
- [FAL.ai ElevenLabs Dubbing Page](https://fal.ai/models/fal-ai/elevenlabs/dubbing)
- [FAL.ai ElevenLabs Partnership Overview](https://fal.ai/elevenlabs)
- [ElevenLabs Official Dubbing Documentation](https://elevenlabs.io/docs/overview/capabilities/dubbing)
- [ElevenLabs API Pricing](https://elevenlabs.io/pricing/api)
