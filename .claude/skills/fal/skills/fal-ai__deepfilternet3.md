---
name: fal-ai/deepfilternet3
display_name: DeepFilterNet 3
category: audio-to-audio
creator: Hendrik Schröter (Rikorose) / FAU Erlangen-Nürnberg
fal_docs: https://fal.ai/models/fal-ai/deepfilternet3/api
original_source: https://github.com/Rikorose/DeepFilterNet
summary: A high-efficiency, low-latency speech enhancement model that removes background noise and upsamples audio to 48kHz.
---

# DeepFilterNet 3

## Overview
- **Slug:** fal-ai/deepfilternet3
- **Category:** Audio-to-Audio (Speech Enhancement)
- **Creator:** [Hendrik Schröter / Rikorose (FAU Erlangen-Nürnberg)](https://github.com/Rikorose/DeepFilterNet)
- **Best for:** Real-time background noise removal and speech clarity enhancement.
- **FAL docs:** [fal-ai/deepfilternet3](https://fal.ai/models/fal-ai/deepfilternet3/api)
- **Original source:** [GitHub Repository](https://github.com/Rikorose/DeepFilterNet) | [Research Paper](https://arxiv.org/abs/2305.08227)

## What it does
DeepFilterNet 3 is a state-of-the-art speech enhancement framework that specializes in removing background noise and improving audio quality for full-band (48kHz) speech. It operates in two stages: first, it enhances the spectral envelope to handle coarse frequency components, and then it applies "deep filtering" to restore periodic speech structures. While it is extremely effective at noise suppression, its dereverberation (removing room echo) capabilities are limited compared to specialized dereverberation models.

## When to use this model
- **Use when:** You need to clean up noisy voice recordings, podcasts, or meeting audio where background hum, street noise, or static is present.
- **Don't use when:** You specifically need to remove heavy room reverb or echo, or when processing non-speech audio (like music) where the filter might accidentally suppress desired melodic components.
- **Alternatives:** 
    - **fal-ai/denoiser:** A similar speech enhancement model based on Facebook's research, often preferred for different noise profiles.
    - **fal-ai/whisper:** Use this if your end goal is transcription rather than audio cleanup.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/deepfilternet3` (sync) / `https://queue.fal.run/fal-ai/deepfilternet3` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | (Required) | URL | The URL of the audio file to enhance. Supports mp3, ogg, wav, m4a, aac. |
| `sync_mode` | boolean | `false` | `true`, `false` | If `true`, the result is returned as a Data URI and not stored in request history. |
| `audio_format` | enum | `mp3` | `mp3`, `aac`, `m4a`, `ogg`, `opus`, `flac`, `wav` | The desired format for the output audio file. |
| `bitrate` | string | `"192k"` | e.g., `"128k"`, `"192k"`, `"320k"` | The bitrate of the output audio. |

### Output
The output returns an `audio_file` object and a `timings` object.
- **audio_file**:
    - `url`: Downloadable link to the enhanced audio.
    - `content_type`: Mime type (e.g., `audio/mpeg`).
    - `file_name`: Auto-generated name of the file.
    - `file_size`: Size in bytes.
    - `duration`: Length of audio in seconds.
    - `channels`: Number of audio channels (typically 1 for speech).
    - `sample_rate`: Usually 48000 Hz.
- **timings**: Breakdowns for `preprocess`, `inference`, and `postprocess` steps.

### Example request
```json
{
  "audio_url": "https://example.com/noisy_audio.mp3",
  "audio_format": "wav",
  "bitrate": "192k"
}
```

### Pricing
$0.001 per second of processed audio ([FAL.ai Pricing](https://fal.ai/models/fal-ai/deepfilternet3)).

## API — via Original Source (BYO-key direct)
FAL.ai is the primary API surface for cloud-hosted DeepFilterNet 3. The original creator provides the model as an open-source framework. For "BYO-key" style direct use, you can deploy the model yourself using:
- **Rust Library/Binary:** `deep-filter` CLI tool for local processing.
- **Python Package:** `pip install deepfilternet`.
- **LADSPA Plugin:** For real-time integration into Linux audio pipelines (PipeWire/EasyEffects).
- **GitHub:** [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)

## Prompting best practices
*Note: This is an audio-to-audio model, not a text-to-speech model. Prompting does not apply. Instead, focus on input quality:*
1. **Sample Rate:** For best results, provide 48kHz audio. The model is optimized for this rate and will upsample lower rates, which may introduce artifacts.
2. **Mono vs Stereo:** The model primarily enhances speech (mono). If you provide stereo audio, it may be mixed down or processed per channel.
3. **Speech-to-Noise Ratio:** While it handles heavy noise well, extremely low SNR (where speech is unintelligible to humans) may lead to "watery" or "robotic" artifacts.

## Parameter tuning guide
- **Audio Format:** Use `wav` or `flac` if you intend to perform further processing on the audio (like transcription) to avoid double compression. Use `mp3` for smaller file sizes in user-facing apps.
- **Bitrate:** `192k` is the sweet spot for speech. Increasing to `320k` rarely improves perceived quality for speech enhancement but increases file size.
- **Sync Mode:** Enable this if you are building a real-time tool where you don't want the overhead of FAL storing the result in their database.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio Input` (URL or File)
    - `Format Selector` (Dropdown)
    - `Bitrate` (String/Text)
- **Outputs:**
    - `Enhanced Audio` (File/URL)
    - `Duration` (Number)
    - `Processing Time` (Number)
- **Chain-friendly with:**
    - `fal-ai/whisper`: Feed the cleaned audio into Whisper for near-perfect transcription.
    - `fal-ai/ffmpeg-utils`: Use FFmpeg to remux the cleaned audio back into a video file.

## Notes & gotchas
- **Dereverberation:** It is not a dereverberation model. If your audio has heavy "echo" from a large room, this model will remove the background hiss but the echo will remain.
- **Max Duration:** FAL generally limits request sizes. For very long files (e.g., >2 hours), consider chunking the audio.
- **Latency:** The model itself has a very low algorithmic latency (~40ms), making it ideal for real-time applications if deployed locally.

## Sources
- [FAL.ai DeepFilterNet 3 API Docs](https://fal.ai/models/fal-ai/deepfilternet3/api)
- [Original DeepFilterNet GitHub](https://github.com/Rikorose/DeepFilterNet)
- [ArXiv: Perceptually Motivated Real-Time Speech Enhancement](https://arxiv.org/abs/2305.08227)
