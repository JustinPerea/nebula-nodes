---
name: fal-ai/elevenlabs/audio-isolation
display_name: ElevenLabs Audio Isolation
category: audio-to-audio
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/audio-isolation
original_source: https://elevenlabs.io/voice-isolator
summary: Professional-grade AI tool that extracts clean voice tracks by removing background noise, music, and ambient interference from audio and video files.
---

# ElevenLabs Audio Isolation

## Overview
- **Slug:** `fal-ai/elevenlabs/audio-isolation`
- **Category:** Audio-to-Audio / Voice Processing
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Extracting studio-quality clean speech from noisy field recordings or video files.
- **FAL docs:** [fal-ai/elevenlabs/audio-isolation](https://fal.ai/models/fal-ai/elevenlabs/audio-isolation)
- **Original source:** [ElevenLabs Voice Isolator](https://elevenlabs.io/voice-isolator)

## What it does
ElevenLabs Audio Isolation (also known as Voice Isolator) uses advanced AI to isolate and enhance human voice content while aggressively removing background noise, wind, traffic, music, and other non-voice interference. It is designed to transform "muddy" or noisy audio into professional, studio-grade vocal tracks. While optimized for speech, it can also be used to clean up vocals in video content for better clarity in post-production.

## When to use this model
- **Use when:** You have a podcast recording with significant background hum, a video interview recorded in a busy street, or any voice recording where the speaker is hard to hear due to environmental noise.
- **Don't use when:** You need to isolate specific musical instruments or remove vocals from a song (it is speech-optimized, not a general stems splitter).
- **Alternatives:**
    - **[fal-ai/whisper](https://fal.ai/models/fal-ai/whisper):** Use if you only need the *text* transcript and don't need the cleaned audio file.
    - **[fal-ai/elevenlabs/speech-to-speech](https://fal.ai/models/fal-ai/elevenlabs/audio-to-audio):** Use if you want to change the speaker's voice entirely while maintaining their performance. Note: this model often has a `remove_background_noise` toggle that uses the same technology internally.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/audio-isolation` (sync) / `https://queue.fal.run/fal-ai/elevenlabs/audio-isolation` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | `None` | URL | URL of the audio file to isolate voice from. Supported: `mp3, ogg, wav, m4a, aac`. |
| `video_url` | string | `None` | URL | URL of the video file to use for audio isolation. Supported: `mp4, mov, webm, m4v, gif`. |

*Note: Either `audio_url` or `video_url` must be provided.*

### Output
The output is a JSON object containing the URL to the cleaned audio file and optional word-level timestamps if supported by the specific version.

```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/mpeg",
    "file_name": "isolated_audio.mp3",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "audio_url": "https://example.com/noisy_podcast.mp3"
}
```

### Pricing
- **FAL.ai:** Approximately **$0.10 per minute** of audio processed ([FAL.ai Pricing](https://fal.ai/models/fal-ai/elevenlabs/audio-isolation)).
- **ElevenLabs Direct:** Costs roughly **1,000 characters per minute** of audio (part of your character-based subscription quota) ([ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/voice-isolator)).

## API — via Original Source (BYO-key direct)
ElevenLabs provides a direct REST API for this model.
- **Endpoint:** `POST https://api.elevenlabs.io/v1/audio-isolation`
- **Auth:** `xi-api-key` header.
- **Additional Parameters:**
    - `file_format`: Supports `pcm_s16le_16` for low-latency applications (16-bit PCM at 16kHz mono).
- **Official Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/audio-isolation/convert)

## Prompting best practices
Since this is an audio-to-audio processing model, there are no text prompts. However, "prompting" the input data is key:
- **High-gain inputs:** If the recording is extremely quiet, normalize it slightly before sending it to ensure the AI can clearly distinguish the speech patterns from the noise floor.
- **Avoid overlapping speakers:** The model is excellent at noise removal but can struggle if two people are speaking loudly at the same time; try to provide segments with clear turn-taking.
- **Format choice:** Uploading in lossless formats like `WAV` or `FLAC` yields better results than heavily compressed `MP3`s, as it preserves the artifacts the AI needs to separate the signal from the noise.

## Parameter tuning guide
FAL.ai's implementation is a "black box" one-click solution. However, when using the **Direct API**, you can tune:
- **`file_format`:** Set to `pcm_s16le_16` if you are building a real-time streaming application (e.g., a live clean-up tool) to reduce latency by skipping the encoding/decoding overhead of MP3.
- **Streaming:** Use the `/v1/audio-isolation/stream` endpoint for real-time results rather than waiting for the entire file to process.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio/Video URL`: The source media to be cleaned.
- **Outputs:**
    - `Clean Audio URL`: The resulting isolated vocal track.
- **Chain-friendly with:**
    - **[fal-ai/whisper](https://fal.ai/models/fal-ai/whisper):** Chain the output of Audio Isolation into Whisper for near-perfect transcription of noisy audio.
    - **[fal-ai/elevenlabs/speech-to-text](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text):** Use the cleaned audio for more accurate diarization (speaker identification).
    - **[fal-ai/elevenlabs/voice-cloning](https://fal.ai/models/fal-ai/elevenlabs/voice-cloning):** Clean up a sample before using it as a source for a Professional Voice Clone.

## Notes & gotchas
- **Max Duration:** FAL and ElevenLabs generally limit single uploads to **1 hour** or **500MB**.
- **Not for Music:** While it will attempt to remove background music from a voice, it is not a professional tool for "karaoke" style vocal extraction from songs; it may introduce "underwater" artifacts if pushed on complex musical tracks.
- **Streaming:** FAL supports streaming mode for this model, allowing for lower time-to-first-byte in interactive apps.

## Sources
- [FAL.ai Audio Isolation Documentation](https://fal.ai/models/fal-ai/elevenlabs/audio-isolation/api)
- [ElevenLabs Voice Isolator Official Page](https://elevenlabs.io/voice-isolator)
- [ElevenLabs API Reference for Audio Isolation](https://elevenlabs.io/docs/api-reference/audio-isolation/convert)
- [ElevenLabs Character-to-Minute Conversion Guide](https://elevenlabs.io/docs/overview/capabilities/voice-isolator)
