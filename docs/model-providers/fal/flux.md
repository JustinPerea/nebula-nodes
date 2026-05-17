---
id: nebula-fal-flux
kind: project-model-integration
project: nebula_nodes
provider: fal
model: flux-family (v1.1-ultra, schnell, fast-sdxl, kontext, flux-2-pro)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL FLUX Family — Audit Note

Covers five FLUX-via-FAL wrapper nodes in Nebula.
All five route through `handle_fal_universal` (see `fal-universal.md` for
the shared infrastructure contract). Each wrapper handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/flux-pro/v1.1-ultra/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/flux/schnell/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/fast-sdxl/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/flux-pro/kontext/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/flux-2-pro/api` — fetched 2026-05-17

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode | executionPattern |
|---------|-------------|----------|------|-----------------|
| `flux-1-1-ultra` | FLUX 1.1 Ultra | `fal-ai/flux-pro/v1.1-ultra` | T2I + I2I | `async-poll` |
| `flux-schnell` | FLUX Schnell | `fal-ai/flux/schnell` | T2I | `sync` |
| `fast-sdxl` | Fast SDXL | `fal-ai/fast-sdxl` | T2I | `sync` |
| `flux-kontext` | FLUX Kontext | `fal-ai/flux-pro/kontext` | I2I edit | `async-poll` |
| `flux-2-pro` | FLUX 2 Pro | `fal-ai/flux-2-pro` | T2I | `async-poll` |

---

## Per-Model Parameter Tables

### flux-1-1-ultra (`fal-ai/flux-pro/v1.1-ultra`)

Dual-param node: uses `sharedParams` + `falParams` in the registry (both groups
are iterated by `main.py` when validating allowed param keys and merged into
`node.params` at dispatch time).

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_url` | string | optional | any URL | via `image` port (Image Guide) |
| `aspect_ratio` | enum | `"16:9"` | `21:9`–`9:21` (9 values) | sharedParam |
| `num_images` | integer | `1` | 1–4 | sharedParam |
| `safety_tolerance` | enum | `"2"` | `"1"`–`"6"` | falParam |
| `enhance_prompt` | boolean | `false` | — | falParam |
| `output_format` | enum | `"jpeg"` | `jpeg`, `png` | falParam |
| `image_prompt_strength` | float | `0.1` | 0.0–1.0 | falParam |
| `seed` | integer | optional | — | falParam |

**Note:** `raw` (boolean, optional) is documented by FAL but omitted from the
registry — low-value advanced param, acceptable to omit.

### flux-schnell (`fal-ai/flux/schnell`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_size` | enum | `"landscape_4_3"` | `square_hd`, `square`, `landscape_4_3`, `landscape_16_9`, `portrait_4_3`, `portrait_16_9` | param |
| `num_inference_steps` | integer | `4` | 1–4 | param |
| `guidance_scale` | float | `3.5` | 1.0–5.0 | param |
| `num_images` | integer | `1` | 1–4 | param |
| `output_format` | enum | `"jpeg"` | `jpeg`, `png`, `webp` | param |
| `acceleration` | enum | `"none"` | `none`, `regular`, `high` | param |
| `enable_safety_checker` | boolean | `true` | — | param |
| `seed` | integer | optional | 0–2147483647 | param |

**Bug fixed:** Frontend `nodeDefinitions.ts` had `aspect_ratio` param (wrong
key — FAL ignores it). Replaced with `image_size` to match API. Also fixed
default from `landscape_16_9` → `landscape_4_3` and `output_format` default
from `webp` → `jpeg` in backend JSON.

### fast-sdxl (`fal-ai/fast-sdxl`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_size` | enum | `"square_hd"` | standard 6 presets | param |
| `num_images` | integer | `1` | 1–4 | param |
| `num_inference_steps` | integer | `25` | 1–50 | param |
| `guidance_scale` | float | `7.5` | 1–20 | param |
| `negative_prompt` | string | `""` | — | param |
| `expand_prompt` | boolean | `false` | — | param |
| `loras` | textarea (JSON array) | `""` | `[{path, scale}]` | param; pre-parsed to list in handler |
| `embeddings` | textarea (JSON array) | `""` | `[{path, tokens}]` | param; pre-parsed to list in handler |
| `format` | enum | `"jpeg"` | `jpeg`, `png` | param |
| `enable_safety_checker` | boolean | `true` | — | param |
| `safety_checker_version` | enum | `"v1"` | `v1`, `v2` | param — **was missing** |
| `seed` | integer | optional | 0–4294967295 | param |

