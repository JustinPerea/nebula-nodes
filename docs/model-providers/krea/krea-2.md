---
provider: krea
model: krea-2-generate,krea-style-train,krea-style-search,krea-moodboard-search,krea-moodboard-create,krea-library-manage
models:
  - krea-2-medium
  - krea-2-large
verified: 2026-10-09
stale_after_days: 14
sources:
  - https://docs.krea.ai/api-reference/krea/krea-2-medium
  - https://docs.krea.ai/api-reference/krea/krea-2-large
  - https://docs.krea.ai/api-reference/assets/upload-an-asset
  - https://docs.krea.ai/api-reference/styles/train-a-custom-style-lora
  - https://docs.krea.ai/developers/job-lifecycle
  - https://api.krea.ai/mcp (tools/list, 2026-10-09)
---

# Krea 2

Direct Krea support only: the Krea API (API token) or the signed-in Krea account (Krea's hosted MCP server). FAL Krea routes are intentionally out of scope.

## Auth

- **API token:** `Authorization: Bearer <KREA_API_TOKEN>` against `https://api.krea.ai`.
- **Krea account:** the node's `_kreaAuth` param set to `mcp`. Nebula uses the OAuth
  connection from Settings; see `docs/KREA-MCP.md`. Old recipes without the param keep
  the API token.

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

API token: `POST /styles/train` creates an async training job from image URLs. Completed training jobs expose `result.style_id` from `GET /jobs/{id}`. Styles can be listed with `GET /styles`, renamed with `PATCH /styles/{id}`, and shared to the API workspace with `POST /styles/{id}/share/workspace`. Training models: `flux_dev`, `flux_schnell`, `wan`, `wan22` (type, learning rate, batch size, steps) and `qwen`, `z-image`, `k2`, `k2-large` (steps only).

Krea account: MCP `create_style` takes `name`, `images`, `model`, `train_type` (Style/Object/Character) and `trigger_word`, and also trains `k1` and `ltx-23-22b`. It has no learning rate, batch size, step count, `Default` type or workspace share, so Style Train refuses those on the account path before uploading. `list_styles` returns `{styles, next_cursor}` with only a cursor filter; Style Search filters `model` and `ids` locally and refuses the API-only `filter`, `user` and `liked` controls. `update_style` renames and `delete_style` deletes (Library Manage).

## Moodboards

Krea's API has no moodboard endpoints, so these nodes are account-only:

- **Krea Moodboards** (`krea-moodboard-search`): MCP `list_moodboards` → `{moodboards: [{id, name, kind, description}]}`, including Krea's presets. Outputs the first match as a wireable moodboard value.
- **Krea Moodboard Create** (`krea-moodboard-create`): uploads local images, calls `create_moodboard`, polls the analysis job and outputs `result.moodboard_id`.
- **Krea Library Manage** (`krea-library-manage`): rename or delete a style or moodboard. A delete takes only a typed ID (never a wired one), and **Confirm delete** must repeat that exact ID, so a shared recipe cannot delete your items. An API token can only rename styles.

The **Krea Moodboard** helper still wraps a known ID for Krea 2 Generate.
