---
name: fal-ai/elevenlabs/music
display_name: ElevenLabs Music
category: text-to-audio
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/music
original_source: https://elevenlabs.io/music
summary: A professional-grade text-to-music model capable of generating full tracks with lyrics, vocals, and structural control.
---

# ElevenLabs Music (fal-ai/elevenlabs/music)

## Overview
- **Slug:** `fal-ai/elevenlabs/music`
- **Category:** Text-to-Audio / Music Generation
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** Generating studio-quality, complete music tracks with vocals, lyrics, and complex arrangements from natural language.
- **FAL docs:** [fal-ai/elevenlabs/music Docs](https://fal.ai/models/fal-ai/elevenlabs/music)
- **Original source:** [ElevenLabs Music API](https://elevenlabs.io/docs/api-reference/music/compose)

## What it does
ElevenLabs Music is a state-of-the-art generative model designed to produce high-fidelity, production-ready music from text descriptions. Unlike simpler "background music" generators, it understands musical theory, structure (intro, verse, chorus, outro), and can even generate and sing original lyrics in multiple languages ([ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/music)). The model is capable of creating diverse genres ranging from classical and jazz to heavy metal and electronic dance music, often including nuanced multi-instrumental layering and emotional arcs ([AI.cc](https://www.ai.cc/eleven-music/)).

## When to use this model
- **Use when:** 
    - You need full songs with vocals and lyrics for social media, ads, or game soundtracks.
    - You require precise control over song structure (e.g., a specific duration for a bridge).
    - You are building a creative application (like a DAW or video editor) that needs on-demand original scores ([ElevenLabs Blog](https://elevenlabs.io/blog/mozart-ai)).
- **Don't use when:**
    - You only need simple, loopable ambient textures (simpler models like ACE-Step might be more cost-effective).
    - You require real-time low-latency generation for interactive live events (inference times for full songs can be significant).
- **Alternatives:**
    - **Stable Audio (Stability AI):** Better for experimental textures and long-form ambient soundscapes.
    - **Suno/Udio (not on FAL):** Competitors in vocal music generation, but ElevenLabs offers more granular API control over "sections" via FAL.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/music` (Sync) / `https://queue.fal.run/fal-ai/elevenlabs/music` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | max 4100 chars | The text description of the music. Cannot be used with `composition_plan`. |
| `composition_plan` | object | - | - | A detailed plan including sections, styles, and lyrics. |
| `music_length_ms` | integer | (auto) | 3000 - 600000 | Desired length in milliseconds (3s to 10 min). |
| `force_instrumental` | boolean | `false` | `true`, `false` | If true, ensures no vocals are generated. |
| `respect_sections_durations` | boolean | `true` | `true`, `false` | How strictly to follow durations in the composition plan. |
| `output_format` | enum | `mp3_44100_128` | mp3, pcm, etc. | Format including codec, sample rate, and bitrate. |

### Output
The API returns a JSON object containing the generated audio file metadata:
```json
{
  "audio": {
    "url": "https://v3.fal.media/.../audio.mp3",
    "content_type": "audio/mpeg",
    "file_name": "elevenlabs_music.mp3",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "An upbeat 80s synthwave track with a driving bassline, retro futuristic synths, and a catchy female vocal about driving through a neon city at night.",
  "music_length_ms": 60000,
  "force_instrumental": false,
  "output_format": "mp3_44100_192"
}
```

### Pricing
FAL.ai charges **$0.80 per output minute** for ElevenLabs Music ([fal.ai Pricing](https://fal.ai/pricing)). Billing is rounded up to the nearest minute (e.g., a 30s track costs $0.80).

## API — via Original Source (BYO-key direct)
ElevenLabs provides a direct API for developers who want to use their own ElevenLabs API keys.

- **Endpoint:** `POST https://api.elevenlabs.io/v1/music`
- **Auth:** `xi-api-key` header.
- **Native-only features:** 
    - **Stem Separation:** Split generated tracks into Vocals, Drums, Bass, and "Others" ([ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/music/separate-stems)).
    - **Inpainting:** Modify specific sections of an existing track ([ElevenLabs Blog](https://elevenlabs.io/blog/eleven-music-new-tools-for-exploring-editing-and-producing-music-with-ai)).
    - **Custom Fine-tunes:** Ability to train the model on your own audio datasets to capture a specific brand sound ([ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/music)).
- **Documentation:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/music/compose)

## Prompting best practices
- **Be structural:** Use keywords like "Intro," "Verse," "Chorus," and "Outro" in your natural language prompt to guide the AI's arrangement.
- **Define instrumentation:** Explicitly list instruments (e.g., "distorted electric guitar," "grand piano," "808 sub-bass").
- **Style and Tempo:** Use descriptive adjectives ("cinematic," "aggressive," "lo-fi") and specify tempo if needed ("120 BPM").
- **Lyric Control:** If not using a `composition_plan`, you can suggest lyrics in the prompt using quotes, though the model performs better with structured section data.
- **Language Support:** The model is multilingual; specify the language of the vocals (e.g., "Japanese pop," "Spanish ballad") for better results ([ElevenLabs Docs](https://elevenlabs.io/docs/overview/capabilities/music)).

## Parameter tuning guide
- **`music_length_ms`:** If left null, the model chooses a length based on the prompt complexity. For background loops, set this to exactly your needed duration.
- **`force_instrumental`:** Always set to `true` if you are generating background scores to avoid unexpected "mumbled" vocal artifacts in the background.
- **`respect_sections_durations`:** When using a `composition_plan`, set this to `true` for video-syncing use cases where section timing must match visual cues precisely.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text): The creative description.
    - `Duration` (Number): Length in ms.
    - `Format` (Select): Output audio quality.
    - `Instrumental Only` (Toggle): Disable vocals.
- **Outputs:**
    - `Audio URL`: Link to the generated MP3/PCM.
    - `JSON Plan`: (If available) The structured breakdown of the generated track.
- **Chain-friendly with:**
    - **ElevenLabs TTS:** Generate a narrator's voice to overlay on the generated music.
    - **Flux.1 [dev]:** Generate professional-looking album cover art based on the song's theme.
    - **Kling/Luma:** Create a music video by using the generated track as a "Sync" or "Background" audio source.

## Notes & gotchas
- **Copyright:** Music generated on paid tiers (Starter+) includes commercial rights, but users should verify specific licensing for generated lyrics if they mirror existing famous works ([ElevenLabs Pricing](https://elevenlabs.io/pricing)).
- **Duration Limit:** Maximum duration is 10 minutes (600,000ms).
- **Inference Time:** Longer tracks can take 1-2 minutes to generate; always use the `queue` mode for durations over 30 seconds.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/elevenlabs/music)
- [ElevenLabs Official Music Docs](https://elevenlabs.io/docs/overview/capabilities/music)
- [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/music/compose)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [AI.cc Technical Breakdown](https://www.ai.cc/eleven-music/)
