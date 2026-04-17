---
name: fal-ai/veo3/fast
display_name: Veo 3 Fast (Google)
category: text-to-video
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/veo3/fast
original_source: https://ai.google.dev/gemini-api/docs/video, https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-0-generate
summary: A high-speed, cost-effective version of Google's flagship Veo 3 video generation model with synchronized audio.
---

# Veo 3 Fast (Google)

## Overview
- **Slug:** `fal-ai/veo3/fast`
- **Category:** Text-to-Video
- **Creator:** [Google DeepMind](https://deepmind.google/)
- **Best for:** High-speed generation of short, cinematic video clips (up to 8s) with natively synchronized audio.
- **FAL docs:** [fal.ai/models/fal-ai/veo3/fast](https://fal.ai/models/fal-ai/veo3/fast)
- **Original source:** [Google AI for Developers](https://ai.google.dev/gemini-api/docs/video)

## What it does
Veo 3 Fast is a optimized version of Google's state-of-the-art video generation model. It produces high-fidelity video clips from text prompts, featuring realistic physics, complex character motion, and professional-grade cinematography. A standout feature is its **joint-latent diffusion architecture**, which generates synchronized audio (ambient noise, music, or dialogue) alongside the visuals in a single pass, ensuring perfect timing and atmosphere.

## When to use this model
- **Use when:** You need fast iteration on video concepts, social media content, or cinematic B-roll with high realism. It is particularly effective for scenes requiring accurate movement and spatial consistency.
- **Don't use when:** You need videos longer than 8 seconds in a single generation, or if you require resolutions higher than 1080p (for 4K, see original source or upcoming 3.1 variants).
- **Alternatives:**
    - `fal-ai/kling-video/v1.5/pro`: Better for longer durations (up to 10s+) and complex humanoid actions.
    - `fal-ai/luma-dream-machine`: Excellent for dramatic camera movements and lighting.
    - `fal-ai/veo3.1/first-last-frame-to-video`: Better for controlled transitions between two specific images.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/veo3/fast` (sync) / `https://queue.fal.run/fal-ai/veo3/fast` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | - | Detailed description of the video to generate. |
| `negative_prompt` | string | - | - | Elements to exclude from the generation. |
| `aspect_ratio` | string | `16:9` | `16:9`, `9:16` | The frame orientation (Landscape vs. Portrait). |
| `duration` | string | `4s` | `4s`, `6s`, `8s` | The length of the generated video. |
| `resolution` | string | `720p` | `720p`, `1080p` | Output video resolution. |
| `generate_audio` | boolean | `true` | `true`, `false` | Whether to generate a synchronized audio track. |
| `seed` | integer | - | - | Random seed for reproducible generations. |
| `auto_fix` | boolean | `true` | `true`, `false` | Automatically modifies prompts to pass safety/quality filters. |
| `safety_tolerance` | integer | `4` | `1` (Strict) to `6` (Loose) | Level of content moderation applied. |

### Output
The API returns a JSON object containing the generated video file details.
```json
{
  "video": {
    "url": "https://fal.run/storage/v1/display/...",
    "content_type": "video/mp4",
    "file_name": "generated_video.mp4",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "prompt": "A cinematic close-up of a futuristic robot chef meticulously preparing sushi in a neon-lit Tokyo kitchen. Steam rises from the rice, and the robot's metallic fingers move with fluid precision.",
  "aspect_ratio": "16:9",
  "duration": "8s",
  "resolution": "1080p",
  "generate_audio": true,
  "safety_tolerance": 5
}
```

### Pricing
FAL.ai charges based on the duration of the video and audio status:
- **Audio ON:** $0.15 per second ($1.20 for an 8s clip).
- **Audio OFF:** $0.10 per second ($0.80 for an 8s clip).

## API — via Original Source (BYO-key direct)
The model is natively available through **Google Cloud Vertex AI** and the **Gemini API**.
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning`
- **Native-only features:** 
    - **4K Resolution:** Native Google APIs support up to 4K preview.
    - **Reference Images:** Support for up to 3 reference images to guide style or character consistency.
    - **Video Extension:** Capability to extend existing videos by 7 seconds.
- **Auth:** OAuth2 (Vertex AI) or API Key (Google AI Studio).
- **Docs:** [Google AI Video Docs](https://ai.google.dev/gemini-api/docs/video)

## Prompting best practices
- **The "Big Five" Structure:** For best results, include:
    1. **Subject:** What is the main focus? (e.g., "A calico kitten")
    2. **Action:** What is happening? (e.g., "pouncing on a red yarn ball")
    3. **Setting/Context:** Where is it? (e.g., "in a sunlit living room with hardwood floors")
    4. **Cinematography:** Camera angle/movement? (e.g., "low-angle tracking shot, shallow depth of field")
    5. **Style/Lighting:** (e.g., "cinematic lighting, 35mm film grain, warm afternoon glow")
- **Audio Guidance:** The model uses the text prompt to derive audio. Keywords like "heavy rain," "city chatter," or "soft jazz playing in background" will influence the generated soundscape.
- **Avoid Over-prompting:** While descriptive, avoid contradictory terms or excessive jargon that might confuse the spatial reasoning of the model.

## Parameter tuning guide
- **Safety Tolerance:** If your prompt is being blocked but is benign, increase to `5` or `6`. Use `1` for enterprise-safe environments.
- **Duration vs. Complexity:** For complex, multi-stage actions, `8s` is recommended to give the model enough temporal "room" to resolve the movement naturally.
- **Auto-Fix:** Keep this `true` unless you have highly specific, technical prompts where you don't want the LLM "pre-processor" to alter your keywords.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (Text)
    - `Aspect Ratio` (Dropdown: 16:9, 9:16)
    - `Duration` (Dropdown: 4s, 6s, 8s)
    - `Resolution` (Dropdown: 720p, 1080p)
    - `Generate Audio` (Boolean)
    - `Seed` (Number)
- **Outputs:**
    - `Video URL` (URL)
    - `Audio Stream` (Note: In most workflow apps, this is embedded in the MP4).

## Notes & gotchas
- **24 FPS:** The model generates at a fixed 24 frames per second, providing a standard cinematic look.
- **MIME Type:** Always returns `video/mp4`.
- **Latency:** Despite the "Fast" naming, video generation is a heavy process. Use **Queue Mode** with webhooks for production applications to avoid timeout issues.
- **Content Policy:** Google's safety filters are notoriously strict regarding PII and likeness of public figures; `auto_fix` will attempt to pivot these prompts to safer alternatives.

## Sources
- [FAL.ai Veo 3 Fast Documentation](https://fal.ai/models/fal-ai/veo3/fast/api)
- [Google DeepMind Technical Blog](https://deepmind.google/technologies/veo/)
- [Vertex AI Generative AI Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo/overview)
