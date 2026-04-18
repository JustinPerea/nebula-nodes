---
name: bytedance/seedance-2.0/fast/image-to-video
display_name: Seedance 2.0 Fast Image to Video
category: image-to-video
creator: ByteDance
fal_docs: https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video
original_source: https://docs.byteplus.com/en/docs/ModelArk/2291680
summary: ByteDance's high-speed multimodal video model generating cinematic 720p video with synchronized audio and precise start/end frame control.
---

# Seedance 2.0 Fast Image to Video

## Overview
- **Slug:** `bytedance/seedance-2.0/fast/image-to-video`
- **Category:** Image-to-Video
- **Creator:** [ByteDance](https://www.bytedance.com/)
- **Best for:** Rapid production of cinematic video clips with native synchronized audio and precise camera control.
- **FAL docs:** [fal.ai/models/bytedance/seedance-2.0/fast/image-to-video](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video)
- **Original source:** [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/2291680)

## What it does
Seedance 2.0 Fast is an accelerated variant of ByteDance's flagship multimodal video model. It animates a starting image (and optionally transitions to a specific end image) into a cinematic video sequence up to 15 seconds long. Unlike many competitors, Seedance 2.0 uses a **Dual-Branch Diffusion Transformer (DB-DiT)** architecture that generates synchronized audio (SFX, ambient, and music) in parallel with the video frames, ensuring that sound effects land exactly when actions occur [Hugging Face](https://huggingface.co/papers/2604.14148), [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).

## When to use this model
- **Use when:** You need high-speed generation of short-form content (ads, social media) where audio is critical.
- **Use when:** You have a specific "Start" and "End" frame and need a smooth, coherent transition.
- **Use when:** You need professional camera movements (dolly zooms, rack focus) without complex prompting [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
- **Don't use when:** You need resolutions higher than 720p (on the FAL platform) or videos longer than 15 seconds.
- **Alternatives:**
    - `bytedance/seedance-2.0/image-to-video`: Higher quality "Standard" tier with better physics and lighting detail at the cost of higher latency.
    - `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`: Stronger for human anatomy and long-duration movements.
    - `fal-ai/veo3/image-to-video`: Google's alternative for high-fidelity photorealistic motion.

## API — via FAL.ai
**Endpoint:** `https://fal.run/bytedance/seedance-2.0/fast/image-to-video` (sync) / `https://queue.fal.run/bytedance/seedance-2.0/fast/image-to-video` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | (required) | N/A | Text description of the desired motion and action. |
| `image_url` | `string` | (required) | N/A | URL or Base64 of the starting frame. Max 30 MB. |
| `end_image_url` | `string` | `null` | N/A | URL of the image for the final frame. Enables A-to-B transitions. |
| `resolution` | `enum` | `720p` | `480p`, `720p` | Output video resolution. |
| `duration` | `enum` | `10` | `auto`, `4` to `15` | Length in seconds. `auto` lets the model decide based on prompt content. |
| `aspect_ratio` | `enum` | `auto` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | Video orientation. `auto` matches the input image. |
| `generate_audio` | `boolean` | `true` | `true`, `false` | Whether to include synchronized sound. |
| `seed` | `integer` | (random) | N/A | For reproducible generations. |
| `end_user_id` | `string` | `null` | N/A | Tracking ID for billing/analytics. |

### Output
The API returns a JSON object containing the generated video file and the seed used.
```json
{
  "video": {
    "url": "https://fal.media/files/...",
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
  "prompt": "Cinematic tracking shot. The warrior draws her glowing sword, sparks fly as it scrapes the stone, the sound of metal on stone and low thunder in the background.",
  "image_url": "https://example.com/start.jpg",
  "end_image_url": "https://example.com/end.jpg",
  "resolution": "720p",
  "duration": "10",
  "generate_audio": true
}
```

### Pricing
- **720p (Fast Tier):** **$0.2419 per second** of generated video [fal.ai](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video/api).
- **Audio:** Included at no extra cost [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
- **Example:** A 10-second 720p clip costs approximately **$2.42**.

## API — via Original Source (BYO-key direct)
The model is natively hosted on ByteDance's cloud platforms: **BytePlus** (International) and **Volcengine / ModelArk** (China).

- **Endpoint:** `POST https://open.byteplusapi.com/v1/videos/generations` (Note: Varies by region)
- **Extra Parameters:** Native API supports up to **1080p and 2K** resolutions not currently exposed on FAL's Fast tier [BytePlus](https://docs.byteplus.com/en/docs/ModelArk/2291680). It also supports **Model Search** for Text-to-Video.
- **Auth Method:** HMAC-SHA256 signature using Access Key (AK) and Secret Key (SK).
- **Link to official docs:** [BytePlus ModelArk Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680).

## Prompting best practices
- **Narrative Structure:** Describe "Subject + Action" first, then "Camera Movement", then "Audio Cues". The model responds better to full sentences than tag lists [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
- **Camera Lingo:** Use professional terms like "Dolly Zoom", "Rack Focus", "Low Angle Tracking", or "Handheld POV". The model understands these as literal instructions [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
- **Explicit Audio:** If you want a specific sound (e.g., "heavy boots crunching on gravel"), mention it. If omitted, the model will generate generic ambient sound based on the scene.
- **Multi-shot Directing:** You can prompt for multiple shots in one go: "Shot 1: ... Shot 2: ...". Use `duration: "auto"` to ensure the model has enough time to render the cuts [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).
- **Failure Mode:** Avoid "quality boosters" like "4k, high resolution". Instead, describe the lighting and texture ("golden hour backlighting, realistic skin pores").

## Parameter tuning guide
- **Duration (auto vs. fixed):** Use `auto` for complex multi-shot prompts. Use a fixed duration (e.g., `5`) for simple product loops to keep costs predictable.
- **Resolution (480p vs. 720p):** Use `480p` for rapid "sketching" and prompt iteration (costs ~$0.09/s on standard, even less on fast). Switch to `720p` for final delivery.
- **End Image URL:** This is the most powerful "hidden" feature. Use it to force the model to end at a specific composition, perfect for loopable videos or "before and after" demos [fal.ai](https://fal.ai/learn/tools/how-to-use-seedance-2-0).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Text Prompt` (Required)
    - `Input Image` (Required)
    - `End Image` (Optional)
    - `Resolution` (Selection: 480p, 720p)
    - `Duration` (Slider: 4-15s)
- **Outputs:**
    - `Video URL`
    - `Audio Stream` (Embedded in video)
    - `Used Seed`
- **Chain-friendly with:**
    - `fal-ai/flux/schnell`: Generate the high-quality starting image.
    - `fal-ai/vocal-remover`: If you need to strip the auto-generated audio to add your own voiceover.
    - `fal-ai/super-resolution`: Upscale the 720p output to 4K for production.

## Notes & gotchas
- **Resolution Limit:** On FAL, the Fast tier is capped at 720p. For 1080p+, users must use the Standard tier or the native BytePlus API.
- **Safety:** Content follows ByteDance's safety policy; explicit violence or NSFW content will trigger a filter.
- **Rate Limits:** As a "Fast" tier model, it typically has higher concurrency limits than the Standard tier.
- **Source-image compatibility (verified live 2026-04-17):** Not every publicly-hosted JPG works as `image_url`. Specifically, `https://storage.googleapis.com/falserverless/example_inputs/ltxv-2-i2v-input.jpg` (the LTX-2 I2V example) returned HTTP 422 at the response-URL stage even after status reached `COMPLETED`. Swapping to a FAL-hosted WebP (`https://v3.fal.media/files/...`) succeeded. Symptom: status → `COMPLETED` in ~6s (vs. real gens take 60–120s), then a 422 on the response fetch. If you see that pattern, suspect the source image — try a different format/aspect or re-host the image through FAL's `/v1/uploads`.

## Sources
- [FAL.ai Seedance 2.0 API Reference](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video/api)
- [FAL.ai "How to Use Seedance 2.0 Like a Pro" Tutorial](https://fal.ai/learn/tools/how-to-use-seedance-2-0)
- [BytePlus ModelArk Official Documentation](https://docs.byteplus.com/en/docs/ModelArk/2291680)
- [Hugging Face: Seedance 2.0 Technical Overview](https://huggingface.co/papers/2604.14148)
- [Forbes: Seedance 2.0 Release Coverage](https://www.forbes.com/sites/ronschmelzer/2026/02/12/bytedances-seedance-20-nails-real-world-physics-and-hyper-real-outputs/)
