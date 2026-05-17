---
id: nebula-fal-recraft
kind: project-model-integration
project: nebula_nodes
provider: fal
model: recraft-v4 (raster, svg)
status: active
verified: 2026-05-17
stale_after_days: 30
---

# FAL Recraft V4 Wrappers — Audit Note

Covers two Recraft-via-FAL wrapper nodes in Nebula:
`recraft-v4-raster` (raster image generation) and `recraft-v4-svg` (SVG vector
generation). Both route through `handle_fal_universal` (see `fal-universal.md`
for the shared infrastructure contract). Each wrapper's handler lives in
`backend/execution/sync_runner.py` and injects `endpoint_id` via
`node.params.setdefault(...)` before calling the universal handler.

## Sources

- `https://fal.ai/models/fal-ai/recraft/v4/text-to-image/api` — fetched 2026-05-17
- `https://fal.ai/models/fal-ai/recraft/v4/text-to-vector/api` — fetched 2026-05-17
- `https://fal.ai/models?keywords=recraft` — fetched 2026-05-17 (model catalog)
- `https://fal.ai/models/fal-ai/recraft-v3/api` — fetched 2026-05-17 (V3 reference,
  used to confirm which params were removed in V4)

---

## Node Matrix

| Node ID | Display Name | Endpoint | Output port |
|---------|-------------|----------|-------------|
| `recraft-v4-raster` | Recraft V4 | `fal-ai/recraft/v4/text-to-image` | `image` (Image) |
| `recraft-v4-svg` | Recraft V4 SVG | `fal-ai/recraft/v4/text-to-vector` | `svg` (SVG) |

Both endpoints use the `fal-ai/recraft/v4/` namespace. The SVG endpoint
(`text-to-vector`) returns `images[0].content_type = "image/svg+xml"`, which
`_parse_fal_output` routes to the `svg` output port. This routing was added in
the FAL universal audit (commit `231c3a5`).

---

## Per-Model Parameter Tables

### recraft-v4-raster (`fal-ai/recraft/v4/text-to-image`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_size` | enum or object | `"square_hd"` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | correct |
| `style_id` | string | — | Custom style UUID | correct |
| `colors` | string (UI) → `list<{r,g,b}>` | — | JSON array or comma-sep hex | converted by handler (see below) |
| `background_color` | string (UI) → `{r,g,b}` | — | JSON object or hex string | added; converted by handler |
| `enable_safety_checker` | boolean | `true` | — | correct |
| ~~`style`~~ | ~~enum~~ | — | — | **removed** (V3-only param; not in V4 API) |

### recraft-v4-svg (`fal-ai/recraft/v4/text-to-vector`)

| Parameter | Type | Default | Accepted values | Status |
|-----------|------|---------|-----------------|--------|
| `prompt` | string | required | — | via `prompt` port |
| `image_size` | enum or object | `"square_hd"` | same 6 options as raster | correct |
| `style_id` | string | — | Custom style UUID | correct |
| `colors` | string (UI) → `list<{r,g,b}>` | — | JSON array or comma-sep hex | converted by handler |
| `background_color` | string (UI) → `{r,g,b}` | — | JSON object or hex string | added; converted by handler |
| `enable_safety_checker` | boolean | `true` | — | **added** (was missing from SVG node) |
| ~~`style`~~ | ~~enum~~ | — | — | **removed** (V3-only param; not in V4 API) |

---

## The `style` Param Removal

Recraft V3 (`fal-ai/recraft-v3`) exposes a `style` enum with ~108 values
(`realistic_image`, `digital_illustration`, `vector_illustration`, and many
substyles like `realistic_image/hdr`, `digital_illustration/pixel_art`, etc.).

Recraft V4 (`fal-ai/recraft/v4/text-to-image` and `text-to-vector`) does **not**
expose a `style` parameter in its API schema. The canonical V4 API schema
(fetched 2026-05-17) lists exactly five parameters: `prompt`, `image_size`,
`colors`, `background_color`, `enable_safety_checker`. No `style` field exists.

