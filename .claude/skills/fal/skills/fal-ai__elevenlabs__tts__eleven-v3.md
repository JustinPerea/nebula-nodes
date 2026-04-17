---
name: fal-ai/elevenlabs/tts/eleven-v3
display_name: ElevenLabs Eleven-v3
category: text-to-speech
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3
original_source: https://elevenlabs.io/v3
summary: State-of-the-art text-to-speech model featuring fine-grained emotional control via audio tags and support for 70+ languages.
---

# ElevenLabs Eleven-v3

## Overview
- **Slug:** `fal-ai/elevenlabs/tts/eleven-v3`
- **Category:** Text-to-Speech (TTS) / Audio Generation
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Emotionally expressive narration, multi-character dialogue, and high-fidelity voice synthesis.
- **FAL docs:** [fal-ai/elevenlabs/tts/eleven-v3](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3)
- **Original source:** [ElevenLabs Eleven v3](https://elevenlabs.io/v3)

## What it does
Eleven v3 is the most advanced speech synthesis model from ElevenLabs, designed for maximum emotional range and contextual understanding. Unlike previous versions, it introduces **Audio Tags**, allowing users to direct the performance with cues like `[laughs]`, `[whispers]`, or `[excited]` directly within the text [ElevenLabs Blog](https://elevenlabs.io/blog/v3-audiotags). It supports over 70 languages and is capable of handling complex multi-speaker scripts in a single generation [ElevenLabs Docs](https://elevenlabs.io/docs/overview/intro).

## When to use this model
- **Use when:** You need high-quality, expressive voiceovers for audiobooks, gaming, or storytelling where emotional nuance is critical.
- **Don't use when:** You require ultra-low latency for real-time conversational AI (use `eleven_flash_v2_5` instead) [Inworld AI Review](https://inworld.ai/resources/elevenlabs-v3-review).
- **Alternatives:** 
    - `eleven_multilingual_v2`: Better for consistent, long-form narration without need for high-frequency emotional shifts.
    - `eleven_flash_v2_5`: Optimized for speed and real-time interaction at ~75ms latency.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/tts/eleven-v3` (sync) / `https://queue.fal.run/fal-ai/elevenlabs/tts/eleven-v3` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | string | (required) | N/A | The text to convert to speech. Supports inline audio tags like `[laughs]`. |
| `voice` | string | `"Rachel"` | Voice ID or name | The voice to use for generation. Must be a valid ElevenLabs voice ID or name. |
| `stability` | float | `0.5` | `0.0` - `1.0` | Controls voice consistency. Lower values are more expressive but less stable. |
| `timestamps` | boolean | `false` | `true`, `false` | Whether to return word-level timestamps in the output. |
| `language_code` | string | `null` | ISO 639-1 (e.g., `en`, `es`) | Forces the model to use a specific language for better pronunciation. |
| `apply_text_normalization` | enum | `"auto"` | `auto`, `on`, `off` | Controls whether the model spells out numbers, dates, etc. |
| `similarity_boost` | float | `0.75` | `0.0` - `1.0` | Higher values follow the original voice's characteristics more closely. |
| `style` | float | `0.0` | `0.0` - `1.0` | Exaggerates the voice's unique style/emotion. |
| `speed` | float | `1.0` | `0.7` - `1.2` | Adjusts the playback speed of the generated audio. |
| `previous_text` | string | `null` | N/A | Context text to improve continuity with previous generations. |
| `next_text` | string | `null` | N/A | Context text to improve continuity with future generations. |

### Output
The API returns a JSON object containing the audio file information and optional timestamps.
```json
{
  "audio": {
    "url": "https://fal.run/storage/files/...",
    "content_type": "audio/mpeg",
    "file_name": "speech.mp3",
    "file_size": 123456
  },
  "timestamps": [
    {
      "text": "Hello",
      "start": 0.0,
      "end": 0.5,
      "type": "word"
    }
  ]
}
```

### Example request
```json
{
  "text": "[excited] Hello! I can't believe how natural this sounds. [laughs] It's amazing!",
  "voice": "JBFqnCBsd6RMkjVDRZzb",
  "stability": 0.4,
  "language_code": "en"
}
```

### Pricing
$0.1 per 1,000 characters processed [FAL.ai Pricing](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3).

## API — via Original Source (BYO-key direct)
**ElevenLabs Native API:**
- **Endpoint:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
- **Parameters:** Includes `model_id` (set to `eleven_v3`), `seed` for reproducibility, and `previous_request_ids` for advanced multi-turn continuity [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
- **Auth method:** `xi-api-key` header.
- **Link:** [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference)

## Prompting best practices
- **Use Audio Tags:** Wrap emotional cues in square brackets (e.g., `[whispering]`, `[shouting]`, `[sighs]`). Tags work best when they match the selected voice's natural range [ElevenLabs Blog](https://elevenlabs.io/blog/v3-audiotags).
- **Length Matters:** Eleven v3 is optimized for longer context. Prompts over 250 characters tend to be more consistent than very short snippets [Scribd - ElevenLabs Prompting Guide](https://www.scribd.com/document/906737085/Prompting-Eleven-v3-Alpha-ElevenLabs-Documentation).
- **Punctuation & Structure:** Use ellipses (`...`) for pauses and capitalization for emphasis. The model is highly sensitive to text structure.
- **Multi-Speaker:** You can write dialogue scripts. When using the native `TextToDialogue` capability, you can assign different voice IDs to specific blocks of text.
- **Example Good Prompt:** `[excited] "The results are in, and... [pauses] we won! [laughs] I can't believe it!"`
- **Example Bad Prompt:** `hi.` (Too short, lacks context for expressive delivery).

## Parameter tuning guide
- **Stability:** Set to **0.3-0.4** for highly emotional or dramatic performances (use with `[audio tags]`). Set to **0.6-0.8** for steady, consistent narration like audiobooks.
- **Similarity Boost:** Use **0.75+** for instant voice clones to ensure they sound like the target. Lower it if the voice starts sounding robotic or "distorted."
- **Style Exaggeration:** Use sparingly (e.g., **0.1-0.2**). High values can lead to unstable audio or artifacts but are great for extreme character acting.
- **Text Normalization:** Leave on `"auto"` for most uses. Turn `"off"` if you have specific phonetic spellings you want the model to follow verbatim.

## Node inputs/outputs
- **Inputs:**
    - `text`: Primary script with audio tags.
    - `voice`: Selection of pre-made or custom voices.
    - `settings`: Stability, style, and similarity sliders.
- **Outputs:**
    - `audio_url`: URL to the generated MP3/PCM file.
    - `timestamps`: JSON array of word timings.
- **Chain-friendly with:**
    - `fal-ai/any-llm`: To generate creative scripts formatted with Eleven v3 audio tags.
    - `fal-ai/translation`: To localize scripts before passing to the multilingual TTS.
    - `fal-ai/dubbing`: For complex video localization workflows.

## Notes & gotchas
- **Latency:** Eleven v3 has significantly higher latency than v2 or Flash. It is NOT suitable for real-time lip-sync or low-latency chatbots [Inworld AI Review](https://inworld.ai/resources/elevenlabs-v3-review).
- **Character Limit:** Typically limited to 5,000 characters per request on FAL.ai.
- **Hallucinations:** At very low stability settings, the model may occasionally emit non-speech sounds or "hallucinate" audio artifacts.

## Sources
- [FAL.ai ElevenLabs Model Page](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3)
- [ElevenLabs Eleven v3 Announcement](https://elevenlabs.io/v3)
- [ElevenLabs Audio Tags Documentation](https://elevenlabs.io/blog/v3-audiotags)
- [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Inworld AI Technical Review of v3](https://inworld.ai/resources/elevenlabs-v3-review)