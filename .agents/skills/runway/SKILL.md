---
name: runway
description: Runway API — Gen-4, Gen-4 Image, Gen-4 Aleph, Act-Two character performance, Veo 3/3.1 pass-through, Seedance 2, Eleven-Labs-backed TTS/STS/dubbing. Activate when the user configures any `runway-*` node or asks about Runway's API. Sourced from the official Stainless-generated Python SDK (github.com/runwayml/sdk-python) on 2026-04-17.
---

# Runway Skill

## When to use

- User configures any `runway-*` node (runway-video, runway-aleph, runway-image, runway-act-two, runway-tts, runway-sts, runway-dubbing)
- User asks about Runway models: Gen-4.5, Gen-4 Turbo, Gen-3a Turbo, Gen-4 Aleph, Gen-4 Image (Turbo), Act-Two, Veo 3, Veo 3.1, Seedance 2, Gemini 2.5 Flash (via Runway)
- User asks about Runway pricing, ratios, durations, voice presets, or dubbing target languages

## Universal rules (all Runway endpoints)

1. **Every task is async.** Submit returns `{"id": "<task_id>"}`. Poll `GET /v1/tasks/{id}` until `status` is `SUCCEEDED` or `FAILED`. Our backend uses `AsyncPollConfig` with 2s interval, 300 poll cap.
2. **Base URL:** `https://api.dev.runwayml.com/v1` (yes — `dev.runwayml.com`, the API gateway).
3. **Required headers:** `Authorization: Bearer <RUNWAY_API_KEY>`, `Content-Type: application/json`, `X-Runway-Version: 2024-11-06`.
4. **Input URIs must be HTTPS.** Data URIs work for images (`_resolve_image` in handler converts local paths). No raw file uploads in the submit body — use `POST /v1/uploads` first if you need to host a local file.
5. **camelCase over the wire.** The SDK uses snake_case (`prompt_text`), but the HTTP API uses camelCase (`promptText`, `videoUri`, `promptImage`, `referenceImages`, `contentModeration`, `bodyControl`, `expressionIntensity`, `publicFigureThreshold`, `outputCount`, `audioUri`, `targetLang`, `disableVoiceCloning`, `dropBackgroundAudio`, `numSpeakers`, `referenceVideos`, `removeBackgroundNoise`, `presetId`). The Runway handler already sends camelCase — don't re-translate.
6. **Content moderation knob:** `contentModeration.publicFigureThreshold` — `"auto"` (default) or `"low"` (less strict on recognizable faces). Available on Gen-4.5, Gen-4 Turbo, Gen-3a Turbo, Gen-4 Image (Turbo + base), Gen-4 Aleph, Act-Two.
7. **Cancel/delete:** `DELETE /v1/tasks/{id}` cancels a running task or deletes a completed one.

## Pick the right endpoint

| User wants | Endpoint | Models | Nebula node |
|---|---|---|---|
| Animate an image → video | `POST /v1/image_to_video` | gen4.5, gen4_turbo, gen3a_turbo, veo3, veo3.1, veo3.1_fast, seedance2 | `runway-video` (with image input) |
| Generate video from text | `POST /v1/text_to_video` | gen4.5, veo3, veo3.1, veo3.1_fast, seedance2 | `runway-video` (no image) |
| Restyle / edit a video | `POST /v1/video_to_video` | gen4_aleph, seedance2 | `runway-aleph` |
| Generate image from text (± refs) | `POST /v1/text_to_image` | gen4_image_turbo, gen4_image, gemini_2.5_flash | `runway-image` |
| Make character perform a reference video | `POST /v1/character_performance` | act_two | `runway-act-two` |
| Text → speech | `POST /v1/text_to_speech` | eleven_multilingual_v2 | `runway-tts` |
| Audio/video → restyled speech | `POST /v1/speech_to_speech` | eleven_multilingual_sts_v2 | `runway-sts` |
| Dub audio to another language | `POST /v1/voice_dubbing` | eleven_voice_dubbing | `runway-dubbing` |

## Detailed references

- **Video generation** (text→video, image→video, video→video): see `video.md`
- **Image generation** (text→image with references): see `image.md`
- **Character performance** (Act-Two): see `character-performance.md`
- **Audio** (TTS, STS, dubbing, voice presets, language codes): see `audio.md`
- **Raw SDK types** at https://github.com/runwayml/sdk-python/tree/main/src/runwayml/types

## Response parsing

Every non-audio endpoint returns a task with `output: [{"url": "..."}]` once `SUCCEEDED`. Video endpoints return one MP4 URL per output (`outputCount` default 1). Image endpoints return one or more image URLs. TTS/STS/dubbing return audio URLs.

## Auth failure playbook

- `401`: `RUNWAY_API_KEY` env var missing or invalid. The key must come from dev.runwayml.com dashboard.
- `403`: API is in limited preview — some accounts lack access to specific models. Confirm the user's plan tier.
- `400` on a ratio: model-specific. See per-endpoint tables; Gen-4.5 accepts different ratios than Veo 3.1 etc.
