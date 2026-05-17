---
id: nebula-fal-wan
kind: project-model-integration
project: nebula_nodes
provider: fal
model: wan-2.6 (t2v, i2v, r2v)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Wan 2.6 Wrappers — Audit Note

Covers the three Wan-2.6-via-FAL wrapper nodes in Nebula:
`wan-2-6-t2v`, `wan-2-6-i2v`, and `wan-2-6-r2v`.

All three route through `handle_fal_universal` (see `fal-universal.md` for
the shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.
The R2V handler additionally collates `video1/video2/video3` input ports
into the `video_urls` array the API requires.

## Sources

- `https://fal.ai/models/wan/v2.6/text-to-video` — fetched 2026-05-17
- `https://fal.ai/models/wan/v2.6/image-to-video` — fetched 2026-05-17
- `https://fal.ai/models/wan/v2.6/reference-to-video` — fetched 2026-05-17
- Skill cache: `.claude/skills/fal/skills/wan__v2.6__*.md`

---

## Node Matrix

| Node ID | Display Name | Endpoint | Mode |
|---------|-------------|----------|------|
| `wan-2-6-t2v` | Wan 2.6 T2V | `wan/v2.6/text-to-video` | T2V |
| `wan-2-6-i2v` | Wan 2.6 I2V | `wan/v2.6/image-to-video` | I2V |
| `wan-2-6-r2v` | Wan 2.6 R2V | `wan/v2.6/reference-to-video` | R2V (multi-video) |

**Endpoint prefix note:** All three Wan 2.6 endpoints are served under the
`wan/` namespace (no `fal-ai/` prefix). This is an Alibaba Cloud DashScope
endpoint routed through FAL, not a FAL-native model. The queue URL is
`https://queue.fal.run/wan/v2.6/...`.

---

## Per-Model Parameter Tables

### wan-2-6-t2v (`wan/v2.6/text-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | ≤800 chars | via `prompt` port |
| `duration` | enum (integer) | `5` | `5`, `10`, `15` | param (corrected: was `"5s"`) |
| `resolution` | enum | `"720p"` | `"720p"`, `"1080p"` | param |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"` | param (expanded: was 3 options) |
| `negative_prompt` | string | `""` | ≤500 chars | param |
| `seed` | integer | null | any | param |
| `generate_audio` | boolean | `true` | — | param (default corrected: was `false`) |
| `enable_prompt_expansion` | boolean | `true` | — | param (added) |
| `multi_shots` | boolean | `true` | — | param (added) |
| `enable_safety_checker` | boolean | `true` | — | param (added) |

### wan-2-6-i2v (`wan/v2.6/image-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `image_url` | string | required | URL / Base64 | via `image` port |
| `prompt` | string | required | ≤800 chars | via `prompt` port |
| `duration` | enum (integer) | `5` | `5`, `10`, `15` | param (corrected: was `"5s"`) |
| `resolution` | enum | `"720p"` | `"720p"`, `"1080p"` | param (corrected: removed spurious `480p`) |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"` | param (unchanged) |
| `negative_prompt` | string | `""` | ≤500 chars | param |
| `seed` | integer | null | any | param |
| `generate_audio` | boolean | `true` | — | param (default corrected: was `false`) |
| `enable_prompt_expansion` | boolean | `true` | — | param (added) |
| `multi_shots` | boolean | `false` | — | param (added; API default is `false` for I2V) |
| `enable_safety_checker` | boolean | `true` | — | param (added) |

### wan-2-6-r2v (`wan/v2.6/reference-to-video`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | ≤800 chars, `@Video1`/`@Video2`/`@Video3` tags | via `prompt` port |
| `video_urls` | array | required | 1–3 video URLs | collated from `video1`/`video2`/`video3` ports by handler |
| `duration` | enum (integer) | `5` | `5`, `10` | param (corrected: was `"5s"`; removed invalid `15`) |
| `resolution` | enum | `"1080p"` | `"720p"`, `"1080p"` | param (corrected: removed `480p`; default was `"720p"`) |
| `aspect_ratio` | enum | `"16:9"` | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"` | param (expanded: was 3 options) |
| `negative_prompt` | string | `""` | ≤500 chars | param |
| `seed` | integer | null | any | param |
| `enable_prompt_expansion` | boolean | `true` | — | param (added) |
| `multi_shots` | boolean | `true` | — | param (added) |
| `enable_safety_checker` | boolean | `true` | — | param (added) |

---

## Findings and Fixes

### wan-2-6-t2v

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | `duration` enum values used `"5s"`, `"10s"`, `"15s"` string format — API takes bare integers `5`, `10`, `15`; every request would be rejected or silently ignored | Changed to integer enum values `5`, `10`, `15` |
| 2 | Medium | `generate_audio` default was `false` — API default is `true`; setting `false` suppresses audio on every generation without the user asking for that | Corrected default to `true` |
| 3 | Low | `aspect_ratio` only exposed 3 options (`16:9`, `9:16`, `1:1`) — API supports 5 (`4:3` and `3:4` missing) | Added `4:3` and `3:4` options |
| 4 | Low | `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` params absent — all accepted by API and affect generation quality/behaviour | Added all three params with API defaults |

### wan-2-6-i2v

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 5 | High | `duration` enum values used `"5s"`, `"10s"`, `"15s"` string format — same as T2V | Changed to integer enum values `5`, `10`, `15` |
| 6 | High | `apiEndpoint` had stale `fal-ai/wan/v2.6/image-to-video` prefix — handler correctly used `wan/v2.6/image-to-video` but the definition was wrong; could confuse tooling that reads `apiEndpoint` | Corrected to `wan/v2.6/image-to-video` |
| 7 | Medium | `resolution` exposed spurious `480p` option — API only supports `720p` and `1080p`; selecting `480p` would cause an API validation error | Removed `480p` |
| 8 | Medium | `generate_audio` default was `false` — same as T2V | Corrected default to `true` |
| 9 | Low | `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` params absent | Added all three (`multi_shots` default `false` for I2V per API spec) |

### wan-2-6-r2v

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 10 | Critical | `video1`/`video2`/`video3` input ports had no mapping in `handle_fal_universal` — all reference videos were silently dropped from the FAL request; every R2V call would fail or produce results ignoring reference material | Added collation logic in `_wan26_r2v_handler`: iterates `video1`/`video2`/`video3` ports, builds `video_urls` list, injects into `node.params` before calling universal handler |
| 11 | High | `duration` enum values used `"5s"`, `"10s"`, `"15s"` — API takes integers; also `"15s"` (15) is not supported by the R2V endpoint (max 10s) | Changed to integer enum `5`, `10` only |
| 12 | High | `apiEndpoint` had stale `fal-ai/` prefix | Corrected to `wan/v2.6/reference-to-video` |
| 13 | Medium | `resolution` exposed spurious `480p` option; default was `720p` but API default is `1080p` | Removed `480p`; corrected default to `1080p` |
| 14 | Low | `aspect_ratio` only had 3 options; API supports 5 | Added `4:3` and `3:4` |
| 15 | Low | `enable_prompt_expansion`, `multi_shots`, `enable_safety_checker` params absent | Added all three |

---

## Port Mapping Summary

| Port ID | FAL field | Handler | Node |
|---------|-----------|---------|------|
| `prompt` | `prompt` | universal | all |
| `image` | `image_url` | universal | i2v |
| `video1` | `video_urls[0]` | `_wan26_r2v_handler` (collation) | r2v |
| `video2` | `video_urls[1]` | `_wan26_r2v_handler` (collation) | r2v |
| `video3` | `video_urls[2]` | `_wan26_r2v_handler` (collation) | r2v |

The `video1/video2/video3` → `video_urls` collation happens entirely in the
wrapper handler before the universal handler is called. The universal handler
then forwards `video_urls` as a param (it passes all non-internal, non-empty
params straight to the FAL payload). No changes to `handle_fal_universal`
were needed.

---

## Output Routing

All three nodes output `video` type. FAL returns `{"video": {"url": "..."}}` for
all Wan 2.6 endpoints. `_parse_fal_output` handles this via the video branch.
No output routing changes needed.

---

## Tests Added

File: `backend/tests/test_fal_handler.py`

| Test | Covers |
|------|--------|
| `test_wan26_t2v_endpoint_injected` | Correct endpoint slug in POST URL; no `fal-ai/` prefix |
| `test_wan26_t2v_key_params_forwarded` | duration as integer, generate_audio, expansion flags |
| `test_wan26_i2v_endpoint_injected` | Correct endpoint slug; no `fal-ai/` prefix |
| `test_wan26_i2v_image_maps_to_image_url` | `image` → `image_url`; duration as integer |
| `test_wan26_r2v_endpoint_injected` | Correct endpoint slug; no `fal-ai/` prefix |
| `test_wan26_r2v_video_ports_collated_into_video_urls` | video1+video2 → `video_urls` list (critical fix) |
| `test_wan26_r2v_single_video_collated` | Single video1 → `video_urls` with one entry |
| `test_wan26_r2v_duration_is_integer` | duration forwarded as integer, not `"10s"` |

File: `backend/tests/test_node_contracts.py` — `test_researched_provider_corrections_are_pinned`

| Pin | Assertion |
|-----|-----------|
| `wan-2-6-t2v.duration` | integer enum `{5, 10, 15}`, default `5` |
| `wan-2-6-t2v.aspect_ratio` | all 5 options present |
| `wan-2-6-t2v.generate_audio` | default `true` |
| `wan-2-6-t2v.resolution` | no `480p` |
| `wan-2-6-t2v.apiEndpoint` | `"wan/v2.6/text-to-video"` (no `fal-ai/`) |
| `wan-2-6-i2v.duration` | integer enum `{5, 10, 15}`, default `5` |
| `wan-2-6-i2v.resolution` | no `480p` |
| `wan-2-6-i2v.generate_audio` | default `true` |
| `wan-2-6-i2v.apiEndpoint` | `"wan/v2.6/image-to-video"` (no `fal-ai/`) |
| `wan-2-6-r2v.duration` | integer enum `{5, 10}` only, default `5` |
| `wan-2-6-r2v.resolution` | no `480p`; default `"1080p"` |
| `wan-2-6-r2v.aspect_ratio` | all 5 options present |
| `wan-2-6-r2v.apiEndpoint` | `"wan/v2.6/reference-to-video"` (no `fal-ai/`) |
| `wan-2-6-r2v` input ports | `video1`, `video2`, `video3` all present |

---

## Open Questions

1. **R2V `video_urls` mutation side-effect** — The handler writes `video_urls`
   directly into `node.params`. If a node object is ever reused across retries,
   a stale `video_urls` value could persist from a prior run. Currently nodes are
   instantiated fresh per execution, so this is safe. If execution ever gains
   retry-with-same-node-object semantics, change the handler to pop `video_urls`
   after each call or inject it as a separate dict.

2. **Wan 2.6 T2V `audio_url` port** — The API accepts an optional `audio_url`
   for background music synchronization. The current node has no `audio` input
   port. The universal handler already maps an `audio` port → `audio_url`, so
   adding the port would be a definition-only change. Deferred — add only when
   the use case is validated in production.

3. **R2V `@VideoN` tag syntax in prompts** — The API requires prompt references
   like `@Video1`, `@Video2`, `@Video3` to be correlated with `video_urls[0]`,
   `video_urls[1]`, `video_urls[2]` respectively. There is no validation that
   the prompt contains the right tags for the number of connected videos. A
   future improvement could warn the user in the UI if they connect `video2` but
   the prompt has no `@Video2` tag.

4. **I2V `multi_shots` default** — Set to `false` (per API default for I2V).
   T2V and R2V both default to `true`. This asymmetry is intentional: I2V is
   typically used for single-shot animation; T2V and R2V are used for narrative
   sequences. Confirm this matches user expectations in production.
