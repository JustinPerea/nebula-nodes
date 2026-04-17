---
name: fal-ai/ffmpeg-api/compose
display_name: FFmpeg API Compose
category: video-to-video
creator: FAL.ai
fal_docs: https://fal.ai/models/fal-ai/ffmpeg-api/compose
original_source: https://ffmpeg.org/
summary: A programmatic video composition tool that combines multiple video, audio, and image tracks using the FFmpeg engine.
---

# FFmpeg API Compose

## Overview
- **Slug:** `fal-ai/ffmpeg-api/compose`
- **Category:** Video-to-Video / Media Utility
- **Creator:** [FAL.ai](https://fal.ai)
- **Best for:** Programmatic video editing, stitching clips, adding overlays, and automated content generation.
- **FAL docs:** [fal-ai/ffmpeg-api/compose](https://fal.ai/models/fal-ai/ffmpeg-api/compose/api)
- **Original source:** [FFmpeg](https://ffmpeg.org/) (Engine)

## What it does
The FFmpeg API Compose model is a high-level wrapper around the industry-standard FFmpeg multimedia framework. It allows developers to programmatically "edit" videos by defining a timeline of "tracks" and "keyframes." Users can layer video clips, audio tracks, and static images into a single cohesive output file. It handles the heavy lifting of transcoding, synchronization, and rendering in a cloud-native environment, making it ideal for apps that need to generate custom video content on the fly.

## When to use this model
- **Use when:** You need to combine multiple media sources (e.g., a background video with a voiceover and a watermark logo).
- **Use when:** You are building an automated video editing tool or a "no-code" video builder.
- **Don't use when:** You need real-time low-latency video mixing (this is an asynchronous batch process).
- **Don't use when:** You need complex AI-driven transitions or generative "in-betweening" (use models like Kling or LTX for that).
- **Alternatives:** 
  - `fal-ai/ffmpeg-api/merge-videos`: Simpler for just joining clips end-to-end.
  - `fal-ai/ffmpeg-api/metadata`: Use this first to get the dimensions and durations of your source files before composing.
  - `fal-ai/ffmpeg-api/waveform`: For generating visual waveforms from the audio component of your composition.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/ffmpeg-api/compose` (Sync) / `https://queue.fal.run/fal-ai/ffmpeg-api/compose` (Queue)

### Input parameters
The API uses a structured `tracks` array to define the composition.

| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `tracks` | `list<Track>` | (Required) | Array of tracks | The list of media tracks to be combined. |
| `tracks[].id` | `string` | (Required) | Unique ID | A unique identifier for the track (e.g., "bg_video"). |
| `tracks[].type` | `string` | (Required) | `video`, `audio`, `image` | The type of media being added to this track. |
| `tracks[].keyframes` | `list<Keyframe>`| (Required) | Array of keyframes | Defines when and where media appears on the track. |
| `keyframes[].timestamp` | `float` | (Required) | 0+ (ms) | The start time in milliseconds on the global timeline. |
| `keyframes[].duration` | `float` | (Required) | 0+ (ms) | The duration in milliseconds for this specific piece of media. |
| `keyframes[].url` | `string` | (Required) | Valid URL | The public URL of the media source file. |

### Output
The API returns a JSON object containing the rendered media.

| Field | Type | Description |
|---|---|---|
| `video_url` | `string` | The permanent URL of the rendered video file. |
| `thumbnail_url` | `string` | A URL for a generated thumbnail image of the final video. |

### Example request
```json
{
  "tracks": [
    {
      "id": "background",
      "type": "video",
      "keyframes": [
        {
          "timestamp": 0,
          "duration": 5000,
          "url": "https://example.com/clip1.mp4"
        }
      ]
    },
    {
      "id": "voiceover",
      "type": "audio",
      "keyframes": [
        {
          "timestamp": 1000,
          "duration": 3000,
          "url": "https://example.com/speech.mp3"
        }
      ]
    }
  ]
}
```

### Pricing
- **Cost:** $0.0002 per second of output video ([FAL.ai Pricing](https://fal.ai/models/fal-ai/ffmpeg-api/compose/llms.txt)).
- Note: This is significantly cheaper than generative AI models because it uses standard CPU/GPU transcoding rather than diffusion inference.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary API surface for this specific managed composition service. While the underlying engine is FFmpeg (which is open-source), there is no "direct API" that offers this exact JSON-to-Video composition schema outside of the FAL platform. Users wishing to run this themselves would need to deploy a custom FFmpeg server.

## Prompting best practices
*This model does not use natural language prompts. Instead, "prompting" is replaced by structural JSON definitions.*
- **Coordinate Systems:** If layering images, ensure they are pre-sized to match the target resolution, as the basic `compose` API often defaults to center-aligning or stretching.
- **Source Health:** Always use `fal-ai/ffmpeg-api/metadata` to verify that your input URLs are valid and have the codecs you expect.
- **Timestamp Precision:** Timestamps are in milliseconds. For frame-accurate editing, calculate your timestamps based on the source's FPS (e.g., for 30fps, increments of ~33.33ms).
- **Codec Consistency:** While the API handles transcoding, using the same container (e.g., MP4) for all inputs can reduce the risk of synchronization issues.

## Parameter tuning guide
- **`tracks` Structure:** Think of this as a "Z-index." Tracks defined later in the array will typically overlay tracks defined earlier if they share the same media type (e.g., placing a logo image after a background video).
- **`duration` vs Source Length:** If the `duration` specified is longer than the source media's actual length, the behavior depends on the media type (images will hold, videos might freeze or loop depending on internal FFmpeg flags).
- **`id` Naming:** Use descriptive IDs like `overlay_logo` or `bg_music` to make your logs and debugging easier to read in the FAL dashboard.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `tracks`: A dynamic list or JSON block containing your media timeline.
- **Outputs:**
  - `Video URL`: The final rendered file.
  - `Thumbnail URL`: For UI previews.
- **Chain-friendly with:**
  - `fal-ai/ffmpeg-api/metadata`: To get source dimensions.
  - `fal-ai/stable-video-diffusion`: To generate clips that are then composed.
  - `fal-ai/ffmpeg-api/waveform`: To visualize the final audio.

## Notes & gotchas
- **Max Duration:** While not strictly capped, extremely long videos (10+ minutes) should always use the **Queue Mode** to avoid HTTP timeouts.
- **Public URLs:** The API cannot access files behind passwords or local storage. Files must be hosted on S3, Fal Storage, or a similar public CDN.
- **Resolution:** The output resolution is typically determined by the first video track provided. If you have mismatched resolutions, the engine may crop or pad the media.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/ffmpeg-api/compose)
- [FAL.ai API Documentation](https://fal.ai/models/fal-ai/ffmpeg-api/compose/api)
- [FAL.ai LLM Reference](https://fal.ai/models/fal-ai/ffmpeg-api/compose/llms.txt)
- [FFmpeg Official Site](https://ffmpeg.org/)