The pre-audit node definitions had a truncated `style` enum (4 values for raster,
3 for SVG) copied from V3. Forwarding an unknown `style` value to the V4 API
would either be silently ignored or cause a validation error. Both `style` enums
have been removed.

If per-style control is needed, use `style_id` with a Recraft custom style UUID,
or switch to `fal-ai/recraft-v3` (V3 endpoint, which retains `style`).

---

## The `colors` and `background_color` Conversion

The FAL V4 API expects:
- `colors`: `list<RGBColor>` where each item is `{"r": int, "g": int, "b": int}`
- `background_color`: `RGBColor` object `{"r": int, "g": int, "b": int}`

The UI stores these as plain strings (the `string` param type). Two input
formats are accepted:
- **Comma-separated hex**: `"#FF0000,#00FF00,#0000FF"` → `[{"r":255,"g":0,"b":0}, ...]`
- **JSON array/object**: `'[{"r":255,"g":0,"b":0}]'` / `'{"r":255,"g":255,"b":255}'`

Conversion is performed in `_apply_recraft_color_params(node)` (module-level
helper in `backend/execution/sync_runner.py`), called from both
`_recraft_raster_handler` and `_recraft_svg_handler` before
`handle_fal_universal`. This is the same pre-processing pattern as `fast-sdxl`'s
`loras`/`embeddings` JSON parsing.

Invalid or empty values are dropped silently so that optional params behave
correctly (FAL rejects empty strings for typed params).

---

## SVG Output Routing

`recraft-v4-svg` outputs an SVG port (`dataType: "SVG"`). FAL returns:

```json
{
  "images": [{"url": "https://cdn.fal.ai/output.svg", "content_type": "image/svg+xml"}]
}
```

`_parse_fal_output` detects `"svg" in content_type.lower()` and routes to
`{"svg": {"type": "SVG", "value": url}}`. This was the bug fixed in commit
`231c3a5` (FAL universal audit). The SVG routing is confirmed working and covered
by `TestParseFalOutputSVG` in `test_fal_handler.py`.

---

## Findings and Fixes

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | `style` enum on `recraft-v4-raster` — 4-value enum (`realistic_image`, `digital_illustration`, `vector_illustration`, `icon`) copied from V3; not in V4 API; would be forwarded as unknown param | Removed `style` param from node definition (both registries) |
| 2 | High | `style` enum on `recraft-v4-svg` — 3-value enum; same issue | Removed `style` param |
| 3 | High | `colors` param placeholder `"#FF0000,#00FF00,#0000FF"` implies string format; FAL V4 expects `list<{r,g,b}>` objects; no conversion existed anywhere | Added `_apply_recraft_color_params()` in `sync_runner.py`; called in both handlers; updated placeholder to show correct JSON format |
| 4 | Medium | `background_color` param entirely absent from both nodes — present in V4 API | Added `background_color` string param to both nodes; conversion handled by `_apply_recraft_color_params()` |
| 5 | Low | `enable_safety_checker` missing from `recraft-v4-svg` — present in raster node and V4 API | Added to SVG node definition |

---

## Port Mapping Summary

| Port ID | FAL field | Handler |
|---------|-----------|---------|
| `prompt` | `prompt` | universal |

No image/video/audio input ports on either node — both are text-to-image/SVG only.
The `colors` and `background_color` conversion happens in the wrapper handlers
before the universal handler receives the params.

---

## Output Routing

| Node | FAL response field | `_parse_fal_output` branch | Output port |
|------|--------------------|---------------------------|-------------|
| `recraft-v4-raster` | `images[0]` with `content_type: "image/png"` or `"image/webp"` | images → Image | `image` (Image) |
| `recraft-v4-svg` | `images[0]` with `content_type: "image/svg+xml"` | images → SVG (via `"svg" in content_type`) | `svg` (SVG) |

---

## Tests Added

File: `backend/tests/test_fal_handler.py`

