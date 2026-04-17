---
name: fal-ai/f5-tts
display_name: F5-TTS
category: text-to-speech
creator: SWivid (X-LANCE Lab)
fal_docs: https://fal.ai/models/fal-ai/f5-tts
original_source: https://github.com/swivid/f5-tts
summary: A state-of-the-art non-autoregressive TTS model using flow matching and Diffusion Transformers for high-quality zero-shot voice cloning.
---

# F5-TTS

## Overview
- **Slug:** `fal-ai/f5-tts`
- **Category:** Text-to-Speech (Audio Generation)
- **Creator:** [SWivid (X-LANCE Lab)](https://github.com/swivid/f5-tts)
- **Best for:** High-fidelity zero-shot voice cloning and expressive speech synthesis without fine-tuning.
- **FAL docs:** [fal-ai/f5-tts](https://fal.ai/models/fal-ai/f5-tts)
- **Original source:** [GitHub Repository](https://github.com/swivid/f5-tts), [Hugging Face Model Card](https://huggingface.co/SWivid/F5-TTS)

## What it does
F5-TTS is a state-of-the-art, fully non-autoregressive text-to-speech system based on **Flow Matching** with a **Diffusion Transformer (DiT)** architecture. It excels at **zero-shot voice cloning**, meaning it can mimic a speaker's voice, emotion, and prosody using only a short (typically 3-10 second) reference audio clip. Unlike traditional autoregressive models (like GPT-style TTS), F5-TTS uses a character-based approach that eliminates the need for complex phoneme alignment or duration models, leading to faster training and smoother inference.

## When to use this model
- **Use when:** You need to clone a specific voice with high accuracy using minimal data, or when you require expressive, natural-sounding speech for content creation, gaming, or virtual assistants.
- **Don't use when:** You need extremely long-form continuous generation (over 30-60 seconds) without chunking, or when you require low-latency real-time streaming for very long sentences where autoregressive models might have a slight edge in stability.
- **Alternatives:**
    - **[ElevenLabs TTS](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3):** Better for production-ready, highly polished voices with built-in emotion controls, though more expensive and less flexible with custom reference audio.
    - **[Fish-Speech](https://fal.ai/models/fal-ai/fish-audio/fish-speech):** Another strong zero-shot competitor that uses a different architecture (LLM-based) and might perform differently on specific accents.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/f5-tts` (sync) / `https://queue.fal.run/fal-ai/f5-tts` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `gen_text` | `string` | *Required* | Max 5000 chars | The target text to be converted into speech. |
| `ref_audio_url` | `string` | *Required* | URL | Public URL to the reference audio file (WAV, MP3, OGG, M4A, AAC). |
| `ref_text` | `string` | `""` | Any string | The transcript of the reference audio. If omitted, FAL uses a built-in ASR model to transcribe it automatically. |
| `model_type` | `enum` | `"F5-TTS"` | `F5-TTS`, `E2-TTS` | `F5-TTS` uses DiT with ConvNeXt V2; `E2-TTS` uses a Flat-UNet Transformer. F5 is generally preferred for quality. |
| `remove_silence` | `boolean` | `true` | `true`, `false` | Whether to automatically trim silence from the beginning and end of the generated audio. |

### Output
The output is a JSON object containing a reference to the generated audio file.
```json
{
  "audio_url": {
    "url": "https://v2.fal.media/files/.../audio.wav",
    "content_type": "audio/wav",
    "file_name": "audio.wav",
    "file_size": 4404019
  }
}
```

### Example request
```json
{
  "gen_text": "Hello, this is a test of the F5-TTS voice cloning capability.",
  "ref_audio_url": "https://example.com/my-voice-sample.wav",
  "ref_text": "This is the transcript of my voice sample.",
  "model_type": "F5-TTS",
  "remove_silence": true
}
```

### Pricing
- **Cost:** $0.05 per 1,000 characters.
- **Efficiency:** Approximately 20 generations per dollar on the standard FAL tier ([FAL Pricing](https://fal.ai/models/fal-ai/f5-tts)).

## API — via Original Source (BYO-key direct)
FAL.ai is the primary hosted API surface for F5-TTS. The original creators ([X-LANCE Lab](https://github.com/swivid/f5-tts)) provide the model as open-source code and weights under the **MIT License** (for code) and **CC-BY-NC** (for weights). There is no dedicated official commercial "BYO-key" API endpoint directly from the research team, though they maintain a demo on [Hugging Face Spaces](https://huggingface.co/spaces/mrfakename/E2-F5-TTS).

## Prompting best practices
- **Reference Audio Quality:** The "prompt" for this model is the `ref_audio_url`. Use a clear, dry recording (no background noise or music) of 5-10 seconds.
- **Transcript Accuracy:** Providing an accurate `ref_text` significantly improves the model's ability to "anchor" the voice characteristics. If the automatic ASR fails or hallucinates, the cloned voice quality will drop.
- **Punctuation Matters:** Use standard punctuation (`.`, `,`, `!`, `?`) in `gen_text` to guide the model's natural pausing and intonation.
- **Language Matching:** While it supports cross-lingual cloning, results are most stable when the reference audio and generated text are in the same language (primarily English or Chinese).

## Parameter tuning guide
- **`model_type`:** Choose `F5-TTS` for the highest quality and most natural prosody. `E2-TTS` (Flat-UNet) is available as an alternative but is generally considered an earlier iteration in this specific research lineage.
- **`remove_silence`:** Always keep this `true` unless you specifically need the "breathing" or ambient space at the end of a clip for cinematic timing.
- **`ref_text`:** If you notice the output voice doesn't sound quite right, manually transcribing the reference audio into this field is the most impactful "tuning" step you can take.

## Node inputs/outputs
- **Inputs:**
    - `Text` (String): The content to speak.
    - `Voice Reference` (URL/File): The sample audio.
    - `Transcript` (String): Manual transcription of the sample.
- **Outputs:**
    - `Audio` (Audio File): The generated speech.
- **Chain-friendly with:**
    - **LLMs (e.g., Llama 3):** To generate the script for the TTS.
    - **Transcription models (e.g., Whisper):** To pre-process reference audio if you don't have the transcript.
    - **Audio-to-Video models:** To create talking head avatars from the generated speech.

## Notes & gotchas
- **Max Duration:** Although the API supports 5000 characters, the underlying model architecture performs best on segments under 30 seconds. For very long texts, it is recommended to split the text into smaller chunks and concatenate the results.
- **Zero-Shot Limitation:** While excellent, it is "zero-shot." It may occasionally struggle with extremely unique vocal quirks or very thick regional accents that weren't well-represented in its training data (Emilia dataset).
- **Safety:** Content generated via FAL.ai is subject to their standard content policy ([FAL Terms](https://fal.ai/legal/terms-of-service)).

## Sources
- [FAL.ai F5-TTS Documentation](https://fal.ai/models/fal-ai/f5-tts)
- [Official GitHub Repository (SWivid/F5-TTS)](https://github.com/swivid/f5-tts)
- [F5-TTS Research Paper (arXiv:2410.06885)](https://arxiv.org/abs/2410.06885)
- [Hugging Face Model Card](https://huggingface.co/SWivid/F5-TTS)
