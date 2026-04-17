---
name: fal-ai/elevenlabs/tts/turbo-v2.5
display_name: ElevenLabs TTS Turbo v2.5
category: text-to-speech
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5
original_source: https://elevenlabs.io/docs/overview/models#eleven-flash-v2-5
summary: A high-speed, low-latency text-to-speech model supporting 32 languages, optimized for real-time conversational AI and interactive applications.
---

# ElevenLabs TTS Turbo v2.5

## Overview
- **Slug:** `fal-ai/elevenlabs/tts/turbo-v2.5`
- **Category:** Text-to-Speech
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Low-latency real-time conversational AI and high-volume multilingual speech generation.
- **FAL docs:** [fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5](https://fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5)
- **Original source:** [ElevenLabs Documentation](https://elevenlabs.io/docs/overview/models#eleven-flash-v2-5)

## What it does
ElevenLabs TTS Turbo v2.5 is a state-of-the-art text-to-speech model engineered for extreme speed without significantly sacrificing the human-like vocal quality ElevenLabs is known for. It supports 32 languages and is specifically optimized for low-latency environments like voice assistants, chatbots, and interactive gaming. Compared to previous versions, it offers up to 3x faster generation for non-English languages and ~25% faster for English ([ElevenLabs Blog](https://elevenlabs.io/blog/introducing-turbo-v25)).

## When to use this model
- **Use when:** Building real-time voice agents, interactive applications, or when cost-efficiency is a priority for large-scale content.
- **Don't use when:** You need maximum emotional range or complex dramatic performance (use `eleven_multilingual_v2` or `eleven_v3` instead).
- **Alternatives:** 
    - **ElevenLabs Multilingual v2:** Better for high-fidelity audiobooks and emotional nuance but with higher latency.
    - **ElevenLabs v3:** The most expressive model for storytelling, supporting 70+ languages but not suitable for real-time.
    - **OpenAI TTS:** A competitive alternative for natural speech, though often with different pricing and language sets.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/tts/turbo-v2.5` (sync) / `https://queue.fal.run/fal-ai/elevenlabs/tts/turbo-v2.5` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | string | *Required* | N/A | The text to convert to speech. |
| `voice` | string | `""` | Voice ID or Name | The voice to use for speech generation. Uses default if empty. |
| `stability` | float | `0.5` | `0.0` - `1.0` | Controls voice stability. Higher is more consistent; lower is more expressive/random. |
| `similarity_boost` | float | `0.75` | `0.0` - `1.0` | Higher values boost clarity and target speaker similarity. |
| `style` | float | `0.0` | `0.0` - `1.0` | Style exaggeration. Attempts to amplify the specific style of the voice. |
| `speed` | float | `1.0` | `0.7` - `1.2` | Adjusts speech tempo. Values < 1.0 slow down; > 1.0 speed up. |
| `timestamps` | boolean | `false` | `true`, `false` | Whether to return word-level timestamps in the response. |
| `previous_text` | string | `null` | N/A | Contextual text before the current request to improve flow/prosody. |
| `next_text` | string | `null` | N/A | Contextual text after the current request for better transitions. |
| `language_code` | string | `null` | ISO 639-1 | Manually enforces a specific language for the model. |
| `apply_text_normalization` | string | `"auto"` | `auto`, `on`, `off` | Controls automatic normalization (e.g., converting "10" to "ten"). |

### Output
The API returns a JSON object containing the audio file details and optional timestamps.
```json
{
  "audio": {
    "url": "https://fal-cdn.com/...",
    "content_type": "audio/mpeg",
    "file_name": "speech.mp3",
    "file_size": 12345
  },
  "timestamps": [
    { "text": "Hello", "start": 0.0, "end": 0.5 },
    ...
  ]
}
```

### Example request
```json
{
  "text": "Hello, how can I help you today?",
  "voice": "21m00Tcm4TlvDq8ikWAM",
  "stability": 0.5,
  "similarity_boost": 0.75,
  "language_code": "en"
}
```

### Pricing
- **FAL.ai:** $0.05 per 1,000 characters ([FAL.ai Pricing](https://fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5/api)).

## API — via Original Source (BYO-key direct)
ElevenLabs provides a direct API for those who wish to use their own keys.
- **Endpoint:** `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
- **Auth method:** Header `xi-api-key`.
- **Additional Parameters:** 
    - `model_id`: Use `eleven_turbo_v2_5`.
    - `apply_language_text_normalization`: A boolean specific to language-aware normalization.
    - `output_format`: Supports various codecs/bitrates (e.g., `mp3_44100_128`, `pcm_44100`).
- **Official Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech)

## Prompting best practices
- **Punctuation is Pacing:** Use commas for short pauses and periods for longer ones. Use ellipses `...` for hesitant pauses.
- **Contextual Anchoring:** Use `previous_text` when generating sequential blocks of dialogue to ensure the AI maintains the same pitch and emotional tone between calls.
- **Language Matching:** For best results, choose a voice whose native accent matches the `language_code` being used.
- **Character Limit:** While Turbo 2.5 supports up to 40,000 characters per call natively, it is often better to chunk long texts into 2,000-5,000 character segments for more stable prosody.
- **Avoid All-Caps:** Avoid writing in ALL CAPS unless you want the model to potentially spell out letters or shout (though shouting is better achieved through "Style" settings).

## Parameter tuning guide
- **Stability (0.5 Sweet Spot):** Move toward **0.3** for more dynamic, expressive, and "human" variation. Move toward **0.8** for steady, corporate, or monotonous narration where consistency is key.
- **Similarity Boost (0.75):** If the voice sounds "grainy" or has artifacts, try lowering this. If the voice doesn't sound enough like the original clone, raise it.
- **Speed (0.7 - 1.2):** Turbo models are naturally fast. Setting speed to **0.9** can often make the delivery feel more natural for standard reading, whereas **1.1** is excellent for fast-paced disclaimers or "speed-reading" scenarios.

## Node inputs/outputs
- **Inputs:**
    - `Text` (String)
    - `Voice ID` (String)
    - `Stability` (Float)
    - `Speed` (Float)
- **Outputs:**
    - `Audio URL` (URL)
    - `Timestamps` (List/JSON)
- **Chain-friendly with:**
    - **fal-ai/llavah:** To describe an image, then feed the description to TTS.
    - **fal-ai/whisper:** To transcribe user audio, process with an LLM, and respond via TTS.
    - **fal-ai/kling-video:** To generate a video and then add a narrated voiceover.

## Notes & gotchas
- **Streaming:** This model is highly recommended for streaming applications due to its ~300ms time-to-first-byte ([WaveSpeedAI](https://wavespeed.ai/blog/posts/introducing-elevenlabs-turbo-v2-5-on-wavespeedai/)).
- **Safety:** ElevenLabs employs automated safety filters; requests violating their terms (e.g., hate speech) may be blocked.
- **Voice Availability:** Not all voices in the ElevenLabs library are optimized for the Turbo model; if a voice sounds robotic, it may be due to the model's compression for speed.

## Sources
- [FAL.ai ElevenLabs TTS Turbo v2.5 Docs](https://fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5/api)
- [ElevenLabs Official Model Overview](https://elevenlabs.io/docs/overview/models)
- [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Introducing Turbo v2.5 Blog Post](https://elevenlabs.io/blog/introducing-turbo-v25)