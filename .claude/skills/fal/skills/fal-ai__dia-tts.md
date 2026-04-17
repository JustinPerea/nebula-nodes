---
name: fal-ai/dia-tts
display_name: Dia TTS
category: text-to-speech
creator: Nari Labs
fal_docs: https://fal.ai/models/fal-ai/dia-tts
original_source: https://github.com/nari-labs/dia
summary: An advanced 1.6B parameter dialogue-centric text-to-speech model capable of generating natural multi-speaker conversations with non-verbal cues.
---

# Dia TTS

## Overview
- **Slug:** `fal-ai/dia-tts`
- **Category:** Text-to-Speech (TTS)
- **Creator:** [Nari Labs](https://github.com/nari-labs/dia)
- **Best for:** Generating ultra-realistic multi-speaker dialogues, podcasts, and dramatic scripts with natural non-verbal cues.
- **FAL docs:** [fal.ai/models/fal-ai/dia-tts](https://fal.ai/models/fal-ai/dia-tts)
- **Original source:** [Nari Labs GitHub](https://github.com/nari-labs/dia) / [Hugging Face](https://huggingface.co/nari-labs/Dia-1.6B)

## What it does
Dia is a state-of-the-art 1.6 billion parameter text-to-speech model specifically engineered for realistic dialogue synthesis. Unlike traditional TTS models that generate one voice at a time, Dia can process a full transcript and generate a complete multi-speaker conversation in a single pass. It natively supports speaker switching, emotional prosody, and natural non-verbal sounds like laughter, sighs, and throat clearing, making it one of the most expressive open-weights TTS models available.

## When to use this model
- **Use when:** You need a natural-sounding conversation between two or more people; you want to include emotional nuance or non-verbal cues; you are creating audiobooks, radio plays, or game dialogue.
- **Don't use when:** You need extremely low latency for single-word responses (the model is optimized for dialogue chunks); you need a language other than English (currently English-only).
- **Alternatives:** 
  - **[ElevenLabs](https://elevenlabs.io):** Higher quality for long-form narration but typically requires more manual stitching for multi-speaker scenes.
  - **[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M):** Much smaller and faster for simple text, but lacks the dialogue-native features of Dia.

## API — via FAL.ai
**Endpoints:**
- **Sync:** `https://fal.run/fal-ai/dia-tts`
- **Queue:** `https://queue.fal.run/fal-ai/dia-tts`
- **Voice Clone Variant:** `https://fal.run/fal-ai/dia-tts/voice-clone`

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | `string` | (Required) | N/A | The transcript to convert to speech. Use `[S1]`, `[S2]` tags for speakers and `(laughs)`, `(sighs)` for non-verbals. |

*Note: While the base model supports parameters like `guidance_scale` and `temperature`, the current FAL.ai implementation focuses on a simplified `text` input to maximize ease of use.*

### Output
The API returns a JSON object containing a reference to the generated audio file.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/mpeg",
    "file_name": "output.mp3",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "text": "[S1] Hey, did you see that new AI model? [S2] Which one? (chuckles) [S1] The one that does realistic dialogue. It's called Dia. [S2] Wow, that sounds amazing! (excited) Let's try it."
}
```

### Pricing
- **Cost:** $0.04 per 1,000 characters.
- **Billing:** Usage-based; characters are counted from the input `text` field.

---

## API — via Original Source (BYO-key direct)
Dia is an open-weights model developed by Nari Labs. While there is no separate centralized "Dia API" (as FAL.ai is the primary commercial provider), the model can be run locally or via Hugging Face Transformers.

- **Native Implementation:** Uses the `transformers` library with the `DiaForConditionalGeneration` class.
- **Auth method:** None (Open Weights / Apache 2.0).
- **Parameters exposed locally:**
  - `guidance_scale` (CFG): Controls how strictly the model follows the prompt.
  - `temperature`: Controls randomness in the output voice/prosody.
  - `top_k` / `top_p`: Standard sampling parameters for transformer-based generation.
- **Official Docs:** [Nari Labs GitHub](https://github.com/nari-labs/dia)

---

## Prompting best practices
- **Use Speaker Tags:** Always start a segment with `[S1]`, `[S2]`, etc. Even if it's a monologue, `[S1]` helps anchor the voice consistency.
- **Incorporate Non-Verbals:** Use parentheses for cues: `(laughs)`, `(sighs)`, `(clears throat)`, `(whispers)`, `(excited)`.
- **Natural Pacing:** Dia excels at conversational timing. Use ellipses (`...`) for pauses and natural punctuation to guide the cadence.
- **Chunking:** For very long scripts (over 2,000 characters), consider splitting into natural scenes to maintain high quality and avoid potential drift.
- **Avoid Ambiguity:** Ensure speaker tags are placed at the beginning of each turn. If a speaker is interrupted and then continues, repeat the tag: `[S1] But... [S2] No! [S1] But as I was saying...`

## Parameter tuning guide
While FAL handles most tuning under the hood, if you are running the model in a custom environment (or if FAL exposes these in "Advanced" mode):
- **CFG Scale (Guidance Scale):** Typically set to **3.0**. Lower values (1.5-2.0) result in more "natural" but potentially varied voices; higher values (4.0+) make the voice more stable but can sound more "constrained."
- **Temperature:** The "sweet spot" is often **1.8**. This high value (relative to LLMs) is necessary for the acoustic transformer to produce expressive human-like variation.
- **Top-P:** Usually set to **0.9** to filter out the long tail of low-probability acoustic tokens.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Transcript` (String): The formatted text with speaker and emotion tags.
- **Outputs:**
  - `Audio URL` (String): The URL to the generated MP3 file.
  - `Audio File` (File): The binary/hosted file object for further processing.
- **Chain-friendly with:**
  - **[fal-ai/minimax-v2](https://fal.ai/models/fal-ai/minimax-v2):** Use to generate a dialogue transcript first, then pass it to Dia.
  - **[fal-ai/ffmpeg-python](https://fal.ai/models/fal-ai/ffmpeg-python):** Use to mix the generated dialogue with background music or sound effects.

## Notes & gotchas
- **Voice Consistency:** Since Dia is "zero-shot," it generates a slightly different voice for `[S1]` every time if no reference is provided. To maintain character consistency across multiple API calls, you should use the `voice-clone` variant or a consistent seed.
- **Language Support:** English is currently the only officially supported language. Other languages may produce unpredictable results or heavy accents.
- **Token Limit:** The model is optimized for segments around 5-30 seconds. Very long single-turn blocks might experience a drop in audio quality or "drift" towards the end.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/dia-tts)
- [Nari Labs GitHub Repository](https://github.com/nari-labs/dia)
- [Hugging Face Model Card](https://huggingface.co/nari-labs/Dia-1.6B)
- [DigitalOcean Implementation Guide](https://www.digitalocean.com/community/tutorials/dia-text-to-speech-nari-labs)
- [FAL OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/dia-tts)
