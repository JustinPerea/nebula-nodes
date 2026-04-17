---
name: fal-ai/chatterbox/speech-to-speech
display_name: Chatterbox Speech-to-Speech
category: audio-to-audio
creator: Resemble AI
fal_docs: https://fal.ai/models/fal-ai/chatterbox/speech-to-speech
original_source: https://docs.resemble.ai/voice-generation/speech-to-speech, https://github.com/resemble-ai/chatterbox
summary: A professional-grade voice conversion model from Resemble AI that clones a target voice while preserving the original audio's timing and delivery.
---

# Chatterbox Speech-to-Speech

## Overview
- **Slug:** `fal-ai/chatterbox/speech-to-speech`
- **Category:** Speech-to-Speech / Voice Conversion
- **Creator:** [Resemble AI](https://www.resemble.ai/)
- **Best for:** High-fidelity voice conversion that preserves emotional nuance and timing.
- **FAL docs:** [fal-ai/chatterbox/speech-to-speech](https://fal.ai/models/fal-ai/chatterbox/speech-to-speech)
- **Original source:** [Resemble AI Documentation](https://docs.resemble.ai/voice-generation/speech-to-speech)

## What it does
Chatterbox Speech-to-Speech (STS) allows users to transform a "source" audio recording into the voice of a "target" speaker. Unlike traditional Text-to-Speech, this model preserves the exact prosody, timing, and delivery of the source audio while mapping the vocal characteristics of the target. It is built on Resemble AI's "Chatterbox" architecture, which utilizes a diffusion-based autoregressive backbone (0.5B parameters) to achieve state-of-the-art voice cloning.

## When to use this model
- **Use when:** You need to change the identity of a speaker while keeping their unique emotional performance, pauses, and cadence intact (e.g., dubbing, game character voice replacement, or creative "memes").
- **Don't use when:** You only have text and need to generate speech from scratch (use [Chatterbox TTS](https://fal.ai/models/fal-ai/chatterbox/text-to-speech) instead).
- **Alternatives:** 
    - **[GPT-4o / ElevenLabs STS]:** Often used for similar tasks but may have different pricing models or latency profiles.
    - **[Resemble Core STS v2]:** The native version available directly via Resemble AI's API which may offer more granular control over sample rates and formats.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/chatterbox/speech-to-speech` (sync) / `https://queue.fal.run/fal-ai/chatterbox/speech-to-speech` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `source_audio_url` | `string` | *Required* | Any public URL | The URL of the source audio file containing the speech you want to convert. Supports mp3, ogg, wav, m4a, aac. |
| `target_voice_audio_url` | `string` | `null` | Any public URL | Optional URL to an audio file to use as a reference for the target voice. The model will match the style and tone of this reference. |

### Output
The output is a JSON object containing the generated audio file metadata.

```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/wav",
    "file_name": "output.wav",
    "file_size": 4404019
  }
}
```

### Example request
```json
{
  "source_audio_url": "https://storage.googleapis.com/chatterbox-demo-samples/samples/duff_stewie.wav",
  "target_voice_audio_url": "https://v3.fal.media/files/tiger/0XODRhebRLiBdu8MqgZc5_tmpljqsylwu.wav"
}
```

### Pricing
$0.015 per minute of generated audio ([FAL.ai Pricing](https://fal.ai/pricing)).

## API — via Original Source (BYO-key direct)
Resemble AI provides a direct API for Speech-to-Speech conversion.

- **Endpoint:** `https://f.cluster.resemble.ai/synthesize`
- **Auth method:** Bearer Token (`Authorization: Bearer YOUR_API_TOKEN`)
- **Extra parameters:**
    - `pitch`: Float (-10.0 to 10.0) to transpose the donor's voice.
    - `sample_rate`: Choose between 8k, 16k, 22.05k, 32k, 44.1k, or 48k Hz.
    - `precision`: `PCM_16`, `PCM_24`, or `PCM_32`.
    - `prompt`: Primer text to steer delivery (e.g., "Speak in a British accent").
- **Official Docs:** [Resemble AI STS API](https://docs.resemble.ai/voice-generation/speech-to-speech)

## Prompting best practices
*Note: While the FAL endpoint for STS primarily uses audio-to-audio, the following applies to the target reference and general usage.*
- **Clean Reference:** Use a target voice sample (5-10 seconds) that is clear, free of background noise, and contains only one speaker.
- **Matched Emotion:** The model excels when the source audio performance already carries the desired emotion. Don't rely on the model to "add" emotion that isn't in the source timing.
- **Avoid Artifacts:** If the source audio has heavy compression or background noise, the output may carry over these artifacts.
- **Cross-Language:** Chatterbox supports cross-language transfer. You can use a reference voice in one language and convert source audio from another language.

## Parameter tuning guide
- **Reference Length:** For the `target_voice_audio_url`, 10 seconds of clear speech is the "sweet spot." Samples longer than 300 seconds are typically trimmed by the underlying engine.
- **Pitch Transposition (Direct API only):** Use the `pitch` parameter on the native API to adjust the target voice's register without affecting the speed of delivery.

## Node inputs/outputs
- **Inputs:**
    - `Source Audio`: File or URL of the speech to be transformed.
    - `Target Reference`: File or URL of the voice you want the speech to sound like.
- **Outputs:**
    - `Generated Audio`: The final converted audio file URL.
- **Chain-friendly with:**
    - **[fal-ai/whisper]:** To transcribe the source audio before or after conversion.
    - **[fal-ai/elevenlabs/tts]:** To generate a source audio file from text if you want to use STS for specific prosody control.

## Notes & gotchas
- **Max Duration:** Files are typically limited to 5 minutes or 50MB in standard processing; longer files may be trimmed.
- **Watermarking:** Outputs include Resemble AI's "Perth" neural watermark, which is imperceptible but allows for detection of AI-generated content.
- **Format Support:** While it accepts multiple formats, `wav` is recommended for the highest quality conversion.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/chatterbox/speech-to-speech)
- [Resemble AI Official Documentation](https://docs.resemble.ai/voice-generation/speech-to-speech)
- [Chatterbox GitHub Repository](https://github.com/resemble-ai/chatterbox)
- [Hugging Face Model Card](https://huggingface.co/ResembleAI/chatterbox)