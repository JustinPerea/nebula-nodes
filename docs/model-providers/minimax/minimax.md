---
id: nebula-minimax-video
kind: project-model-integration
project: nebula_nodes
provider: minimax
status: active
verified: 2026-05-16
stale_after_days: 30
---

# MiniMax Video Generation in Nebula Nodes

Nebula integration notes for the MiniMax T2V, I2V, and S2V video generation nodes.

Canonical docs consulted (accessed 2026-05-16):
- https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
- https://platform.minimaxi.com/docs/api-reference/video-generation-i2v
- https://platform.minimaxi.com/docs/api-reference/video-generation-s2v
- https://platform.minimaxi.com/docs/api-reference/video-generation-query

## Node Matrix

| Node ID | Port IDs (in) | Port IDs (out) | Key | Model |
|---|---|---|---|---|
| `minimax-t2v` | `prompt` | `video` | `MINIMAX_API_KEY` | `MiniMax-Hailuo-2.3` (default) |
| `minimax-i2v` | `first_frame_image`, `prompt` | `video` | `MINIMAX_API_KEY` | `MiniMax-Hailuo-2.3` (default) |
| `minimax-s2v` | `subject_reference`, `prompt` | `video` | `MINIMAX_API_KEY` | `S2V-01` (only) |

All three nodes share the same handler (`handle_minimax_video` in `backend/handlers/minimax.py`) and the same endpoint `POST https://api.minimaxi.com/v1/video_generation`. The handler dispatches to the correct variant by checking which input port has a value.

## T2V Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-02` | `MiniMax-Hailuo-2.3` | `T2V-01-Director` and `T2V-01` exist in API but not exposed in Nebula |
| `duration` | `6`, `10` | `6` | 10s only available at 768P; 1080P is 6s only |
| `resolution` | `768P`, `1080P` | `768P` | 768P is the API default for Hailuo-2.3 |

API also accepts `prompt_optimizer` (bool, default `true`) and `fast_pretreatment` (bool, default `false`) — not currently exposed in Nebula UI.

## I2V Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-02` | `MiniMax-Hailuo-2.3` | `I2V-01-Director`, `I2V-01-live`, `I2V-01` also exist |
| `duration` | `6`, `10` | `6` | Same constraint as T2V |
| `resolution` | `768P`, `1080P` | `768P` | `512P` available for Hailuo-02 but not exposed |

I2V required port: `first_frame_image` (Image) — URL or base64 data URI, JPG/JPEG/PNG/WebP, <20 MB, short edge >300px, aspect ratio 2:5 to 5:2.

## S2V Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `S2V-01` | `S2V-01` | Only one model; exposed for explicitness |

S2V does **not** accept `duration` or `resolution` — these params were removed in this audit. The API accepts only `model`, `subject_reference` (required), `prompt`, `prompt_optimizer`, `callback_url`, `aigc_watermark`.

The `subject_reference` field shape sent to the API:
```json
[{"type": "character", "image": ["<url_or_data_uri>"]}]
```
Only `type: "character"` (human face) is currently supported.

## 3-Step Async Pattern

1. `POST /v1/video_generation` → returns `task_id`
2. `GET /v1/query/video_generation?task_id=<id>` → poll until `status` is `Success` or `Fail`
   - Valid non-terminal statuses: `Preparing`, `Queueing`, `Processing`
3. On `Success`, use `file_id` to call `GET /v1/files/retrieve/<file_id>` → `file.download_url`
4. Download video locally, return `{"video": {"type": "Video", "value": "<local_path>"}}`

## Findings and Changes (2026-05-16)

### Bugs Fixed

| Finding | Severity | Fix |
|---|---|---|
| **I2V port id mismatch**: registry used `image`, handler read `first_frame_image` — I2V was silently falling through to T2V mode | Critical | Renamed port id to `first_frame_image` in both registries |
| **S2V port id mismatch**: registry used `image`, handler read `subject_reference` — S2V was silently falling through to T2V mode | Critical | Renamed port id to `subject_reference` in both registries |
| **`last_frame_image` not in API**: I2V registry exposed `last_frame` port and handler sent `last_frame_image` — field does not exist in MiniMax I2V API | High | Removed port from registry and body assignment from handler |
| **Wrong base domain**: handler and registry used `api.minimaxi.chat`; canonical docs specify `api.minimaxi.com` | High | Updated `MINIMAX_API_BASE` constant and all `apiEndpoint` values |
| **Duration `9` not valid**: registry listed 9s as an option; MiniMax API supports 6s and 10s only | Medium | Changed `9 → 10` in duration enum for T2V and I2V |
| **Resolution default wrong**: registry defaulted to `1080P`; API default for Hailuo-2.3 is `768P` (1080P only available at 6s) | Medium | Changed default to `768P`, replaced `720P` option with `768P` |
| **S2V exposed `duration`/`resolution` params**: S2V API does not accept these fields | Medium | Removed both params from S2V node definition |
| **S2V missing `model` param**: handler defaults to `S2V-01` but it wasn't user-visible | Low | Added `model` enum param with single `S2V-01` option |

### Files Changed

- `backend/handlers/minimax.py` — base URL, port id reads, body construction per variant, removed `last_frame_image`, removed unused `uuid4` import
- `backend/data/node_definitions.json` — all three nodes: base URL, port ids, duration/resolution enums, S2V params
- `frontend/src/constants/nodeDefinitions.ts` — mirrors JSON changes
- `backend/tests/test_node_contracts.py` — added pinned assertions for corrected values
- `backend/tests/test_minimax_handler.py` — new handler test (T2V body shape, I2V body shape, S2V body shape, port id contracts, base URL, error cases)

## Open Questions

1. **`api.minimaxi.chat` vs `api.minimaxi.com`**: The docs OpenAPI spec lists `api.minimaxi.com`. The old `.chat` domain may still work as a legacy alias but is not documented. Changed to `.com`; monitor for any auth/routing errors.
2. **`MiniMax-Hailuo-2.3-Fast`**: Docs show this as a valid I2V model but it is not in the Nebula model enum. Not added in this pass to keep diff small — consider adding in a follow-up.
3. **`prompt_optimizer`** (default `true`): The API silently optimizes prompts by default. This is not exposed in Nebula. Power users may want to disable it. Low priority; flag for Phase 5 UI pass.
4. **S2V fixed output spec**: Docs do not state the fixed resolution/duration for S2V-01 output. Not currently a blocking issue since the params were non-functional before removal.
5. **`T2V-01-Director`, `I2V-01-Director`, `I2V-01-live`, `I2V-01`**: Legacy and director models exist but are not in Nebula. Consider adding in a catalog expansion pass.
