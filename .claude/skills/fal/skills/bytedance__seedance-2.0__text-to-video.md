---
name: bytedance/seedance-2.0/text-to-video
display_name: Seedance 2.0 (Text-to-Video)
category: text-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/bytedance/seedance-2.0/text-to-video
original_source: https://seed.bytedance.com/en/seedance2_0
summary: ByteDance's flagship multimodal model for cinematic, physics-accurate video with native synchronized audio.
---

# Seedance 2.0 (Text-to-Video)

## Overview
- **Slug:** `bytedance/seedance-2.0/text-to-video`
- **Category:** text-to-video
- **Creator:** [ByteDance (Seed Research)](https://seed.bytedance.com/en/seedance2_0)
- **Best for:** High-fidelity cinematic videos with perfectly synchronized native audio and complex physics.
- **FAL docs:** [FAL.ai/seedance-2.0](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)
- **Original source:** [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## What it does
Seedance 2.0 is a state-of-the-art multimodal generative model designed for synchronized video and audio creation in a single pass ([Atlas Cloud](https://www.atlascloud.ai/models/bytedance/seedance-2.0/text-to-video)). Unlike previous generations that layered audio as a post-processing step, Seedance 2.0 uses a **Dual-Branch Diffusion Transformer (DB-DiT)** architecture to generate visual and auditory signals simultaneously ([Leecho Global AI](https://leechoglobalai.com/seedance-2-0-technical-architecture-data-ethics-industry-impact-analysis/)). This results in industry-leading phoneme-level lip synchronization and physics-accurate motion, such as object collisions and realistic fluid dynamics ([FAL.ai](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)).

The model excels at "director-level" control, allowing users to specify camera language, emotional tone, and multi-subject interactions through natural language ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)). It supports a wide range of aspect ratios and durations up to 15 seconds, maintaining high temporal consistency and character stability throughout the clip ([Invideo](https://invideo.io/blog/seedance-2-0-overview/)).

## When to use this model
- **Use when:** You need synchronized speech (lip-syncing), realistic physics (sports, fighting, collisions), or high-end cinematic quality for commercial production ([Atlas Cloud](https://www.atlascloud.ai/models/bytedance/seedance-2.0/text-to-video)).
- **Don't use when:** You need very long-form content (over 15s) in a single shot without using the extension endpoint, or when cost is the only factor (the "Fast" variant or alternative models like Wan 2.5 might be more economical) ([Atlas Cloud Blog](https://www.atlascloud.ai/blog/case-studies/seedance-2.0-pricing-full-cost-breakdown-2026)).
- **Alternatives:**
    - **[Wan 2.5](https://fal.ai/pricing):** More affordable for lower-stakes creative prototyping but lacks the native audio sync of Seedance.
    - **[Kling 3.0](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video):** Offers native 4K output but generally has a higher latency for synchronized audio-visual tasks ([Atlas Cloud Blog](https://www.atlascloud.ai/blog/case-studies/seedance-2.0-pricing-full-cost-breakdown-2026)).
    - **[Veo 3.1](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video):** Strong cinematic style but different motion characteristics compared to Seedance’s world-model physics ([Atlas Cloud Blog](https://www.atlascloud.ai/blog/case-studies/seedance-2.0-pricing-full-cost-breakdown-2026)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/bytedance/seedance-2.0/text-to-video` (sync) / `https://queue.fal.run/bytedance/seedance-2.0/text-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | — | **Required** | Scene description. Wrap spoken dialogue in "quotes" for lip-sync ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `resolution` | string | `720p` | `480p`, `720p` | Output resolution ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `duration` | string | `auto` | `auto`, `4`-`15` | Video length in seconds ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `aspect_ratio` | string | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | Framing of the video ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate native synced audio ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `seed` | integer | — | — | For reproducible generation ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |
| `end_user_id` | string | — | — | Unique ID for B2B billing/tracking ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)). |

### Output
The API returns a JSON object containing the generated video file details and the seed used ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)).
```json
{
  "video": {
    "url": "https://v3b.fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567
  },
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A close-up of a futuristic chef saying \"The secret is in the spice\" while a purple flame erupts from a pan. High-speed photography, cinematic lighting.",
  "duration": "5",
  "resolution": "720p",
  "aspect_ratio": "16:9"
}
```

### Pricing
- **Standard (720p with audio):** $0.3034 per second of generated output ([FAL.ai](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)).
- **Fast Variant:** $0.2419 per second ([FAL.ai](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)).

## API — via Original Source (BYO-key direct)
ByteDance provides the Seedance 2.0 API through its **BytePlus** (international) and **Volcengine** (China) platforms ([NxCode](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026)).

- **Endpoint:** `https://ark.ap-southeast.bytepluses.com/api/v3` ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680))
- **Auth Method:** Bearer Token via `ARK_API_KEY` header.
- **Additional Parameters:**
    - `watermark` (boolean): BytePlus allows disabling the watermark ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
    - `ratio`: "adaptive" is used natively for auto-scaling ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
    - **Multimodal Reference:** Native BytePlus API supports up to 12 inputs (9 images, 3 videos, 3 audio) in a single JSON `content` array with specific roles (`reference_image`, `reference_video`, etc.) ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
- **Docs:** [BytePlus ModelArk Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## Prompting best practices
- **Dialogue:** Use double quotes for lip-sync. Example: `The robot turned and said: "I have seen the end of time."` ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)).
- **Camera Movement:** Explicitly name camera actions. Keywords like `Hitchcock zoom`, `continuous tracking shot`, `low-angle pan`, and `dolly-in` work exceptionally well due to the model's training on cinematic data ([PixVerse](https://pixverse.ai/en/blog/what-is-seedance-2-0-ai-video-model)).
- **Physics Cues:** Describe interactions to trigger the world model. Example: `The glass bottle shatters against the stone wall, fragments flying in realistic arcs.` ([Leecho Global AI](https://leechoglobalai.com/seedance-2-0-technical-architecture-data-ethics-industry-impact-analysis/)).
- **Pacing:** Use temporal keywords like `fast cuts`, `slow motion`, or `rhythmic beats` to guide the DB-DiT audio-visual alignment ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
- **Avoid Over-Prompting:** Don't list 50 technical camera specs; the model follows simple, narrative descriptions better than "comma-soup" style prompts.

## Parameter tuning guide
- **`duration` (auto):** Setting this to `auto` is highly recommended for narrative prompts. The model will analyze the prompt complexity and stop generation at the most "natural" narrative conclusion between 4-15s ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)).
- **`resolution` (480p vs 720p):** Use 480p for rapid prototyping to save ~20% on costs and reduce latency. Switch to 720p for final renders ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)).
- **`generate_audio` (true):** Always keep this `true` unless you specifically need a silent clip. There is no cost penalty for audio generation on FAL, and the native sync is difficult to replicate with post-production AI audio tools ([FAL.ai Docs](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)).

## Node inputs/outputs
- **Inputs:**
    - `prompt` (Text)
    - `resolution` (Dropdown)
    - `duration` (Number/Slider)
    - `aspect_ratio` (Dropdown)
    - `seed` (Number)
- **Outputs:**
    - `video_url` (Link)
    - `generation_seed` (Number)
- **Chain-friendly with:**
    - **[Flux 2](https://fal.ai/models/fal-ai/flux-2-flex):** Generate a high-quality character image first, then use it as a reference in Seedance 2.0 Image-to-Video.
    - **[Whisper](https://fal.ai/docs/model-api-reference/audio-api/whisper):** Transcribe a user's voice clip to use as the dialogue prompt in Seedance for "deepfake" style lip-syncing.

## Notes & gotchas
- **B2B Restrictions:** FAL.ai restricts this model to business customers outside the United States ([FAL.ai](https://fal.ai/models/fal-ai/seedance-2.0/text-to-video)).
- **Max Duration:** 15 seconds is a hard limit for a single generation. Use the `extension` or `edit` endpoints (available at source) for longer sequences ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).
- **Watermarks:** Requests through FAL may contain a small watermark; BytePlus API allows watermark removal ([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680)).

## Sources
- [FAL.ai Model Page](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)
- [FAL.ai API Reference](https://fal.ai/docs/model-api-reference/video-generation-api/bytedance-seedance-2-0-text-to-video)
- [BytePlus ModelArk Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)
- [ByteDance Seed Research](https://seed.bytedance.com/en/seedance2_0)
- [Atlas Cloud Technical Assessment](https://www.atlascloud.ai/models/bytedance/seedance-2.0/text-to-video)
- [Leecho Global AI Lab Report](https://leechoglobalai.com/seedance-2-0-technical-architecture-data-ethics-industry-impact-analysis/)
