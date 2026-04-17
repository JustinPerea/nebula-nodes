---
name: fal-ai/speech-to-text/turbo
display_name: Speech-to-Text (Turbo)
category: speech-to-text
creator: NVIDIA (NeMo Canary family)
fal_docs: https://fal.ai/models/fal-ai/speech-to-text/turbo
original_source: https://huggingface.co/nvidia/canary-1b
summary: An ultra-fast, real-time speech-to-text model powered by NVIDIA Canary-1B for high-accuracy transcription.
---

# Speech-to-Text (Turbo)

## Overview
- **Slug:** `fal-ai/speech-to-text/turbo`
- **Category:** Speech-to-Text
- **Creator:** [NVIDIA](https://developer.nvidia.com/blog/new-standard-for-speech-recognition-and-translation-from-the-nvidia-nemo-canary-model/)
- **Best for:** Ultra-fast, real-time transcription with high accuracy.
- **FAL docs:** [fal.ai/models/fal-ai/speech-to-text/turbo](https://fal.ai/models/fal-ai/speech-to-text/turbo)
- **Original source:** [NVIDIA NeMo Canary-1B](https://huggingface.co/nvidia/canary-1b)

## What it does
`fal-ai/speech-to-text/turbo` is a high-performance automatic speech recognition (ASR) model designed for speed and accuracy. Powered by the **NVIDIA Canary-1B** architecture, it provides near real-time transcription of audio files. It excels at handling long-form audio while maintaining structural integrity through built-in punctuation and capitalization (PnC) [NVIDIA Blog](https://developer.nvidia.com/blog/new-standard-for-speech-recognition-and-translation-from-the-nvidia-nemo-canary-model/).

## When to use this model
- **Use when:** You need the fastest possible transcription for live or bulk audio processing where latency is critical.
- **Don't use when:** You require specialized domain-specific terminology (e.g., niche medical or legal) without a custom vocabulary or if you need extremely high-fidelity multilingual support beyond the primary European languages (though Canary-1B-v2 expanded this significantly) [HuggingFace](https://huggingface.co/nvidia/canary-1b-v2).
- **Alternatives:** 
    - **fal-ai/whisper:** The standard for multilingual robustness, though generally slower than the Turbo variant [fal.ai](https://fal.ai/docs/examples/audio-speech/convert-speech-to-text).
    - **fal-ai/wizper:** An optimized Whisper v3 Large model offering the best accuracy-to-performance ratio for complex audio [fal.ai](https://fal.ai/docs/examples/audio-speech/convert-speech-to-text).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/speech-to-text/turbo` (sync) / `https://queue.fal.run/fal-ai/speech-to-text/turbo` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | `string` | *Required* | Valid URL or Base64 | Local filesystem path or remote URL to an audio file (mp3, ogg, wav, m4a, aac). |
| `use_pnc` | `boolean` | `true` | `true`, `false` | Whether to use Canary's built-in punctuation & capitalization. |

### Output
The model returns a JSON object containing the transcribed text and status indicators.
```json
{
  "output": "The transcribed text goes here...",
  "partial": false
}
```
- **output (string):** The final or partial transcription.
- **partial (boolean):** Indicates if the transcript is still in progress (used for streaming/queue updates).

### Example request
```json
{
  "input": {
    "audio_url": "https://storage.googleapis.com/falserverless/model_tests/whisper/dinner_conversation.mp3",
    "use_pnc": true
  }
}
```

### Pricing
The model is billed based on the duration of the processed audio:
- **Cost:** $0.0008 per second of audio [fal.ai](https://fal.ai/models/fal-ai/speech-to-text/turbo).

## API — via Original Source (BYO-key direct)
NVIDIA provides a native API surface for Canary through their **NVIDIA NIM** (NVIDIA Inference Microservices) platform.
- **Native Endpoint:** `https://build.nvidia.com/nvidia/canary-1b-asr`
- **Auth:** Requires an NVIDIA NGC API Key.
- **Additional Parameters:** Native NVIDIA NIM implementation allows for specific `source_language` and `target_language` tags, as well as `task` (transcribe vs translate) parameters that may be abstracted in the FAL "Turbo" implementation [NVIDIA NIM](https://build.nvidia.com/nvidia/canary-1b-asr/api).

## Prompting best practices
*Note: As an ASR model, "prompting" refers to the quality of the input audio rather than a text prompt.*
1. **Clear Audio:** Ensure the input audio is mono, 16-bit, and ideally sampled at 16000 Hz for optimal compatibility with the underlying Canary architecture [HuggingFace](https://huggingface.co/nvidia/canary-1b).
2. **Minimize Background Noise:** While robust, reducing ambient noise significantly lowers the Word Error Rate (WER).
3. **Punctuation Control:** Keep `use_pnc` enabled for readable transcripts; disable it only if you need raw text for further NLP downstream processing.

## Parameter tuning guide
- **audio_url:** Support for both hosted URLs and Base64 encoded strings. For files larger than 10MB, a hosted URL is recommended to avoid request timeouts.
- **use_pnc:** This is the most impactful setting for readability. If your workflow involves LLM summarization later, keeping this `true` helps the LLM understand sentence boundaries better.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio Input` (URL or File)
    - `Punctuation Toggle` (Boolean)
- **Outputs:**
    - `Transcript` (String)
    - `Is Partial` (Boolean)
- **Chain-friendly with:**
    - **fal-ai/any-llm:** To summarize the resulting transcript.
    - **fal-ai/elevenlabs/text-to-speech:** To re-voice or dub the transcribed content.

## Notes & gotchas
- **Streaming:** Supports real-time streaming through the `subscribe` method and `onQueueUpdate` callbacks on the FAL platform [fal.ai](https://fal.ai/models/fal-ai/speech-to-text/turbo/api).
- **Supported Formats:** Strictly accepts mp3, ogg, wav, m4a, and aac.
- **Architecture:** Based on NVIDIA NeMo Canary, which uses a Transducer-Decoder architecture for low-latency processing.

## Sources
- [FAL.ai Speech-to-Text Turbo Documentation](https://fal.ai/models/fal-ai/speech-to-text/turbo)
- [NVIDIA NeMo Canary-1B HuggingFace Card](https://huggingface.co/nvidia/canary-1b)
- [NVIDIA Developer Blog - Canary Model Release](https://developer.nvidia.com/blog/new-standard-for-speech-recognition-and-translation-from-the-nvidia-nemo-canary-model/)
- [NVIDIA NIM API Reference](https://build.nvidia.com/nvidia/canary-1b-asr/api)
