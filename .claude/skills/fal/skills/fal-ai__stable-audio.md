---
name: fal-ai/stable-audio
display_name: Stable Audio Open
category: text-to-audio
creator: Stability AI
fal_docs: https://fal.ai/models/fal-ai/stable-audio
original_source: https://huggingface.co/stabilityai/stable-audio-open-1.0
summary: An open-weights text-to-audio model by Stability AI that generates high-fidelity 44.1kHz stereo audio clips up to 47 seconds long.
---

# Stable Audio Open

## Overview
- **Slug:** `fal-ai/stable-audio`
- **Category:** text-to-audio
- **Creator:** [Stability AI](https://stability.ai/)
- **Best for:** Generating short, high-fidelity audio samples, sound effects, and musical stems from text prompts.
- **FAL docs:** [fal-ai/stable-audio](https://fal.ai/models/fal-ai/stable-audio)
- **Original source:** [HuggingFace - Stable Audio Open 1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0)

## What it does
Stable Audio Open is an open-weights latent diffusion model designed for high-quality text-to-audio generation. It specializes in creating 44.1kHz stereo audio clips, primarily focused on sound effects, musical loops, and ambient textures. While it excels at short-form audio, it is limited to a maximum duration of approximately 47 seconds and lacks the complex song structuring capabilities found in later "Pro" versions of the model. [Stability AI](https://stability.ai/news-updates/stable-audio-open-research-paper)

## When to use this model
- **Use when:** You need high-fidelity (44.1kHz) stereo sound effects, short loops for game design, or instrumental stems for music production.
- **Don't use when:** You need full-length songs with vocals, tracks longer than 47 seconds, or complex musical structures (verse-chorus-bridge).
- **Alternatives:** 
    - **[Stable Audio 2.5](https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio):** Use for longer generations (up to 3 minutes) and full song structures.
    - **[ElevenLabs Music](https://fal.ai/models/fal-ai/elevenlabs/music):** Better for melodic compositions and controlled song sections.
    - **[ACE-Step](https://fal.ai/models/fal-ai/ace-step/prompt-to-audio):** A faster, more cost-effective alternative for quick prototyping. [fal.ai](https://fal.ai/learn/tools/ai-music-generators)

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/stable-audio` (sync) / `https://queue.fal.run/fal-ai/stable-audio` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The description of the audio you want to generate (e.g., "128 BPM tech house drum loop"). |
| `seconds_start` | integer | `0` | 0 - 47 | The start point of the audio clip to generate. |
| `seconds_total` | integer | `30` | 0 - 47 | The total duration of the audio clip to generate. |
| `steps` | integer | `100` | 1 - 1000 | The number of denoising steps. Higher values generally improve quality but increase inference time. |

### Output
The output is a JSON object containing a reference to the generated audio file.
```json
{
  "audio_file": {
    "url": "https://fal.media/files/rabbit/...",
    "content_type": "audio/mpeg",
    "file_name": "stable-audio-output.mp3",
    "file_size": 4404019
  }
}
```

### Example request
```json
{
  "prompt": "Cinematic ambient pads with a distant lonely piano melody, 44.1kHz, high fidelity",
  "seconds_total": 45,
  "steps": 150
}
```

### Pricing
- **FAL.ai:** Approximately **$0 per compute second** for the Open model (subject to change based on FAL's serverless GPU rates). [fal.ai](https://fal.ai/models/fal-ai/stable-audio)
- Note: High-tier models like Stable Audio 2.5 are priced at a flat $0.20 per audio. [fal.ai](https://fal.ai/learn/tools/ai-music-generators)

## API — via Original Source (BYO-key direct)
Stability AI offers the Stable Audio series via their official Platform API. 
- **Endpoint:** `https://api.stability.ai/v2beta/stable-audio/text-to-audio`
- **Cost:** 20 credits per generation (~$0.20).
- **Extra Features:** The official API often provides access to the latest "Pro" versions (2.5) with longer durations and structure control. [Stability AI API Docs](https://platform.stability.ai/docs/api-reference)

## Prompting best practices
- **Include Technical Metadata:** Specify BPM and Key for musical loops (e.g., "90 BPM, G Major").
- **Production Terminology:** Use words like "reverb", "warmth", "compressed", or "clean studio recording" to guide the sonic texture. [Stability AI Guide](https://stability.ai/guides/stable-audio-25-prompt-guide)
- **Layer Instruments:** List specific instruments rather than broad categories (e.g., "heavy Moog bass" instead of just "bass").
- **Avoid Over-complicating:** Simple, descriptive prompts often yield cleaner results for sound effects.
- **Negative Prompts:** Use "low quality", "mono", or "noisy" in the negative prompt if the API implementation supports it (via certain FAL wrappers).

## Parameter tuning guide
- **`steps` (100+):** Increasing steps beyond 100 can refine the details of complex instruments but typically plateaus after 250.
- **`seconds_total`:** For seamless loops, ensure your prompt matches the duration (e.g., a 4-bar loop at 120 BPM is exactly 8 seconds).
- **`seconds_start`:** Useful for continuing a specific vibe if the model allows for temporal conditioning in future updates, though in 1.0 it primarily affects the latent offset.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (String)
  - `Duration` (Number)
  - `Denoising Steps` (Number)
- **Outputs:**
  - `Audio URL` (Link)
  - `Audio File` (File)
- **Chain-friendly with:**
  - `fal-ai/whisper`: Transcribe generated audio for verification.
  - `fal-ai/stable-diffusion`: Generate album art or visuals based on the same audio prompt.

## Notes & gotchas
- **47-Second Limit:** This model cannot generate tracks longer than 47.36 seconds due to its architectural training (256 latents). [HuggingFace](https://huggingface.co/stabilityai/stable-audio-open-small/discussions/2)
- **Non-Commercial Limit:** The Stability AI Community License allows commercial use only for organizations earning less than $1M in annual revenue. [Stability AI License](https://stability.ai/license)
- **No Vocals:** It is not trained to produce realistic singing or speech; vocal prompts will result in stylized or unintelligible "alien" vocals.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/stable-audio)
- [HuggingFace Model Card](https://huggingface.co/stabilityai/stable-audio-open-1.0)
- [Stability AI Research Paper](https://stability.ai/news-updates/stable-audio-open-research-paper)
- [Stability AI Prompting Guide](https://stability.ai/guides/stable-audio-25-prompt-guide)