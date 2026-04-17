---
name: bytedance/seedance-2.0/fast/text-to-video
display_name: Seedance 2.0 Fast Text to Video
category: text-to-video
creator: ByteDance (Seed Team)
fal_docs: https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video
original_source: https://seed.bytedance.com/en/seedance2_0
summary: ByteDance's high-speed, cinematic text-to-video model featuring native audio-visual joint generation and professional camera control.
---

# Seedance 2.0 Fast Text to Video

## Overview
- **Slug:** `bytedance/seedance-2.0/fast/text-to-video`
- **Category:** Text-to-Video
- **Creator:** [ByteDance (Seed Team)](https://seed.bytedance.com/en/seed2)
- **Best for:** High-speed, high-fidelity cinematic video generation with synchronized audio.
- **FAL docs:** [fal.ai/models/bytedance/seedance-2.0/fast/text-to-video](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video)
- **Original source:** [Seedance 2.0 Official Page](https://seed.bytedance.com/en/seedance2_0)

## What it does
Seedance 2.0 is a state-of-the-art native multi-modal audio-video generation model developed by [ByteDance](https://seed.bytedance.com/en/seedance2_0). Unlike traditional models that generate video and then overlay sound, Seedance 2.0 uses a unified **dual-branch diffusion transformer architecture** to generate visuals and audio simultaneously. This ensures perfect synchronization between action and sound effects ([arXiv:2604.14148](https://arxiv.org/abs/2604.14148)). The "Fast" tier is optimized for low-latency scenarios, offering a 30% speed improvement over standard models while maintaining cinematic quality and director-level camera control ([PixVerse Blog](https://pixverse.ai/en/blog/what-is-seedance-2-0-ai-video-model)).

## When to use this model
- **Use when:** You need rapid cinematic video generation (4-15s), native high-fidelity audio (SFX/ambience/music), or complex camera movements like dolly zooms and rack focuses ([fal.ai Seedance 2.0 Landing Page](https://fal.ai/seedance-2.0)).
- **Don't use when:** You require extremely long-form content (beyond 15 seconds in a single pass) or ultra-high resolutions above 720p (for the fast tier).
- **Alternatives:** 
  - **[Seedance 2.0 (Standard)](https://fal.ai/models/bytedance/seedance-2.0/text-to-video):** Higher quality and resolution at the cost of speed.
  - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Stronger physics modeling for specific action sequences.
  - **[Veo 3.1](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video):** Excellent for frame-to-video consistency.

## API — via FAL.ai
**Endpoint:** `https://fal.run/bytedance/seedance-2.0/fast/text-to-video` (sync) / `https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | N/A | The text prompt used to generate the video. |
| `resolution` | string | `720p` | `480p`, `720p` | Output video resolution. 480p is faster. |
| `duration` | string | `10` | `auto`, `4` to `15` | Duration in seconds. `auto` lets the model decide based on prompt content. |
| `aspect_ratio` | string | `16:9` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | The aspect ratio of the generated video. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate synchronized audio for the video. |
| `seed` | integer | (Random) | N/A | Seed for reproducibility. |
| `end_user_id` | string | N/A | N/A | Unique ID for the end user for tracking purposes. |

### Output
The output is a JSON object containing the generated video file details and the seed used.
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 1234567
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A cinematic tracking shot following a neon-lit cybernetic panther sprinting through a rainy futuristic street, splashing through puddles, synth-wave audio with heavy bass and splashing sounds.",
  "resolution": "720p",
  "duration": "10",
  "aspect_ratio": "16:9",
  "generate_audio": true
}
```

### Pricing
- **$0.2419 per second** for 720p video generation ([fal.ai Playground](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video/playground)).
- Approximate cost per request: ~$2.42 for a 10-second 720p video.

## API — via Original Source (BYO-key direct)
The model is available natively through **BytePlus ModelArk** (ByteDance's enterprise cloud platform).

- **Endpoint:** `https://ark.ap-southeast.bytepluses.com/api/v3`
- **Model ID:** `dreamina-seedance-2-0-fast-260128`
- **Auth Method:** `ARK_API_KEY` (Header-based authentication).
- **Extra Parameters:** Native BytePlus API supports more granular multimodal inputs (up to 9 images and 3 videos as reference clusters) and specific "Binding Logic" using the `@` symbol in prompts ([BytePlus Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
- **Official Docs:** [BytePlus ModelArk - Seedance 2.0 Tutorial](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## Prompting best practices
- **Reference Binding:** Use specific tokens or numbers to refer to reference assets if using multimodal nodes (e.g., "Keep the character from [Image 1] but perform the action from [Video 1]").
- **Audio-Visual Cues:** Describe sounds explicitly to guide the native audio generation (e.g., "a crisp apple tapping sound," "ice clinking in a shaker").
- **Camera Language:** Use professional cinematography terms: "Dolly zoom," "First-person POV," "Long-take," "Rack focus."
- **Style Tokens:** Specify lighting and textures: "Cyberpunk neon," "Film grain," "Muted warm color grading," "Luxury leather texture."
- **Avoid Over-complication:** While the model is powerful, too many conflicting action verbs in a short 10s window can lead to "jittery" results.
- **Good Prompt:** "A hyper-realistic medium shot of a woman in her 30s sitting on a charcoal sofa, drinking matcha, smiling softly. Handheld camera feel. Cinematic lighting."
- **Bad Prompt:** "Video of a woman. She is happy. There is a sofa." (Too vague for cinematic output).

## Parameter tuning guide
- **Resolution (720p vs 480p):** Use 720p for final production assets; 480p is significantly cheaper and faster for "pre-viz" or rapid prototyping of camera movements.
- **Duration:** Setting `auto` is excellent for storytelling prompts where the model can determine the natural cadence of the action. For fixed-loop UI elements, manually set `4` or `5`.
- **Generate Audio:** Always keep this `true` for social media content to leverage the unique native sync, unless you plan to add a specific score in post-production.
- **Aspect Ratio:** Use `9:16` for TikTok/Instagram Reels and `21:9` for an ultra-wide cinematic movie look.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Text Prompt` (String)
  - `Resolution` (Dropdown)
  - `Duration` (Slider/Dropdown)
  - `Aspect Ratio` (Dropdown)
  - `Generate Audio` (Boolean)
- **Outputs:**
  - `Video URL` (URL)
  - `Audio-Video File` (File Object)
  - `Seed` (Integer)
- **Chain-friendly with:** 
  - **[Seedream V4](https://fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image):** Use to generate consistent character "reference images" first.
  - **[Remove Background Video](https://fal.ai/models/fal-ai/remove-background-video):** For compositing generated assets.
  - **[Llama 3 Vision](https://fal.ai/models/fal-ai/llama-3-vision):** To auto-generate descriptive prompts from reference images.

## Notes & gotchas
- **Ephemeral Storage:** Generated video URLs on FAL are typically temporary. Ensure your workflow saves the file to a permanent bucket ([fal.ai Documentation](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video/api)).
- **Safety Filters:** Like most ByteDance models, it has strict content policies against NSFW and highly violent content.
- **Token-based Pricing:** Note that pricing can technically fluctuate based on a token calculation (width * height * duration), though the per-second rate is the primary benchmark for users ([fal.ai Playground](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video/playground)).

## Sources
- [FAL.ai API Documentation](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video/api)
- [BytePlus ModelArk Official Guide](https://docs.byteplus.com/en/docs/ModelArk/2291680)
- [Seedance 2.0 Research Paper (arXiv:2604.14148)](https://arxiv.org/abs/2604.14148)
- [PixVerse Technical Analysis](https://pixverse.ai/en/blog/what-is-seedance-2-0-ai-video-model)
- [Atlas Cloud Seedance 2.0 Architecture Review](https://www.atlascloud.ai/blog/case-studies/generative-ai-model-seedance-2-0-a-guide-to-all-round-reference)