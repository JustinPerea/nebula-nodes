---
name: fal-ai/minimax/speech-02-turbo
display_name: MiniMax Speech-02 Turbo
category: text-to-speech
creator: MiniMax
fal_docs: https://fal.ai/models/fal-ai/minimax/speech-02-turbo
original_source: https://platform.minimax.io/docs/api-reference/speech-t2a-intro
summary: A high-speed, low-latency text-to-speech model by MiniMax offering human-like expressiveness and multilingual support across 300+ voices.
---

# MiniMax Speech-02 Turbo

## Overview
- **Slug:** `fal-ai/minimax/speech-02-turbo`
- **Category:** Text-to-Speech (TTS)
- **Creator:** [MiniMax](https://www.minimax.io/)
- **Best for:** Real-time voice assistants, low-latency interactive applications, and high-volume content generation.
- **FAL docs:** [FAL.ai/minimax/speech-02-turbo](https://fal.ai/models/fal-ai/minimax/speech-02-turbo)
- **Original source:** [MiniMax Platform](https://platform.minimax.io/docs/api-reference/speech-t2a-intro)

## What it does
MiniMax Speech-02 Turbo is a state-of-the-art Text-to-Audio (T2A) model optimized for speed and human-like expressiveness. It utilizes a Transformer-based architecture with a learnable speaker encoder to capture complex vocal characteristics and emotional nuances. The "Turbo" variant is specifically designed for real-time use cases, offering significantly lower latency than the "HD" version while maintaining high-quality prosody and rhythm. It supports over 40 languages and provides access to a library of 300+ pre-defined voices, along with robust zero-shot voice cloning capabilities.

## When to use this model
- **Use when:**
  - You need "instant" audio response for a chatbot or virtual assistant.
  - You are generating long-form content where processing cost and speed are priorities.
  - Your application requires emotional versatility (e.g., switching between happy, sad, or angry tones).
  - You need native-quality pronunciation in multiple languages (English, Chinese, Spanish, etc.).
- **Don't use when:**
  - You require the absolute highest fidelity for professional studio-grade voiceovers (use `speech-02-hd` instead).
  - You need to generate audio longer than 5000 characters in a single synchronous call (on FAL).
- **Alternatives:**
  - **fal-ai/minimax/speech-02-hd:** Higher quality audio fidelity at the cost of higher latency.
  - **fal-ai/elevenlabs/tts:** Industry-leading voice variety and quality, though often with different pricing structures and latency profiles.
  - **fal-ai/openai/tts:** Robust and simple, but with fewer granular controls for emotion and pitch compared to MiniMax.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax/speech-02-turbo` (sync) / `https://queue.fal.run/fal-ai/minimax/speech-02-turbo` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | `string` | (required) | 1-5000 chars | The text content to convert to speech. Use `\n` for paragraph breaks. |
| `voice_setting` | `object` | `{}` | - | Container for voice-specific configurations. |
| `voice_setting.voice_id` | `string` | `""` | - | The ID of the voice to use (e.g., `Wise_Woman`, `Friendly_Person`). |
| `voice_setting.speed` | `float` | `1.0` | 0.5 - 2.0 | Controls the speed of the generated speech. |
| `voice_setting.vol` | `float` | `1.0` | 0.0 - 10.0 | Controls the output volume level. |
| `voice_setting.pitch` | `integer`| `0` | -12 to 12 | Adjusts the pitch of the voice. |
| `voice_setting.emotion` | `enum` | `neutral` | `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `neutral` | Sets the emotional tone of the speech. |
| `voice_setting.english_normalization` | `boolean` | `false` | - | Improves reading of numbers and symbols in English text. |
| `audio_setting` | `object` | `{}` | - | Container for audio format configurations. |
| `audio_setting.sample_rate` | `enum` | `32000` | `8000`, `16000`, `22050`, `24000`, `32000`, `44100` | The sample rate of the output audio. |
| `audio_setting.bitrate` | `enum` | `128000` | `32000`, `64000`, `128000`, `256000` | The bitrate of the output audio. |
| `audio_setting.format` | `enum` | `mp3` | `mp3`, `pcm`, `flac`, `wav` | The file format for the output. |
| `audio_setting.channel` | `enum` | `1` | `1` (mono), `2` (stereo) | Number of audio channels. |
| `language_boost` | `enum` | `null` | `Chinese`, `English`, `Spanish`, `French`, `auto`, etc. | Enhances recognition and pronunciation for specific languages. |
| `output_format` | `enum` | `url` | `url`, `hex` | Whether to return a downloadable URL or hex-encoded data. |
| `pronunciation_dict` | `object` | `{}` | - | A dictionary for custom text-to-pronunciation overrides. |

### Output
The output is a JSON object containing the audio file metadata and the duration.
```json
{
  "audio": {
    "url": "https://fal.run/storage/...",
    "content_type": "audio/mpeg",
    "file_name": "speech.mp3",
    "file_size": 179926
  },
  "duration_ms": 11124
}
```

### Example request
```json
{
  "text": "Hello! Welcome to the future of real-time voice synthesis.",
  "voice_setting": {
    "voice_id": "Friendly_Person",
    "speed": 1.0,
    "emotion": "happy"
  },
  "audio_setting": {
    "format": "mp3",
    "sample_rate": 32000
  }
}
```

### Pricing
- **FAL.ai:** $0.06 per 1,000 characters.
- **Queue/Async usage:** Standard FAL infrastructure rates apply for long-running jobs.

## API — via Original Source (BYO-key direct)
MiniMax offers a direct API for developers who want to manage their own keys and usage.
- **Endpoint:** `https://api.minimax.io/v1/t2a_v2`
- **Auth:** `Authorization: Bearer <MINIMAX_API_KEY>`
- **Native Advantages:**
  - **Higher Limits:** Supports up to 10,000 characters for synchronous requests.
  - **Asynchronous Mode:** Supports up to 1,000,000 characters for long-form content.
  - **WebSocket Support:** Native support for real-time bidirectional streaming.
  - **Voice Management:** Direct access to custom voice cloning and voice design endpoints.
- **Official Docs:** [MiniMax T2A HTTP Reference](https://platform.minimax.io/docs/api-reference/speech-t2a-http)

## Prompting best practices
- **Punctuation is King:** Use commas for short pauses and periods or newlines for longer breaks. The model is highly sensitive to punctuation for determining prosody.
- **Emotion Tags:** While primarily set via the `emotion` parameter, the model often infers tone from the text context. Writing in a style that matches the desired emotion (e.g., using exclamation marks for "happy") improves results.
- **Pause Markers:** For specific timing, use the pause marker syntax `<#x#>` where `x` is the duration in seconds (e.g., `Hello <#0.5#> how are you?`).
- **Phonetic Overrides:** If the model mispronounces a brand name or technical term, use the `pronunciation_dict` to map the text to a more phonetic representation.
- **Avoid Over-speeding:** Speeds above 1.5x can lead to "slurring" of syllables; 1.1x to 1.2x is usually the sweet spot for professional narration.

## Parameter tuning guide
- **Speed (0.5 to 2.0):** 1.0 is default. Use 1.1 for a modern "podcast" feel or 0.9 for dramatic, solemn readings.
- **Emotion:** Use `happy` or `surprised` for customer service or marketing; `neutral` or `sad` for news or serious narration.
- **Sample Rate:** `32000` or `44100` is recommended for high-quality playback. Use `16000` only for bandwidth-constrained telephony apps.
- **English Normalization:** Always enable this (`true`) if your text contains many dates, phone numbers, or currency values to ensure they are read correctly (e.g., "1999" as "nineteen ninety-nine").

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Text` (string)
  - `Voice ID` (string)
  - `Emotion` (dropdown/enum)
  - `Speed` (number)
- **Outputs:**
  - `Audio URL` (string)
  - `Duration` (number)
- **Chain-friendly with:**
  - **LLM Nodes:** To generate the text content before synthesis.
  - **Translation Nodes:** To localize text before speaking.
  - **Video Generation Nodes:** To create lip-synced characters (e.g., using the audio URL as input for a talkie model).

## Notes & gotchas
- **Character Limits:** FAL enforces a 5000-character limit per request. For longer texts, you must chunk the text yourself or use the native MiniMax Async API.
- **Regional availability:** The `auto` language detection works best on longer sentences; for single words or short phrases, manually specifying the `language_boost` is more reliable.
- **Interjection support:** Note that specific interjection tags (like `(laughs)`) are primarily supported in the 2.8 version; older versions may treat these as literal text.

## Sources
- [FAL.ai MiniMax Model Page](https://fal.ai/models/fal-ai/minimax/speech-02-turbo)
- [MiniMax API Documentation](https://platform.minimax.io/docs/api-reference/speech-t2a-intro)
- [MiniMax T2A HTTP Specification](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [Wavespeed AI Model Analysis](https://wavespeed.ai/models/minimax/speech-02-turbo)
