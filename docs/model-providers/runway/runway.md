---
id: nebula-runway
kind: project-model-integration
project: nebula_nodes
provider: runway
model: runway-video, runway-aleph, runway-image, runway-act-two, runway-tts, runway-sts, runway-dubbing
status: active
verified: 2026-10-14
stale_after_days: 30
---

# Runway Family in Nebula Nodes

Nebula-specific integration notes for the seven Runway nodes:
`runway-video`, `runway-aleph`, `runway-image`, `runway-act-two`, `runway-tts`, `runway-sts`, `runway-dubbing`.

All share `backend/handlers/runway.py`.

## 2026-10-14 update

Checked against Runway's request schema (`https://docs.dev.runwayml.com/openapi.json`),
models guide, pricing page and changelog (`llms-full.txt`), all fetched 2026-10-14.

- **Retired:** `gen3a_turbo` and `gen4_aleph` ("no longer available on Runway Dev",
  2026-07-30); `veo3` is gone from the image/text-to-video schema. Options removed;
  `runway-aleph` defaults to `aleph2`. Saved graphs migrate in
  `backend/services/retired_nodes.py` (gen3a_turbo -> gen4_turbo, veo3 -> veo3.1 with
  duration rounded up to 4/6/8, gen4_aleph -> aleph2). The handler refuses the old IDs.
- **Per-model limits:** `RUNWAY_VIDEO_MODELS` / `RUNWAY_IMAGE_MODELS` in the handler hold
  each model's ratios, durations and fields. The node definitions show each option only
  for the models that take it (`visibleWhen` on options), and the handler checks every
  value before the billed submit. `duration` is now an enum (2-30 + `auto`, per model).
- **New models:** `seedance2_mini`, `seedance2_5` on `runway-video`; `seedream5_pro`,
  `seedream5_lite` on `runway-image` (Runway resells ByteDance; not a maker route).
- **New params:** `runway-video` `audio` (Veo, Seedance) and `resolution` (HappyHorse
  image-to-video, which takes no `ratio`); `runway-image` `grounding` (Seedream). Seed is
  sent only to models whose schema has it.
- **Aleph 2.0 has no `references` field.** The reference image now goes as
  `keyframes: [{uri, at: 0}]`, as in Runway's own aleph2 example.
- **Local files over 5MB** (encoded data URI) go through `POST /v1/uploads` (ephemeral,
  `runway://`, 24 h, 200MB max) on every Runway handler. The schema caps data URIs at
  5MB; the inputs guide says 16MB for video/audio, and the stricter value is used.
- **Pricing:** `runway-video` and `runway-image` have entries in
  `backend/data/model_pricing.json` (credits at $0.01).

## Sources

Verified against canonical sources fetched 2026-05-17:

- `https://docs.dev.runwayml.com/api/` — official Runway API reference
- `https://github.com/runwayml/sdk-python` — official Stainless-generated Python SDK
  - `src/runwayml/_client.py` — base URL, auth headers, X-Runway-Version value
  - `src/runwayml/types/image_to_video_create_params.py` — image_to_video param schema
  - `src/runwayml/types/text_to_video_create_params.py` — text_to_video param schema
  - `src/runwayml/types/text_to_image_create_params.py` — text_to_image param schema
  - `src/runwayml/types/video_to_video_create_params.py` — video_to_video param schema
  - `src/runwayml/types/character_performance_create_params.py` — character_performance param schema
  - `src/runwayml/types/text_to_speech_create_params.py` — text_to_speech param schema
  - `src/runwayml/types/speech_to_speech_create_params.py` — speech_to_speech param schema
  - `src/runwayml/types/voice_dubbing_create_params.py` — voice_dubbing param schema

## API Fundamentals

| Field | Value |
|---|---|
| Base URL | `https://api.dev.runwayml.com` |
| Version header | `X-Runway-Version: 2024-11-06` |
| Auth header | `Authorization: Bearer {key}` |
| Task poll | `GET /v1/tasks/{id}` |
| Success status | `SUCCEEDED` |
| Failure status | `FAILED` |
| Status field path | `status` |
| Task ID field path | `id` |
| Output field path | `output` (array of URLs) |

Note: base URL uses `api.dev.runwayml.com` — this is the current production domain per the SDK `_client.py`. The `.dev` subdomain is not a staging/sandbox environment; it is Runway's live production API as of May 2026.

## Node Summary

