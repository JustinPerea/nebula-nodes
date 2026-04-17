---
name: xai/tts/v1
display_name: xAI Text to Speech (v1)
category: text-to-audio
creator: xAI
fal_docs: [FAL.ai Docs](https://fal.ai/models/xai/tts/v1)
original_source: [xAI Official Docs](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
summary: High-fidelity, expressive text-to-speech with fine-grained emotional control via inline tags.
---

# xAI Text to Speech (v1)

## Overview
- **Slug:** `xai/tts/v1`
- **Category:** Text-to-Audio
- **Creator:** [xAI](https://x.ai)
- **Best for:** Creating expressive, human-like voiceovers with precise control over emotions and pacing.
- **FAL docs:** [fal.ai/models/xai/tts/v1](https://fal.ai/models/xai/tts/v1)
- **Original source:** [xAI Developer Docs](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)

## What it does
The xAI TTS model is a high-fidelity text-to-speech engine designed for expressive and realistic voice synthesis. Unlike traditional robotic TTS systems, it leverages xAI's transformer-based "audio-as-language" architecture to capture nuanced prosody, rhythm, and natural filler sounds. It supports five distinct voices and over 20 languages, with a standout feature being "Speech Tags" that allow users to program laughter, whispers, and pauses directly into the input text.

## When to use this model
- **Use when:** You need high-quality narration for videos, interactive characters in games, or accessible content that sounds emotionally resonant rather than mechanical.
- **Don't use when:** You require voice cloning (it only supports fixed preset voices) or when you need extremely high-speed batch processing of millions of short strings where low cost is more important than expression.
- **Alternatives:**
    - **ElevenLabs:** Offers more voice variety and cloning but can be more expensive.
    - **OpenAI TTS:** Great for general use but lacks the fine-grained inline emotional tagging (laughter, sighs) found in xAI.

## API — via FAL.ai
**Endpoint:** `https://fal.run/xai/tts/v1` (Synchronous) / `https://queue.fal.run/xai/tts/v1` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | string | - | 1 - 15,000 characters | The text to convert. Supports inline speech tags (e.g., `[laugh]`, `<whisper>`). |
| `voice` | string | `eve` | `eve`, `ara`, `rex`, `sal`, `leo` | The voice profile to use for synthesis. |
| `language` | string | `auto` | `auto`, `en`, `zh`, `fr`, `de`, `hi`, `ja`, etc. | BCP-47 language code or `auto` for detection. |
| `output_format.container` | string | `mp3` | `mp3`, `wav`, `pcm`, `mulaw`, `alaw` | The audio file format. |
| `output_format.sample_rate` | integer | `24000` | 8000, 16000, 22050, 24000, 44100, 48000 | Audio sample rate in Hz. |
| `output_format.bit_rate` | integer | `128000` | 32k, 64k, 96k, 128k, 192k | Audio bit rate (for compressed formats). |
| `streaming` | boolean | `false` | `true`, `false` | Whether to stream the audio output. |

### Output
The output returns a JSON object containing the generated audio metadata:
- `audio`: An object with:
    - `url`: Publicly accessible URL to the audio file.
    - `content_type`: Mime type (e.g., `audio/mpeg`).
    - `file_name`: Generated filename.
    - `file_size`: Size in bytes.

### Example request
```json
{
  "text": "I can't believe it! [laugh] That was actually [pause] amazing. <whisper>Don't tell anyone.</whisper>",
  "voice": "ara",
  "language": "en",
  "output_format": {
    "container": "mp3",
    "sample_rate": 44100
  }
}
```

### Pricing
FAL.ai bills this model at **$0.0042 per 1000 characters** (equivalent to $4.20 per 1 million characters).

---

## API — via Original Source (BYO-key direct)
**Endpoint:** `https://api.x.ai/v1/tts`
**Auth:** Bearer Token (`XAI_API_KEY`)
**Native Advantages:** Access to the WebSocket streaming endpoint for lower latency and the ability to manage team-wide rate limits (3,000 RPM / 50 RPS) directly.
**Documentation:** [xAI TTS API Reference](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)

---

## Prompting best practices
- **Use Speech Tags:** The model's power lies in its tags. Use `[pause]` for dramatic effect, `[laugh]` for humor, and `[sigh]` for disappointment.
- **Wrapping Tags:** Use `<whisper>text</whisper>`, `<slow>text</slow>`, or `<fast>text</fast>` to change the delivery style of entire phrases.
- **Punctuation Matters:** The model uses periods, commas, and exclamation marks to inform its natural prosody. Don't skip them!
- **Phonetic Spelling:** For unusual names or technical terms, try spelling them phonetically (e.g., "FAL AI" instead of "fal.ai") for better pronunciation.
- **Avoid Over-tagging:** Too many `[laugh]` tags in a short sentence can sound unnatural.

---

## Parameter tuning guide
- **Voice Selection:** 
    - `eve`: Best for energetic, upbeat, or customer-facing roles.
    - `ara`: Best for warm, friendly, or narrative storytelling.
    - `rex`: Best for confident, clear instructions or announcements.
    - `sal`: Best for professional, calm, or corporate delivery.
    - `leo`: Best for authoritative, steady, or news-style narration.
- **Sample Rate:** Set to `44100` or `48000` for high-quality video production; use `8000` or `16000` for telephony (G.711) applications to save bandwidth.
- **Container:** Use `wav` or `pcm` if you intend to do further audio processing/mastering to avoid compression artifacts.

## Node inputs/outputs
- **Inputs:** 
    - `Text` (Main string input)
    - `Voice` (Dropdown)
    - `Language` (Dropdown/String)
    - `Container` (Dropdown)
- **Outputs:** 
    - `Audio File` (URL/File)
- **Chain-friendly with:** 
    - `xai/grok-2`: To generate the persona-driven script first.
    - `fal-ai/minimax-video`: To use the audio as a drive-track for lip-syncing a digital human.
    - `fal-ai/whisper`: For generating timestamps (STT) if you need to sync captions perfectly.

## Notes & gotchas
- **Max Length:** Single requests are capped at 15,000 characters. For books or long articles, you must chunk the text.
- **Safety:** The model may filter or refuse to generate audio for content that violates xAI's safety policies (though requests deemed in violation are still billed).
- **Region:** Native API is primarily hosted in `us-east-1`.

## Sources
- [FAL.ai xAI TTS Model Page](https://fal.ai/models/xai/tts/v1)
- [xAI Developer Documentation](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
- [Scenario xAI TTS Guide](https://help.scenario.com/en/articles/xai-grok-text-to-speech/)
- [Basenor Model Launch Report](https://www.basenor.com/blogs/news/xai-launches-grok-text-to-speech-api-5-voices-20-languages)