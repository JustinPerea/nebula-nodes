---
name: fal-ai/mmaudio-v2/text-to-audio
display_name: MMAudio V2 Text to Audio
category: text-to-audio
creator: Ho Kei Cheng (University of Illinois Urbana-Champaign), Sony AI, and Sony Group Corporation
fal_docs: https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio
original_source: https://github.com/hkchengrex/MMAudio
summary: A high-quality 44.1kHz text-to-audio generation model based on multimodal flow matching, capable of generating professional sound effects and ambient soundscapes.
---

# MMAudio V2 Text to Audio

## Overview
- **Slug:** `fal-ai/mmaudio-v2/text-to-audio`
- **Category:** text-to-audio
- **Creator:** [Ho Kei Cheng (Rex Cheng)](https://hkchengrex.github.io/), Sony AI, and Sony Group Corporation.
- **Best for:** High-fidelity sound effects, ambient atmospheres, and cinematic textures.
- **FAL docs:** [https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio](https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio)
- **Original source:** [https://github.com/hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio)

## What it does
MMAudio V2 is a multimodal audio generation model that uses a flow-matching objective to synthesize high-quality audio (44.1kHz) from textual descriptions. While its primary research breakthrough was in video-to-audio synchronization, the model is exceptionally strong at standalone text-to-audio, producing semantically aligned soundscapes that are more detailed and stable than many previous diffusion-based audio models. It can generate up to 30 seconds of audio in a single call.

## When to use this model
- **Use when:** You need high-fidelity sound effects (Foley), ambient environmental sounds, or instrumental textures that require a specific "feel" described in text.
- **Don't use when:** You need clear, intelligible human speech (it often produces "sim-ish" or unintelligible speech) or complex multi-track musical compositions with lyrics.
- **Alternatives:** 
  - [fal-ai/stable-audio](https://fal.ai/models/fal-ai/stable-audio): Better for full-length musical compositions.
  - [fal-ai/playai/tts](https://fal.ai/models/fal-ai/playai/tts): Better for high-quality human speech.
  - [fal-ai/elevenlabs/sound-effects](https://fal.ai/models/fal-ai/elevenlabs/sound-effects): A strong competitor for short SFX.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/mmaudio-v2/text-to-audio` (sync) / `https://queue.fal.run/fal-ai/mmaudio-v2/text-to-audio` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | The description of the audio to generate (e.g., "Thunderstorm in a dense forest"). |
| `negative_prompt` | string | "" | N/A | What to avoid in the generated audio (e.g., "music, speech, white noise"). |
| `duration` | float | 8.0 | 1.0 - 30.0 | Duration of the audio clip in seconds. |
| `num_steps` | integer | 25 | 1 - 50 | Number of inference steps for the ODE solver. Higher values can improve quality but increase cost. |
| `cfg_strength` | float | 4.5 | 1.0 - 20.0 | Classifier Free Guidance strength. Higher follows the prompt more strictly but may introduce artifacts. |
| `seed` | integer | random | N/A | Seed for reproducibility. |
| `mask_away_clip` | boolean | false | true/false | Internal technical parameter to mask visual CLIP features during text-only generation. |

### Output
The API returns a JSON object containing a reference to the generated audio file:
```json
{
  "audio": {
    "url": "https://fal.run/storage/...",
    "content_type": "audio/flac",
    "file_name": "mmaudio_output.flac",
    "file_size": 1001342
  }
}
```

### Example request
```json
{
  "prompt": "A busy city street with distant sirens and footsteps on pavement",
  "duration": 10,
  "num_steps": 30,
  "cfg_strength": 5.0
}
```

### Pricing
$0.001 per generated second. An 8-second clip costs $0.008.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary commercial API surface for MMAudio V2. The original creators have released the code on [GitHub](https://github.com/hkchengrex/MMAudio) under an MIT license, but they do not provide a direct managed API for commercial use. Developers can self-host the model using the provided weights (CC-BY-NC 4.0 license).

## Prompting best practices
- **Be Specific with Context:** Instead of "rain," use "heavy rain hitting a tin roof with occasional distant thunder."
- **Use Audio Keywords:** Include words like "high fidelity," "stereo," "ambient," or "foley" to guide the model's texture.
- **Negative Prompting:** If the model adds unwanted "hallucinated" music or speech-like babbling, explicitly add "music, singing, talking, whispering" to the negative prompt.
- **Avoid Ambiguity:** The model struggles with concepts it hasn't seen in its 2,500-hour training set (VGGSound, AudioCaps, etc.). Stick to natural sounds and common industrial/domestic noises.

## Parameter tuning guide
- **`duration`:** Keep prompts concise for shorter durations. For 30-second clips, describe a progression (e.g., "Starts with birds chirping, then a car drives by").
- **`num_steps`:** 25 is usually sufficient. Increase to 40-50 only if the audio sounds "grainy" or lacks detail.
- **`cfg_strength`:** 4.5 is the sweet spot. If the output is too generic, try 6.0-7.0. If the audio sounds distorted or "over-baked," lower it to 3.5.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (Text)
  - `Duration` (Number)
  - `CFG Strength` (Slider)
  - `Negative Prompt` (Text)
- **Outputs:**
  - `Audio File` (Audio/URL)
- **Chain-friendly with:**
  - `fal-ai/kling-video`: Generate a video first, then use MMAudio to add sound.
  - `fal-ai/flux-pro`: Generate an image, then use MMAudio to create a matching ambient loop.

## Notes & gotchas
- **Speech Limitation:** The model is not a TTS engine. Any speech it generates will likely be garbled.
- **Output Format:** Usually defaults to FLAC or MP4 (if bundled with video).
- **Latency:** MMAudio is very fast; it can typically generate 8 seconds of audio in ~1.2 seconds of compute time.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio)
- [MMAudio GitHub Repository](https://github.com/hkchengrex/MMAudio)
- [MMAudio Research Paper (CVPR 2025)](https://arxiv.org/abs/2412.15322)
- [MMAudio Project Webpage](https://hkchengrex.github.io/MMAudio)
