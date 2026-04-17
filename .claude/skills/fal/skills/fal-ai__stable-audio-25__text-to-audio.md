---
name: fal-ai/stable-audio-25/text-to-audio
display_name: Stable Audio 2.5 (Text to Audio)
category: text-to-audio
creator: Stability AI
fal_docs: https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio
original_source: https://stability.ai/news-updates/stability-ai-introduces-stable-audio-25-the-first-audio-model-built-for-enterprise-sound-production-at-scale, https://stability.ai/guides/stable-audio-25-prompt-guide
summary: A high-fidelity text-to-audio model by Stability AI capable of generating up to 3-minute structured musical compositions and sound effects.
---

# Stable Audio 2.5 (Text to Audio)

## Overview
- **Slug:** `fal-ai/stable-audio-25/text-to-audio`
- **Category:** Text-to-Audio / Music Generation
- **Creator:** [Stability AI](https://stability.ai/)
- **Best for:** Generating high-fidelity, structured musical tracks up to 3 minutes long.
- **FAL docs:** [FAL.ai Stable Audio 2.5](https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio)
- **Original source:** [Stability AI Stable Audio 2.5 Announcement](https://stability.ai/news-updates/stability-ai-introduces-stable-audio-25-the-first-audio-model-built-for-enterprise-sound-production-at-scale)

## What it does
Stable Audio 2.5 is a state-of-the-art latent diffusion model designed to generate high-quality music and sound effects from text descriptions. Unlike many competitors that produce short loops, it is optimized for full-length compositions (up to 3 minutes) with a coherent musical structure, including intros, development sections, and outros ([Stability AI](https://stability.ai/news-updates/stability-ai-introduces-stable-audio-25-the-first-audio-model-built-for-enterprise-sound-production-at-scale)). It leverages an Adversarial Relativistic-Contrastive (ARC) training method for significantly faster inference times (< 2 seconds on GPU) while maintaining 44.1kHz stereo fidelity ([Stability AI](https://stability.ai/news-updates/stability-ai-introduces-stable-audio-25-the-first-audio-model-built-for-enterprise-sound-production-at-scale)).

## When to use this model
- **Use when:** You need full-length instrumental background music, atmospheric soundscapes, or specific sound effects with consistent timing and structure.
- **Don't use when:** You need vocal tracks with coherent lyrics (it is instrumental-only) or if you require tracks longer than 3 minutes.
- **Alternatives:** 
    - **Suno/Udio:** Better for vocal tracks and pop songs with lyrics.
    - **Stable Audio 1.0:** Use if you have specific legacy compatibility needs, though 2.5 is superior in quality.
    - **AudioLDM:** A lighter-weight alternative for shorter sound effects.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/stable-audio-25/text-to-audio` (sync) / `https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The description of the audio/music to generate. |
| `seconds_total` | integer | `190` | 1 - 190 | Total duration of the generated audio in seconds. |
| `num_inference_steps` | integer | `8` | 1 - 50 | The number of denoising steps. Higher values can improve quality but increase latency. |
| `guidance_scale` | float | `1.0` | 0 - 20 | Controls how closely the model follows the prompt. Higher = stricter. |
| `seed` | integer | N/A | N/A | Random seed for reproducible results. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the media as a data URI immediately. |

### Output
The API returns a JSON object containing the generated audio file metadata and the seed used.
- **`audio`**: 
    - `url`: Publicly accessible URL to the generated WAV/MP3 file.
    - `content_type`: The MIME type of the file (e.g., `audio/wav`).
    - `file_name`: Name of the generated file.
    - `file_size`: Size in bytes.
- **`seed`**: The random seed used for generation.

### Example request
```json
{
  "prompt": "An upbeat 128 BPM Chicago House track with deep basslines, syncopated hi-hats, and a soulful piano melody. Atmosphere is energetic and club-ready.",
  "seconds_total": 60,
  "num_inference_steps": 12,
  "guidance_scale": 7.5
}
```

### Pricing
FAL.ai charges a flat rate of **$0.20 per audio generation** ([FAL.ai](https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio)).

## API — via Original Source (BYO-key direct)
Stability AI offers direct API access through their platform.
- **Endpoint:** `https://api.stability.ai/v2beta/stable-audio/generate/text-to-audio`
- **Auth:** Bearer Token (API Key from [platform.stability.ai](https://platform.stability.ai/))
- **Notes:** The native API often has more granular control over output formats (e.g., bitrates) and potentially lower latency for enterprise integrations.

## Prompting best practices
- **Include BPM and Tempo:** Specific BPMs (e.g., "124 BPM") help the model lock in a rhythmic structure.
- **Define Structure:** Mention sections like "Intro," "Build-up," or "Crescendo" to guide the composition.
- **Layer Instruments:** List primary and secondary instruments (e.g., "Lead synth, acoustic drums, deep sub-bass").
- **Specify Production Style:** Use terms like "lo-fi," "studio quality," "analog warmth," or "reverberant hall."
- **Bad Prompt:** "Fast music."
- **Good Prompt:** "Fast-paced cinematic orchestral track for a chase scene, featuring aggressive staccato strings, heavy percussion, and brass swells. Mood is tense and urgent, 140 BPM."

## Parameter tuning guide
- **`seconds_total`**: Set this to the exact length you need. If you are making a loop, setting it to exactly 4, 8, or 16 bars worth of seconds (at a specific BPM) yields better results.
- **`guidance_scale`**: Use `1.0` to `3.0` for creative, abstract interpretations; use `7.0` to `12.0` for strict adherence to complex descriptions.
- **`num_inference_steps`**: Stable Audio 2.5 is very efficient; `8` steps is often enough for good quality. Increase to `15-20` only if the audio sounds "fuzzy" or lacks clarity.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Duration` (Number)
    - `Guidance Scale` (Slider)
    - `Steps` (Number)
    - `Seed` (Number)
- **Outputs:**
    - `Audio File` (Audio/URL)
    - `Seed` (Number)
- **Chain-friendly with:** 
    - `fal-ai/stable-audio-25/audio-to-audio` (for style transfer)
    - `fal-ai/stable-audio-25/inpaint` (for editing specific sections)
    - `fal-ai/playht/tts` (to combine music with voiceovers in post-processing)

## Notes & gotchas
- **Max Duration:** Although the FAL schema allows `190` seconds, the model is natively optimized for up to 3 minutes (180s).
- **No Lyrics:** The model may occasionally generate "singing-like" vowel sounds, but it cannot produce intelligible lyrics.
- **Content Filtering:** Stability AI uses content recognition to prevent the generation of copyrighted music styles that too closely mimic specific artists.

## Sources
- [FAL.ai Stable Audio 2.5 Docs](https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio)
- [Stability AI Product Page](https://stability.ai/news-updates/stability-ai-introduces-stable-audio-25-the-first-audio-model-built-for-enterprise-sound-production-at-scale)
- [Stability AI Prompting Guide](https://stability.ai/guides/stable-audio-25-prompt-guide)
