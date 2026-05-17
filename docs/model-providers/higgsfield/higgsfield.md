---
id: nebula-higgsfield
kind: project-model-integration
project: nebula_nodes
provider: higgsfield
status: active
verified: 2026-05-16
stale_after_days: 30
---

# Higgsfield Video Generation in Nebula Nodes

Nebula integration notes for the Higgsfield video generation node.

Canonical docs consulted (accessed 2026-05-16):
- https://docs.higgsfield.ai/docs/llms.txt (doc index)
- https://docs.higgsfield.ai/docs/how-to/introduction.md (API overview, auth)
- https://docs.higgsfield.ai/docs/how-to/sdk.md (SDK + status values)
- https://docs.higgsfield.ai/docs/how-to/webhooks.md (polling endpoint, response shape)
- https://docs.higgsfield.ai/docs/guides/video.md (model endpoints, request shape)

## Node Matrix

| Node ID | Port IDs (in) | Port IDs (out) | Key | Default Model |
|---|---|---|---|---|
| `higgsfield` | `prompt`, `image` | `video` | `HIGGSFIELD_API_KEY` | `higgsfield-ai/dop/standard` |

Handler: `backend/handlers/higgsfield.py` → `handle_higgsfield`

## Models

Higgsfield is a multi-model platform. Each model has a distinct URL path — the model is encoded in the endpoint URL, not in a request body `model` field.

| Label | Model Path (used as URL segment) | Notes |
|---|---|---|
| DoP Standard | `higgsfield-ai/dop/standard` | Default; supports T2V and I2V |
| DoP Preview | `higgsfield-ai/dop/preview` | Beta variant of DoP |
| Kling v2.1 Pro | `kling-video/v2.1/pro/image-to-video` | I2V only |
| Seedance v1 Pro | `bytedance/seedance/v1/pro/image-to-video` | I2V only |

The pre-audit model list (`higgsfield-native`, `kling-2.6`, `sora-2`, `veo-3.1`) consisted of invented/wrong IDs that would have returned 404 at the API.

## API Pattern

### Authentication
```
Authorization: Key {api_key}
Content-Type: application/json
Accept: application/json
```

The Higgsfield SDK documentation shows `Key {api_key}:{api_secret}` for two-credential setups. When `HIGGSFIELD_API_KEY` stores the key alone, the single-token `Key {token}` format is used. This differs from Bearer auth used by most providers.

### Submit: `POST https://platform.higgsfield.ai/{model_path}`

Request body:
```json
{
  "prompt": "...",
  "duration": 5,
  "aspect_ratio": "16:9",
  "image_url": "https://..."  // optional, for I2V models
}
```

Response:
```json
{
  "request_id": "9417a243-e457-4075-895b-b68f3cda5303",
  "status": "queued",
  "status_url": "...",
  "cancel_url": "..."
}
```

### Poll: `GET https://platform.higgsfield.ai/requests/{request_id}/status`

Status values:
- `queued` — waiting in queue
- `in_progress` — actively processing
- `completed` — success
- `failed` / `error` — generation failed
- `nsfw` — content policy rejection
- `cancelled` — user cancelled

Completed response:
```json
{
  "status": "completed",
  "video": { "url": "https://cdn.higgsfield.ai/..." }
}
```

Video URL lives at `poll_data["video"]["url"]`, not top-level.

## Params

| Param | Type | Default | Notes |
|---|---|---|---|
| `model` | enum | `higgsfield-ai/dop/standard` | Selects endpoint path; not sent in body |
| `duration` | integer | 5 | Seconds; range 1–15 |
| `aspect_ratio` | enum | `16:9` | Options: `16:9`, `9:16`, `1:1` |

## Findings and Changes (2026-05-16)

### Bugs Fixed

| Finding | Severity | Fix |
|---|---|---|
| **Wrong base domain**: handler used `api.higgsfield.ai`; canonical is `platform.higgsfield.ai` | Critical | Updated `HIGGSFIELD_BASE` constant and `apiEndpoint` in both registries |
| **Wrong endpoint pattern**: handler POSTed to `/v1/video/generate`; API uses `/{model_path}` model-specific URLs | Critical | Endpoint now built as `{base}/{model_id}` from param |
| **Wrong auth scheme**: handler sent `Bearer {key}`; Higgsfield requires `Key {key}` | High | Changed auth header format |
| **Wrong polling endpoint**: handler hit `/v1/video/{id}`; API uses `/requests/{request_id}/status` | Critical | Updated poll URL |
| **Wrong response ID field**: handler read `id`, `job_id`, `generation_id`; API returns `request_id` | Critical | Now reads `result.get("request_id")` |
| **Wrong video URL path**: handler checked top-level `url`/`video_url`; API nests it at `video.url` | High | Now reads `poll_data.get("video", {}).get("url")` |
| **Wrong status values**: handler treated `succeeded`/`complete`/`done` as terminal; API uses `completed` | Medium | Status check now matches only `completed` |
| **Missing `nsfw` status**: handler had no branch for content-policy rejection | Medium | Added explicit `nsfw` → RuntimeError branch |
| **Invented model IDs**: `higgsfield-native`, `kling-2.6`, `sora-2`, `veo-3.1` all non-existent | High | Replaced with canonical platform paths from docs |
| **Missing `image` input port**: node had no way to pass reference image for I2V models | Medium | Added optional `image` input port; handler wires it to `image_url` body field |
| **Missing `aspect_ratio` param**: not exposed in node definition | Low | Added `aspect_ratio` enum param |

### Files Changed

- `backend/handlers/higgsfield.py` — base URL constant, auth header, submit URL, polling URL, ID field, status values, video URL extraction, model path mapping, image port wiring
- `backend/data/node_definitions.json` — base URL, model IDs, added image port, added aspect_ratio param
- `frontend/src/constants/nodeDefinitions.ts` — mirrors JSON changes
- `backend/tests/test_higgsfield_handler.py` — new (base URL, auth scheme, endpoint, poll URL, ID field, video URL extraction, status values, error cases, output contract)

## Open Questions

1. **Single key vs key:secret**: Docs show `Key {api_key}:{api_secret}` for two-credential auth. If users are issued separate key + secret, `HIGGSFIELD_API_KEY` should store the combined `key:secret` string. No code change needed — the value is passed as-is after `Key `. Document in `.env.example`.
2. **DoP text-to-video**: Docs describe the video guide as image-to-video focused, but the DoP (Depth of Presence) model appears to support text-to-video as well. Confirm with a live request before promoting as T2V.
3. **Model list completeness**: Higgsfield hosts 100+ models. The four in the enum are the ones explicitly documented as of 2026-05-16. Expect this to expand quickly — mark `stale_after_days: 30`.
4. **Polling response `images` array**: The SDK docs show `result['images'][0]['url']` as the video URL for some models. Webhooks docs show `video.url`. Handler currently uses `video.url` per webhook shape — monitor if some models return the `images` array instead.
