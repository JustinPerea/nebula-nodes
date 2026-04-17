---
name: fal-ai/minimax/speech-02-hd
display_name: MiniMax Speech-02 HD
category: text-to-speech
creator: MiniMax
fal_docs: https://fal.ai/models/fal-ai/minimax/speech-02-hd
original_source: https://platform.minimax.io/docs/api-reference/speech-t2a-intro
summary: A high-fidelity text-to-speech model by MiniMax offering expressive, human-like voice synthesis with advanced emotion control and zero-shot voice cloning.
---

# MiniMax Speech-02 HD

## Overview
- **Slug:** `fal-ai/minimax/speech-02-hd`
- **Category:** Text-to-Speech
- **Creator:** [MiniMax](https://www.minimax.io/)
- **Best for:** Professional voiceovers, audiobooks, and emotionally expressive narration.
- **FAL docs:** [fal-ai/minimax/speech-02-hd](https://fal.ai/models/fal-ai/minimax/speech-02-hd)
- **Original source:** [MiniMax Platform Documentation](https://platform.minimax.io/docs/api-reference/speech-t2a-intro)

## What it does
MiniMax Speech-02 HD is a premier high-definition text-to-speech (TTS) model designed for lifelike, human-quality voice synthesis. It excels in capturing natural prosody, rhythm, and stability, consistently ranking at the top of industry benchmarks like the Artificial Analysis Speech Arena. The model supports over 30 languages (recently expanded to 40+) and features advanced emotion control, allowing for nuanced performances ranging from "happy" and "sad" to "angry" and "fearful."

## When to use this model
- **Use when:** You need high-fidelity audio for production-ready content like podcasts, video narrations, or professional voiceovers where emotional nuance is critical.
- **Don't use when:** You need the absolute lowest possible latency for real-time conversational AI (use `speech-02-turbo` instead).
- **Alternatives:** 
    - **[fal-ai/minimax/speech-02-turbo](https://fal.ai/models/fal-ai/minimax/speech-02-turbo):** Faster, optimized for real-time streaming at the cost of slight fidelity.
    - **[fal-ai/elevenlabs/tts](https://fal.ai/models/fal-ai/elevenlabs/tts):** Strong alternative for high-quality English and multilingual voices with a different tonal profile.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax/speech-02-hd` (sync) / `https://queue.fal.run/fal-ai/minimax/speech-02-hd` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | `string` | *Required* | Max 5,000 chars | The text to convert to speech. |
| `voice_setting.voice_id` | `string` | `""` | [System Voice IDs] | Predefined voice ID (e.g., "Calm_Woman"). |
| `voice_setting.speed` | `float` | `1.0` | `0.5` to `2.0` | Speech speed. |
| `voice_setting.vol` | `float` | `1.0` | `0` to `10.0` | Volume level. |
| `voice_setting.pitch` | `integer` | `0` | `-12` to `12` | Pitch adjustment in semitones. |
| `voice_setting.emotion` | `enum` | `neutral` | `happy, sad, angry, fearful, disgusted, surprised, neutral` | Emotional tone of the speech. |
| `voice_setting.english_normalization` | `boolean` | `false` | - | Improves number reading performance in English. |
| `audio_setting.sample_rate` | `integer` | `32000` | `8000, 16000, 22050, 24000, 32000, 44100` | Output sample rate in Hz. |
| `audio_setting.bitrate` | `integer` | `128000` | `32000, 64000, 128000, 256000` | Audio bitrate in bps. |
| `audio_setting.format` | `enum` | `mp3` | `mp3, pcm, flac, wav` | Output file format. |
| `audio_setting.channel` | `integer` | `1` | `1 (mono), 2 (stereo)` | Number of audio channels. |
| `language_boost` | `enum` | - | `Chinese, English, Japanese, etc.` | Enhances recognition of specific languages/dialects. |
| `output_format` | `enum` | `url` | `url, hex` | Whether to return a file URL or hex data. |
| `pronunciation_dict` | `object` | - | `{"text": "replacement"}` | Custom pronunciation mapping. |

### Output
The API returns a JSON object containing the audio file details and its duration.
```json
{
  "audio": {
    "url": "https://fal-cdn.com/...",
    "content_type": "audio/mpeg",
    "file_name": "speech.mp3",
    "file_size": 12345
  },
  "duration_ms": 3500
}
```

### Example request
```json
{
  "text": "The quick brown fox jumps over the lazy dog.",
  "voice_setting": {
    "voice_id": "Calm_Woman",
    "speed": 1.0,
    "emotion": "happy"
  },
  "audio_setting": {
    "format": "mp3",
    "sample_rate": 44100
  }
}
```

### Pricing
- **Cost:** $0.10 per 1,000 characters.
- Supports commercial use as a partner model on FAL.ai.

## API — via Original Source (BYO-key direct)
The model is developed by MiniMax and is available directly via their developer platform.
- **Endpoint:** `https://api.minimax.io/v1/text_to_audio`
- **Auth Method:** Requires `API Key` and `Group ID`.
- **Additional features:** The native API supports up to 10,000 characters synchronously and up to 1 million characters asynchronously for massive batch jobs (e.g., full audiobook generation).
- **Official Docs:** [MiniMax T2A API Reference](https://platform.minimax.io/docs/api-reference/speech-t2a-intro)

## Prompting best practices
- **Control Pauses:** Use `<#x#>` where `x` is the duration in seconds (e.g., `<#0.5#>`) to insert precise silences. This is highly effective between sentences or for dramatic effect.
- **Use Interjection Tags:** For `Turbo` variants or newer HD iterations (like `speech-2.6+`), the model supports tags like `(laughs)`, `(sighs)`, and `(coughs)` to inject human-like non-verbal sounds.
- **Language Boosting:** Always set the `language_boost` parameter to match the primary language of your text to ensure the most natural accent and pronunciation.
- **Character Consistency:** When generating long scripts with multiple speakers, use specific `voice_id` values consistently. MiniMax supports over 300 pre-built voices.

## Parameter tuning guide
- **Emotion:** Use "surprised" or "happy" for engaging content like marketing videos. Use "neutral" or "calm" (via voice ID selection) for audiobooks to avoid listener fatigue.
- **Speed:** `1.0` is standard. For technical or educational content, `0.9` can help clarity, while `1.1` to `1.2` works well for fast-paced social media ads.
- **Pitch:** Adjusting pitch by `1` or `2` semitones can slightly alter a voice's perceived age or authority without breaking realism.
- **English Normalization:** Always enable this if your text contains many numbers, dates, or abbreviations to ensure they are read correctly (e.g., "$10.50" read as "ten dollars and fifty cents").

## Node inputs/outputs
- **Inputs:**
    - `text`: Main text content.
    - `voice_id`: Target voice selector.
    - `emotion`: Emotional tone selector.
    - `speed`: Playback speed control.
- **Outputs:**
    - `audio_url`: URL to the generated audio file.
    - `duration_ms`: Duration for timing synchronization in workflows.
- **Chain-friendly with:**
    - **[fal-ai/minimax/video-01](https://fal.ai/models/fal-ai/minimax/video-01):** Use generated speech to provide audio for MiniMax video generation.
    - **[fal-ai/llm-summarizer]:** Use an LLM to generate the script or summary, then pass it to Speech-02 HD for narration.

## Notes & gotchas
- **Character Limit:** Synchronous calls via FAL are typically limited to 5,000 characters. For longer texts, use the queue system or split the text into chunks.
- **Pause Placement:** Pause markers must be placed between speakable text segments and cannot be used consecutively.
- **Model Versions:** While `speech-02-hd` is the slug, MiniMax also has `speech-2.6-hd` and `speech-2.8-hd` variants which may be exposed via specific sub-schemas or newer FAL endpoints as they are released.

## Sources
- [FAL.ai MiniMax Speech-02 HD Documentation](https://fal.ai/models/fal-ai/minimax/speech-02-hd)
- [MiniMax Platform API Reference](https://platform.minimax.io/docs/api-reference/speech-t2a-intro)
- [Artificial Analysis - MiniMax Performance Benchmarks](https://artificialanalysis.ai/models/speech-02-hd)
- [MiniMax Official Website](https://www.minimax.io/)
