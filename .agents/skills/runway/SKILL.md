---
name: runway
description: Runway API — Gen-4.5 / Gen-4 Turbo, Veo 3.1 pass-through, Seedance 2.0 / Fast / Mini / 2.5, HappyHorse 1.0, Aleph 2.0, Gen-4 Image, Nano Banana Pro, GPT Image 2, Seedream 5.0 Pro / Lite, Act-Two character performance, Eleven-Labs-backed TTS/STS/dubbing. Activate when the user configures any `runway-*` node or asks about Runway's API. Sourced from the official Python SDK (github.com/runwayml/sdk-python) on 2026-04-17; models, limits and prices re-checked against docs.dev.runwayml.com (openapi.json, guides) on 2026-10-14.
---

# Runway Skill

## When to use

- User configures any `runway-*` node (runway-video, runway-aleph, runway-image, runway-act-two, runway-tts, runway-sts, runway-dubbing)
- User asks about Runway models: Gen-4.5, Gen-4 Turbo, Aleph 2.0, Gen-4 Image (Turbo), Act-Two, Veo 3.1 (+ Fast), Seedance 2.0 / Fast / Mini / 2.5, HappyHorse 1.0, Nano Banana Pro, GPT Image 2, Gemini 2.5 Flash, Seedream 5.0 Pro / Lite (via Runway)
- Retired on Runway: Gen-3a Turbo and Gen-4 Aleph (2026-07-30), Veo 3 (gone from the schema). Saved nodes migrate to Gen-4 Turbo, Aleph 2.0 and Veo 3.1.
- User asks about Runway pricing, ratios, durations, voice presets, or dubbing target languages

## Universal rules (all Runway endpoints)

1. **Every task is async.** Submit returns `{"id": "<task_id>"}`. Poll `GET /v1/tasks/{id}` until `status` is `SUCCEEDED` or `FAILED`. Our backend uses `AsyncPollConfig` with 2s interval, 300 poll cap.
2. **Base URL:** `https://api.dev.runwayml.com/v1` (yes — `dev.runwayml.com`, the API gateway).
3. **Required headers:** `Authorization: Bearer <RUNWAY_API_KEY>`, `Content-Type: application/json`, `X-Runway-Version: 2024-11-06`.
4. **Input URIs must be HTTPS** (or `data:` / `runway://`). The handler turns a local file into a data URI while the encoded URI fits Runway's 5MB cap, and uploads bigger files (up to 200MB) through `POST /v1/uploads` (ephemeral, `runway://`, valid 24 h).
5. **camelCase over the wire.** The SDK uses snake_case (`prompt_text`), but the HTTP API uses camelCase (`promptText`, `videoUri`, `promptImage`, `referenceImages`, `contentModeration`, `bodyControl`, `expressionIntensity`, `publicFigureThreshold`, `outputCount`, `audioUri`, `targetLang`, `disableVoiceCloning`, `dropBackgroundAudio`, `numSpeakers`, `referenceVideos`, `removeBackgroundNoise`, `presetId`). The Runway handler already sends camelCase — don't re-translate.
6. **Content moderation knob:** `contentModeration.publicFigureThreshold` — `"auto"` (default) or `"low"` (less strict on recognizable faces). Available on Gen-4.5, Gen-4 Turbo, Gen-4 Image (Turbo + base), Aleph 2.0, Act-Two. Nebula doesn't expose it.
7. **Cancel/delete:** `DELETE /v1/tasks/{id}` cancels a running task or deletes a completed one.

## Pick the right endpoint

| User wants | Endpoint | Models | Nebula node |
|---|---|---|---|
| Animate an image → video | `POST /v1/image_to_video` | gen4.5, gen4_turbo, veo3.1, veo3.1_fast, happyhorse_1_0, seedance2, seedance2_fast, seedance2_mini, seedance2_5 | `runway-video` (with image input) |
| Generate video from text | `POST /v1/text_to_video` | all of the above but gen4_turbo | `runway-video` (no image) |
| Restyle / edit a video | `POST /v1/video_to_video` | aleph2 (Seedance v2v not exposed) | `runway-aleph` |
| Generate image from text (± refs) | `POST /v1/text_to_image` | gen4_image, gen4_image_turbo, gemini_image3_pro, gpt_image_2, gemini_2.5_flash, seedream5_pro, seedream5_lite | `runway-image` |
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
- `400` on a ratio or duration: model-specific. The node shows only the chosen model's values and the handler checks them before submitting, so a 400 usually means a stale saved value; see `video.md` / `image.md`.
