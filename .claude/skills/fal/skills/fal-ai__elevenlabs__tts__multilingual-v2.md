---
name: fal-ai/elevenlabs/tts/multilingual-v2
display_name: ElevenLabs TTS Multilingual v2
category: text-to-audio
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2/api
original_source: https://elevenlabs.io/docs/overview/models#multilingual-v2
summary: State-of-the-art multilingual speech synthesis model providing lifelike, emotionally rich audio in 29+ languages.
---

# ElevenLabs TTS Multilingual v2

## Overview
- **Slug:** `fal-ai/elevenlabs/tts/multilingual-v2`
- **Category:** Text-to-Audio
- **Creator:** [ElevenLabs](https://elevenlabs.io)
- **Best for:** High-fidelity narration, audiobooks, and emotionally nuanced voiceovers in multiple languages.
- **FAL docs:** [FAL.ai Documentation](https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2/api)
- **Original source:** [ElevenLabs Models Documentation](https://elevenlabs.io/docs/overview/models#multilingual-v2)

## What it does
ElevenLabs Multilingual v2 is a premier text-to-speech model engineered for stability, language diversity, and accent accuracy. It produces natural, lifelike speech with a high emotional range and contextual understanding. Unlike simpler TTS models, it maintains a speaker's unique vocal characteristics and personality even when switching between its [29 supported languages](https://elevenlabs.io/docs/overview/models#multilingual-v2).

## When to use this model
- **Use when:** You need the highest quality "human-like" narration for long-form content like podcasts or audiobooks.
- **Use when:** You are building multilingual applications where a single voice must speak multiple languages fluently while keeping the same persona.
- **Don't use when:** You need ultra-low latency (under 200ms) for real-time conversational agents; use `eleven_flash_v2_5` instead.
- **Alternatives:** 
    - **ElevenLabs Flash v2.5:** Optimized for speed (~75ms latency) but slightly less expressive.
    - **OpenAI TTS:** Good general-purpose TTS, often lower cost but with fewer voice customization options.

## API — via FAL.ai
**Endpoints:**
- **Sync:** `https://fal.run/fal-ai/elevenlabs/tts/multilingual-v2`
- **Queue:** `https://queue.fal.run/fal-ai/elevenlabs/tts/multilingual-v2`

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | string | *Required* | Max 10,000 chars | The text to convert to speech. |
| `voice` | string | `""` | Voice ID/Name | The specific voice ID (e.g., `JBFqnCBsd6RMkjVDRZzb`) to use. |
| `stability` | float | `0.5` | `0.0 - 1.0` | Higher values make the voice more consistent; lower values allow more emotional variation. |
| `similarity_boost` | float | `0.75` | `0.0 - 1.0` | Enhances how closely the output matches the original voice's timbre. |
| `style` | float | `0.0` | `0.0 - 1.0` | Controls emotional intensity. High values increase dramatic emphasis. |
| `speed` | float | `1.0` | `0.7 - 1.2` | Adjusts speech rate (0.7 is slower, 1.2 is faster). |
| `timestamps` | boolean | `false` | `true, false` | If true, returns word-level timestamps for syncing visuals. |
| `language_code` | string | `""` | ISO 639-1 | Enforces a specific language (e.g., `en`, `fr`, `es`). |
| `previous_text` | string | `""` | - | Contextual text to help the model maintain tone from a previous segment. |
| `next_text` | string | `""` | - | Contextual text for what follows to improve prosody. |
| `apply_text_normalization` | enum | `"auto"` | `auto, on, off` | Controls how numbers/dates are spoken. |

### Output
The output returns a JSON object containing a `audio` field with a file URL and optional `timestamps`.
```json
{
  "audio": {
    "url": "https://fal-cdn.com/audio/...",
    "content_type": "audio/mpeg",
    "file_name": "speech.mp3",
    "file_size": 123456
  },
  "timestamps": [
    {"text": "Hello", "start": 0.0, "end": 0.5},
    ...
  ]
}
```

### Pricing
- **Cost:** ~$0.10 per 1,000 characters [FAL Pricing](https://fal.ai/pricing).

## API — via Original Source (BYO-key direct)
Users can connect directly to ElevenLabs using their own API Key for more granular control over output formats and latency optimization.
- **Endpoint:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
- **Auth Method:** `X-API-KEY` header.
- **Additional Parameters:** 
    - `optimize_streaming_latency`: (Integer 0-4) to reduce time-to-first-byte.
    - `output_format`: Supports `mp3_44100_128`, `pcm_44100`, `ulaw_8000`, and more.
- **Official Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech)

## Prompting best practices
- **Punctuation is Key:** Use commas for short pauses, periods for long pauses, and dashes (—) for abrupt breaks.
- **Use Ellipses:** Inserting `...` between phrases creates a natural "thinking" or "trailing off" pause.
- **Capitalization for Emphasis:** While the model is robust, capitalizing key words or using exclamation marks can subtly guide the emotional intensity.
- **Context Chaining:** Always provide `previous_text` when generating long scripts in chunks; this prevents the model from resetting its "energy level" at the start of every segment.
- **Language Enforcement:** If a text has many foreign loanwords, use `language_code` to ensure the model doesn't switch accents mid-sentence.

## Parameter tuning guide
- **Stability (0.5):** Increase to `0.8+` for professional narration (news, e-learning) where consistency is vital. Decrease to `0.3` for high-drama characters or storytelling.
- **Similarity Boost (0.75):** If a cloned voice sounds "hollow" or slightly robotic, try lowering this. If it doesn't sound enough like the target, raise it.
- **Style Exaggeration (0.0):** Keep at `0` for most uses. Only increase if you want a more "animated" or "breathier" performance, but be aware it can occasionally introduce artifacts.

## Node inputs/outputs
- **Inputs:**
    - `Text Content` (String)
    - `Voice ID` (String)
    - `Settings` (Object: Stability, Similarity, Style)
- **Outputs:**
    - `Audio URL` (URL)
    - `Word Timestamps` (List)
- **Chain-friendly with:**
    - **[Llama 3 / GPT-4o]:** For generating the script before TTS.
    - **[HeyGen / Sync Labs]:** For lip-syncing the generated audio to a video avatar.
    - **[Suno / Udio]:** For adding background music to the narration.

## Notes & gotchas
- **Character Limit:** Strictly capped at 10,000 characters per request on FAL. For longer scripts, use a "Split and Stitch" workflow.
- **Streaming:** Supports the `fal.stream` method for faster playback in UI applications.
- **Voice IDs:** You must use the UUID-style voice IDs (e.g., `21m00Tcm4TlvDq8ikWAM` for "Rachel"). You can find these in the ElevenLabs Voice Library or via their `/v1/voices` endpoint.

## Sources
- [FAL.ai Multilingual v2 Model Page](https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2)
- [ElevenLabs Official Documentation](https://elevenlabs.io/docs/overview/models)
- [ElevenLabs Pricing and Character Limits](https://help.elevenlabs.io/hc/en-us/articles/13298164480913)
