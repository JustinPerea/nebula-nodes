---
name: fal-ai/ace-step
display_name: ACE-Step
category: text-to-audio
creator: ACE Studio & StepFun
fal_docs: https://fal.ai/models/fal-ai/ace-step
original_source: https://github.com/ACE-Step/ACE-Step-1.5
summary: A high-fidelity music generation foundation model capable of producing full songs with lyrics and vocals from text descriptions.
---

# ACE-Step

## Overview
- **Slug:** `fal-ai/ace-step`
- **Category:** Text-to-Audio / Music Generation
- **Creator:** [ACE Studio](https://github.com/ace-step) & [StepFun](https://www.stepfun.com/)
- **Best for:** Generating high-fidelity, full-length songs (up to 60s on FAL, up to 10m natively) with melody, harmony, and synthesized vocals.
- **FAL docs:** [FAL.ai ACE-Step Docs](https://fal.ai/models/fal-ai/ace-step)
- **Original source:** [ACE-Step v1.5 GitHub](https://github.com/ACE-Step/ACE-Step-1.5)

## What it does
ACE-Step is a state-of-the-art open-source music foundation model that overcomes the structural limitations of previous autoregressive models. By integrating a **Diffusion Transformer (DiT)** with **Sana's Deep Compression AutoEncoder (DCAE)** and a lightweight linear transformer, it achieves "commercial-grade" audio quality at unprecedented speeds. It can generate complete tracks from genre tags and lyrics, or transform existing audio via inpainting, outpainting, and remixing. Its unique hybrid architecture uses a Language Model as a "planner" to generate a song blueprint (metadata, lyrics, captions) which then guides the diffusion process.

## When to use this model
- **Use when:** You need complete songs with vocals, high-quality loops, or specific style transfers where lyrics and melody must align perfectly.
- **Don't use when:** You need real-time low-latency sound effects (SFX) or extremely short, non-musical environmental sounds.
- **Alternatives:** 
    - [Stable Audio](https://fal.ai/models/fal-ai/stable-audio): Better for general soundscapes and instrumental textures.
    - [Suno/Udio](https://suno.com): Stronger for consumer-facing "full song" simplicity but less controllable via API parameters.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ace-step` (sync) / `https://queue.fal.run/fal-ai/ace-step` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `tags` | string | **Required** | Comma-separated tags | Genre tags (e.g., "lofi, hiphop, chill") to control style. |
| `lyrics` | string | `""` | Text | Lyrics to be sung. Use `[inst]` or `[instrumental]` for non-vocal tracks. |
| `duration` | float | `60` | 5.0 - 60.0 (FAL) | Length of the generated audio in seconds. |
| `number_of_steps` | integer | `27` | 1 - 200 | Inference steps. 27 is balanced; 50+ for higher detail. |
| `seed` | integer | null | Any integer | Seed for reproducibility. |
| `scheduler` | enum | `euler` | `euler`, `heun` | The sampling algorithm used for generation. |
| `guidance_type` | enum | `cfg` | `cfg`, `apg`, `cfg_star` | CFG method. `cfg` is standard; `apg` is often cleaner. |
| `granularity_scale` | integer | `10` | 1 - 20 | Higher values can reduce audio artifacts. |
| `guidance_interval` | float | `0.5` | 0.0 - 1.0 | Steps where guidance is applied (0.5 = middle steps). |
| `guidance_scale` | float | `15` | 1.0 - 30.0 | Overall prompt adherence strength. |
| `tag_guidance_scale`| float | `5` | 1.0 - 20.0 | Strength of the style tags. |
| `lyric_guidance_scale`| float| `1.5` | 0.0 - 10.0 | Strength of the lyric adherence. |

### Output
The API returns a JSON object containing:
- `audio`: A File object with a `url` to the hosted MP3/WAV, `content_type`, `file_name`, and `file_size`.
- `seed`: The integer seed used for the request.
- `tags`: The effective tags used.
- `lyrics`: The processed lyrics used.

### Example request
```json
{
  "tags": "90s boom bap, soulful, jazzy, 92 BPM",
  "lyrics": "[Verse 1]\nCity lights and rainy nights\nChasing dreams in neon lights",
  "duration": 30,
  "guidance_scale": 15
}
```

### Pricing
FAL.ai charges approximately **$0.0002 per second** of generated audio. For $1.00, you can generate roughly 5,000 seconds (83 minutes) of music.

## API — via Original Source (BYO-key direct)
The original source is open-source (Apache 2.0 / MIT). You can run a native API server by cloning the [ACE-Step v1.5 GitHub repository](https://github.com/ACE-Step/ACE-Step-1.5) and running:
```bash
python acestep/api_server.py --enable-api --api-key YOUR_KEY --port 8001
```
**Native advantages:**
- **Extra Params:** Supports `bpm`, `key_scale` (e.g., "C Minor"), `audio_format` (wav, flac), and `vocal_language` (50+ supported).
- **Extended Duration:** Supports generation up to 10 minutes (600s) on high-VRAM hardware.
- **Advanced Tasks:** Direct access to `vocal-to-bgm` and `stem_extraction` which are often omitted from basic web wrappers.

## Prompting best practices
1. **Structural Tags:** Include technical markers in your tags like "BPM", "Key", and "Energy Level" (e.g., `120 BPM, G Major, High Energy`).
2. **Lyric Formatting:** Use brackets for song structure like `[Verse]`, `[Chorus]`, and `[Outro]`. This helps the model align the planning layer.
3. **Instrumental Mode:** If you don't want vocals, set lyrics to `[instrumental]` rather than leaving it empty to avoid "ghost vocals" or humming.
4. **Genre Fusion:** The model excels at blending; try unlikely pairs like `cyberpunk jazz` or `medieval trap`.
5. **Failure Mode:** Vague prompts like "good music" often result in generic pop. Be specific about instrumentation (e.g., `electric guitar, synth pad`).

## Parameter tuning guide
- **Guidance Scale (10-20):** Lower (~10) allows for more "creative" musicality; higher (~20) forces strict adherence to tags but may over-process the audio.
- **Granularity Scale:** If the audio sounds "metallic" or "crunchy," increase this to 15 or 20.
- **Guidance Interval:** Setting this to `1.0` applies guidance throughout all steps, which is better for complex lyrics but may reduce overall audio fidelity.

## Node inputs/outputs
- **Inputs:** 
    - `Tags` (String)
    - `Lyrics` (String)
    - `Duration` (Number)
    - `Guidance Scale` (Number)
- **Outputs:** 
    - `Audio URL` (File/URL)
    - `Seed` (Integer)
- **Chain-friendly with:** 
    - `fal-ai/whisper`: To transcribe and then "remix" audio.
    - `fal-ai/flux`: To generate cover art based on the music tags/lyrics.

## Notes & gotchas
- **Max Duration:** FAL's playground and default API usually cap at 60 seconds. Longer generations require the queue mode or self-hosting.
- **Commercial Use:** The model weights are released under a permissive license (MIT/Apache 2.0) and trained on royalty-free data, making it safer for commercial use than some competitors.
- **VRAM:** Locally, it is highly efficient, running on as little as 4GB VRAM for 1.5-Turbo.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/ace-step)
- [ACE-Step GitHub Repository](https://github.com/ACE-Step/ACE-Step-1.5)
- [Official Research Paper (arXiv)](https://arxiv.org/abs/2506.00045)
- [StepFun Official Site](https://www.stepfun.com/)