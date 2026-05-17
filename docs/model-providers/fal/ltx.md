---
id: nebula-fal-ltx
kind: project-model-integration
project: nebula_nodes
provider: fal
model: ltx-video (ltx-2, ltx-2.3)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL LTX Wrappers — Audit Note

Covers the two LTX-via-FAL wrapper nodes in Nebula:
`ltx-video-2` and `ltx-2-3`.

Both route through `handle_fal_universal` (see `fal-universal.md` for
the shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/ltx-2/image-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/ltx-2.3/audio-to-video/api` — fetched 2026-05-17

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode |
|---------|-------------|----------|------|
| `ltx-video-2` | LTX Video 2 | `fal-ai/ltx-2/image-to-video` | I2V |
| `ltx-2-3` | LTX 2.3 | `fal-ai/ltx-2.3/image-to-video` | I2V / T2V / A2V |

---

## Per-Model Parameter Tables

### ltx-video-2 (`fal-ai/ltx-2/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | required | any URL | via `image` port |
| `prompt` | string | required | — | via `prompt` port |
| `duration` | enum | `"6"` | `"6"`, `"8"`, `"10"` | param |
| `resolution` | enum | `"1080p"` | `"1080p"`, `"1440p"`, `"2160p"` | param |
| `fps` | enum | `"25"` | `"25"`, `"50"` | param (added) |
| `generate_audio` | boolean | `true` | — | param (added, default corrected) |

**Note:** Aspect ratio is fixed at 16:9 for this endpoint. The `fast` variant
(`fal-ai/ltx-2/image-to-video/fast`) adds duration options `"12"`–`"20"` but
only at 1080p + 25 FPS. Not exposed in this node.

### ltx-2-3 (`fal-ai/ltx-2.3/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | optional | any URL | via `image` port |
| `prompt` | string | required | — | via `prompt` port |
| `end_image_url` | string | optional | any URL | via `end_image` port (added) |
| `audio_url` | string | optional | any URL | via `audio` port → `audio_url` |
| `duration` | enum | `"6"` | `"6"`, `"8"`, `"10"` | param (type corrected: was integer) |
| `resolution` | enum | `"1080p"` | `"1080p"`, `"1440p"`, `"2160p"` | param |
| `aspect_ratio` | enum | `"auto"` | `"auto"`, `"16:9"`, `"9:16"` | param (default + options corrected) |
| `fps` | enum | `"25"` | `"24"`, `"25"`, `"48"`, `"50"` | param (options expanded) |
| `generate_audio` | boolean | `true` | — | param (default corrected) |

---

## Findings and Fixes

### ltx-video-2

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Medium | `fps` param absent — API accepts `"25"` or `"50"`; omitting means the API always uses its server default and users have no control | Added `fps` enum param with options `"25"`, `"50"`, default `"25"` |
| 2 | Medium | `generate_audio` param absent — API default is `true`; without the param users cannot opt out of audio synthesis (extra cost) | Added `generate_audio` boolean param, default `true` to match API |

### ltx-2-3

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 3 | High | `duration` param type was `integer` with `min: 2, max: 20` — API only accepts discrete enum values `"6"`, `"8"`, `"10"` (string type); arbitrary integers like `7` or `15` would be rejected by the API | Changed to `enum` with string values `"6"`, `"8"`, `"10"`, default `"6"` |
| 4 | High | `aspect_ratio` default was `"16:9"` but API default is `"auto"`; option `"1:1"` was present but not accepted by the API; option `"auto"` was missing | Set default to `"auto"`, added `"auto"` option, removed `"1:1"` |
| 5 | Medium | `fps` options were integer values `25` and `50` — API expects string enum and also accepts `"24"` and `"48"`; missing options and wrong value types | Changed values to strings, added `"24"` and `"48"` options |
| 6 | Medium | `generate_audio` default was `false` but API default is `true`; would silently suppress audio on every generation | Corrected default to `true` |
| 7 | Low | `end_image` input port missing — API supports `end_image_url` for start-to-end frame interpolation; universal handler already maps `end_image` port to `end_image_url` | Added `end_image` port (optional, Image type) |
| 8 | Low | `_ltx_23_handler` used bare `node, inputs, api_keys` parameters without type annotations, unlike all other FAL wrapper handlers | Added type annotations to match handler convention |

---

## Port Mapping Summary

All port-to-API-field mappings are handled by `handle_fal_universal`. No
handler-specific mapping logic is needed for either LTX node.

| Port ID | FAL field | Handler |
|---------|-----------|---------|
| `image` | `image_url` | universal |
| `end_image` | `end_image_url` | universal |
| `audio` | `audio_url` | universal |
| `prompt` | `prompt` | universal |

---

## Output Routing

Both nodes output `video` type. FAL returns `{"video": {"url": "..."}}` for
all LTX endpoints. `_parse_fal_output` handles this via the video branch.
No output routing changes needed.

---

## Tests Added

File: `backend/tests/test_fal_handler.py`

| Test | Covers |
|------|--------|
| `test_ltx_video2_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_ltx_video2_image_maps_to_image_url` | `image` → `image_url`; fps + generate_audio forwarded |
| `test_ltx_video2_generate_audio_false_omitted_when_empty` | Missing param → not sent to API |
| `test_ltx_23_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_ltx_23_key_params_forwarded` | duration, aspect_ratio, fps, generate_audio all forwarded |
| `test_ltx_23_end_image_maps_to_end_image_url` | `end_image` port → `end_image_url` |
| `test_ltx_23_audio_port_maps_to_audio_url` | `audio` port → `audio_url`; raw `"audio"` key absent |

File: `backend/tests/test_node_contracts.py` — `test_researched_provider_corrections_are_pinned`

| Pin | Assertion |
|-----|-----------|
| `ltx-video-2.fps` | options `{"25", "50"}`, default `"25"` |
| `ltx-video-2.generate_audio` | default `true` |
| `ltx-2-3.duration` | type `enum`, options `{"6", "8", "10"}` |
| `ltx-2-3.aspect_ratio` | `"auto"` present, `"1:1"` absent, default `"auto"` |
| `ltx-2-3.fps` | options `{"24", "25", "48", "50"}`, default `"25"` |
| `ltx-2-3.generate_audio` | default `true` |
| `ltx-2-3` input ports | `end_image` present, `audio` present |

---

## Open Questions

1. **ltx-2-3 `duration` fast-model range** — the `fast` variant
   (`fal-ai/ltx-2.3/image-to-video/fast`) extends duration to `"6"`–`"20"` with
   the constraint that durations above `"10"` require 25 FPS + 1080p. This node
   targets the standard endpoint; if the fast variant is added as a separate
   node, expose the full range with the constraint documented.

2. **ltx-2-3 `image_url` as optional** — the API marks `image_url` as optional,
   supporting pure text-to-video generation. The node currently exposes the
   `image` port as `required: false`, which is correct. Confirm in production that
   submitting without an image works end-to-end (no server-side validation surprises).

3. **ltx-2-3 audio-driven generation** — the separate `audio-to-video` endpoint
   (`fal-ai/ltx-2.3/audio-to-video`) accepts `audio_url` as the required input
   and uses a different schema (guidance_scale, aspect_ratio only). The current
   node routes to `image-to-video` which accepts `audio_url` as optional. If
   audio-first generation becomes a primary use case, consider a dedicated node
   for the `audio-to-video` endpoint.

4. **Saved-graph compatibility** — old graphs saved with ltx-2-3 may have
   `duration` stored as an integer (e.g. `7`). The universal handler forwards
   params as-is, so `"duration": 7` would reach the API and may be rejected.
   Consider adding param-coercion logic in `_ltx_23_handler` to snap integer
   duration values to the nearest valid enum string.
