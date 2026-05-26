# Handler Gaps — Meshy API Features Our Nebula Nodes Do Not Expose

Cross-checked on 2026-04-17: official Meshy API docs vs. `backend/handlers/meshy.py` + `backend/data/node_definitions.json`.

This is an **actionable list** of Meshy capabilities that exist in the API but aren't wired through to our nebula nodes yet. When a user asks for a feature listed here, you can:
1. Note that the underlying API supports it
2. Tell them it's not in the current node UI
3. Either add it (if small) or file a follow-up

## meshy-text-to-3d

### Missing exposed parameters
- `decimation_mode` (int 1-4) — adaptive alternative to `target_polycount` that adapts to geometry complexity
- `target_formats` — user can't limit output to specific formats (saves time)
- `moderation` (bool) — content screening
- `auto_size` + `origin_at` — AI-estimated real-world sizing
- `ai_model` — no UI to pick meshy-5 vs meshy-6 vs latest; handler defaults to `latest` silently

### Missing in refine mode
- `texture_prompt` — can't give text guidance for texture generation
- `texture_image_url` — can't provide a reference image for texture style
- `remove_lighting` — exposed for some nodes but not this one

## meshy-image-to-3d

### Missing exposed parameters
- `ai_model` — not exposed
- `decimation_mode` — not exposed
- `save_pre_remeshed_model` — not exposed (useful for comparing before/after remesh)
- `image_enhancement` — not exposed (default true; turn off to preserve exact input style)
- `remove_lighting` — not exposed (default true; produces cleaner textures for custom lighting)
- `texture_prompt` — not exposed (text guidance for texture, costs +10 credits)
- `texture_image_url` — not exposed (reference image for texture, costs +10 credits)
- `moderation` — not exposed
- `target_formats` — not exposed
- `auto_size` + `origin_at` — not exposed

## meshy-multi-image-to-3d

### Missing exposed parameters
- `decimation_mode` — not exposed
- `save_pre_remeshed_model` — not exposed
- `texture_prompt` — not exposed
- `texture_image_url` — not exposed
- `moderation` — not exposed
- `target_formats` — not exposed
- `auto_size` + `origin_at` — not exposed

## meshy-retexture

### Missing features
- **`input_task_id` chaining not exposed.** The API accepts `input_task_id` to reference a prior Meshy task (text-to-3d, image-to-3d, remesh) instead of a URL. Our handler only accepts `model_url`. Adding this would let users chain retexture after earlier Meshy tasks without re-uploading.
- **`image_style_url` not exposed.** The API supports a 2D reference image to guide retexturing (in addition to `text_style_prompt`). Handler only passes the text prompt.
- `target_formats` — not exposed

### Handler note
The handler uses the node's `prompt` input (connected from a `text-input` node) and maps it to the API's `text_style_prompt` field. This is correct but note the field name mismatch if you're debugging.

## meshy-rigging

### Missing features
- **`input_task_id` not exposed.** Same pattern — chain from a prior Meshy task instead of re-passing the URL.
- **`texture_image_url` not exposed.** Optional UV-unwrapped base color PNG for use with `model_url`. Handler doesn't support this, so users must supply a fully-textured GLB.

## meshy-animate

### Missing features
- **Only `change_fps` post-processing supported.** API also supports:
  - `fbx2usdz` — convert animation to USDZ format (great for iOS/AR pipelines)
  - `extract_armature` — extract skeleton only, without mesh

### UX issue
- `action_id` is a raw integer input. Users have to know or look up specific IDs. A proper picker UI reading from `reference/animation-library.md` would be a big UX win.

## meshy-remesh

### Missing features
- **`input_task_id` not exposed.** Chain from prior Meshy task.
- **`decimation_mode` not exposed.** Adaptive decimation alternative to target_polycount.
- **`auto_size` + `origin_at` not exposed.** AI-estimated real-world sizing.

## meshy-text-to-image

### Handler bug (potential)
- **`generate_multi_view` and `aspect_ratio` are mutually exclusive** per Meshy docs: *"generate_multi_view and aspect_ratio cannot be used simultaneously"*. Our node exposes both parameters and the handler passes both to the API if set. **Result:** API returns 400 when user sets both. Fix: in the handler, if `generate_multi_view=true`, strip `aspect_ratio` from the body (or vice versa).

## meshy-image-to-image

No gaps detected — matches API spec fully. Node exposes `ai_model`, `prompt`, `reference_image_urls` (via inputs), `generate_multi_view`. These are the only params the API supports.

## meshy-3d-print

No gaps detected. Node exposes `input_task_id` (via input), `max_colors`, `max_depth`. Matches API fully.

## Priority recommendations (most-requested → least)

If you extend nodes incrementally, here's my ranking:

1. **Fix the text-to-image mutual-exclusion bug** (1-line handler patch)
2. **Add `input_task_id` chaining to retexture, rigging, remesh** — huge for pipeline workflows; avoids re-upload churn
3. **Add `texture_prompt` + `texture_image_url` to image-to-3d and multi-image-to-3d** — massively improves output control for users with existing style references
4. **Add animation library picker UI for meshy-animate** — users can't use 580+ animations if they have to memorize IDs
5. **Add `ai_model` picker to text-to-3d and image-to-3d** — lets cost-conscious users pick meshy-5 (~4× cheaper)
6. **Add `decimation_mode` option to remesh + text-to-3d + image-to-3d** — better for complex geometry than flat polycount
7. **Add `target_formats` picker** — reduces task completion time when user knows which format they want
8. **Add `image_style_url` to retexture** — image-driven retexturing is the most common retexture use case

Gaps below this line are "nice to have" — not deal-breakers for current users.

## Testing a gap fix

When adding a parameter:
1. Add it to the node definition JSON (`backend/data/node_definitions.json`) with appropriate type/default
2. Add the key to the handler's param-passthrough whitelist in `meshy.py`
3. Test via `nebula create ...` with the new param value
4. Verify the API accepts it (use `--verbose` and inspect the body sent)
5. Verify the output is what you expected
