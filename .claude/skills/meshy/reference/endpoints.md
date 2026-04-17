# Meshy API — Endpoint Reference

All URLs relative to `https://api.meshy.ai`. Auth header required on every call: `Authorization: Bearer <MESHY_API_KEY>`.

## Endpoint map

| Feature | Create | Retrieve | Delete | List | Stream (SSE) |
|---|---|---|---|---|---|
| Text-to-3D | POST `/openapi/v2/text-to-3d` | GET `/openapi/v2/text-to-3d/:id` | DELETE `/openapi/v2/text-to-3d/:id` | GET `/openapi/v2/text-to-3d` | GET `/openapi/v2/text-to-3d/:id/stream` |
| Image-to-3D | POST `/openapi/v1/image-to-3d` | GET `/openapi/v1/image-to-3d/:id` | DELETE `/openapi/v1/image-to-3d/:id` | GET `/openapi/v1/image-to-3d` | GET `/openapi/v1/image-to-3d/:id/stream` |
| Multi-Image-to-3D | POST `/openapi/v1/multi-image-to-3d` | GET `/openapi/v1/multi-image-to-3d/:id` | DELETE `/openapi/v1/multi-image-to-3d/:id` | GET `/openapi/v1/multi-image-to-3d` | GET `/openapi/v1/multi-image-to-3d/:id/stream` |
| Remesh | POST `/openapi/v1/remesh` | GET `/openapi/v1/remesh/:id` | DELETE `/openapi/v1/remesh/:id` | GET `/openapi/v1/remesh` | GET `/openapi/v1/remesh/:id/stream` |
| Retexture | POST `/openapi/v1/retexture` | GET `/openapi/v1/retexture/:id` | DELETE `/openapi/v1/retexture/:id` | GET `/openapi/v1/retexture` | GET `/openapi/v1/retexture/:id/stream` |
| Rigging | POST `/openapi/v1/rigging` | GET `/openapi/v1/rigging/:id` | DELETE `/openapi/v1/rigging/:id` | — | GET `/openapi/v1/rigging/:id/stream` |
| Animation | POST `/openapi/v1/animations` | GET `/openapi/v1/animations/:id` | DELETE `/openapi/v1/animations/:id` | — | GET `/openapi/v1/animations/:id/stream` |
| Text-to-Image | POST `/openapi/v1/text-to-image` | GET `/openapi/v1/text-to-image/:id` | DELETE `/openapi/v1/text-to-image/:id` | GET `/openapi/v1/text-to-image` | GET `/openapi/v1/text-to-image/:id/stream` |
| Image-to-Image | POST `/openapi/v1/image-to-image` | GET `/openapi/v1/image-to-image/:id` | DELETE `/openapi/v1/image-to-image/:id` | GET `/openapi/v1/image-to-image` | GET `/openapi/v1/image-to-image/:id/stream` |
| 3D Print Multi-Color | POST `/openapi/v1/print/multi-color` | GET `/openapi/v1/print/multi-color/:id` | DELETE `/openapi/v1/print/multi-color/:id` | GET `/openapi/v1/print/multi-color` | GET `/openapi/v1/print/multi-color/:id/stream` |

**Note:** text-to-3d uses `/v2/`, every other endpoint uses `/v1/`.

## Status codes

| Code | Meaning | Common causes |
|---|---|---|
| `200` | Success | Polling/list response |
| `400` | Bad Request | Missing params, unreachable URL, invalid format, mutually-exclusive params, prompt too long (>600 chars), invalid polycount (<100 or >300,000), lowpoly with conflicting params |
| `401` | Unauthorized | Missing/invalid API key |
| `402` | Payment Required | Insufficient credits |
| `404` | Not Found | Task ID doesn't exist (also appears in stream errors) |
| `422` | Unprocessable Entity | **Rigging-specific:** "Pose estimation failed" — model isn't valid humanoid |
| `429` | Too Many Requests | Rate limit exceeded. Response body distinguishes `RateLimitExceeded` (req/s) vs `NoMoreConcurrentTasks` (queue) |

