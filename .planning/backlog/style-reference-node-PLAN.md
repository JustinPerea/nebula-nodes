# Style Reference Node — PLAN

> **READY 2026-05-18.** Phase 2 of `docs/superpowers/plans/2026-05-16-node-input-api-contract-hardening.md` landed in commit `799adb3`; the brief's "no new model nodes until catalog is audited" gate is cleared. This plan is unblocked and ready to execute when picked up.

Phase: Step 1 of the "Higgsfield Canvas → Nebula" gap-close (see thread research, 2026-05-10).
Goal: ship one new utility node — `style-reference` — that lets a user drop a reference image, optionally auto-derives a style description from it, and emits both as connectable ports so any downstream image/video/chat model can be styled from it without rewiring.

## Why this node first

- **Smallest surface, biggest perceived behavior.** Canvas's most-shown demo is "drop an image, every downstream gen picks up the style." We can deliver that without a brush UI, new model integration, or new infra.
- **Wraps existing capability, doesn't add new model spend.** All the underlying style-application is already in the catalog: `nano-banana` (multi-ref), `flux-kontext`, `seedream-4-5`, `gpt-image-2-edit`. The node is glue.
- **Works for image *and* video flows.** The Image+Text pair feeds image models directly and video models via a generated first frame.

## What it does (user-visible)

1. User drops a reference image into the node (drag-drop, file picker, or paste URL — same affordances as `image-input`).
2. Node emits two ports:
   - `image` (Image) — the reference, byte-identical to what the user dropped.
   - `style_description` (Text) — a model-generated description of the *visual style* (palette, lighting, medium, era, mood) of the reference. Subject content is deliberately omitted.
3. A **Mode** param picks how `style_description` is produced:
   - `auto` — call Gemini Chat with a fixed style-extraction system prompt on first run, cache result on the node.
   - `manual` — user types the description (textarea param). No API call.
   - `passthrough` — emit empty text; only the image is useful. (For when downstream model already accepts an Image-typed style ref directly, e.g. nano-banana.)
4. **Strength** param (0–1, default 0.7) is appended to the description as `(style strength: 0.7)` so downstream prompts inherit it. Models with explicit `guidance_scale` can ignore the suffix; this is a soft signal.

The node is in the **utility** category (not a model). It costs nothing on `auto` after the first run because of `ExecutionCache`.

## Where it sits in the codebase

| Surface | File | Change |
|---|---|---|
| Definition | `backend/data/node_definitions.json` | Add `style-reference` entry |
| Handler | `backend/handlers/style_reference.py` | New file (~120 lines) |
| Registration | `backend/execution/sync_runner.py` | Add to `SYNC_HANDLERS` dict |
| Frontend | (none) | Auto-discovered via `/api/nodes`. ModelNode renders it from the JSON. |
| Tests | `backend/tests/test_style_reference.py` | New file |
| Docs | `.claude/skills/nebula/SKILL.md` | Add Style Reference to Utility Nodes section |

No frontend code. The node renders through existing `ModelNode.tsx` because its definition shape matches existing utility nodes (`image-input` is the closest precedent).

## Node definition (exact JSON)

```json
"style-reference": {
  "id": "style-reference",
  "displayName": "Style Reference",
  "category": "utility",
  "apiProvider": "google",
  "apiEndpoint": "/v1beta/models/gemini-2.5-flash:generateContent",
  "envKeyName": "GOOGLE_API_KEY",
  "executionPattern": "sync",
  "inputPorts": [],
  "outputPorts": [
    {
      "id": "image",
      "label": "Reference",
      "dataType": "Image",
      "required": false
    },
    {
      "id": "style_description",
      "label": "Style",
      "dataType": "Text",
      "required": false
    }
  ],
  "params": [
    {
      "key": "filePath",
      "label": "Reference Image",
      "type": "file",
      "required": true,
      "default": ""
    },
    {
      "key": "mode",
      "label": "Description Mode",
      "type": "enum",
      "required": false,
      "default": "auto",
      "options": [
        { "label": "Auto (Gemini)", "value": "auto" },
        { "label": "Manual", "value": "manual" },
        { "label": "Image only", "value": "passthrough" }
      ]
    },
    {
      "key": "manual_description",
      "label": "Description",
      "type": "textarea",
      "required": false,
      "default": "",
      "placeholder": "e.g. wabi-sabi minimalism, warm tungsten lighting, grainy 35mm film",
      "visibleWhen": { "mode": ["manual"] }
    },
    {
      "key": "strength",
      "label": "Strength",
      "type": "float",
      "required": false,
      "default": 0.7,
      "min": 0,
      "max": 1,
      "step": 0.05
    },
    {
      "key": "focus",
      "label": "Focus",
      "type": "enum",
      "required": false,
      "default": "all",
      "visibleWhen": { "mode": ["auto"] },
      "options": [
        { "label": "All (palette + lighting + medium + mood)", "value": "all" },
        { "label": "Palette only", "value": "palette" },
        { "label": "Lighting only", "value": "lighting" },
        { "label": "Medium / texture only", "value": "medium" }
      ]
    }
  ]
}
```

## Handler logic (`backend/handlers/style_reference.py`)

