---
provider: krea
model: krea-2-generate,krea-style-train,krea-style-search
models:
  - krea-2-medium
  - krea-2-large
verified: 2026-05-30
stale_after_days: 14
sources:
  - https://docs.krea.ai/api-reference/krea/krea-2-medium
  - https://docs.krea.ai/api-reference/krea/krea-2-large
  - https://docs.krea.ai/api-reference/assets/upload-an-asset
  - https://docs.krea.ai/api-reference/styles/train-a-custom-style-lora
  - https://docs.krea.ai/developers/job-lifecycle
---

# Krea 2

Direct Krea API support only in this integration. FAL Krea routes are intentionally out of scope.

## Auth

Use `Authorization: Bearer <KREA_API_TOKEN>` against `https://api.krea.ai`.

## Generate

- Medium endpoint: `POST /generate/image/krea/krea-2/medium`
- Large endpoint: `POST /generate/image/krea/krea-2/large`
- Required: `prompt`, `aspect_ratio`, `resolution`
- `resolution` currently allows only `1K`
- `aspect_ratio`: `1:1`, `4:3`, `3:2`, `16:9`, `2.35:1`, `4:5`, `2:3`, `9:16`
- `creativity`: `raw`, `low`, `medium`, `high`, default `medium`
- `seed`: number or null
- `image_style_references`: max 10 items, each `{ url, strength? }`, strength `0..1`, default `0.5`
- `moodboards`: max 1 item, each `{ id, strength? }`, strength `0..1`, schema default `0.23`
- `styles`: array of `{ id, strength }`, strength `-2..2`

Submit returns a Krea job with `job_id`; poll `GET /jobs/{id}` until `completed`, then read image URLs from `result.urls`.

## Assets

`POST /assets` accepts multipart file upload and returns an `image_url`. Nebula uses this internally when a local image or generated output is connected as a Krea image style reference.

## Styles

`POST /styles/train` creates an async training job from image URLs. Completed training jobs expose `result.style_id` from `GET /jobs/{id}`. Styles can be listed with `GET /styles` and shared to the API workspace with `POST /styles/{id}/share/workspace`.

## Product Notes

Krea moodboards are referenceable by ID, but the verified API surface did not expose public create/list moodboard endpoints. Nebula represents moodboards as ID wrapper nodes rather than trying to manage them.
