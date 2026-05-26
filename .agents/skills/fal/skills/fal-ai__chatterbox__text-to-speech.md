---
name: fal-ai/chatterbox/text-to-speech
display_name: Chatterbox (Resemble AI)
category: text-to-speech
creator: Resemble AI
fal_docs: https://fal.ai/models/fal-ai/chatterbox/text-to-speech/api
original_source: https://docs.resemble.ai/getting-started/model-versions
summary: A production-grade, open-source TTS model by Resemble AI featuring zero-shot voice cloning, emotive tags, and precise expressivity controls.
---

# Chatterbox (Resemble AI)

## Overview
- **Slug:** `fal-ai/chatterbox/text-to-speech`
- **Category:** Text-to-Speech
- **Creator:** [Resemble AI](https://www.resemble.ai/)
- **Best for:** High-fidelity, zero-shot voice cloning with granular emotional control.
- **FAL docs:** [FAL.ai/chatterbox](https://fal.ai/models/fal-ai/chatterbox/text-to-speech)
- **Original source:** [Resemble AI Docs](https://docs.resemble.ai/getting-started/model-versions), [GitHub](https://github.com/resemble-ai/chatterbox)

## What it does
Chatterbox is a state-of-the-art text-to-speech (TTS) model family developed by [Resemble AI](https://www.resemble.ai/) and hosted on [FAL.ai](https://fal.ai/). It excels at **zero-shot voice cloning**, allowing users to replicate a target voice using as little as 5–10 seconds of reference audio without any training or fine-tuning. A standout feature is its **emotion exaggeration control**, which allows for adjusting the intensity of the performance, from flat narration to high-drama expression.

The model is built on a transformer-based architecture (utilizing a ~500M parameter Llama backbone) and includes built-in neural watermarking ([PerTh](https://github.com/resemble-ai/perceptual-watermarking)) to ensure responsible AI usage.

## When to use this model
- **Use when:**
    - You need to clone a specific voice instantly from a short clip.
    - You want to add human-like "flaws" or expressions (laughs, sighs) via tags.
    - You require high-quality narration for videos, gaming characters, or AI agents.
    - You are building multilingual applications and want a single model that handles multiple languages (via the Multilingual request).
- **Don't use when:**
    - You need ultra-low latency (<150ms) for real-time conversation (use the **Turbo** variant or a dedicated streaming service).
    - You require advanced SSML support beyond basic emotive tags.
- **Alternatives:**
    - **ElevenLabs (Voice Design):** Better for stylized character creation but often more expensive.
    - **F5-TTS:** An alternative open-source cloning model, though it lacks the specific exaggeration controls of Chatterbox.
    - **OpenAI TTS-1:** Faster and cheaper for standard narration, but does not support zero-shot cloning.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/chatterbox/text-to-speech` (sync) / `https://queue.fal.run/fal-ai/chatterbox/text-to-speech` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | `string` | *Required* | Max 5000 chars | The text to synthesize. Supports emotive tags like `<laugh>`, `<sigh>`, `<gasp>`. |
| `audio_url` | `string` | `null` | URL | Optional reference audio (5-10s) for voice cloning. Overrides defaults. |
| `exaggeration`| `float` | `0.25` | `0.0` - `2.0` | Controls emotional intensity. `0.0` is neutral; `1.0+` is highly expressive. |
| `temperature` | `float` | `0.7` | `0.05` - `2.0` | Controls randomness. Higher = more variation in prosody/pitch. |
| `cfg` | `float` | `0.5` | `0.1` - `1.0` | Classifier-free guidance scale. Controls how strictly it follows the audio prompt. |
| `seed` | `integer`| `null` | Any integer | Used for reproducible results. |

### Advanced Schemas (Other Request Types)
The FAL endpoint also supports specific request formats for **Turbo** and **Multilingual** modes:
- **Turbo (`ChatterboxTurboRequest`):** Optimized for speed with square-bracket tags like `[laugh]`, `[sigh]`, `[shush]`.
- **Multilingual (`ChatterboxMultilingualRequest`):** Supports 23 languages (en, es, fr, de, hi, zh, ja, etc.) with a 300-character limit.

### Output
The API returns a JSON object containing the generated audio file metadata.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/wav",
    "file_name": "speech.wav",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "text": "I just found a hidden treasure in the backyard! <laugh> Check it out!",
  "audio_url": "https://example.com/voice_sample.wav",
  "exaggeration": 0.5,
  "cfg": 0.4
}
```

### Pricing
- **Standard:** $0.025 per 1,000 characters.
- **HD Version:** $0.04 per 1,000 characters.

## API — via Original Source (BYO-key direct)
Resemble AI provides a direct API for enterprise users and those seeking advanced features like real-time streaming or project management.

- **Endpoint:** `https://f.cluster.resemble.ai/synthesize`
- **Auth Method:** Bearer Token (API Key)
- **Extra Parameters:** Supports full SSML, `output_format` (mp3/wav), and `sample_rate` (up to 44.1kHz).
- **Official Docs:** [Resemble AI API Reference](https://docs.resemble.ai/api-reference/synthesize)

## Prompting best practices
- **Use Emotive Tags:** Enhance realism by inserting `<laugh>`, `<sigh>`, or `<chuckle>` at natural pauses.
- **Cloning Quality:** Ensure your `audio_url` points to a clean sample (minimal background noise, single speaker) for the best results.
- **Turbo Tags:** If using the Turbo variant, use square brackets like `[cough]` or `[clear throat]`.
- **Punctuation Matters:** Chatterbox is sensitive to punctuation; use commas for brief pauses and ellipses (...) for longer, more dramatic pauses.

**Example Good Prompt:**
> "Listen, I've been thinking about what you said <sigh>... and honestly? <laugh> You're absolutely right."

**Example Bad Prompt (Over-tagged):**
> "<laugh> Hello <laugh> how <laugh> are <laugh> you?" (Overuse sounds mechanical and distorted).

## Parameter tuning guide
- **Exaggeration (0.25 - 0.7):** Start at `0.25`. If the voice sounds too monotone, bump to `0.5`. Use `0.7+` only for extreme character acting.
- **CFG (0.3 - 0.5):** If the speaker's pace is too fast or doesn't match the reference audio's rhythm, lower `cfg` to `0.3`.
- **Temperature (0.7 - 1.0):** Keep at `0.7` for consistency. Increase to `1.0` if you want the model to take more "creative" liberties with pitch and emphasis.

## Node inputs/outputs
- **Inputs:**
    - `text`: Primary string for synthesis.
    - `audio_url`: Reference file for voice cloning.
    - `exaggeration`: Float slider (0-1).
- **Outputs:**
    - `audio`: The resulting WAV/MP3 file URL.
- **Chain-friendly with:**
    - **Llama 3 / GPT-4o:** To generate the text prompt.
    - **HeyGen / SadTalker:** To use the generated audio for lip-syncing a video avatar.

## Notes & gotchas
- **Character Limits:** Standard TTS on FAL allows up to 5000 characters; Multilingual is limited to 300.
- **Accent Bleed:** When using Multilingual, setting `cfg` to `0` helps reduce the "accent" of the reference voice if it doesn't match the target language.
- **Watermarking:** All audio contains an imperceptible watermark for safety; do not attempt to strip it for malicious use cases.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/chatterbox/text-to-speech)
- [Resemble AI Official Documentation](https://docs.resemble.ai)
- [Resemble AI GitHub Repository](https://github.com/resemble-ai/chatterbox)
- [FAL.ai API Schema JSON](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/chatterbox/text-to-speech)