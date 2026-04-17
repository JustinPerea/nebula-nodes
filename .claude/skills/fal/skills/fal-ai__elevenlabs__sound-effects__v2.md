---
name: fal-ai/elevenlabs/sound-effects/v2
display_name: ElevenLabs Sound Effects V2
category: text-to-audio
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/api
original_source: https://elevenlabs.io/docs/overview/capabilities/sound-effects, https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
summary: High-fidelity generative AI model for creating cinematic sound effects, foley, and ambient textures from natural language descriptions.
---

# ElevenLabs Sound Effects V2

## Overview
- **Slug:** `fal-ai/elevenlabs/sound-effects/v2`
- **Category:** Text-to-Audio (Generative SFX)
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Generating cinematic foley, ambient backgrounds, and interactive game sounds.
- **FAL docs:** [fal-ai/elevenlabs/sound-effects/v2](https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/api)
- **Original source:** [ElevenLabs SFX Documentation](https://elevenlabs.io/docs/overview/capabilities/sound-effects)

## What it does
ElevenLabs Sound Effects V2 is a state-of-the-art generative model designed to turn text descriptions into high-fidelity audio assets. It excels at creating everything from simple Foley (footsteps, splashes) to complex cinematic soundscapes (sci-fi drones, high-impact trailer "braams"). The V2 model introduced higher sample rates (up to 48kHz), longer durations (up to 30 seconds), and seamless looping capabilities, making it a professional-grade tool for filmmakers, game developers, and content creators.

## When to use this model
- **Use when:** You need custom, royalty-free sound effects that don't exist in standard libraries; you require seamless ambient loops for backgrounds; or you need synchronized foley for specific visual actions.
- **Don't use when:** You need full-length musical compositions (use [ElevenLabs Music](https://fal.ai/models/fal-ai/elevenlabs/music) instead) or long-form narration (use [ElevenLabs TTS](https://fal.ai/models/fal-ai/elevenlabs/text-to-speech)).
- **Alternatives:** 
    - `fal-ai/stable-audio`: Better for structured musical elements and longer compositions.
    - `fal-ai/elevenlabs/sound-effects/v1`: The legacy version; use only if V2's creative style doesn't match your needs.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/sound-effects/v2` (Sync) / `https://queue.fal.run/fal-ai/elevenlabs/sound-effects/v2` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `text` | string | *Required* | N/A | The description of the sound effect to generate. Supports natural language and technical audio terms. |
| `duration_seconds` | float | `null` | 0.5 - 22.0 (FAL) / 30.0 (Native) | The desired length in seconds. If `null`, the model determines the optimal length based on the prompt. |
| `prompt_influence` | float | 0.3 | 0.0 - 1.0 | Controls adherence to the prompt. Higher values result in more literal interpretations; lower values allow for more creative "hallucination." |
| `loop` | boolean | `false` | `true`, `false` | If `true`, the model generates an audio clip that can be looped seamlessly without audible seams. |
| `output_format` | enum | `mp3_44100_128` | See below | The audio codec and quality settings. |

**Available `output_format` values:**
- `mp3_22050_32`, `mp3_44100_32`, `mp3_44100_64`, `mp3_44100_96`, `mp3_44100_128`, `mp3_44100_192`
- `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_44100` (Note: PCM requires specific playback handling).
- *Native ElevenLabs API supports 48kHz WAV, which may be available via specific headers or higher-tier settings.*

### Output
The model returns a JSON object containing a reference to the generated audio file.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/mpeg",
    "file_name": "generated_audio.mp3",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "text": "Deep, resonating cinematic sub-bass drop followed by a metallic echo in a vast cavern",
  "duration_seconds": 5.0,
  "prompt_influence": 0.5,
  "loop": false
}
```

### Pricing
- **FAL.ai:** Approximately `$0.002 per second` of generated audio ([FAL Playground](https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2)).
- **Note:** Pricing is billed per second of the output audio file.

## API — via Original Source (BYO-key direct)
**Endpoint:** `https://api.elevenlabs.io/v1/sound-generation`
- **Auth:** `xi-api-key` header.
- **Max Duration:** Up to **30 seconds**.
- **Output:** Supports `WAV` at `48kHz` (high fidelity) in addition to MP3.
- **Documentation:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)

## Prompting best practices
- **Use Technical Keywords:** Include terms like "reverb", "distorted", "muffled", "high-pass filter", or "stereo spread" to guide the acoustics.
- **Describe Sequences:** Describe the sound over time (e.g., "A heavy wooden door creaks open slowly, followed by a loud metallic thud").
- **Specify Materials:** Mention materials to get accurate foley (e.g., "glass shattering on concrete" vs "glass shattering on carpet").
- **Atmospheric Modifiers:** Use words like "Cinematic", "Lo-fi", "Vintage", or "ASMR" to set the overall tone and texture.
- **Avoid Ambiguity:** Instead of "scary sound", use "high-pitched violin screech with a deep guttural growl".

**Good Prompt:** `"Heavy footsteps walking on dry leaves in a quiet autumn forest, distant crows cawing, 48kHz, binaural audio texture"`
**Bad Prompt:** `"forest noises"`

## Parameter tuning guide
- **Prompt Influence (0.3 - 0.5):** This is the "sweet spot." Below 0.3, the model might ignore specific parts of your prompt to make the sound "musical" or "natural." Above 0.7, the sound can become over-processed or literal.
- **Duration Setting:** If you need a specific sync point (e.g., a 3-second splash), set `duration_seconds` explicitly. If you just want a "good sound," leave it `null` to let the AI decide the natural decay time.
- **Looping:** Always use `loop: true` for rain, wind, engine hums, or crowd chatter to avoid a "dip" in sound when replaying in a loop.

## Node inputs/outputs
- **Inputs:**
    - `Text Prompt`: The description of the sound.
    - `Duration`: Float value for length.
    - `Influence`: Prompt adherence factor.
    - `Loop Toggle`: Boolean for seamless repetition.
- **Outputs:**
    - `Audio URL`: Direct link to the generated `.mp3` or `.wav`.
- **Chain-friendly with:**
    - `fal-ai/kling-video`: Generate sound effects for AI-generated video clips.
    - `fal-ai/flux-pro`: Create audio-reactive assets or sounds for static concepts.
    - `fal-ai/elevenlabs/audio-isolation`: Isolate specific parts of the generated sound.

## Notes & gotchas
- **Duration Limits:** While the native ElevenLabs API supports up to 30 seconds, the FAL implementation documentation lists a maximum of **22 seconds**. Test longer durations carefully.
- **Watermarks:** Check your ElevenLabs plan; lower tiers may require attribution or have specific usage rights.
- **Content Policy:** The model has built-in safety filters to prevent the generation of extremely violent or sexually explicit audio content.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/api)
- [ElevenLabs Official Product Page](https://elevenlabs.io/docs/overview/capabilities/sound-effects)
- [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
- [ElevenLabs V2 Launch Announcement](https://www.linkedin.com/posts/elevenlabsio_introducing-v2-of-our-sfx-model-generate-activity-7368680062662909953-aeBg)