```python
async def handle_style_reference(node, inputs, api_keys, emit=None):
    file_path = node.params.get("filePath")
    if not file_path:
        raise ValueError("Style Reference needs a reference image (filePath)")

    abs_path = _normalize_local_path(file_path)  # accept /api/outputs URL or absolute path
    if not abs_path.exists():
        raise ValueError(f"Reference image not found: {abs_path}")

    image_value = {"type": "Image", "value": str(abs_path)}

    mode = node.params.get("mode", "auto")
    strength = float(node.params.get("strength", 0.7))

    if mode == "passthrough":
        return {"image": image_value, "style_description": {"type": "Text", "value": ""}}

    if mode == "manual":
        text = node.params.get("manual_description", "").strip()
        if strength != 1.0 and text:
            text = f"{text} (style strength: {strength:.2f})"
        return {"image": image_value, "style_description": {"type": "Text", "value": text}}

    # auto: call Gemini with focused system prompt
    focus = node.params.get("focus", "all")
    system_prompt = _STYLE_PROMPTS[focus]  # 4 fixed prompts; deliberately exclude subject content
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY required for Auto mode (or switch to Manual)")

    description = await _describe_style(api_key, abs_path, system_prompt)
    if strength != 1.0:
        description = f"{description} (style strength: {strength:.2f})"

    return {"image": image_value, "style_description": {"type": "Text", "value": description}}
```

`_describe_style` reuses Gemini's image-input pattern from `handlers/google_gemini.py` (`handle_gemini_chat` already does the multipart inline-data dance — extract a helper or call directly with a one-shot message).

The 4 fixed system prompts (kept short — Gemini 2.5 Flash is cheap, but every word costs):
- `all` — `"In 30-40 words, describe the VISUAL STYLE of this image: palette, lighting, medium/texture, mood, era. Do not describe the subject or what is happening. Output a single comma-separated phrase suitable for appending to a generation prompt."`
- `palette` — `"In 15 words, describe the color palette only..."`
- `lighting` — `"In 15 words, describe the lighting only..."`
- `medium` — `"In 15 words, describe the medium and texture only..."`

## Caching

`ExecutionCache` already keys on `(definition_id, params, inputs)`. For `style-reference`:
- `params.filePath` is part of the key → swapping the image re-runs.
- `params.mode/focus/strength` are part of the key → tweaking re-runs.
- No `inputs` (no input ports).

So Auto mode hits the API exactly once per (image, focus) combination per run. No extra logic needed.

## Wiring patterns this enables

```
[ Style Reference (auto) ]──image──────────────► [ nano-banana ]
                          ╰──style_description──► [ combine-text ]──text──► [ nano-banana ]:prompt
                                                  ▲
[ text-input "a corgi puppy" ]────────────────────╯
```

CLI:
```bash
python -m nebula clear
python -m nebula create style-reference --param filePath=/path/to/wes-anderson-still.png
python -m nebula create text-input --param value="a corgi puppy in a sunlit kitchen"
python -m nebula create combine-text --param template="{text1}, {text2}"
python -m nebula create nano-banana --param model=gemini-3.1-flash-image-preview
python -m nebula connect n2:text n3:text1
python -m nebula connect n1:style_description n3:text2
python -m nebula connect n3:text n4:prompt
python -m nebula connect n1:image n4:images
python -m nebula run n4
```

Variants:
- **Image-only fast path** — set `mode=passthrough`, only connect `image` to nano-banana's `images` port (multi-ref). One node, two wires.
- **Same style across many gens** — fan-out from `style_description` to multiple model nodes via `router`.
- **Style for video** — feed `style_description` into a `combine-text` template that builds Veo's prompt; feed `image` into Veo as the optional first frame.

## Tests (`backend/tests/test_style_reference.py`)

1. `test_passthrough_returns_empty_description` — no API call, image-only output is byte-identical to input file.
2. `test_manual_appends_strength_suffix` — `mode=manual`, `strength=0.5` → description ends with `(style strength: 0.50)`. With `strength=1.0`, no suffix.
3. `test_auto_calls_gemini_with_focused_prompt` — mock `httpx.AsyncClient`, assert system prompt matches `focus`, assert returned text is propagated.
4. `test_auto_missing_key_errors` — `GOOGLE_API_KEY` absent + `mode=auto` raises `ValueError` mentioning manual fallback.
5. `test_missing_file_errors` — empty `filePath` raises with a clear message.
6. `test_image_url_resolves_to_local_path` — `/api/outputs/...`-style URL is resolved via the same helper used in `main.py::_output_path_from_ref`.
7. `test_caching_skips_repeat_call` — second run with same params hits cache, mock client receives only one call. (May live in `test_engine.py` if `ExecutionCache` is exercised there; mirror the existing pattern.)

## Out of scope for this PLAN

- Brush/mask UI for inpaint (deferred to step 3 of the roadmap)
- Identity Token / Soul ID equivalent (step 4)
- Variation Fan-Out node (step 2 — separate plan)
- Real-time collab / templates / library (deferred indefinitely)
- Calling Higgsfield's own Soul-image API (no public docs, would be guesswork)

## Risks / things to verify before merging

- **Gemini's style-only prompts can leak subject content.** Manually test 5–10 references and confirm output reads as a style descriptor, not a caption. If it leaks, tighten the system prompt or add a regex post-processor to strip noun phrases.
- **`combine-text` template formatting.** The natural template is `"{text1}, {text2}"`, but commas inside `style_description` produce double commas. Acceptable; nano-banana tolerates it. Note this in SKILL.md examples.
- **Strength suffix is a soft signal.** It nudges Gemini/Imagen but does nothing for FLUX-Kontext (which has its own `guidance_scale`). Document this — don't pretend it's a real lever.

## Done criteria

- `python -m nebula info style-reference` returns the spec.
- `python -m nebula quick style-reference --param filePath=<path> --param mode=passthrough` returns `{"image": {...}, "style_description": {"value": ""}}`.
- The graph above (Style Reference + text-input + combine-text + nano-banana) runs end-to-end and produces a styled image.
- All 7 tests pass.
- SKILL.md Utility Nodes section lists Style Reference with one-line description and one example wiring.

## Estimated effort

~1 day for one developer who already knows the codebase. Most of the cost is writing tests and the 4 system prompts; the handler is small.
