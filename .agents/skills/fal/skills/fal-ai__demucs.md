---
name: fal-ai/demucs
display_name: Demucs (Source Separation)
category: audio-to-audio
creator: Meta AI Research (Facebook Research)
fal_docs: https://fal.ai/models/fal-ai/demucs
original_source: https://github.com/facebookresearch/demucs
summary: State-of-the-art music source separation (stemming) for vocals, drums, bass, guitar, and piano.
---

# Demucs (Source Separation)

## Overview
- **Slug:** `fal-ai/demucs`
- **Category:** Audio-to-Audio / Music Source Separation
- **Creator:** [Meta AI Research](https://github.com/facebookresearch/demucs)
- **Best for:** High-fidelity stem separation for music production and remixing.
- **FAL docs:** [fal.ai/models/fal-ai/demucs](https://fal.ai/models/fal-ai/demucs)
- **Original source:** [facebookresearch/demucs GitHub](https://github.com/facebookresearch/demucs)

## What it does
Demucs is a state-of-the-art (SOTA) music source separation model that uses a hybrid transformer-convolutional architecture to decompose mixed audio tracks into individual components (stems). It can isolate **vocals, drums, bass, other instruments,** and in specific modes, **guitar and piano**. The "Hybrid Transformer" (v4) approach allows the model to process both time-domain waveforms and frequency-domain spectrograms simultaneously, resulting in significantly fewer "watery" artifacts and better phase preservation than older models like Spleeter.

## When to use this model
- **Use when:** You need professional-grade isolation of vocals for remixes, karaoke, or dialogue cleanup. It is excellent for extracting clean drum samples or basslines from complex tracks.
- **Don't use when:** You need real-time, ultra-low latency separation (it is computationally heavy) or when the input audio is extremely low-bitrate/distorted, as artifacts will be magnified.
- **Alternatives:**
    - **[Spleeter](https://github.com/deezer/spleeter):** Faster but lower quality with more spectral artifacts.
    - **[MDX-Net](https://github.com/kuielab/mdx-net):** Often used in competitions; Demucs v4 (htdemucs) generally matches or exceeds its performance in naturalness.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/demucs` (sync) / `https://queue.fal.run/fal-ai/demucs` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | *Required* | Any valid URL | The URL of the audio file to process (MP3, WAV, OGG, M4A, AAC). |
| `model` | enum | `"htdemucs_6s"` | `htdemucs`, `htdemucs_ft`, `htdemucs_6s`, `hdemucs_mmi`, `mdx`, `mdx_extra`, `mdx_q`, `mdx_extra_q` | The specific Demucs architecture. `htdemucs_ft` is highest quality; `htdemucs_6s` includes guitar/piano. |
| `stems` | list<string> | All stems | `vocals`, `drums`, `bass`, `other`, `guitar`, `piano` | Which stems to return. Note: `guitar`/`piano` only work with `6s` models. |
| `segment_length` | integer | Model-specific | ~8 to 60 | Processing window in seconds. Smaller values save memory; larger values improve context. |
| `shifts` | integer | `1` | `1` to `10` | Random shifts for equivariant stabilization. Increasing this (e.g., to `5`) significantly boosts quality but slows processing. |
| `overlap` | float | `0.25` | `0.0` to `1.0` | Overlap between segments. Higher values (e.g., `0.5`) reduce boundary clicks/artifacts. |
| `output_format` | enum | `"mp3"` | `mp3`, `wav` | Format of the resulting stem files. |

### Output
Returns a JSON object containing URLs to the individual audio stems.
```json
{
  "vocals": { "url": "...", "content_type": "audio/mpeg", "file_name": "vocals.mp3" },
  "drums": { "url": "...", "content_type": "audio/mpeg", "file_name": "drums.mp3" },
  "bass": { "url": "...", "content_type": "audio/mpeg", "file_name": "bass.mp3" },
  "other": { "url": "...", "content_type": "audio/mpeg", "file_name": "other.mp3" },
  "guitar": { "url": "...", "content_type": "audio/mpeg", "file_name": "guitar.mp3" }, // If 6s model used
  "piano": { "url": "...", "content_type": "audio/mpeg", "file_name": "piano.mp3" }     // If 6s model used
}
```

### Example request
```json
{
  "audio_url": "https://example.com/song.mp3",
  "model": "htdemucs_ft",
  "shifts": 5,
  "output_format": "wav"
}
```

### Pricing
- **Cost:** ~$0.0007 per compute second on FAL.ai.
- A typical 3-minute song takes ~15-30 seconds to process on a high-end GPU (A100/H100), costing roughly **$0.01 - $0.02 per song**.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary commercial API surface. Meta provides the model as open-source code on [GitHub](https://github.com/facebookresearch/demucs). There is no "Meta Official API" for third-party keys; however, the model can be run locally or self-hosted via PyTorch.

## Prompting best practices
Demucs does not use text prompts. Quality is entirely dependent on:
1. **Source Quality:** Use lossless (WAV/FLAC) inputs for the best results. High-frequency detail is the first thing lost in separation.
2. **Model Selection:** Always use `htdemucs_ft` (fine-tuned) if quality is paramount and you only need 4 stems.
3. **Equivariant Stabilization:** If a vocal sounds "jittery," increase `shifts` to `5` or higher.

## Parameter tuning guide
- **`model`**: Use `htdemucs_ft` for the "gold standard" vocal/instrumental split. Use `htdemucs_6s` only if you explicitly need guitar or piano (though piano quality is often experimental).
- **`shifts`**: This is your "Quality vs. Speed" knob. `1` is fast; `5` is a sweet spot for high-quality production; `10` is for archival/critical work but will be very slow.
- **`overlap`**: If you hear "pumping" or volume dips every few seconds, increase `overlap` to `0.5`. This ensures smoother cross-fading between processed chunks.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio URL` (Required): The mix to separate.
    - `Model Type`: Selection of v4 variants.
    - `Quality (Shifts)`: Integer slider (1-10).
- **Outputs:**
    - `Vocals` (Audio)
    - `Drums` (Audio)
    - `Bass` (Audio)
    - `Other` (Audio)
    - `Piano/Guitar` (Optional Audio)
- **Chain-friendly with:**
    - **[fal-ai/whisper](https://fal.ai/models/fal-ai/whisper):** Separate vocals with Demucs first, then send the isolated vocal stem to Whisper for much higher transcription accuracy.
    - **[fal-ai/foley](https://fal.ai/models/fal-ai/foley):** Remove original audio and generate new sound effects.

## Notes & gotchas
- **Max Duration:** FAL.ai typically supports files up to 10-20 minutes depending on the queue configuration, but very long files may time out.
- **6-Stem Limitations:** The `piano` stem in `htdemucs_6s` often suffers from "bleeding" (hearing other instruments in the piano track).
- **Memory:** Locally, Demucs requires 8GB+ VRAM for the Transformer models. FAL handles this for you on their serverless infra.

## Sources
- [FAL.ai Demucs API Docs](https://fal.ai/models/fal-ai/demucs/api)
- [Meta Demucs GitHub Repository](https://github.com/facebookresearch/demucs)
- [Hybrid Transformer Demucs Research Paper](https://arxiv.org/abs/2211.08553)
- [Torchaudio Demucs Tutorial](https://pytorch.org/audio/stable/tutorials/hybrid_demucs_tutorial.html)