| Test | Covers |
|------|--------|
| `TestParseRecraftColor::test_hex_with_hash` | Hex `#RRGGBB` → `{r,g,b}` |
| `TestParseRecraftColor::test_hex_without_hash` | Hex without `#` prefix |
| `TestParseRecraftColor::test_rgb_dict_passthrough` | Already-dict value passes through |
| `TestParseRecraftColor::test_invalid_hex_returns_none` | Invalid input → `None` |
| `TestParseRecraftColor::test_short_hex_returns_none` | 3-char hex → `None` |
| `TestParseRecraftColor::test_dict_missing_keys_returns_none` | Incomplete dict → `None` |
| `TestApplyRecraftColorParams::test_hex_csv_colors_converted_to_rgb_list` | Comma-sep hex → `[{r,g,b}]` list |
| `TestApplyRecraftColorParams::test_json_array_colors_converted` | JSON array string → list |
| `TestApplyRecraftColorParams::test_empty_colors_dropped` | Empty string → key removed |
| `TestApplyRecraftColorParams::test_invalid_colors_dropped` | Unparseable → key removed |
| `TestApplyRecraftColorParams::test_hex_background_color_converted` | Hex bg → `{r,g,b}` |
| `TestApplyRecraftColorParams::test_json_object_background_color_converted` | JSON object string → `{r,g,b}` |
| `TestApplyRecraftColorParams::test_empty_background_color_dropped` | Empty bg → key removed |
| `TestApplyRecraftColorParams::test_no_color_params_unchanged` | No color params → no mutation |
| `test_recraft_raster_endpoint_injected` | Correct endpoint slug in POST URL |
| `test_recraft_raster_colors_hex_csv_sent_as_rgb_list` | Colors arrive as `[{r,g,b}]`; `style` absent |
| `test_recraft_raster_background_color_sent_as_rgb_object` | `background_color` arrives as `{r,g,b}` |
| `test_recraft_svg_endpoint_injected` | Correct endpoint slug; result routed to `svg` port |
| `test_recraft_svg_colors_hex_csv_sent_as_rgb_list` | Colors → `[{r,g,b}]`; `style` absent |
| `test_recraft_svg_output_port_is_svg_not_image` | `image/svg+xml` → `svg` port (not `image`) |

File: `backend/tests/test_node_contracts.py` — `test_researched_provider_corrections_are_pinned`

| Pin | Assertion |
|-----|-----------|
| `recraft-v4-raster` no `style` | `"style" not in param_keys` |
| `recraft-v4-raster` has `style_id`, `colors`, `background_color`, `enable_safety_checker` | key presence |
| `recraft-v4-raster.apiEndpoint` | `"fal-ai/recraft/v4/text-to-image"` |
| `recraft-v4-raster` output | `Image` port present; no `SVG` port |
| `recraft-v4-svg` no `style` | `"style" not in param_keys` |
| `recraft-v4-svg` has `style_id`, `colors`, `background_color`, `enable_safety_checker` | key presence |
| `recraft-v4-svg.apiEndpoint` | `"fal-ai/recraft/v4/text-to-vector"` |
| `recraft-v4-svg` output | `SVG` port present; no `Image` port |

---

## Open Questions

1. **V4 `style` alternatives** — The V4 API has no `style` param. If users need
   stylistic control, the workflow is: create a style in Recraft's web UI, copy
   the style UUID, and use the `style_id` param. This is not documented in the
   UI placeholder; a tooltip or help text linking to `recraft.ai` would improve
   discoverability.

2. **V4.1 availability** — As of 2026-05-17, `recraft/v4.1/text-to-image` and
   `recraft/v4.1/text-to-vector` are listed in the FAL catalog with sharper
   prompt control and up to 2048×2048 resolution. These are separate endpoints
   (not drop-in replacements for V4) and would require new node definitions if
   added to Nebula.

3. **`colors` list length limit** — The FAL API documentation does not specify
   a maximum number of colors. Behavior with large palettes (>10 colors) is
   untested.

4. **Saved-graph compat note** — Saved graphs with `style` param set will
   silently forward that value to FAL V4; FAL typically ignores unknown fields
   but a `node.params.pop('style', None)` in the handler would be safer if
   errors surface.
