---
id: nebula-fal-misc
kind: project-model-integration
project: nebula_nodes
provider: fal
model: sora-2, moonvalley, pixverse-v4-5, remove-background, seedvr2-upscale
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Misc Wrappers — Audit Note

Covers five miscellaneous FAL wrapper nodes. All route through `handle_fal_universal`
(see `fal-universal.md`).

> **Live-smoke correction (2026-05-17):** The initial audit set sora-2 and pixverse-v4-5
> duration options as STRINGS. Direct API verification shows FAL expects INTEGERS for
> these two: sora-2 takes `4`/`8`/`12`/`16`/`20`, pixverse takes `5`/`8`. Both registries
> reverted to integer option values. The Inspector dropdown will send the integer type
> correctly. The Nebula CLI's `--param key=value` flag passes strings unconditionally,
> so live CLI smoke for integer enum params is a known limitation — verify via the UI
> or direct curl instead.

## Sources

- `https://fal.ai/models/fal-ai/sora-2/text-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/pixverse/v4.5/text-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/imageutils/rembg/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/seedvr/upscale/image/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/moonvalley/image-to-video` — returned 404 on 2026-05-17; endpoint ID and params retained from prior implementation; mark for re-verification

---

## Node Matrix

| ID | Endpoint | Input Ports | Output Port | Handler |
|----|----------|-------------|-------------|---------|
| `sora-2` | `fal-ai/sora-2/text-to-video` (std) or `/pro` | `prompt` | `video` | `_sora2_handler` |
| `moonvalley` | `fal-ai/moonvalley/image-to-video` | `image`, `prompt` | `video` | `_moonvalley_handler` |
| `pixverse-v4-5` | `fal-ai/pixverse/v4.5/text-to-video` | `prompt`, `image` | `video` | `_pixverse_handler` |
| `remove-background` | `fal-ai/imageutils/rembg` | `image` | `image` | `_remove_bg_handler` |
| `seedvr2-upscale` | `fal-ai/seedvr/upscale/image` | `image` | `image` | `_seedvr2_upscale_handler` |

---

## sora-2

**Endpoint routing:** `_sora2_handler` pops the `model` param and selects the Pro endpoint
(`fal-ai/sora-2/text-to-video/pro`) when `model == "pro"`, otherwise standard. The `model`
value is never forwarded to FAL (intentional — FAL's inner model enum differs).

**FAL API `duration` type:** string. Node definition must use string values (`"4"`, `"8"`, etc.)
**FAL API `resolution` default:** `"720p"` (not `"1080p"`).

### Bugs Fixed

| # | Severity | Field | Before | After |
|---|----------|-------|--------|-------|
| 1 | Medium | `duration` default | `4` (int) | `"4"` (string) |
| 2 | Medium | `duration` options | `[4, 8, 12, 16, 20]` (ints) | `["4","8","12","16","20"]` (strings) |
| 3 | Low | `resolution` default | `"1080p"` | `"720p"` (matches FAL API default) |

---

## moonvalley

FAL model page returned HTTP 404 on 2026-05-17. Endpoint
`fal-ai/moonvalley/image-to-video` is retained from the existing implementation.
Port shape (`image` + `prompt` → `video`) and params (`duration`, `resolution`) appear
consistent with the image-to-video pattern used across other FAL I2V nodes.

**Action required:** Re-verify endpoint ID and param schema when FAL page becomes
accessible. Mark endpoint as unverified.

No bugs fixed in this node; no changes made.

---

## pixverse-v4-5

**FAL API `duration` type:** string (`"5"`, `"8"`).
**`quality` param:** Not present in FAL API spec. FAL exposes `style` instead
(`anime`, `3d_animation`, `clay`, `comic`, `cyberpunk`).
**`aspect_ratio`:** Present in FAL API but missing from node definition.

### Bugs Fixed

| # | Severity | Field | Before | After |
|---|----------|-------|--------|-------|
| 4 | High | `quality` param | Present (`Turbo/Normal/Fast`) — not a FAL field | Removed |
| 5 | Medium | `duration` default | `5` (int) | `"5"` (string) |
| 6 | Medium | `duration` options | `[5, 8]` (ints) | `["5","8"]` (strings) |
| 7 | Low | `aspect_ratio` param | Missing | Added (`16:9`, `4:3`, `1:1`, `3:4`, `9:16`) |
| 8 | Low | `style` param | Missing | Added (`anime`, `3d_animation`, `clay`, `comic`, `cyberpunk`) |

---

## remove-background

Endpoint `fal-ai/imageutils/rembg` verified. Input `image` port maps to `image_url` via
`_to_fal_url` in `handle_fal_universal`. Output is `{"image": {"url": "..."}}` parsed by
the single-image-dict branch of `_parse_fal_output`.

**`crop_to_bbox`:** Optional boolean param in FAL API — was missing from node definition.

### Bugs Fixed

| # | Severity | Field | Before | After |
|---|----------|-------|--------|-------|
| 9 | Low | `crop_to_bbox` param | Missing | Added (boolean, default `false`) |

---

## seedvr2-upscale

Endpoint `fal-ai/seedvr/upscale/image` verified. Input `image` port maps to `image_url`.
Output is `{"image": {"url": "..."}}`.

All params verified: `upscale_mode`, `upscale_factor`, `target_resolution`, `noise_scale`,
`output_format`, `seed` — all match FAL API schema with correct types and defaults.

No bugs fixed. Node definition was accurate.

---

## Open Questions

1. **moonvalley 404** — FAL model page is inaccessible. Endpoint ID may have changed
   (e.g. to `fal-ai/moonvalley-marey/image-to-video` or similar). Re-verify before
   relying on this node in production.

2. **pixverse image port** — The node has an `image` input port, implying image-to-video
   support. The FAL text-to-video endpoint may not accept `image_url`. Confirm whether
   PixVerse v4.5 has a separate I2V endpoint that should be used when an image is wired.
