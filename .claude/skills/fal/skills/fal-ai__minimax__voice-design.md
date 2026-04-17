---
name: fal-ai/minimax/voice-design
display_name: MiniMax Voice Design
category: text-to-audio
creator: MiniMax
fal_docs: https://fal.ai/models/fal-ai/minimax/voice-design
original_source: https://platform.minimax.io/docs/api-reference/voice-design-design
summary: Generate unique, personalized AI voices from text descriptions without reference audio.
---

# MiniMax Voice Design

## Overview
- **Slug:** `fal-ai/minimax/voice-design`
- **Category:** Text-to-Audio (Voice Synthesis)
- **Creator:** [MiniMax](https://platform.minimax.io/)
- **Best for:** Creating unique, non-existent AI voice personas via text descriptions for consistent use in TTS workflows.
- **FAL docs:** [fal.ai/models/fal-ai/minimax/voice-design](https://fal.ai/models/fal-ai/minimax/voice-design)
- **Original source:** [MiniMax API Docs](https://platform.minimax.io/docs/api-reference/voice-design-design)

## What it does
MiniMax Voice Design allows users to "prompt" a new voice into existence. Unlike traditional voice cloning which requires a 10-60 second audio sample of a real person, this model generates a unique `voice_id` based on a text description of traits like age, gender, accent, and emotional tone. It outputs a `voice_id` that can be stored and reused across MiniMax’s suite of high-fidelity TTS models, along with a preview audio clip to verify the design.

## When to use this model
- **Use when:** You need a specific "character" voice (e.g., "a raspy 80-year-old pirate" or "a bubbly teenage tech vlogger") but don't have a voice actor or recording to clone.
- **Use when:** You want to avoid legal/ethical complexities of cloning real human voices by generating a completely synthetic persona.
- **Don't use when:** You need to replicate a specific real person's voice (use `fal-ai/minimax/voice-clone` instead).
- **Alternatives:** 
    - `fal-ai/minimax/voice-clone`: For replicating an existing voice from an audio file.
    - `elevenlabs/voice-design`: A similar descriptive voice generation tool from ElevenLabs.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax/voice-design` (sync) / `https://queue.fal.run/fal-ai/minimax/voice-design` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | Max 1500 chars | Detailed description of the desired voice (gender, age, tone, style). |
| `preview_text` | `string` | *Required* | Max 500 chars | The text used to generate the sample audio for you to hear the designed voice. |

### Output
The output is a JSON object containing the ID for the newly designed voice and a preview audio file.
```json
{
  "custom_voice_id": "voice_12345678",
  "audio": {
    "url": "https://fal.media/files/.../audio.mp3",
    "content_type": "audio/mpeg",
    "file_name": "preview.mp3",
    "file_size": 12345
  }
}
```

### Example request
```json
{
  "prompt": "A calm, middle-aged male narrator with a deep, resonant voice and a slight British accent. He sounds authoritative yet comforting, like a documentary host.",
  "preview_text": "In the heart of the ancient forest, secrets remain buried beneath the moss and stone, waiting for those who dare to listen."
}
```

### Pricing
- **Per voice design:** $3.00 per successful generation (creates a permanent `voice_id`).
- **Preview Characters:** $0.03 per 1000 characters processed in `preview_text`.
- *Note:* Costs are billed directly to your FAL.ai account balance.

## API — via Original Source (BYO-key direct)
MiniMax provides a native API for developers who want to bypass middleware.
- **Endpoint:** `https://api.minimax.io/v1/voice_design`
- **Auth method:** Bearer Token (API Key) via `Authorization` header.
- **Additional parameters:** The native API supports an optional `voice_id` field if you wish to specify a custom string identifier for the generated voice.
- **Official Docs:** [MiniMax Voice Design Reference](https://platform.minimax.io/docs/api-reference/voice-design-design)

## Prompting best practices
- **The "Persona" Stack:** Always include **Gender + Age + Tone + Accent**. 
    - *Poor:* "A man speaking."
    - *Good:* "A gravelly, 50-year-old male from Texas with a slow, Southern drawl and a friendly, neighborly tone."
- **Contextual Cues:** Describe the *setting* or *profession* the voice belongs to. Keywords like "vlogger," "news anchor," "ASMR artist," or "video game villain" help the model apply the correct prosody.
- **Emotional Detail:** Add adjectives for the state of mind, such as "breathless," "ecstatic," "melancholy," or "authoritative."
- **Avoid Ambiguity:** Use concrete terms. Instead of "nice voice," use "warm, melodic, and soothing."

## Parameter tuning guide
Since this model is primarily prompt-driven, "tuning" happens within the `prompt` string:
- **Intensity:** To make a trait stronger, use modifiers like "extremely," "highly," or "very." (e.g., "extremely raspy").
- **Pacing:** Mention the speed in the prompt (e.g., "fast-paced and energetic" vs "measured and deliberate").
- **Language Bias:** Even though the model is multilingual, specifying the native language in the prompt (e.g., "Native French speaker speaking English") can help ground the accent.

## Node inputs/outputs
- **Inputs:**
    - `Voice Description` (String): The text prompt for the persona.
    - `Test Script` (String): The 500-char preview text.
- **Outputs:**
    - `Voice ID` (String): The unique identifier to be passed to future TTS nodes.
    - `Preview Audio` (URL): A link to the generated MP3/WAV.
- **Chain-friendly with:**
    - `fal-ai/minimax/speech-02-hd-v2.5`: Use the generated `voice_id` here to generate long-form high-definition audio.
    - `fal-ai/minimax/speech-01-turbo`: Use for low-latency, real-time responses using your custom voice.

## Notes & gotchas
- **Stability:** The generated voice is statistically "designed." If you run the exact same prompt twice, you may get slightly different variations. Save the `voice_id` immediately once you find a version you like.
- **Preview Limit:** The `preview_text` is strictly capped at 500 characters. For longer testing, you must use a standard TTS endpoint with the returned `voice_id`.
- **Character Limits:** The `prompt` has a 1500-character limit, allowing for extremely detailed character descriptions.

## Sources
- [FAL.ai MiniMax Documentation](https://fal.ai/models/fal-ai/minimax/voice-design)
- [MiniMax Official API Platform](https://platform.minimax.io/docs/api-reference/api-overview)
- [WaveSpeedAI Technical Overview](https://wavespeed.ai/blog/posts/introducing-minimax-voice-design-on-wavespeedai/)
