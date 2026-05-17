---
id: nebula-fal-seedance
kind: project-model-integration
project: nebula_nodes
provider: fal
model: seedance v1.5 pro + seedance 2.0 (t2v, i2v, r2v, fast-t2v, fast-i2v)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Seedance Wrappers — Audit Note

Covers all six Seedance-via-FAL wrapper nodes in Nebula:
`seedance-v1-5`, `seedance-2-t2v`, `seedance-2-i2v`, `seedance-2-r2v`,
`seedance-2-fast-t2v`, and `seedance-2-fast-i2v`.

All six route through `handle_fal_universal` (see `fal-universal.md` for the
shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/bytedance/seedance-2.0/text-to-video` — fetched 2026-05-17
- `https://fal.ai/models/bytedance/seedance-2.0/image-to-video` — fetched 2026-05-17
- `https://fal.ai/models/bytedance/seedance-2.0/reference-to-video` — fetched 2026-05-17
- `https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video` — fetched 2026-05-17
- `https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video` — fetched 2026-05-17

---

## Endpoint Prefix Convention

`seedance-v1-5` uses the `fal-ai/bytedance/...` namespace — this is a
FAL-native model hosted under the FAL organization prefix. The Seedance 2.0
family uses the `bytedance/seedance-2.0/...` namespace (no `fal-ai/` prefix)
because they are served directly from Bytedance's endpoint routing through
`queue.fal.run`. Both namespaces are intentional and correct; they reflect
different hosting arrangements for the two model generations.

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode |
|---------|-------------|----------|------|
| `seedance-v1-5` | Seedance V1.5 Pro (I2V) | `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | I2V |
| `seedance-2-t2v` | Seedance 2.0 Text-to-Video | `bytedance/seedance-2.0/text-to-video` | T2V |
| `seedance-2-i2v` | Seedance 2.0 I2V | `bytedance/seedance-2.0/image-to-video` | I2V |
| `seedance-2-r2v` | Seedance 2.0 R2V | `bytedance/seedance-2.0/reference-to-video` | R2V (multi-image) |
| `seedance-2-fast-t2v` | Seedance 2.0 Fast T2V | `bytedance/seedance-2.0/fast/text-to-video` | T2V (fast) |
| `seedance-2-fast-i2v` | Seedance 2.0 Fast I2V | `bytedance/seedance-2.0/fast/image-to-video` | I2V (fast) |

---

## Per-Model Parameter Tables

### seedance-v1-5 (`fal-ai/bytedance/seedance/v1.5/pro/image-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `duration` | enum (string) | `"5"` | `"4"`.."12"` (integer strings, no "s" suffix) |
| `aspect_ratio` | enum | `"16:9"` | `16:9`, `9:16`, `1:1`, `21:9`, `4:3`, `3:4`, `auto` |
| `resolution` | enum | `"720p"` | `480p`, `720p`, `1080p` |
| `generate_audio` | boolean | `true` | — |
| `camera_fixed` | boolean | `false` | — |
| `seed` | integer | — | optional |

**Ports:** `prompt` (required), `image` (required), `end_image` (optional) → `video`

### seedance-2-t2v (`bytedance/seedance-2.0/text-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `aspect_ratio` | enum | `"auto"` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `duration` | enum (string) | `"auto"` | `auto`, `"4"`.."15"` |
| `resolution` | enum | `"720p"` | `480p`, `720p`, `1080p` |
| `generate_audio` | boolean | `true` | — |
| `seed` | integer | — | optional |

**Ports:** `prompt` (required) → `video`

### seedance-2-i2v (`bytedance/seedance-2.0/image-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `aspect_ratio` | enum | `"auto"` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `duration` | enum (string) | `"auto"` | `auto`, `"4"`.."15"` |
| `resolution` | enum | `"720p"` | `480p`, `720p`, `1080p` |
| `generate_audio` | boolean | `true` | — |
| `seed` | integer | — | optional |

**Ports:** `image` (required), `prompt` (required), `end_image` (optional) → `video`

### seedance-2-r2v (`bytedance/seedance-2.0/reference-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `aspect_ratio` | enum | `"auto"` | `auto`, `21:9`, `16:9`, `9:16`, `4:3`, `1:1`, `3:4` |
| `duration` | enum (string) | `"auto"` | `auto`, `"4"`, `"6"`, `"8"`, `"10"`, `"15"` |
| `resolution` | enum | `"720p"` | `480p`, `720p`, `1080p` |
| `generate_audio` | boolean | `true` | — |
| `seed` | integer | — | optional |

**Ports:** `prompt` (required), `images` (multi-port, up to 9 images) → `video`

The `images` multi-port maps to `image_urls` array in the FAL request body via
the universal handler's multi-image path (commit `231c3a5`). Reference assets
in the prompt as `@Image1`, `@Image2`, etc.

### seedance-2-fast-t2v (`bytedance/seedance-2.0/fast/text-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `aspect_ratio` | enum | `"auto"` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `duration` | enum (string) | `"auto"` | `auto`, `"4"`.."15"` |
| `resolution` | enum | `"720p"` | `480p`, `720p` (no 1080p for fast tier) |
| `generate_audio` | boolean | `true` | — |
| `seed` | integer | — | optional |

**Ports:** `prompt` (required) → `video`

### seedance-2-fast-i2v (`bytedance/seedance-2.0/fast/image-to-video`)

| Param | Type | Default | Valid values |
|-------|------|---------|-------------|
| `aspect_ratio` | enum | `"auto"` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `duration` | enum (string) | `"auto"` | `auto`, `"4"`.."15"` |
| `resolution` | enum | `"720p"` | `480p`, `720p` (no 1080p for fast tier) |
| `generate_audio` | boolean | `true` | — |
| `seed` | integer | — | optional |

**Ports:** `image` (required), `prompt` (required), `end_image` (optional) → `video`

---

## Bugs Found and Fixed (2026-05-17)

| # | Severity | Node | Field | Was | Now |
|---|----------|------|-------|-----|-----|
| 1 | Critical | `seedance-v1-5` | frontend `apiEndpoint` | `fal-ai/seedance/v1.5/text-to-video` | `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` |
| 2 | High | `seedance-v1-5` | both: `duration` values | `"4s"`, `"8s"` (string+suffix) | `"4"`, `"5"` … `"12"` (integer strings) |
| 3 | High | `seedance-v1-5` | both: `duration` default | `"8s"` | `"5"` (API default) |
| 4 | High | `seedance-v1-5` | frontend: `image` port | `required: false` | `required: true` (API requires `image_url`) |
| 5 | Medium | `seedance-v1-5` | frontend: missing `end_image` port | absent | added (`end_image_url`) |
| 6 | Medium | `seedance-v1-5` | both: missing `generate_audio` param | absent | added (default `true`) |
| 7 | Medium | `seedance-v1-5` | both: missing `camera_fixed` param | absent | added (default `false`) |
| 8 | Medium | `seedance-v1-5` | both: missing `seed` param (backend) | absent | added |
| 9 | Medium | `seedance-v1-5` | both: `resolution` missing 1080p | `480p`, `720p` | added `1080p` |
| 10 | Medium | `seedance-v1-5` | frontend `displayName` | `Seedance V1.5` | `Seedance V1.5 Pro (I2V)` |
| 11 | Medium | `seedance-2-t2v` | both: `aspect_ratio` default | `"16:9"` | `"auto"` (API default) |
| 12 | Medium | `seedance-2-t2v` | both: `resolution` missing 1080p | `480p`, `720p` | added `1080p` |
| 13 | Medium | `seedance-2-i2v` | both: `resolution` missing 1080p | `480p`, `720p` | added `1080p` |
| 14 | Medium | `seedance-2-r2v` | both: missing `21:9` aspect ratio | absent | added |
| 15 | Medium | `seedance-2-r2v` | both: missing `resolution` param | absent | added (480p, 720p, 1080p) |
| 16 | Low | `seedance-2-fast-t2v` | both: `aspect_ratio` default | `"16:9"` | `"auto"` (API default) |
| 17 | Low | `seedance-2-fast-t2v` | both: `duration` default | `"10"` | `"auto"` (API default) |
| 18 | Low | `seedance-2-fast-i2v` | both: `duration` default | `"10"` | `"auto"` (API default) |

**Total: 18 bugs across 6 nodes.**

### Items confirmed correct (no change needed)

- All 6 `apiProvider: fal` — correct
- All 6 `executionPattern: async-poll` — correct
- All 6 `envKeyName: FAL_KEY` — correct
- All 6 output port `video` with `dataType: Video` — correct
- `seedance-2-r2v` `images` multi-port (`multiple: true`) → maps to `image_urls` via fal_universal — correct (fixed in commit `231c3a5`)
- `seedance-2-*` duration values are integer strings (`"4"`.."15"`, no "s" suffix) — correct
- `seedance-2-fast-*` resolution limited to 480p/720p (no 1080p) — confirmed from FAL docs
- Endpoint prefix asymmetry (`fal-ai/` for v1.5, none for 2.0) — intentional, reflects different hosting namespaces
