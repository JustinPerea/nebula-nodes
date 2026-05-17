---
id: nebula-fal-kling
kind: project-model-integration
project: nebula_nodes
provider: fal
model: kling-video (v2.1, v3, o3)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Kling Wrappers — Audit Note

Covers the three Kling-via-FAL wrapper nodes in Nebula:
`kling-v2-1`, `kling-v3`, `kling-o3`.

All three route through `handle_fal_universal` (see `fal-universal.md` for
the shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/kling-video/v2.1/pro/image-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video/api` — fetched 2026-05-17

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode |
|---------|-------------|----------|------|
| `kling-v2-1` | Kling v2.1 | `fal-ai/kling-video/v2.1/pro/image-to-video` | I2V |
| `kling-v3` | Kling V3 | `fal-ai/kling-video/v3/standard/text-to-video` | T2V (+ optional I2V) |
| `kling-o3` | Kling Omni 3 | `fal-ai/kling-video/o3/standard/image-to-video` | I2V |

---

## Per-Model Parameter Tables

### kling-v2-1 (`fal-ai/kling-video/v2.1/pro/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | required | any URL | via `image` port |
| `prompt` | string | optional | — | via `prompt` port |
| `tail_image_url` | string | optional | any URL | via `tail_image` port (End Frame) |
| `duration` | enum | `"5"` | `"5"`, `"10"` | param |
| `negative_prompt` | string | `"blur, distort, and low quality"` | — | param |
| `cfg_scale` | float | `0.5` | 0.0–1.0 | param |

**Note:** The v2.1 Pro endpoint does **not** accept `aspect_ratio` or
`resolution`. Both were previously present in the node definition and
have been removed.

### kling-v3 (`fal-ai/kling-video/v3/standard/text-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | — | required (or `multi_prompt`) | via `prompt` port |
| `image_url` | string | optional | any URL | via `image` port (Start Image) |
| `end_image_url` | string | optional | any URL | via `end_image` port |
| `duration` | enum | `"5"` | `"3"`–`"15"` (all integers) | param (4 representative values shown) |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"` | param |
| `negative_prompt` | string | `"blur, distort, and low quality"` | — | param (default was missing) |
| `shot_type` | enum | `"customize"` | `"customize"`, `"intelligent"` | param |
| `multi_prompt` | array | — | up to 6 shots | textarea param, pre-parsed to array in handler |
| `generate_audio` | boolean | `true` | — | param |
| `cfg_scale` | float | `0.5` | 0.0–1.0 | param |

**Note:** The `resolution` param (not a real API field) has been removed.
The `negative_prompt` default was previously absent (placeholder only) — now
set to the API's documented default.

### kling-o3 (`fal-ai/kling-video/o3/standard/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | required | any URL | via `image` port |
| `prompt` | string | optional | — | via `prompt` port (was wrongly required) |
| `end_image_url` | string | optional | any URL | via `end_image` port (added) |
| `duration` | enum | `"5"` | `"3"`–`"15"` | param (4 representative values) |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"` | param |
| `generate_audio` | boolean | `false` | — | param (default corrected from `true`) |
| `negative_prompt` | string | `"blur, distort, and low quality"` | — | param (added) |
| `cfg_scale` | float | `0.5` | 0.0–1.0 | param (added) |
| `shot_type` | enum | `"customize"` | `"customize"`, `"intelligent"` | param (added) |

---

## Findings and Fixes

### kling-v2-1

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Medium | `aspect_ratio` param present but not accepted by v2.1 Pro endpoint | Removed from both JSON and TS definitions |
| 2 | Low | Missing `tail_image` input port — API supports `tail_image_url` for end-frame interpolation; universal handler already maps this port | Added `tail_image` port (End Frame) |

### kling-v3

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 3 | High | `resolution` param present but not accepted by v3/standard endpoint — would be forwarded as an unknown key | Removed from both definitions |
| 4 | Low | `negative_prompt` had no default (placeholder only) but API default is `"blur, distort, and low quality"` — empty param would be omitted by universal handler, changing API behavior silently | Added canonical default |

### kling-o3

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 5 | High | `ref_video1/2/3` input ports (Video type) present but `o3/standard/image-to-video` has no reference-video parameter — these were silently ignored by universal handler | Removed all three ports |
| 6 | High | `resolution` param present but not accepted by this endpoint | Removed |
| 7 | Medium | `prompt` port marked `required: true` but API docs state it is optional (either `prompt` or `multi_prompt` must be provided, and `image_url` alone is sufficient) | Changed to `required: false` |
| 8 | Medium | `generate_audio` default was `true`; o3/standard API default is `false` — extra cost incurred for every generation without opt-in | Corrected to `false` |
| 9 | Medium | `duration` options only `"5"` and `"10"` but API accepts `"3"`–`"15"` | Expanded to 4 representative values: `"3"`, `"5"`, `"10"`, `"15"` |
| 10 | Low | Missing `end_image` port — API supports `end_image_url`; universal handler already maps `end_image` port | Added `end_image` port (End Frame) |
| 11 | Low | Missing `negative_prompt`, `cfg_scale`, `shot_type` params present in the API | Added all three |
| 12 | Low | `_kling_o3_handler` did not pre-parse `multi_prompt` JSON strings, unlike `_kling_v3_handler` | Added same JSON parse/drop logic |

---

## Output Routing

All three nodes output `video` type. FAL returns `{"video": {"url": "..."}}` for
all Kling endpoints. `_parse_fal_output` handles this via the video branch
(priority 5 in detection order). No output routing changes needed.

---

## Tests Added

File: `backend/tests/test_fal_handler.py`

| Test | Covers |
|------|--------|
| `test_kling_v2_1_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_kling_v2_1_image_maps_to_image_url` | `image` port → `image_url`; `aspect_ratio` absent |
| `test_kling_v2_1_tail_image_maps_to_tail_image_url` | `tail_image` port → `tail_image_url` |
| `test_kling_v3_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_kling_v3_aspect_ratio_and_duration_forwarded` | Param forwarding; `resolution` absent |
| `test_kling_v3_start_image_maps_to_image_url` | `image` → `image_url`, `end_image` → `end_image_url` |
| `test_kling_o3_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_kling_o3_image_maps_to_image_url` | `image` port → `image_url`; `resolution`/`ref_video1` absent |
| `test_kling_o3_end_image_maps_to_end_image_url` | `end_image` port → `end_image_url` |

---

## Open Questions

1. **o3/standard `generate_audio` default** — the FAL API page for
   `o3/standard/image-to-video` did not state an explicit default on 2026-05-17.
   The skill reference file (`fal-ai__kling-video__o3__standard__image-to-video.md`)
   documents it as `false`. Set to `false` as the conservative default. Verify
   against a live generation if behavior is unexpected.

2. **kling-v3 `image` port as start frame** — the v3/standard endpoint is
   primarily T2V. Whether `image_url` is accepted as a start-frame hint on the
   standard tier (vs. only on `v3/pro/image-to-video`) is not confirmed by the
   API reference page. The port is kept as optional since the API does not
   explicitly reject it and the Pro skill notes confirm the pattern works there.

3. **kling-o3 `multi_prompt` exposure** — the API accepts `multi_prompt` on
   o3/standard but no textarea param was added to the node definition (only the
   handler pre-parse was added). If multi-shot storyboarding is a desired user
   feature for o3, add the same `multi_prompt` textarea param as kling-v3.

4. **Duration enum completeness** — all three nodes expose only 3–4 duration
   options out of the full 3–15 range. This is intentional (avoid a 13-item
   dropdown) but could be changed to a numeric slider if user feedback warrants it.
