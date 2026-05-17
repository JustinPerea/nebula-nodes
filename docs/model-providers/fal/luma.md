---
id: nebula-fal-luma
kind: project-model-integration
project: nebula_nodes
provider: fal
model: luma-ray2 (t2v, i2v, flash-modify)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Luma Ray 2 Wrappers — Audit Note

Covers the three Luma-Ray-2-via-FAL wrapper nodes in Nebula:
`luma-ray2-t2v`, `luma-ray2-i2v`, and `luma-ray2-flash-modify`.

All three route through `handle_fal_universal` (see `fal-universal.md` for
the shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/llms.txt` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/image-to-video` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/image-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/modify` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/modify/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/modify/llms.txt` — fetched 2026-05-17

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode |
|---------|-------------|----------|------|
| `luma-ray2-t2v` | Luma Ray 2 | `fal-ai/luma-dream-machine/ray-2` | T2V |
| `luma-ray2-i2v` | Luma Ray 2 I2V | `fal-ai/luma-dream-machine/ray-2/image-to-video` | I2V |
| `luma-ray2-flash-modify` | Luma Ray 2 Flash Modify | `fal-ai/luma-dream-machine/ray-2-flash/modify` | Video modify |

All three endpoints use the `fal-ai/luma-dream-machine/` namespace (standard
`fal-ai/` prefix, unlike the Wan 2.6 endpoints which use `wan/`).

---

## Per-Model Parameter Tables

### luma-ray2-t2v (`fal-ai/luma-dream-machine/ray-2`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`, `"21:9"`, `"9:21"` | param (corrected: added `21:9`, `9:21`; removed `1:1`) |
| `resolution` | enum | `"540p"` | `"540p"`, `"720p"`, `"1080p"` | param (default corrected: was `"720p"`) |
| `duration` | enum | `"5s"` | `"5s"`, `"9s"` | param (correct) |
| `loop` | boolean | `false` | — | param (correct) |

### luma-ray2-i2v (`fal-ai/luma-dream-machine/ray-2/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | optional | URL / Base64 | via `image` port |
| `end_image_url` | string | optional | URL / Base64 | via `end_image` port |
| `prompt` | string | optional | — | via `prompt` port |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`, `"21:9"`, `"9:21"` | param (corrected: added `9:21`) |
| `resolution` | enum | `"540p"` | `"540p"`, `"720p"`, `"1080p"` | param (correct) |
| `duration` | enum | `"5s"` | `"5s"`, `"9s"` | param (correct) |
| `loop` | boolean | `false` | — | param (correct) |

**Note:** `image_url` is listed as optional by the API (the model can also
generate from prompt alone, like T2V). The `image` input port is marked
`required: true` in the node definition which is slightly stricter than the API
but matches the intended UX for an I2V node — do not relax this.

### luma-ray2-flash-modify (`fal-ai/luma-dream-machine/ray-2-flash/modify`)

The flash-modify API is a **video restyling / retexturing** model. Its input
schema is completely different from the T2V/I2V endpoints — it does not accept
`aspect_ratio`, `resolution`, or `duration`.

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `video_url` | string | **required** | URL / Base64 | via `video` port |
| `image_url` | string | optional | URL / Base64 | via `image` port (added) |
| `prompt` | string | optional | — | via `prompt` port (was marked required; corrected) |
| `mode` | enum | `"flex_1"` | `adhere_1`–`adhere_3`, `flex_1`–`flex_3`, `reimagine_1`–`reimagine_3` | param (added; was entirely missing) |

`mode` controls the amount of modification applied:
- `adhere_*` — minimal change, preserves original content closely
- `flex_*` — moderate transformation (default: `flex_1`)
- `reimagine_*` — maximum transformation

---

## Findings and Fixes

### luma-ray2-t2v

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | `aspect_ratio` enum missing `21:9` and `9:21` — API supports 6 options; node had 5 (with spurious `1:1` replacing both ultrawides) | Replaced `1:1` with `21:9` and `9:21` |
| 2 | Medium | `resolution` default was `"720p"` — API default is `"540p"` (the lowest/cheapest tier); defaulting to `720p` silently applies a 2x cost multiplier on every generation | Corrected default to `"540p"` |

### luma-ray2-i2v

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 3 | Low | `aspect_ratio` enum missing `9:21` — had `21:9` but not its portrait counterpart | Added `9:21` |

### luma-ray2-flash-modify

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 4 | Critical | `aspect_ratio`, `resolution`, `duration` params present — none of these exist in the flash-modify API; they would be forwarded to the API and cause validation errors | Removed all three params |
| 5 | Critical | `mode` param entirely absent — this is the primary API control knob (9 enum values controlling modification intensity from `adhere_1` to `reimagine_3`) | Added `mode` enum param with all 9 values, default `"flex_1"` |
| 6 | Medium | `prompt` input port marked `required: true` — API defines prompt as optional (the model can restyle without a text instruction) | Changed to `required: false` |
| 7 | Low | No `image` input port — API accepts an optional `image_url` for a reference style image | Added `image` port (Image, optional) |

---

## Port Mapping Summary

| Port ID | FAL field | Handler | Node |
|---------|-----------|---------|------|
| `prompt` | `prompt` | universal | t2v, i2v, flash-modify |
| `image` | `image_url` | universal | i2v (start frame), flash-modify (reference style) |
| `end_image` | `end_image_url` | universal | i2v (end frame) |
| `video` | `video_url` | universal | flash-modify (input video) |

All port mappings are handled by `handle_fal_universal` — no custom logic
was needed in the Luma wrapper handlers themselves. The `video → video_url`
mapping was already added in commit `038f902` (FAL universal polish).

---

## Output Routing

All three nodes output `video` type. FAL returns `{"video": {"url": "..."}}` for
all three endpoints. `_parse_fal_output` handles this via the video branch.
No output routing changes needed.

---

## Tests Added

File: `backend/tests/test_fal_handler.py`

| Test | Covers |
|------|--------|
| `test_luma_ray2_t2v_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_luma_ray2_t2v_key_params_forwarded` | aspect_ratio, duration, resolution, loop forwarded |
| `test_luma_ray2_t2v_ultrawide_aspect_ratios_forwarded` | 21:9 / 9:21 forwarded correctly |
| `test_luma_ray2_i2v_endpoint_injected` | Correct endpoint slug |
| `test_luma_ray2_i2v_image_maps_to_image_url` | image→image_url; end_image→end_image_url; 9:21 ratio |
| `test_luma_ray2_flash_modify_endpoint_injected` | Correct endpoint slug |
| `test_luma_ray2_flash_modify_video_maps_to_video_url` | video→video_url; mode forwarded; aspect_ratio/resolution/duration absent |
| `test_luma_ray2_flash_modify_reference_image_maps_to_image_url` | image→image_url for reference style |
| `test_luma_ray2_flash_modify_without_prompt_still_works` | prompt optional — no prompt connected works |

File: `backend/tests/test_node_contracts.py` — `test_researched_provider_corrections_are_pinned`

| Pin | Assertion |
|-----|-----------|
| `luma-ray2-t2v.aspect_ratio` | all 6 options; `1:1` absent |
| `luma-ray2-t2v.resolution` | default `"540p"` |
| `luma-ray2-t2v.duration` | `{"5s", "9s"}` |
| `luma-ray2-t2v.apiEndpoint` | `"fal-ai/luma-dream-machine/ray-2"` |
| `luma-ray2-i2v.aspect_ratio` | all 6 options including `9:21` |
| `luma-ray2-i2v.apiEndpoint` | `"fal-ai/luma-dream-machine/ray-2/image-to-video"` |
| `luma-ray2-i2v` input ports | `image`, `end_image` present |
| `luma-ray2-flash-modify.mode` | all 9 ModeEnum values; default `"flex_1"` |
| `luma-ray2-flash-modify` params | no `aspect_ratio`, `resolution`, `duration` |
| `luma-ray2-flash-modify` input ports | `video`, `image` present |
| `luma-ray2-flash-modify.prompt` | `required: false` |
| `luma-ray2-flash-modify.apiEndpoint` | `"fal-ai/luma-dream-machine/ray-2-flash/modify"` |

---

## Open Questions

1. **luma-ray2-i2v `image` port required vs optional** — The API marks
   `image_url` as optional (T2V-style generation is valid without a start
   frame). The node keeps `required: true` to enforce the I2V UX. If users
   need a "no start frame" path, the correct fix is a separate T2V node, not
   relaxing this port.

2. **luma-ray2-flash-modify `prompt` empty behavior** — When no prompt is
   provided, the model will restyle based on `mode` alone (and optionally
   `image_url`). This is valid per the API. The node correctly marks prompt
   as optional after this fix.

3. **Ray 2 vs Ray 2 Flash** — The `ray-2-flash/modify` endpoint is a
   flash-tier variant, not just a rename. It has a completely different input
   schema (no aspect/resolution/duration). If a standard Ray 2 modify
   endpoint exists in the future (`ray-2/modify` — seen referenced in the
   T2V API docs sidebar), it would be a separate node.

4. **`loop` param on I2V** — The API supports `loop` for I2V (same as T2V).
   The node correctly exposes it. Behavior with `end_image_url` + `loop` is
   not documented; likely creates a seamless loop between start and end frames.
