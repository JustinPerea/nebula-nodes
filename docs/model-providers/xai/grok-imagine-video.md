---
id: nebula-xai-grok-imagine-video
kind: project-model-integration
project: nebula_nodes
provider: xai
status: active
verified: 2026-05-16
stale_after_days: 30
---

# xAI Grok Imagine Video in Nebula Nodes

Nebula integration notes for the `grok-imagine-video` node (provider: xai).

Canonical docs consulted (accessed 2026-05-16):
- https://docs.x.ai/docs/models (model IDs, deprecations)
- https://docs.x.ai/developers/model-capabilities/video/generation (endpoint, params, response shape)

## Node Matrix

| Node ID | Port IDs (in) | Port IDs (out) | Key | Model |
|---|---|---|---|---|
| `grok-imagine-video` | `prompt`, `image` | `video` | `XAI_API_KEY` | `grok-imagine-video` (fixed) |

Handler: `backend/handlers/grok_video.py` → `handle_grok_video`

## Model

`grok-imagine-video` is the only xAI video generation model as of 2026-05-16. It is exposed under the "Grok Imagine" brand and priced at **$0.050 per second** of generated video.

The pre-audit handler used model ID `grok-2-video` — this ID does not exist in the xAI model catalog.

## API Pattern

### Authentication
```
Authorization: Bearer {api_key}
Content-Type: application/json
```

### Submit: `POST https://api.x.ai/v1/videos/generations`

Note: path is `/v1/videos/generations` (plural `videos`) — not `/v1/video/generations`.

Request body:
```json
{
  "model": "grok-imagine-video",
  "prompt": "...",
  "duration": 10,
  "aspect_ratio": "16:9",
  "resolution": "720p",
  "image": "https://..."  // optional, for image-to-video
}
```

Response:
```json
{
  "request_id": "d97415a1-5796-b7ec-379f-4e6819e08fdf"
}
```

Field name is `request_id`, not `id` or `generation_id`.

### Poll: `GET https://api.x.ai/v1/videos/{request_id}`

Note: path is `/v1/videos/{id}` (plural `videos`, no `generations` segment).

Status values:
- `pending` — still processing
- `done` — complete
- `expired` — request expired before completion
- `failed` — generation failed

Completed response:
```json
{
  "status": "done",
  "video": {
    "url": "https://vidgen.x.ai/.../video.mp4",
    "duration": 8,
    "respect_moderation": true
  },
  "model": "grok-imagine-video"
}
```

Video URL lives at `poll_data["video"]["url"]` (nested), not top-level `url` or `video_url`.

Error response:
```json
{
  "status": "failed",
  "error": {"code": "invalid_argument", "message": "..."}
}
```

Error message is at `error.message`, not top-level `error`.

## Params

| Param | Type | Default | Notes |
|---|---|---|---|
| `duration` | integer | 5 | Seconds; range 1–15 |
| `aspect_ratio` | enum | `16:9` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` |
| `resolution` | enum | `480p` | `480p` (default) or `720p` |

## Findings and Changes (2026-05-16)

### Bugs Fixed

| Finding | Severity | Fix |
|---|---|---|
| **Wrong submit endpoint**: handler used `/v1/video/generations`; API path is `/v1/videos/generations` (plural) | Critical | Updated endpoint URL in handler and both registries |
| **Wrong poll endpoint**: handler used `/v1/video/generations/{id}`; API path is `/v1/videos/{request_id}` | Critical | Updated poll URL |
| **Wrong model ID**: handler hardcoded `grok-2-video`; canonical ID is `grok-imagine-video` | Critical | Updated model ID in handler |
| **Wrong response ID field**: handler read `id` or `generation_id`; API returns `request_id` | Critical | Now reads `result.get("request_id")` only |
| **Wrong terminal status**: handler treated `completed`/`succeeded`/`complete` as success; API status is `done` | High | Status check now matches only `"done"` |
| **Missing `expired` status**: handler had no branch for expired requests | Medium | Added `expired` to the failed-status branch |
| **Wrong video URL path**: handler checked top-level `url`/`video_url`/`output.url`; API nests at `video.url` | High | Now reads `poll_data.get("video", {}).get("url")` |
| **Wrong image field name**: handler sent image as `image_url`; API field is `image` | Medium | Changed body key from `image_url` to `image` |
| **Wrong `apiEndpoint` in registries**: both JSON and TS pointed to `/v1/images/generations` (image endpoint) | High | Corrected to `/v1/videos/generations` in both files |
| **Missing `resolution` param**: not in node definition; API supports `480p`/`720p` | Low | Added `resolution` enum param with default `480p` |
| **Missing `3:2` and `2:3` aspect ratios**: API supports 7 aspect ratios; registry only had 5 | Low | Added `3:2` and `2:3` to aspect_ratio enum |
| **Error message extraction wrong**: handler read `poll_data.get("error", status)`; error is nested at `error.message` | Low | Now reads `err.get("message", status)` |

### Files Changed

- `backend/handlers/grok_video.py` — endpoint URLs, model ID, response ID field, status values, video URL extraction, image field name, error extraction, added resolution param forwarding
- `backend/data/node_definitions.json` — `apiEndpoint`, added `resolution` param, added `3:2`/`2:3` aspect ratios
- `frontend/src/constants/nodeDefinitions.ts` — mirrors JSON changes
- `backend/tests/test_grok_video_handler.py` — new (endpoint URLs, model ID, request body, poll URL, ID field, status values, video URL extraction, error cases, output contract)

## Open Questions

1. **Image-to-video field format**: The `image` field accepts URLs and potentially base64 data URIs, but xAI docs don't specify the exact accepted formats for local files. The handler currently passes base64 data URIs for local paths — monitor for API rejection.
2. **`reference_images` array**: Docs mention a `reference_images` field for reference-to-video mode, distinct from `image`. Not currently exposed in Nebula. Consider adding a separate `grok-imagine-video-r2v` node in a catalog expansion pass.
3. **`480p` default resolution**: xAI docs list `480p` as default and `720p` as premium. The pre-audit node had no resolution param, so all requests defaulted to `480p` implicitly. Now explicit.
4. **Model stability**: `grok-imagine-video` is the only video model and was listed without a deprecation date as of 2026-05-16. However, the models page shows a deprecation pattern (`grok-4-1-fast` retired May 15, 2026). Re-verify model ID in 30 days.