| Node | Handler | Endpoint | Output | Exec |
|---|---|---|---|---|
| `runway-video` | `handle_runway_video` | `/v1/image_to_video` or `/v1/text_to_video` | `video` (Video) | async-poll |
| `runway-aleph` | `handle_runway_aleph` | `/v1/video_to_video` | `video` (Video) | async-poll |
| `runway-image` | `handle_runway_image` | `/v1/text_to_image` | `image` (Image) | async-poll |
| `runway-act-two` | `handle_runway_act_two` | `/v1/character_performance` | `video` (Video) | async-poll |
| `runway-tts` | `handle_runway_tts` | `/v1/text_to_speech` | `audio` (Audio) | async-poll |
| `runway-sts` | `handle_runway_speech_to_speech` | `/v1/speech_to_speech` | `audio` (Audio) | async-poll |
| `runway-dubbing` | `handle_runway_voice_dubbing` | `/v1/voice_dubbing` | `audio` (Audio) | async-poll |

## Findings and Fixes

### runway-image: ratio 9:16 portrait — `"720:1280"` is the correct final value (REVERTED)

**Severity:** Medium. The initial audit identified a label/value mismatch: the label said `"768x1360 (9:16)"` while the value was `"720:1280"`, and the audit subagent changed the value to `"768:1360"` to match the SDK schema.

**That change was reverted in commit `c963dd0`.** Live-smoke testing showed the Runway API rejected `"768:1360"` at runtime. The valid option for the 9:16 portrait ratio is `"720:1280"` per the Runway API's actual accepted values.

**Final state:** Registry has `{ "label": "720x1280 (9:16)", "value": "720:1280" }`. The label and value are internally consistent and the value is API-validated. No further change needed.

### runway-video: dual-endpoint routing not reflected in node's apiEndpoint field (INFO, no fix needed)

**Severity:** Info only. The `runway-video` node has `"apiEndpoint": "/v1/image_to_video"` in its definition, but the handler dynamically routes to either `/v1/image_to_video` or `/v1/text_to_video` depending on whether an image is provided. The handler gates text-only requests per model (`RUNWAY_VIDEO_MODELS`; every model but `gen4_turbo` has text-to-video as of 2026-10-14). The `apiEndpoint` field in the node definition is metadata only (not used at runtime) so the mismatch is cosmetic. Noted but not changed.

### All nodes: auth headers, base URL, version string — PASS

Handler uses `RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1"`, `X-Runway-Version: 2024-11-06`, and `Authorization: Bearer {key}`. All three match the SDK `_client.py` exactly.

### runway-aleph: `videoUri` field name — PASS

Handler sends `"videoUri"` in the request body. SDK confirms the Python alias is `video_uri` → JSON alias `videoUri`. Correct.

### runway-aleph: `references` structure — SUPERSEDED 2026-10-14

This was right for `gen4_aleph`. `aleph2` (now the only Aleph model) has no `references`
field and rejects unknown fields; the handler sends the reference as
`keyframes: [{"uri": ref_uri, "at": 0}]`.

### runway-act-two: `character` and `reference` structures — PASS

Handler constructs `{"type": "image"|"video", "uri": ...}` for character and `{"type": "video", "uri": ...}` for reference. SDK confirms `CharacterImage`, `CharacterVideo`, and `Reference` type shapes. All correct.

### runway-tts / runway-sts: ElevenLabs-backed endpoints — PASS

TTS model: `"eleven_multilingual_v2"` — confirmed as the only valid value in SDK.
STS model: `"eleven_multilingual_sts_v2"` — confirmed as the only valid value in SDK.
Voice structure: `{"type": "runway-preset", "presetId": "..."}` — confirmed.
`removeBackgroundNoise` param (STS): confirmed field name matches SDK alias.

### runway-dubbing: `audioUri` and field names — PASS

Handler sends `audioUri`, `targetLang`, `disableVoiceCloning`, `dropBackgroundAudio`, `numSpeakers`. All confirmed by SDK `voice_dubbing_create_params.py`. Note: SDK does not specify a model name in the type signature (the `model` field was not found in the SDK params for this endpoint). Handler sends `"eleven_voice_dubbing"` as model — this appears to be an internal Runway routing string; not verified from a machine-readable source but consistent with Runway's ElevenLabs-backed naming convention for TTS (`eleven_multilingual_v2`) and STS (`eleven_multilingual_sts_v2`). No change made — low risk.

### runway-image: Gemini 2.5 Flash model exposed via Runway — PASS (audited)

The node definition exposes `gemini_2.5_flash` alongside `gen4_image` and `gen4_image_turbo`. The SDK `text_to_image_create_params.py` confirms `Gemini2_5Flash` as a valid model variant for the `/v1/text_to_image` endpoint. Runway acts as a passthrough for this model.

### All audio handlers: output saved as `.mp3` — PASS

`_save_audio_from_url` saves to `{uuid}.mp3`. Runway TTS/STS/dubbing all return MP3 audio. Correct.

## Param Matrix (post-audit)