## Task lifecycle + polling

1. **Submit:** `POST` returns `{"result": "<task_id>"}` (201 or 202).
2. **Poll:** `GET /{endpoint}/{task_id}` repeatedly. Check `status`. Typical interval: 2–5 seconds. Our handlers use 3s and poll up to 300 times (~15 min max).
3. **Done when:** `status` is `"SUCCEEDED"`, `"FAILED"`, or `"CANCELED"`. `progress` reaches 100 on success.
4. **Or stream:** `GET /{endpoint}/{task_id}/stream` returns Server-Sent Events. For `PENDING`/`IN_PROGRESS`, SSE events only include `id`, `progress`, `status`. For `SUCCEEDED`, SSE emits the full task object.

## Queue awareness

`preceding_tasks` field is meaningful only when `status == "PENDING"`. Shows how many tasks are ahead of yours.

## Task expiration

All tasks include `expires_at` (ms since epoch). Download outputs before that time — URLs in the response use `?Expires=` signed tokens. Extending the task doesn't happen automatically; re-run if needed.

## Deletion

`DELETE /{endpoint}/{task_id}` is **permanent**. Task and all assets wiped.

## Common response envelope

### Create response (all endpoints)

```json
{"result": "018a210d-8ba4-705c-b111-1f1776f7f578"}
```

### Retrieve response (common fields)

```json
{
  "id": "string",
  "type": "<endpoint_type>",
  "status": "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED",
  "progress": 0-100,
  "created_at": <ms>,
  "started_at": <ms or 0>,
  "finished_at": <ms or 0>,
  "expires_at": <ms>,
  "preceding_tasks": <int, meaningful when PENDING>,
  "task_error": {"message": "<err or empty>"}
}
```

Each endpoint adds its own fields:
- **Mesh endpoints** (text-to-3d, image-to-3d, multi-image, remesh, retexture, 3d-print): `model_urls`, `texture_urls`, `thumbnail_url`
- **Rigging:** `result.rigged_character_glb_url`, `result.rigged_character_fbx_url`, `result.basic_animations`
- **Animation:** `result.animation_glb_url`, `result.animation_fbx_url`, `result.processed_*`
- **2D gen:** `image_urls` (1 or 3)

## Task types (`type` field)

| Endpoint | `type` value |
|---|---|
| Text-to-3D preview | `"text-to-3d-preview"` |
| Text-to-3D refine | `"text-to-3d-refine"` |
| Image-to-3D | `"image-to-3d"` |
| Multi-Image-to-3D | `"multi-image-to-3d"` |
| Remesh | `"remesh"` |
| Retexture | `"retexture"` |
| Rigging | `"rig"` |
| Animation | `"animate"` |
| Text-to-Image | `"text-to-image"` |
| Image-to-Image | `"image-to-image"` |
| 3D Print | `"print-multi-color"` |

## List endpoints — pagination

All `GET /{endpoint}` list endpoints accept:
- `page_num` (integer, default 1)
- `page_size` (integer, default 10, **max 50**)
- `sort_by` (string): `"+created_at"` ascending or `"-created_at"` descending

Rigging and Animation have no documented list endpoint in the API reference.

## Timestamp format

All timestamps are milliseconds since January 1, 1970 UTC (RFC 3339). `0` when the event hasn't happened yet (e.g., `started_at: 0` while `PENDING`).

## Model URL format notes

- Each key in `model_urls` corresponds to an output format (`glb`, `fbx`, `obj`, `mtl`, `usdz`, `stl`, `3mf`, `blend` for remesh only)
- Keys are **omitted** (not empty strings) when the format wasn't generated
- URLs contain `?Expires=<timestamp>` signed query params — links eventually expire
- Download promptly; don't cache URLs long-term
