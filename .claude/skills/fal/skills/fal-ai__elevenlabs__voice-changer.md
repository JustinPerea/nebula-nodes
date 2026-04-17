---
name: fal-ai/elevenlabs/voice-changer
display_name: ElevenLabs Voice Changer
category: audio-to-audio
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/voice-changer
original_source: https://elevenlabs.io/docs/api-reference/speech-to-speech/convert
summary: Transform any voice audio into a different, high-quality ElevenLabs voice while preserving the original performance's emotion and nuance.
---

# ElevenLabs Voice Changer

## Overview
- **Slug:** `fal-ai/elevenlabs/voice-changer`
- **Category:** Audio-to-Audio / Voice Conversion
- **Creator:** [ElevenLabs](https://elevenlabs.io)
- **Best for:** High-fidelity voice transformation preserving emotional nuance.
- **FAL docs:** [fal.ai/models/fal-ai/elevenlabs/voice-changer](https://fal.ai/models/fal-ai/elevenlabs/voice-changer)
- **Original source:** [ElevenLabs Speech-to-Speech API](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert)

## What it does
The ElevenLabs Voice Changer (also known as Speech-to-Speech) allows users to transform the voice in an audio recording into a different, fully cloned or designed voice. Unlike traditional Text-to-Speech, this model captures and mimics the performance nuances of the original audio—including whispers, laughs, cries, accents, and subtle emotional cues—while replacing the vocal characteristics with the target voice [ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/voice-changer). It is widely used for character voice consistency, fixing dialog in post-production, and creating localized content with high emotional fidelity.

## When to use this model
- **Use when:** You have a performance (e.g., an actor's voice) that has the right emotion and timing, but you want to change the speaker's identity to a specific AI voice or a cloned voice.
- **Don't use when:** You only have text (use Text-to-Speech instead) or when you need real-time low-latency translation (though it is fast, it is optimized for file-based conversion).
- **Alternatives:** 
    - `fal-ai/elevenlabs/text-to-speech`: Use if you don't have a source audio performance and need to generate speech from text.
    - `fal-ai/whisper`: Use for transcribing audio to text without changing the voice.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/voice-changer` (sync) / `https://queue.fal.run/fal-ai/elevenlabs/voice-changer` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | `string` | *Required* | URL | The input audio file to be transformed. Supports mp3, ogg, wav, m4a, aac [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api). |
| `voice` | `string` | `"Rachel"` | Voice Name/ID | The voice to use for the transformed audio. Can be a name like "Rachel", "Arla", or a specific ElevenLabs `voice_id` [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api). |
| `remove_background_noise` | `boolean` | `false` | `true`, `false` | If enabled, removes background noise from the input audio before processing [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api). |
| `seed` | `integer` | `null` | 0 - 4294967295 | Optional seed for reproducible generation [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api). |
| `output_format` | `enum` | `"mp3_44100_128"` | see below | Output format (codec, sample rate, and bitrate) [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api). |

**Possible `output_format` values:**
- `mp3_22050_32`, `mp3_44100_32`, `mp3_44100_64`, `mp3_44100_96`, `mp3_44100_128`, `mp3_44100_192`
- `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_44100`, `pcm_48000`
- `ulaw_8000`, `alaw_8000`
- `opus_48000_32`, `opus_48000_64`, `opus_48000_96`, `opus_48000_128`, `opus_48000_192`

### Output
The output is a JSON object containing:
- `audio`: A File object containing the `url` of the generated audio, `content_type`, `file_name`, and `file_size`.
- `seed`: The integer seed used for the generation [fal.ai Schema](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api).

### Example request
```json
{
  "audio_url": "https://storage.googleapis.com/falserverless/example_inputs/elevenlabs/voice_change_in.mp3",
  "voice": "Arla",
  "remove_background_noise": true,
  "output_format": "mp3_44100_128"
}
```

### Pricing
FAL.ai charges approximately **$0.3 per minute** of processed audio for this model [fal.ai Playground](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/playground).

---

## API — via Original Source (BYO-key direct)
ElevenLabs provides a direct API for Speech-to-Speech conversion.

- **Endpoint:** `POST https://api.elevenlabs.io/v1/speech-to-speech/{voice_id}`
- **Auth:** Requires `xi-api-key` in headers.
- **Additional Parameters:**
    - `model_id`: Defaults to `eleven_english_sts_v2`. Use `eleven_multilingual_sts_v2` for non-English source audio.
    - `voice_settings`: A JSON object with `stability`, `similarity_boost`, `style`, and `use_speaker_boost`.
- **Pricing:** 1,000 credits per minute of processed audio [ElevenLabs Help](https://help.elevenlabs.io/hc/en-us/articles/24938328105873-How-much-does-Voice-Changer-cost).
- **Official Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert)

## Prompting best practices
- **Performance is Key:** The model is a "mirror." If the input audio is monotone, the output will be monotone. If the input has high energy, the output will follow [ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/voice-changer).
- **Clean Audio:** Use `remove_background_noise=true` if your source recording has ambient hum or static, as these can sometimes be interpreted as vocal textures by the model.
- **Voice Selection:** Choose a target voice that matches the "character" of the performance. A deep male voice performance might sound unnatural when mapped to a high-pitched child's voice.
- **Language Matching:** While the model is multilingual, using the `eleven_multilingual_sts_v2` model (via direct API or if default on FAL) ensures better handling of non-English accents.

## Parameter tuning guide
- **Voice Selection:** Start with the default "Rachel" or "Arla" for testing. For production, use the `voice_id` of a professionally cloned voice for the best results.
- **Output Format:** For web apps, `mp3_44100_128` is the sweet spot for quality vs. file size. For professional post-production, use `pcm_44100` or `mp3_44100_192`.
- **Seed:** Use a fixed seed if you are iterating on other parameters and want to ensure the vocal delivery remains consistent across calls.

## Node inputs/outputs
- **Inputs:**
    - `Audio URL`: The source audio to transform.
    - `Voice Name/ID`: The destination voice identity.
    - `Remove Noise`: Toggle to clean the source audio.
- **Outputs:**
    - `Audio URL`: The transformed audio file.
- **Chain-friendly with:**
    - `fal-ai/whisper`: To get a transcript of the transformed audio.
    - `fal-ai/foley-v1`: To add sound effects to the transformed voice performance.

## Notes & gotchas
- **Max Duration:** ElevenLabs typically limits single requests to 5 minutes of audio. Longer files should be chunked [ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/voice-changer).
- **Nondeterminism:** Output can vary slightly even with the same parameters unless a `seed` is specified.
- **Commercial Use:** Commercial rights for the generated audio depend on your ElevenLabs/FAL subscription tier [ElevenLabs Pricing](https://elevenlabs.io/pricing).

## Sources
- [FAL.ai ElevenLabs Voice Changer Docs](https://fal.ai/models/fal-ai/elevenlabs/voice-changer/api)
- [ElevenLabs Speech-to-Speech API Reference](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert)
- [ElevenLabs Voice Changer Capabilities](https://elevenlabs.io/docs/overview/capabilities/voice-changer)
- [ElevenLabs Pricing and Credits](https://help.elevenlabs.io/hc/en-us/articles/24938328105873-How-much-does-Voice-Changer-cost)