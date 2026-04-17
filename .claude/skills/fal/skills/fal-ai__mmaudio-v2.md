---
name: fal-ai/mmaudio-v2
display_name: MMAudio V2
category: text-to-audio
creator: Sony AI & University of Illinois Urbana-Champaign (UIUC)
fal_docs: https://fal.ai/models/fal-ai/mmaudio-v2
original_source: https://github.com/hkchengrex/MMAudio
summary: A state-of-the-art multimodal audio generation model that synthesizes high-quality, synchronized soundtracks and sound effects for video or text inputs.
---

# MMAudio V2

## Overview
- **Slug:** `fal-ai/mmaudio-v2`
- **Category:** Audio Generation / Video-to-Audio (V2A)
- **Creator:** [Sony AI](https://sony.ai/) & [University of Illinois Urbana-Champaign (UIUC)](https://illinois.edu/)
- **Best for:** Adding synchronized, context-aware sound effects and atmospheric audio to silent AI-generated videos.
- **FAL docs:** [https://fal.ai/models/fal-ai/mmaudio-v2](https://fal.ai/models/fal-ai/mmaudio-v2)
- **Original source:** [https://github.com/hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio)

## What it does
MMAudio V2 is a professional-grade multimodal model designed to generate high-quality audio that is perfectly synchronized with visual content. Unlike traditional audio generators, it uses a joint multimodal training approach to "understand" the motion and timing within a video, allowing it to place sound effects (like footsteps, impacts, or environmental sounds) at precisely the right moments. It can generate audio from a video input, a text prompt, or both simultaneously.

## When to use this model
- **Use when:** You have a silent video (e.g., from Kling, Luma, or Runway) and need realistic, synchronized sound effects (SFX) or ambient noise.
- **Use when:** You need precise temporal alignment between visual events (like a ball hitting a floor) and the resulting sound.
- **Don't use when:** You need high-fidelity musical compositions or intelligible, long-form human speech (the model currently struggles with complex linguistics).
- **Alternatives:** 
    - **[ElevenLabs Audio Native](https://elevenlabs.io/):** Better for clean narration but lacks native video-sync capabilities.
    - **[Stable Audio](https://fal.ai/models/fal-ai/stable-audio):** Superior for general music generation but harder to sync precisely with video motion.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/mmaudio-v2` (Sync) / `https://queue.fal.run/fal-ai/mmaudio-v2` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | string | *Required* | URL | The URL of the video to generate audio for. Can be MP4, MOV, WebM, M4V, or GIF. |
| `prompt` | string | *Required* | text | A descriptive prompt for the desired audio (e.g., "heavy rain on a tin roof with distant thunder"). |
| `negative_prompt`| string | "" | text | Characteristics you want to exclude from the audio (e.g., "music, talking, static"). |
| `duration` | float | 8.0 | 1 - 30 | The length of the generated audio in seconds. |
| `num_steps` | integer | 25 | 10 - 100 | Number of diffusion steps. Higher values improve quality but increase latency. |
| `cfg_strength` | float | 4.5 | 1.0 - 20.0 | Classifier Free Guidance strength. Controls how closely the model follows the prompt. |
| `seed` | integer | random | 0 - 2^32 | Random seed for reproducible results. |
| `mask_away_clip` | boolean | false | true/false | If true, the model ignores any existing audio in the input video and generates a completely new track. |

### Output
The model returns a JSON object containing a `video` field. This is a reference to a video file that includes the original visual content muxed with the newly generated audio track.

```json
{
  "video": {
    "url": "https://fal.run/storage/outputs/...",
    "content_type": "video/mp4",
    "file_name": "mmaudio_output.mp4",
    "file_size": 1024000
  }
}
```

### Example request
```json
{
  "video_url": "https://example.com/silent_car_drift.mp4",
  "prompt": "Screeching tires on asphalt, engine revving, smoke hissing",
  "duration": 5.0,
  "cfg_strength": 5.0
}
```

### Pricing
- **Cost:** $0.001 per second of audio generated.
- This is significantly cheaper than full video generation, as you only pay for the audio synthesis layer.

## API — via Original Source (BYO-key direct)
FAL.ai is currently the primary commercial API surface for MMAudio V2. While the model is open-source (MIT code, CC-BY-NC weights), there is no official "Direct API" provided by the researchers at Sony/UIUC for public production use. Developers can self-host using the [GitHub repository](https://github.com/hkchengrex/MMAudio).

## Prompting best practices
- **Be Material-Specific:** Instead of "walking," use "heavy boots crunching on dry gravel." The model responds well to descriptions of textures and materials.
- **Describe Intensity:** Use adjectives like "forceful," "subtle," "distant," or "rhythmic" to guide the volume and cadence.
- **Avoid Speech Prompts:** Do not prompt for specific dialogue; instead, prompt for "muffled crowd chatter" or "indistinct whispers" if ambient voices are needed.
- **Style Tokens:** For cinematic results, use tokens like "high fidelity," " Foley," and "clean sound design."
- **Example Good Prompt:** `Cinematic low-end thud, metallic resonance, echoing in a large hall.`
- **Example Bad Prompt:** `A man says 'hello world' while standing in a room.` (Speech will likely be unintelligible).

## Parameter tuning guide
- **`cfg_strength` (4.5 - 7.0):** The sweet spot. 4.5 provides a natural balance; move toward 7.0 if the model is ignoring specific sound elements in your prompt.
- **`num_steps` (25):** 25 steps is the recommended balance for speed and quality. Increasing to 50 can help with complex textures like rushing water or fire, but rarely improves simple impacts.
- **`mask_away_clip`:** Set this to `true` if your source video has "dirty" audio (background noise from recording) that you want to completely replace.

## Node inputs/outputs
- **Inputs:**
    - `Video URL`: Silent or source video.
    - `Audio Prompt`: Description of sounds.
    - `Duration`: Desired output length.
- **Outputs:**
    - `Video URL`: The final video with the new audio track integrated.
- **Chain-friendly with:**
    - **[Kling Video](https://fal.ai/models/fal-ai/kling-video):** Generate the high-quality video first, then pass the URL to MMAudio.
    - **[Flux.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** Create a still image, animate it with a video model, and finish with MMAudio for a complete AV pipeline.

## Notes & gotchas
- **Temporal Alignment:** The model focuses on the center of the frame for synchronization (Synchformer logic). Ensure the main action is relatively centered for the best sync.
- **Resolution:** The CLIP encoder resizes video frames to 384x384 internally; high-resolution input is supported but won't necessarily improve audio accuracy.
- **Speech Limitation:** As noted in the technical report, human-like speech sounds are often generated as "unintelligible phonemes." It is a sound effects model, not a TTS model.

## Sources
- [FAL.ai MMAudio V2 Documentation](https://fal.ai/models/fal-ai/mmaudio-v2/api)
- [Official GitHub Repository (hkchengrex/MMAudio)](https://github.com/hkchengrex/MMAudio)
- [Research Paper: Taming Multimodal Joint Training... (CVPR 2025)](https://arxiv.org/abs/2412.15322)
