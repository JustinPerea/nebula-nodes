---
name: meshy
description: Meshy 3D generation API — text-to-3D, image-to-3D, multi-image-to-3D, remesh, retexture, auto-rigging, animation, 3D printing, plus nano-banana-backed 2D gen. Activate when the user asks for 3D models, rigging, animations, 3D printing, or configures any node whose id starts with `meshy-`. Sourced directly from docs.meshy.ai on 2026-04-17 — every parameter, endpoint, and price quoted here came from the canonical API reference.
---

# Meshy Skill

## When to use

- User asks for a 3D model (text description or image reference)
- User wants to rig a character, animate a rigged character, or 3D-print a model
- User wants to retexture or remesh an existing 3D model
- User configures any `meshy-*` node
- User asks about credit costs, rate limits, or which Meshy model to pick

## Universal rules (all Meshy endpoints)

1. **Every task is async.** Submit returns `{"result": "<task_id>"}`. Poll `GET /{endpoint}/{task_id}` or subscribe to `/stream` for SSE. Task is done when `status` is `SUCCEEDED`, `FAILED`, or `CANCELED`.
2. **Assets expire.** Task responses include `expires_at` (ms since epoch). Download outputs promptly.
3. **Auth:** `Authorization: Bearer <MESHY_API_KEY>` header. Our backend uses `MESHY_API_KEY`.
4. **Base URL:** `https://api.meshy.ai/openapi/` — `v1` for most endpoints, `v2` for text-to-3d only.
5. **Status values:** `PENDING` → `IN_PROGRESS` → `SUCCEEDED` / `FAILED` / `CANCELED`.
6. **Error codes:** `400` bad params · `401` auth · `402` insufficient credits · `404` not found · `422` pose estimation failed (rigging only) · `429` rate limit.
7. **Task ID format:** k-sortable UUID. Docs say *"you should not make any assumptions about the format of the id"* — treat as opaque.
8. **Delete is irreversible.** `DELETE /{endpoint}/{task_id}` permanently removes the task and all assets.

## Pick the right endpoint

| User wants | Endpoint | Credits | Nebula node |
|---|---|---|---|
| 3D model from text | `/v2/text-to-3d` (preview, then refine) | 20 (meshy-6) + 10 refine, or 5 + 10 (older) | `meshy-text-to-3d` |
| 3D model from single image | `/v1/image-to-3d` | 20 (no tex) / 30 (with tex) on meshy-6, or 5/15 on older | `meshy-image-to-3d` |
| 3D model from 2–4 images (same object, different angles) | `/v1/multi-image-to-3d` | same as image-to-3d | `meshy-multi-image-to-3d` |
| Convert format or reduce polycount on existing model | `/v1/remesh` | 5 | `meshy-remesh` |
| Re-texture existing 3D model with text or image | `/v1/retexture` | 10 | `meshy-retexture` |
| Auto-rig a humanoid character | `/v1/rigging` | 5 (includes walking + running free) | `meshy-rigging` |
| Apply an animation from the library | `/v1/animations` | 3 | `meshy-animate` |
| Multi-color 3D print output (3MF) | `/v1/print/multi-color` | 10 | `meshy-3d-print` |
| 2D image via nano-banana routed through Meshy | `/v1/text-to-image` or `/v1/image-to-image` | 3 (nano-banana) / 9 (pro) | `meshy-text-to-image`, `meshy-image-to-image` |

Full pricing and credit breakdown: `reference/credits.md`.

## Core prompting principles

Meshy docs are sparse on prompting guidance. What they say explicitly:

- **Text-to-3D prompt limit:** 600 characters
- **Description format:** "a monster mask", "a futuristic robot warrior" — noun-phrase style, concrete objects. Works like Imagen/Nano Banana — narrative description beats keyword soup.
- **Texture prompt:** 600 characters. Describe materials, palette, surface finish.
- **Image texturing limitation:** *"may not work optimally if there are substantial geometry differences"* — keep the texture reference image close in form to the actual 3D model.
- **Multi-image-to-3D:** *"All images should depict the same object from different angles for best results"* — 1 to 4 images, same subject, varied angles.

## Workflow patterns

### Full text-to-3D with textured output
1. `POST /v2/text-to-3d` with `mode=preview`, `prompt`, `ai_model`, optional topology/polycount — returns preview `task_id`
2. Poll preview task until `SUCCEEDED`
3. `POST /v2/text-to-3d` with `mode=refine`, `preview_task_id=<id from step 1>`, optional `enable_pbr`, `texture_prompt` or `texture_image_url` — returns refine `task_id`
4. Poll refine task until `SUCCEEDED`
5. Download from `model_urls.glb` (or whichever format)

### Rig + animate a character
1. Generate or upload a textured humanoid GLB under 300k faces (use `remesh` first if larger)
2. `POST /v1/rigging` with `model_url` or `input_task_id`, `height_meters` (default 1.7)
3. Rigging result includes free walk + run animations AND a `rig_task_id`
4. `POST /v1/animations` with that `rig_task_id` and an `action_id` from `reference/animation-library.md`
5. Download `result.animation_glb_url`

### Image → 3D → multi-color print
1. `POST /v1/image-to-3d` (textured, preferably meshy-6)
2. Poll until `SUCCEEDED`, capture its `task_id`
3. `POST /v1/print/multi-color` with `input_task_id=<that id>`, optional `max_colors` (1–16, default 4), `max_depth` (3–6, default 4)
4. Download `model_urls['3mf']`
5. Open in slicer (Bambu Studio, OrcaSlicer, etc.)

## Topic files

Deeper per-workflow guidance:

- **`3d-generation.md`** — text-to-3D (preview + refine), image-to-3D, multi-image-to-3D
- **`post-processing.md`** — remesh, retexture, rigging, animation, multi-color print
- **`2d-generation.md`** — text-to-image and image-to-image (nano-banana-backed through Meshy)
- **`reference/endpoints.md`** — every endpoint URL + HTTP method + response schema
- **`reference/credits.md`** — full pricing table
- **`reference/rate-limits.md`** — per-tier rate limits + 429 handling
- **`reference/animation-library.md`** — all 580+ `action_id` values for the animate endpoint
- **`reference/handler-gaps.md`** — parameters the Meshy API supports that our current nebula nodes do NOT expose (actionable list for when to extend nodes)

## In the nebula_nodes context

- Meshy CLI node ids: `meshy-text-to-3d`, `meshy-image-to-3d`, `meshy-multi-image-to-3d`, `meshy-remesh`, `meshy-retexture`, `meshy-rigging`, `meshy-animate`, `meshy-3d-print`, `meshy-text-to-image`, `meshy-image-to-image`.
- Backend handlers in `backend/handlers/meshy.py`. All use the same `_poll_meshy_task` helper.
- When chaining Meshy tasks (e.g. rigging → animate), the `rig_task_id` must come from a rigging node's output `task_id` port.
- When a 3D node's output goes to the canvas, the GLB is downloaded locally and served via `/api/outputs/…` — frontend `MeshPreview` component renders via model-viewer.
- Meshy's `texture_image_url` / `image_style_url` params accept public URLs or base64 data URIs. Our backend converts local file paths to data URIs via `image_to_data_uri`.
- Known handler limitations are documented in `reference/handler-gaps.md`. Mention them to the user when they ask for something a Meshy feature supports but our node doesn't currently expose.
