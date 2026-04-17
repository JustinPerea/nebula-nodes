---
name: fal-ai/whisper
display_name: Whisper (OpenAI)
category: speech-to-text
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/whisper
original_source: https://github.com/openai/whisper, https://huggingface.co/openai/whisper-large-v3
summary: A state-of-the-art speech recognition and translation model by OpenAI, optimized for high-speed inference on fal.ai.
---

# Whisper (OpenAI)

## Overview
- **Slug:** `fal-ai/whisper`
- **Category:** Speech-to-Text / Audio Transcription & Translation
- **Creator:** [OpenAI](https://github.com/openai/whisper)
- **Best for:** High-accuracy multilingual transcription and translation into English.
- **FAL docs:** [fal-ai/whisper](https://fal.ai/models/fal-ai/whisper)
- **Original source:** [OpenAI Whisper GitHub](https://github.com/openai/whisper)

## What it does
Whisper is a general-purpose speech recognition model trained on a massive dataset of 680,000 hours of multilingual and multitask supervised data from the web ([OpenAI](https://github.com/openai/whisper)). It can perform automatic speech recognition (ASR) and speech translation into English for dozens of languages ([Hugging Face](https://huggingface.co/openai/whisper-large-v3)). While highly accurate, its receptive field is natively 30 seconds, requiring chunking strategies for longer files ([Hugging Face](https://huggingface.co/openai/whisper-large-v3)).

## When to use this model
- **Use when:** You need high-fidelity transcription of clear speech, or need to translate foreign audio directly into English text.
- **Don't use when:** Real-time low-latency streaming is the absolute priority (consider `fal-ai/whisper/stream` or specialized streaming models).
- **Alternatives:** 
  - **[Wizper (fal-ai/wizper)](https://fal.ai/models/fal-ai/wizper):** An optimized version of Whisper v3 by fal.ai that is significantly faster and cheaper ([fal.ai](https://fal.ai/models/fal-ai/wizper/api)).
  - **[Speech-to-Text (fal-ai/speech-to-text)](https://fal.ai/pricing):** A generic endpoint often used for basic transcription tasks.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/whisper` (sync) / `https://queue.fal.run/fal-ai/whisper` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | (required) | URL | Publicly accessible URL of the audio file (mp3, wav, m4a, etc.). |
| `task` | enum | `transcribe` | `transcribe`, `translate` | The task to perform: transcription (same language) or translation (to English). |
| `language` | enum | `null` | ISO codes (e.g., `en`, `es`) | Language of the input audio. If `null`, the model auto-detects. |
| `diarize` | boolean | `false` | `true`, `false` | Whether to identify and separate different speakers. |
| `chunk_level` | enum | `none` | `none`, `segment`, `word` | Detail level of timestamps. `none` often improves transcription quality. |
| `batch_size` | integer | `64` | `1` to `64` | Number of parallel chunks processed. Higher is faster but may impact context. |
| `prompt` | string | `""` | Text | Initial text to guide the model's style or vocabulary. |
| `num_speakers` | integer | `null` | `1+` | Expected number of speakers for diarization. |

### Output
The API returns a JSON object containing:
- `text`: The full reconstructed transcription.
- `chunks`: A list of segments with `timestamp` (array), `text` (string), and `speaker` (if diarization is enabled).
- `inferred_languages`: A list of detected languages with confidence.
- `diarization_segments`: Detailed speaker segments with timestamps.

### Example request
```json
{
  "audio_url": "https://example.com/audio.mp3",
  "task": "transcribe",
  "chunk_level": "segment",
  "diarize": true
}
```

### Pricing
fal.ai typically bills Whisper models based on **compute time** ($0.00 per compute second on some tiers or specific GPU rates) or **audio duration**. 
- Standard Whisper Large v3 on fal is estimated at **$1.15 per 1,000 audio minutes** ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text/models/whisper)).
- Optimized "Wizper" variants are cheaper, around **$0.50 per 1,000 minutes** ([Artificial Analysis](https://artificialanalysis.ai/speech-to-text/models/whisper)).

## API — via Original Source (BYO-key direct)
OpenAI offers Whisper via their official API (endpoint: `https://api.openai.com/v1/audio/transcriptions`).
- **Auth:** OpenAI API Key.
- **Pricing:** $0.006 / minute.
- **Limits:** 25MB file size limit (requires manual chunking for larger files).
- **Difference:** fal.ai's implementation handles much larger files and offers specialized parameters like `batch_size` and integrated diarization that are not in the native OpenAI API.

## Prompting best practices
- **Include Acronyms:** If your audio contains technical jargon or specific names (e.g., "SaaS", "fal.ai"), include them in the `prompt` parameter to improve recognition.
- **Punctuation Style:** Use the `prompt` to define how you want the transcript to look. For example, a prompt with lots of commas and periods will encourage the model to punctuate more aggressively.
- **Language Bias:** If the model struggles to detect a language, explicitly set the `language` parameter to avoid "hallucinating" a more common language like English.

## Parameter tuning guide
- **`chunk_level`:** Set to `none` if you don't need timestamps; this often results in a more coherent and higher-quality final text output because the model is less constrained by segment boundaries.
- **`diarize`:** Enable this for interviews or meetings. Note that this adds cost and processing time as it requires a separate diarization pass.
- **`batch_size`:** For very long files (1 hour+), keep this at `64` for maximum speed. For short, sensitive files where context between sentences matters, lower it.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Audio URL`: String (URL)
  - `Task`: Select (`transcribe`, `translate`)
  - `Language`: Select (ISO list)
  - `Prompt`: String
- **Outputs:**
  - `Full Text`: String
  - `Chunks`: List of Objects
  - `Speakers`: List of Segments
- **Chain-friendly with:** 
  - **`fal-ai/flux`:** Generate images based on transcribed descriptions.
  - **LLM Nodes:** Pass the transcript to an LLM (e.g., GPT-4) for summarization or action item extraction.

## Notes & gotchas
- **Hallucinations:** In silent segments or low-quality audio, Whisper may hallucinate repetitive text or subtitles ([Hugging Face](https://huggingface.co/openai/whisper-large-v3)).
- **Max Duration:** fal.ai typically handles files up to several hours, but extremely long files should be processed via the **Queue** endpoint to avoid timeouts.
- **Webhooks:** Use the `webhookUrl` parameter in queue mode to receive a POST request when the transcription is finished, rather than polling.

## Sources
- [FAL.ai Whisper API Reference](https://fal.ai/models/fal-ai/whisper/api)
- [OpenAI Whisper Research Paper & Model Card](https://github.com/openai/whisper)
- [Hugging Face Whisper Large v3 Documentation](https://huggingface.co/openai/whisper-large-v3)
- [Artificial Analysis - Whisper Provider Comparison](https://artificialanalysis.ai/speech-to-text/models/whisper)
