# Runway Video Endpoints

Three endpoints, two Nebula nodes (`runway-video`, `runway-aleph`). Fields and limits are
from Runway's request schema (https://docs.dev.runwayml.com/openapi.json), read 2026-10-14.
Runway rejects any field a model doesn't list, so the handler sends only what the chosen
model takes. The per-model tables live in `backend/handlers/runway.py`
(`RUNWAY_VIDEO_MODELS`), and the node shows each ratio/duration option only for the
models that take it.

**Retired:** `gen3a_turbo` and `gen4_aleph` (2026-07-30, Runway changelog) and `veo3`
(gone from the schema). Saved nodes migrate: gen3a_turbo -> gen4_turbo, veo3 -> veo3.1
(duration rounded up to 4/6/8), gen4_aleph -> aleph2.

## `runway-video`: image connected -> `POST /v1/image_to_video`, prompt only -> `POST /v1/text_to_video`

| `model` | Durations | Image-to-video ratios | Text-to-video ratios | Prompt | Extras the node sends |
|---|---|---|---|---|---|
| `gen4.5` | 2–10 | `1280:720`, `720:1280`, `1104:832`, `960:960`, `832:1104`, `1584:672` | `1280:720`, `720:1280` | ≤1000; **required with an image** | `seed` |
| `gen4_turbo` | 2–10 | same as gen4.5 | none (image required) | ≤1000, optional | `seed` |
| `veo3.1`, `veo3.1_fast` | 4, 6, 8 | `1280:720`, `720:1280`, `1080:1920`, `1920:1080` | same | ≤1000 | `audio` (default true; without it Veo bills less, see prices), `seed` |
| `happyhorse_1_0` | 3–15 | **no ratio**: `resolution` `720p` / `1080p` (output follows the image) | `1280:720`, `720:1280`, `960:960`, `1108:832`, `832:1108`, `1920:1080`, `1080:1920`, `1440:1440`, `1662:1248`, `1248:1662` | 2–2500 | `resolution` (image only). No seed. |
| `seedance2` | 4–15 or `auto` | 24: the 12 below + 1080p (`2206:946`, `1920:1080`, `1664:1248`, `1440:1440`, `1248:1664`, `1080:1920`) + 4K (`3840:1646`, `3840:2160`, `3840:2880`, `3840:3840`, `2880:3840`, `2160:3840`) | same | ≤3500 | `audio`, `seed` |
| `seedance2_fast`, `seedance2_mini` | 4–15 or `auto` | 12 (480p/720p): `992:432`, `864:496`, `752:560`, `640:640`, `560:752`, `496:864`, `1470:630`, `1280:720`, `1112:834`, `960:960`, `834:1112`, `720:1280` | same | ≤3500 | `audio`, `seed` |
| `seedance2_5` | 4–30 or `auto` | 18 (480p–1080p): `992:432`, `854:480`, `752:560`, `640:640`, `560:752`, `480:854`, then the 720p and 1080p ratios above | same | ≤15000 | `audio`, `seed` |

`duration: "auto"` lets Seedance pick; Runway bills the model maximum up front and
refunds the rest, so Nebula leaves it unpriced. The inspector filters ratios by model,
not by whether an image is wired, so a gen4.5 text-only run with a 4:3 ratio fails in
the handler with a list of the valid ones (before any billed call).

### Example (Gen-4.5 image-to-video)

```json
POST /v1/image_to_video
{
  "model": "gen4.5",
  "promptImage": "https://example.com/first.png",
  "promptText": "Slow dolly-in on the subject's face; cinematic lighting.",
  "ratio": "1280:720",
  "duration": 8,
  "seed": 12345
}
```

### Example (HappyHorse image-to-video: resolution, no ratio, no seed)

```json
{ "model": "happyhorse_1_0", "promptImage": "data:image/png;base64,...", "resolution": "1080p", "duration": 12 }
```

### What the API takes that `runway-video` doesn't send

- `promptImage` as `[{uri, position: "first"|"last"}]` (first + last keyframes) or as
  reference images (Seedance: omit `position`). The node sends one first-frame image.
- Text-to-video `references` (images), `referenceVideos`, `referenceAudio` (Seedance).
- Veo `negativePrompt`; Gen-4.5 `outputFormat` (ProRes / HDR, extra cost) and
  `contentModeration`.
- Seedance 2.5 `draft: true` (cheap 480p preview) and enhancing it with
  `{model: "seedance2_5", draftTaskId}` on text_to_video within 7 days.
- Seedance video-to-video (below): the node has no video input.

## `POST /v1/video_to_video`

### Aleph 2.0 (`runway-aleph`)

| Field | Required | Notes |
|---|---|---|
| `model` | yes | `"aleph2"` (the only Aleph model; default) |
| `videoUri` | yes | Input video, 2–30 s. HTTPS URL, data URI ≤5MB, or `runway://` upload URI. |
| `promptText` | no on the API, required by the node | ≤1000 chars. |
| `keyframes` | no | 1–5 guidance images `{uri, at: 0-1}` or `{uri, seconds}`. The node's `reference` image goes as `[{uri, at: 0}]`. |
| `seed` | no | int |
| `targetAspectRatio`, `outputFormat`, `proresProfile`, `contentModeration` | no | Not exposed by the node. |

Aleph 2.0 has **no `references` field** (that was Gen-4 Aleph).

### Seedance video-to-video (not exposed in Nebula)

`seedance2`, `seedance2_fast`, `seedance2_mini`, `seedance2_5` take `promptVideo`
(required), `promptText`, `audio`, `duration`, `ratio`, `references` (up to 9 images; 30
for 2.5), `referenceVideos` (up to 2 for 2.0 / Fast / Mini, 9 for 2.5) and
`referenceAudio`. `seedance2_5` also takes `mode`: `reference` (default), `extend` or
`edit`, and `draft`.

## Local files

Local paths become a data URI while the encoded URI fits Runway's 5MB cap; larger files
(up to 200MB) go through `POST /v1/uploads` (`{filename, type: "ephemeral"}` -> presigned
form -> `runway://` URI, valid 24 h). Public HTTPS URLs pass through unchanged.

## Prices (credits, $0.01 each; guides/pricing.md 2026-10-14)

Per second: gen4.5 12, gen4_turbo 5, veo3.1 40 with audio / 20 without, veo3.1_fast 15 /
10, seedance2 36 (480p/720p) / 40 (1080p) / 150 (4K), seedance2_fast 29, seedance2_mini 16
(64 minimum), seedance2_5 20 / 30 / 68 at 480p / 720p / 1080p (80 minimum), happyhorse 15
(720p) / 30 (1080p), aleph2 28 (56 minimum).
