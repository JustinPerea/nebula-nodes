---
name: fal-ai/wizper
display_name: Wizper (Whisper v3)
category: speech-to-text
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/wizper
original_source: https://github.com/openai/whisper
summary: An optimized version of OpenAI's Whisper v3 Large for high-performance transcription and translation.
---

# Wizper (Whisper v3)

## Overview
- **Slug:** `fal-ai/wizper`
- **Category:** Speech-to-Text
- **Creator:** [OpenAI](https://openai.com/) (Optimized by [FAL.ai](https://fal.ai/))
- **Best for:** High-accuracy multilingual transcription and translation of long-form audio.
- **FAL docs:** [fal.ai/models/fal-ai/wizper](https://fal.ai/models/fal-ai/wizper)
- **Original source:** [OpenAI Whisper GitHub](https://github.com/openai/whisper) / [HuggingFace Card](https://huggingface.co/openai/whisper-large-v3)

## What it does
Wizper is an "inference-wizard" optimized version of OpenAI's **Whisper v3 Large** model. It provides state-of-the-art automatic speech recognition (ASR) and speech translation (into English) across nearly 100 languages. FAL's implementation is designed to deliver the same Word Error Rate (WER) as the original model but with significantly higher performance and lower latency ([FAL.ai](https://fal.ai/models/fal-ai/wizper)).

## When to use this model
- **Use when:** You need the highest accuracy for transcribing audio with background noise, strong accents, or technical jargon.
- **Use when:** You need to translate non-English audio directly into English text.
- **Don't use when:** You need real-time, ultra-low latency "as-you-speak" transcription (though it is fast, it typically processes chunks).
- **Alternatives:**
  - `fal-ai/whisper`: The standard Whisper implementation.
  - `fal-ai/distil-whisper`: A faster, distilled version with slightly lower accuracy but much lower cost.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/wizper` (sync) / `https://queue.fal.run/fal-ai/wizper` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | *Required* | URL | The URL of the audio file. Supports mp3, ogg, wav, m4a, aac, mp4, webm. |
| `task` | Enum | `transcribe` | `transcribe`, `translate` | Whether to transcribe the audio in its original language or translate it to English. |
| `language` | Enum | `null` | ISO codes (en, fr, etc.) | Language of the audio. If `null`, the model auto-detects the language. |
| `chunk_level` | string | `segment` | `segment`, `word` | The granularity of timestamps in the output chunks. |
| `max_segment_len`| integer | `29` | 1 - 30 | Maximum length of a speech segment in seconds before splitting. |
| `merge_chunks` | boolean | `true` | `true`, `false` | If enabled, consecutive chunks are merged to improve readability. |
| `version` | string | `3` | `3` | The model version to use (Whisper v3 Large). |

### Output
The output is a JSON object containing the full text and detailed timestamps.
```json
{
  "text": "Full transcription text here...",
  "chunks": [
    {
      "timestamp": [0.0, 5.2],
      "text": "The first segment of audio."
    }
  ],
  "languages": ["en"]
}
```

### Example request
```json
{
  "audio_url": "https://example.com/audio.mp3",
  "task": "transcribe",
  "language": "en"
}
```

### Pricing
FAL.ai typically bills Wizper based on **compute seconds**. While the playground may display "$0" for trial users, standard serverless billing for this model is approximately **$0.0003 per compute second** (roughly $1.08/hr), matching the cost of the underlying A100 GPU hardware used for inference ([FAL Pricing](https://fal.ai/pricing), [External Research](https://github.com/danielrosehill/Cloud-STT-Price-Points-1225)).

## API — via Original Source (BYO-key direct)
OpenAI provides a hosted Whisper API, but for direct model access, it is typically self-hosted or run via inference providers.
- **OpenAI API Endpoint:** `https://api.openai.com/v1/audio/transcriptions`
- **Auth:** Bearer Token (OpenAI API Key)
- **Direct Usage:** You can run the model locally using the `openai-whisper` Python package or via `transformers`.

## Prompting best practices
- **Clear Audio:** Ensure the input audio is as clean as possible. While robust, extreme noise still degrades performance.
- **Language Hinting:** If you know the language, specify it in the `language` parameter to avoid auto-detection errors and reduce latency.
- **Long-form Audio:** For very long files, use the `queue` mode and webhooks to handle the extended processing time.
- **Avoid Hallucinations:** In very quiet or silent segments, Whisper may "hallucinate" repetitive text or generic phrases. Use the `merge_chunks` parameter to help clean up output.

## Parameter tuning guide
- **`task`:** Set to `translate` if you have non-English audio and want the text in English. It is often more accurate than transcribing and then using an LLM to translate.
- **`max_segment_len`:** Lowering this can provide more frequent timestamps, which is useful for closed-captioning (SRT) generation.
- **`language`:** Manual setting prevents the model from misidentifying a speaker's language during the initial few seconds.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Audio URL`: Link to the source file.
  - `Task`: Selection for transcribe/translate.
  - `Language Hint`: Optional ISO code.
- **Outputs:**
  - `Full Text`: The complete transcription string.
  - `Chunks`: Array of timestamped segments for subtitle generation.
- **Chain-friendly with:**
  - `fal-ai/any-llm`: To summarize the transcription or extract action items.
  - `fal-ai/playht/tts`: To re-voice the transcription in a different style.

## Notes & gotchas
- **Max Duration:** FAL handles long-form audio by chunking, but extremely long files (hours) should be processed via the **Queue API**.
- **Experimental Tag:** FAL currently labels Wizper as `[Experimental]`, meaning schema changes or optimizations may occur frequently.
- **Hallucinations:** Like all Whisper models, it can occasionally repeat sentences if the audio is ambiguous or silent.

## Sources
- [FAL.ai Wizper Model Page](https://fal.ai/models/fal-ai/wizper)
- [OpenAI Whisper v3 Announcement](https://github.com/openai/whisper/discussions/1762)
- [HuggingFace Whisper Large-v3 Card](https://huggingface.co/openai/whisper-large-v3)
- [FAL.ai Pricing Documentation](https://fal.ai/pricing)
