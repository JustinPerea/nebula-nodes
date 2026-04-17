---
name: fal-ai/kokoro/american-english
display_name: Kokoro TTS (American English)
category: text-to-speech
creator: hexgrad
fal_docs: https://fal.ai/models/fal-ai/kokoro/american-english
original_source: https://huggingface.co/hexgrad/Kokoro-82M
summary: A lightweight, 82M-parameter text-to-speech model delivering human-level quality with extreme efficiency.
---

# Kokoro TTS (American English)

## Overview
- **Slug:** `fal-ai/kokoro/american-english`
- **Category:** text-to-speech
- **Creator:** [hexgrad](https://huggingface.co/hexgrad) (trained by [@rzvzn](https://github.com/hexgrad/kokoro))
- **Best for:** High-quality, low-latency speech synthesis for applications where cost and speed are critical.
- **FAL docs:** [https://fal.ai/models/fal-ai/kokoro/american-english](https://fal.ai/models/fal-ai/kokoro/american-english)
- **Original source:** [https://github.com/hexgrad/kokoro](https://github.com/hexgrad/kokoro)

## What it does
Kokoro is a "frontier" text-to-speech (TTS) model that achieves high-fidelity, natural-sounding audio despite having only **82 million parameters**. Based on the [StyleTTS 2 architecture](https://arxiv.org/abs/2306.07691), it uses style diffusion and adversarial training to generate expressive speech without needing a reference audio clip. It is significantly more efficient than models 10-50x its size, making it ideal for real-time voice agents, content narration, and edge deployment.

## When to use this model
- **Use when:** You need high-quality speech at a fraction of the cost of premium providers like ElevenLabs.
- **Use when:** Low-latency response is required for interactive voice assistants.
- **Don't use when:** You need native voice cloning (Kokoro uses pre-trained voicepacks).
- **Don't use when:** You require complex emotional control or high-level acting (use ElevenLabs for top-tier expressiveness).
- **Alternatives:** 
    - [fal-ai/elevenlabs/tts](https://fal.ai/models/fal-ai/elevenlabs/tts): Higher quality and voice cloning, but significantly more expensive.
    - [fal-ai/metavoice-v1](https://fal.ai/models/fal-ai/metavoice-v1): Open-weight alternative with zero-shot cloning, but much larger and slower.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/kokoro/american-english` (sync) / `https://queue.fal.run/fal-ai/kokoro/american-english` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | `""` | N/A | The text to be converted into speech. Max length is generally limited by context window (~512 tokens/phonemes). |
| `voice` | string | `af_heart` | See below | Voice ID for the desired voice style. |
| `speed` | float | `1.0` | `0.1` to `5.0` | Playback speed of the generated audio. |

**Available Voices (American English):**
- **Female (`af_`):** `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`
- **Male (`am_`):** `am_adam`, `am_michael`, `am_puck`, `am_fenrir`, `am_liam`, `am_onyx`, `am_santa`, `am_echo`

### Output
The output is a JSON object containing a reference to the generated audio file.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/wav",
    "file_name": "audio.wav",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "prompt": "Hello! I am Kokoro, a lightweight but powerful text-to-speech model.",
  "voice": "af_bella",
  "speed": 1.0
}
```

### Pricing
- **Cost:** $0.02 per 1,000 characters.
- **Efficiency:** Approximately 50,000 characters per $1.00 on FAL.ai.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary managed API surface. Since the model is open-weight, there is no single "official" direct API from the creator, but it can be self-hosted using the [hexgrad/kokoro](https://github.com/hexgrad/kokoro) library or [Kokoro-js](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) for ONNX/WebGPU.

- **Endpoint:** Local or custom deployment (e.g., FastAPI wrapper).
- **Auth method:** None (open weights).
- **Link to official docs:** [https://github.com/hexgrad/kokoro](https://github.com/hexgrad/kokoro)

## Prompting best practices
- **Punctuation is key:** The model uses punctuation to determine prosody and pauses. Use commas for brief pauses and periods/exclamation marks for sentence boundaries.
- **Capitalization:** Use capitalization for emphasis or to signal the start of a new thought, as the internal phonemizer (espeak-ng) and Bert-based text encoder rely on standard text formatting.
- **Phonetic hints:** While FAL's implementation primarily takes raw text, the underlying model supports IPA phonemes (e.g., `[kˈOkəɹO]`). If the model struggles with a name, try spelling it phonetically.
- **Segment long text:** For very long paragraphs, split the input into smaller chunks (under 500 characters) to ensure the highest stability and avoid "robotic" drift toward the end of a long sequence.

## Parameter tuning guide
- **Speed (0.8 - 1.2):** Most natural results occur near the 1.0 default. Values below 0.8 can sound overly drawn out, while values above 1.5 are useful for "fine print" or rapid information delivery.
- **Voice Selection:** 
    - Use `af_bella` or `af_sarah` for standard, high-quality female narration.
    - Use `am_adam` or `am_michael` for clear, professional male narration.
    - Use `af_sky` for a more "modern" AI assistant tone.

## Node inputs/outputs
- **Inputs:** 
    - `Prompt` (Text)
    - `Voice` (Dropdown/String)
    - `Speed` (Number)
- **Outputs:** 
    - `Audio URL` (URL)
    - `Audio File` (File)
- **Chain-friendly with:** 
    - `fal-ai/flux/schnell`: Use Kokoro to provide narration for images generated in real-time.
    - `fal-ai/any-llm`: Use an LLM to generate the script/prompt for Kokoro.

## Notes & gotchas
- **Phonemizer:** Kokoro relies on `espeak-ng` for G2P (grapheme-to-phoneme). Unusual names or jargon might occasionally be mispronounced; use phonetic spelling if this happens.
- **Context Limit:** The model has a context length of 512 tokens. While the library handles longer text by chunking, the best quality is achieved when sentences are kept concise.
- **No Cloning:** Unlike ElevenLabs, you cannot upload a sample to clone a voice. You must choose from the provided voicepacks.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/kokoro/american-english)
- [hexgrad/Kokoro-82M Hugging Face Card](https://huggingface.co/hexgrad/Kokoro-82M)
- [StyleTTS 2 Research Paper](https://arxiv.org/abs/2306.07691)
- [FAL.ai API Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kokoro/american-english)