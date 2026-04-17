---
name: fal-ai/gemini-tts
display_name: Gemini TTS
category: text-to-audio
creator: Google DeepMind / Google Cloud
fal_docs: https://fal.ai/models/fal-ai/gemini-tts
original_source: https://cloud.google.com/text-to-speech/docs/gemini-tts
summary: High-fidelity, prompt-steerable speech synthesis supporting multi-speaker conversations and expressive delivery.
---

# Gemini TTS

## Overview
- **Slug:** `fal-ai/gemini-tts`
- **Category:** Text-to-Audio (TTS)
- **Creator:** [Google DeepMind](https://deepmind.google/models/gemini-audio/)
- **Best for:** Generating expressive, multi-speaker podcasts, audiobooks, and conversational AI with natural language control over performance.
- **FAL docs:** [fal.ai/models/fal-ai/gemini-tts](https://fal.ai/models/fal-ai/gemini-tts)
- **Original source:** [Google Cloud Gemini-TTS Documentation](https://cloud.google.com/text-to-speech/docs/gemini-tts)

## What it does
Gemini TTS is a state-of-the-art speech synthesis model that leverages the Gemini multimodal architecture to provide "steerable" audio generation. Unlike traditional TTS models that rely on rigid SSML tags, Gemini TTS allows users to use natural language prompts to dictate the style, pace, accent, and emotional tone of the speech. It supports both single-speaker and complex multi-speaker configurations, making it ideal for creating dynamic dialogues and narrations.

## When to use this model
- **Use when:** You need high-quality, human-like narration where specific emotions (e.g., "cheerful," "curious," "whispering") are required.
- **Use when:** You are creating multi-speaker content like podcasts or dramatic reads where different voices must interact naturally.
- **Don't use when:** You need real-time streaming audio (the model does not support streaming output).
- **Alternatives:** 
    - [fal-ai/gemini-3.1-flash-tts](https://fal.ai/models/fal-ai/gemini-3.1-flash-tts): The newer version supporting granular audio tags for even more precise control.
    - [fal-ai/playai/tts-v3](https://fal.ai/models/fal-ai/playai/tts-v3): Good for high-fidelity, low-latency single-speaker narration.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/gemini-tts` (sync) / `https://queue.fal.run/fal-ai/gemini-tts` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | - | The text to convert to speech. Supports natural-language instructions and speaker aliases (e.g., "Alice: Hello!"). |
| `style_instructions` | `string` | `null` | - | Optional delivery instructions prepended to the prompt (e.g., "Speak warmly and slowly"). |
| `voice` | `VoiceEnum` | `Kore` | 30 presets | Voice preset for single-speaker synthesis. Ignored if `speakers` is set. |
| `model` | `ModelEnum` | `gemini-2.5-flash-tts` | `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts` | Choice between the fast/efficient Flash model or the high-quality Pro model. |
| `language_code` | `Enum` | `null` | 80+ locales | Specific language/locale for synthesis (e.g., "English (US)", "French (France)"). |
| `speakers` | `list<SpeakerConfig>`| `null` | - | Configuration for multi-speaker mode. Maps speaker IDs in the prompt to specific voice presets. |
| `temperature` | `float` | `1.0` | 0.0 to 2.0+ | Controls randomness/creativity of delivery. Higher = more varied. |
| `output_format` | `Enum` | `mp3` | `mp3`, `wav`, `ogg_opus` | The audio file format. |

### Output
The API returns a JSON object containing an `audio` field with the file details:
- `url`: The public URL to the generated audio.
- `content_type`: Mime type (e.g., `audio/mpeg`).
- `file_name`: Name of the file.
- `file_size`: Size in bytes.

### Example request
```json
{
  "prompt": "Host: Welcome to the future of AI! Today we are discussing Gemini TTS.\nGuest: Thanks for having me. I'm excited to show how expressive this model can be.",
  "model": "gemini-2.5-flash-tts",
  "speakers": [
    { "speaker_id": "Host", "voice": "Charon" },
    { "speaker_id": "Guest", "voice": "Kore" }
  ],
  "style_instructions": "Read this as a friendly, professional podcast intro."
}
```

### Pricing
- **Flash Model:** $0.50 per 1 million input tokens / $10.00 per 1 million output tokens.
- **Pro Model:** Costs are doubled ($1.00 per 1M input / $20.00 per 1M output).

## API — via Original Source (BYO-key direct)
The original model is hosted by **Google Cloud Platform (GCP)**. Users can access it directly via the Cloud Text-to-Speech API or Vertex AI.
- **Endpoint:** `https://texttospeech.googleapis.com/v1/text:synthesize`
- **Auth:** Google Cloud Service Account (OAuth 2.0).
- **Extra Features:** Native API supports sample rate configuration and raw PCM (LINEAR16) output.
- **Docs:** [Google Cloud TTS - Gemini-TTS](https://cloud.google.com/text-to-speech/docs/gemini-tts)

## Prompting best practices
- **Use Descriptive Adjectives:** Instead of just "happy," try "Say this with infectious enthusiasm" or "Deliver this like a closely guarded secret."
- **Inline Tags:** You can use bracketed instructions within the text, e.g., `[whispering] Don't let them hear you... [normal] Okay, let's go.`
- **Punctuation Matters:** The model respects ellipsis `...` for pauses and exclamation marks `!` for emphasis more effectively than standard TTS.
- **Contextual Framing:** Provide the model with a scenario in `style_instructions`, such as "You are a weary traveler sharing a story by a campfire."
- **Avoid Over-prompting:** Mixing too many conflicting style instructions (e.g., "fast but slow") can lead to unpredictable distortions.

## Parameter tuning guide
- **`model` selection:** Use `flash` for chatbots or low-cost applications. Use `pro` for public-facing media like audiobooks where the highest fidelity is paramount.
- **`temperature`:** Increase to `1.5` or higher if the delivery feels too "flat" or repetitive. Lower to `0.7` for professional corporate narrations that need to be consistent.
- **`style_instructions`:** Use this for global tone (e.g., "British accent") rather than per-sentence changes, which should be done in the `prompt` itself.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Style Instructions` (Text)
    - `Model` (Dropdown)
    - `Voice` (Dropdown)
    - `Speakers` (JSON/List)
- **Outputs:**
    - `Audio File` (URL/Audio)
- **Chain-friendly with:** 
    - `fal-ai/gemini-v-pro`: Use to generate a podcast script from a document, then pass to Gemini TTS.
    - `fal-ai/flux-pro`: Create cover art for the generated audio/podcast.

## Notes & gotchas
- **No Streaming:** This is a batch-oriented model; you must wait for the full generation to complete before playing.
- **Context Limit:** Total input is limited to 32k tokens, which is generally enough for several minutes of speech but may require chunking for full-length books.
- **Speaker Mapping:** Ensure the `speaker_id` in the `speakers` list matches the prefix used in the `prompt` exactly (including the colon).

## Sources
- [FAL.ai Gemini TTS Documentation](https://fal.ai/models/fal-ai/gemini-tts/api)
- [Google Cloud Gemini-TTS Official Guide](https://cloud.google.com/text-to-speech/docs/gemini-tts)
- [Google DeepMind Model Overview](https://deepmind.google/models/gemini-audio/)