**Sync pattern resolved (Open Question 3 from fal-universal.md):** `fast-sdxl`
has `executionPattern: sync`. However, `_fast_sdxl_handler` is defined inside
`build_handler_registry`, which closes over `emit` — so `emit` is always passed
to `handle_fal_universal`. The FAL API for `fast-sdxl` uses a standard
queue (returns `request_id`), so the poll loop runs normally. If FAL ever
returns the result directly (no `request_id`), the handler short-circuits
correctly via `_parse_fal_output`. No fix needed for execution pattern.

**Bug fixed:** `safety_checker_version` param was missing from both registries.
Frontend TS was also stripped down (missing `expand_prompt`, `loras`,
`embeddings`, `format`, `enable_safety_checker`, `safety_checker_version`,
`seed`). All added.

### flux-kontext (`fal-ai/flux-pro/kontext`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_url` | string | required | any URL | via `image` port (required) |
| `aspect_ratio` | enum | no default | `21:9`–`9:21` (9 values) | param |
| `num_images` | integer | `1` | 1–4 | param — **was missing from frontend TS** |
| `guidance_scale` | float | `3.5` | 1–20 | param |
| `enhance_prompt` | boolean | optional | — | param |
| `output_format` | enum | `"jpeg"` | `jpeg`, `png` | param |
| `safety_tolerance` | enum | `"2"` | `"1"`–`"6"` | param (max is 6, confirmed) |
| `seed` | integer | optional | — | param |

**Bug fixed:** `num_images` was missing from the frontend `nodeDefinitions.ts`.
Added with default 1, min 1, max 4.

**Note:** FAL docs description says "1 being the most strict and 5 being the
most permissive" for `safety_tolerance`, but the actual enum schema lists
values `1`–`6`. The registry correctly includes all 6 values.

### flux-2-pro (`fal-ai/flux-2-pro`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_size` | enum | `"landscape_4_3"` | standard 6 presets | param |
| `output_format` | enum | `"jpeg"` | `jpeg`, `png` | param |
| `safety_tolerance` | enum | `"2"` | `"1"`–`"5"` | param (max is 5, differs from other FLUX) |
| `enable_safety_checker` | boolean | `true` | — | param |
| `seed` | integer | optional | — | param |

**Bug fixed (HIGH):** `num_images` param was present in both backend JSON and
frontend TS registries but is NOT documented in the FAL API for `flux-2-pro`.
Sending `num_images > 1` would cause an API validation error. Removed from
backend JSON registry (frontend TS did not have it — already clean).

---

## Bugs Fixed in This Audit

| # | Node | Severity | Description | Fix |
|---|------|----------|-------------|-----|
| 1 | `flux-schnell` | High | Frontend TS had `aspect_ratio` param — wrong key, API uses `image_size`. Param was silently ignored by FAL; users got default size regardless of selection | Replaced `aspect_ratio` with `image_size` (6 preset options) in frontend TS |
| 2 | `flux-schnell` | Medium | Backend JSON `image_size` default was `landscape_16_9`; API default is `landscape_4_3` | Fixed default to `landscape_4_3` in backend JSON |
| 3 | `flux-schnell` | Medium | Backend JSON `output_format` default was `webp`; API default is `jpeg` | Fixed default to `jpeg`; reordered options JPEG first |
| 4 | `flux-schnell` | Medium | Frontend TS was stripped — missing `num_inference_steps`, `guidance_scale`, `output_format`, `acceleration`, `enable_safety_checker` | Added all missing params to frontend TS |
| 5 | `fast-sdxl` | Medium | `safety_checker_version` param missing from both registries (documented API param: `v1`/`v2`) | Added to both backend JSON and frontend TS |
| 6 | `fast-sdxl` | Medium | Frontend TS was stripped — missing `expand_prompt`, `loras`, `embeddings`, `format`, `enable_safety_checker`, `seed` | Added all missing params |
| 7 | `flux-2-pro` | High | `num_images` param present in backend JSON registry but not documented in FAL API. Sending `num_images > 1` causes API error | Removed from backend JSON |
| 8 | `flux-kontext` | Medium | `num_images` param missing from frontend TS (present in backend JSON) | Added to frontend TS (default 1, min 1, max 4) |

Total: 8 bugs across 4 nodes. `flux-1-1-ultra` was clean.

---

## Open Questions

1. **`flux-schnell` `guidance_scale`** — FLUX Schnell is a distilled model
   that typically ignores CFG scale. The FAL API documents the param (default
   3.5) but it may have no effect. Kept in registry since FAL accepts it and
   removing it could surprise users who set it.

2. **`flux-2-pro` `num_images` undocumented** — Confirmed not in FAL schema.
   If Black Forest Labs adds multi-image support in a future API revision, the
   param should be re-added at that time. Tracking note left here.

3. **`fast-sdxl` sync executionPattern** — Resolved. See "Sync pattern
   resolved" note in the `fast-sdxl` section above. No fix needed.
