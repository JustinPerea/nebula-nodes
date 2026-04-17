---
name: fal-ai/sora-2/text-to-video
display_name: OpenAI Sora 2 (via FAL)
category: text-to-video
creator: OpenAI
fal_docs: https://fal.ai/models/fal-ai/sora-2/text-to-video
original_source: https://openai.com/index/sora-2/
summary: OpenAI's flagship video generation model featuring state-of-the-art physics, synchronized audio, and character consistency.
---

# OpenAI Sora 2 (via FAL.ai)

## Overview
- **Slug:** `fal-ai/sora-2/text-to-video`
- **Category:** text-to-video
- **Creator:** [OpenAI](https://openai.com/)
- **Best for:** High-fidelity, physically accurate video generation with synchronized audio and consistent characters.
- **FAL docs:** [fal.ai/models/fal-ai/sora-2/text-to-video](https://fal.ai/models/fal-ai/sora-2/text-to-video)
- **Original source:** [OpenAI Sora 2 Documentation](https://developers.openai.com/api/docs/guides/video-generation)

## What it does
Sora 2 is OpenAI's flagship video generation model, representing a significant leap in physical accuracy, realism, and controllability over its predecessor. It is capable of generating richly detailed, dynamic clips up to 20 seconds long, complete with synchronized sound effects and dialogue. Key advancements include better adherence to the laws of physics, improved object permanence, and the ability to maintain character consistency across multiple generations.

## When to use this model
- **Use when:** You need the highest possible realism, complex camera movements, or synchronized audio/dialogue for cinematic storytelling or high-end marketing content.
- **Don't use when:** You need ultra-fast, low-cost previews (use [Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine) or [Kling](https://fal.ai/models/fal-ai/kling-video) for faster iterations).
- **Alternatives:** 
    - **[Kling 2.5](https://fal.ai/models/fal-ai/kling-video):** Excellent for character motion and high-quality textures, often at a lower price point.
    - **[Luma Dream Machine](https://fal.ai/models/fal-ai/luma-dream-machine):** Great for rapid prototyping and stylized motion.
    - **[Wan 2.1](https://fal.ai/models/fal-ai/wan-2.1):** A strong open-source alternative for high-resolution video generation.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sora-2/text-to-video` (Sync) / `https://queue.fal.run/fal-ai/sora-2/text-to-video` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | N/A | The text prompt describing the video, including subject, motion, and style. |
| `resolution` | `string` | `720p` | `720p`, `1080p` | The output resolution. |
| `aspect_ratio` | `string` | `16:9` | `16:9`, `9:16` | The aspect ratio of the generated video. |
| `duration` | `integer` | `4` | `4, 8, 12, 16, 20` | Duration of the generated video in seconds. |
| `model` | `string` | `sora-2` | `sora-2`, `sora-2-2025-12-08`, `sora-2-2025-10-06` | Specific model version to use. |
| `character_ids` | `list<string>` | `[]` | N/A | Up to two character IDs to maintain visual consistency. |
| `detect_and_block_ip` | `boolean` | `true` | `true`, `false` | Enables checking for known intellectual property in the prompt. |
| `delete_video` | `boolean` | `true` | `true`, `false` | Deletes the video from FAL's storage after generation for privacy. |

### Output
The output returns a JSON object containing the video file information and metadata.
```json
{
  "video": {
    "url": "https://v2.fal.media/...",
    "content_type": "video/mp4",
    "file_name": "video.mp4",
    "file_size": 1234567,
    "width": 1280,
    "height": 720,
    "fps": 30,
    "duration": 4,
    "num_frames": 120
  },
  "video_id": "abc-123",
  "thumbnail": { "url": "..." },
  "spritesheet": { "url": "..." }
}
```

### Example request
```json
{
  "prompt": "A cinematic tracking shot of a neon-lit cyberpunk city at night, heavy rain reflecting off the asphalt, flying cars soaring between skyscrapers.",
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "duration": 4,
  "model": "sora-2"
}
```

### Pricing
- **Cost:** ~$0.10 per second generated.
- A 5-second video costs approximately $0.50. Pricing may vary based on resolution settings (e.g., 1080p might be higher).

## API — via Original Source (BYO-key direct)
OpenAI provides a direct API for Sora 2, which allows for additional features like video extensions and edits.

- **Endpoint:** `https://api.openai.com/v1/videos`
- **Auth Method:** Bearer Token (`OPENAI_API_KEY`)
- **Native Parameters:**
    - `size`: A string like `"1280x720"` or `"1920x1080"`.
    - `seconds`: Duration as a string.
    - `input_reference`: Supports an image or video URL for grounding the generation.
- **Additional Endpoints:**
    - `POST /v1/videos/extensions`: Extend an existing video segment.
    - `POST /v1/videos/edits`: Perform targeted edits on an uploaded video.
- **Official Docs:** [OpenAI Videos API](https://developers.openai.com/api/docs/guides/video-generation)

## Prompting best practices
- **Be Descriptive and Specific:** Describe the lighting, camera movement, and textures in detail. Instead of "a forest," use "a lush temperate rainforest at golden hour, low-angle tracking shot through the ferns."
- **Use Style Tokens:** Explicitly state the style, such as "cinematic," "3D animation," "documentary style," or "8mm film."
- **Focus on Action:** Sora 2 excels at complex motion. Describe the interaction between objects (e.g., "water splashing against the rocks and forming foam").
- **Character Consistency:** Use the `character_ids` feature for recurring characters to avoid visual drifting.
- **Avoid Over-Prompting:** While detail is good, contradictory instructions (e.g., "fast-moving but slow-motion") can confuse the physics engine.

## Parameter tuning guide
- **Duration:** Start with `4` seconds for prototyping. Only use `16-20` seconds for final renders, as longer videos have a higher chance of compositional drift.
- **Resolution:** Use `720p` for testing and `1080p` for final delivery. Higher resolutions may significantly increase generation time and cost.
- **Model Versioning:** Use the generic `sora-2` alias for the latest improvements, or a specific snapshot (e.g., `sora-2-2025-12-08`) if you need reproducible results for a production pipeline.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Text Prompt` (Required)
    - `Resolution` (Selection)
    - `Aspect Ratio` (Selection)
    - `Duration` (Slider/Selection)
    - `Character IDs` (List/Text)
- **Outputs:**
    - `Video URL` (File)
    - `Thumbnail URL` (Image)
    - `Video ID` (String)
- **Chain-friendly with:**
    - **[GPT-4o](https://fal.ai/models/fal-ai/gpt-4o):** Use as a prompt expander to generate detailed scene descriptions.
    - **[ElevenLabs](https://fal.ai/models/fal-ai/elevenlabs/text-to-speech):** For adding custom voiceovers (though Sora 2 has native audio, specific voices may still need external tools).
    - **[Remove.bg](https://fal.ai/models/fal-ai/remove-bg):** For post-processing video frames if needed.

## Notes & gotchas
- **Sync Audio:** Sora 2 generates audio by default. If you need silent video, you may need to strip the audio track post-generation.
- **Safety Filters:** OpenAI has strict filters against generating real public figures, sexually explicit content, or copyrighted IP. The `detect_and_block_ip` parameter is proactive in enforcing this.
- **Deprecation Warning:** OpenAI has signaled that the current Sora 2 API versions may be replaced by newer architectures late in 2026. Keep an eye on the [OpenAI deprecations page](https://developers.openai.com/api/docs/deprecations).

## Sources
- [FAL.ai Sora 2 Model Page](https://fal.ai/models/fal-ai/sora-2/text-to-video)
- [OpenAI Sora 2 Release Blog](https://openai.com/index/sora-2/)
- [OpenAI API Documentation](https://developers.openai.com/api/docs/guides/video-generation)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