### runway-video

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | yes | `gen4.5` | `model` | gen4.5, seedance2, seedance2_fast, happyhorse_1_0, gen4_turbo, veo3.1, veo3.1_fast, seedance2_mini, seedance2_5 |
| `duration` | enum | no | 5 | `duration` | Per model: gen4.5/gen4_turbo 2–10, veo3.1(_fast) 4/6/8, happyhorse 3–15, seedance2/_fast/_mini 4–15 + auto, seedance2_5 4–30 + auto |
| `ratio` | enum | no | `1280:720` | `ratio` | Per model and endpoint (see `RUNWAY_VIDEO_MODELS`); not sent for happyhorse image-to-video |
| `seed` | int | no | — | `seed` | 0–4294967295; not for happyhorse |
| `resolution` | enum | no | `720p` | `resolution` | happyhorse image-to-video only (720p/1080p) |
| `audio` | bool | no | true | `audio` | veo3.1(_fast), seedance*; Veo bills less without audio |

### runway-aleph

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | no | `aleph2` | `model` | aleph2 (gen4_aleph retired 2026-07-30) |
| `seed` | int | no | — | `seed` | 0–4294967295 |

### runway-image

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `model` | enum | yes | `gen4_image` | `model` | gen4_image, gen4_image_turbo, gemini_image3_pro, gpt_image_2, gemini_2.5_flash, seedream5_pro, seedream5_lite |
| `ratio` | enum | no | `1360:768` | `ratio` | Each model's own list (`RUNWAY_IMAGE_MODELS`); 1360:768 is Gen-4 only |
| `seed` | int | no | — | `seed` | 0–4294967295; Gen-4 Image (+ Turbo) only |
| `grounding` | bool | no | false | `grounding` | Seedream only; sent when true |

### runway-act-two

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `bodyControl` | bool | no | false | `bodyControl` | Enables non-facial body movement |
| `expressionIntensity` | int | no | 3 | `expressionIntensity` | 1–5 |
| `ratio` | enum | no | `1280:720` | `ratio` | 6 options |
| `seed` | int | no | — | `seed` | 0–4294967295 |

### runway-tts

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `voiceId` | enum | no | `Maya` | `voice.presetId` | 30 preset voices |

### runway-sts

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `voiceId` | enum | no | `Maya` | `voice.presetId` | 20 preset voices |
| `removeBackgroundNoise` | bool | no | false | `removeBackgroundNoise` | |

### runway-dubbing

| Param | Type | Required | Default | API field | Notes |
|---|---|---|---|---|---|
| `targetLang` | enum | yes | `es` | `targetLang` | 28 language codes |
| `disableVoiceCloning` | bool | no | false | `disableVoiceCloning` | |
| `dropBackgroundAudio` | bool | no | false | `dropBackgroundAudio` | |
| `numSpeakers` | int | no | — | `numSpeakers` | 1–10; auto-detect when absent |

## Async Poll Flow (all 7 nodes)

```
POST /v1/{endpoint}   → { id: "task_...", status: "PENDING"|... }
  ↓ poll every 2s (max 300 polls = 10 min)
GET /v1/tasks/{id}    → { status: "SUCCEEDED"|"FAILED", output: [...urls] }
  ↓ when status == "SUCCEEDED"
output[0]             → URL to generated asset
```

The `async_poll_execute` runner handles the full loop. `AsyncPollConfig` is constructed per-node with the correct poll URL template.

## Check Summary

| Check | runway-video | runway-aleph | runway-image | runway-act-two | runway-tts | runway-sts | runway-dubbing |
|---|---|---|---|---|---|---|---|
| Base URL correct | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| X-Runway-Version header | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Auth header format | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Endpoint path correct | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Model value(s) match API | PASS | PASS | PASS | PASS | PASS | PASS | INFO |
| Required body fields present | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Response `output[0]` consumed | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Ratio label/value consistent | N/A | N/A | FIXED | N/A | N/A | N/A | N/A |
| Output saved correctly | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

## Open Questions

1. **`runway-dubbing` model string** — Handler sends `"eleven_voice_dubbing"` as the `model` field. The SDK `VoiceDubbingCreateParams` does not specify a `model` literal in the type definition; the field appears in the body but is not in the typed params. This may be an undocumented internal routing string. Risk: low (the field is present in existing integration; would fail loudly if wrong).

2. **Veo3.1 `audio` param** — Resolved 2026-10-14: `audio` is a node param for Veo 3.1 and Seedance.

3. **Gen4.5 `duration` field (image_to_video)** — SDK marks `duration` as `Required` for `gen4.5` in image_to_video context (must be integer 2–10). Handler defaults to 5 if not set, which is valid. No issue, but worth noting the field is required by the API, not optional.

4. **`text_to_video` ratios for gen4.5** — The schema limits gen4.5 text_to_video to `"1280:720"` and `"720:1280"`. The handler checks it before submitting. The inspector filters ratios by model but can't see whether an image is wired, so it still offers the image-to-video ratios for gen4.5 text-only runs; the handler's error names the valid ones.
