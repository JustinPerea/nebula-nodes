# Implementation Notes — Nebula Character

Running record of decisions made during implementation that weren't dictated by
the spec, changes made outside the original scope, tradeoffs, and surprises.

## 2026-05-30 — Wire the per-use override layer + consistencyStrength into the consumer

Closed two spec-compliance gaps a holistic integration review found: the UI
surfaced controls that did nothing.

- **Gap A** — `consistencyStrength` (Studio slider → store → bundle) was dropped
  by `expand_character` and never threaded into the base call.
- **Gap B** — the `character` node's three override params (`override_prompt`,
  `override_refs`, `strength_override`) were declared, rendered, and defaulted
  but had no consumer; the bundle omitted them and the handler docstring
  falsely claimed they were "consumed by downstream nodes."

### Decisions

- **Prompt order** — when `overridePrompt` is set, the expanded prompt is
  `"{frozenTraitString}. {base_prompt}. {overridePrompt}"`; otherwise
  `"{frozenTraitString}. {base_prompt}"`. The verbatim trait string always leads
  (identity anchor — Seedance finding); the per-use override **trails** the base
  prompt so it refines rather than displaces scene/shot intent. Documented in the
  `cinema/identity.py` module docstring and spec §4.4.

- **image_urls order** — `referenceViews` (verbatim, first) ++ the bundle's
  node-level `overrideRefs` ++ the consumer's scene/shot `override_refs`
  parameter. The bundle's per-use refs sit between the stored identity views and
  the scene/shot refs. The anti-FLORA capability guard counts the FINAL total
  (now including `overrideRefs`) against `MODEL_MAX_REFS`.

- **`override_refs` is a `file` param (single string)** — the `character` node
  handler wraps a non-empty value as a one-element list (`overrideRefs`), to
  match the list shape of `referenceViews`; empty → field omitted. No path
  resolution in the node; the consumer resolves/downloads refs exactly like
  `referenceViews` (mirrors how `character_refs` are passed as raw URL/path
  strings).

- **`strength_override` parsing** — `''` (and None/unset) is the "inherit"
  sentinel → field omitted from the bundle. A set value is parsed to float and
  clamped to 0..1 (mirrors the slider's min/max). An **unparseable** value is
  treated as inherit (field omitted) rather than raising — a malformed override
  should not break identity resolution.

- **Effective strength** — `expand_character` now returns a `strength` key:
  `strengthOverride` if set, else `consistencyStrength`; `None` on the
  no-character path. Return shape is now
  `{prompt, image_urls, seed, strength}`.

### The honest strength finding (Gap A, applied-where-supported)

- **No reachable v1 base model exposes a usable IP-adherence / reference-strength
  knob.** Verified against the actual handlers and node defs:
  - `nano-banana` (`gemini-3.1-flash-image-preview`, "Nano Banana 2") — the
    Gemini `generateContent` `imageConfig` accepts only `aspectRatio` and
    `imageSize` (see `handlers/google_gemini.py::handle_nano_banana`). No
    strength/guidance/adherence field. Identity is driven purely by re-feeding
    reference images.
  - `seedream-4-5` (`fal-ai/bytedance/seedream/v4.5/text-to-image` via
    `handle_fal_universal`) — its node def exposes only `image_size`,
    `num_images`, `max_images`, `enable_safety_checker`, `seed`
    (`frontend/src/constants/nodeDefinitions.ts`). No reference-strength param.
  - `flux-kontext` — reference-edit (kontext) with no published adherence knob.
  - Research synthesis confirms: reference-edit models keep identity by
    re-feeding refs, not by a strength dial.

- **Decision:** introduce a `MODEL_STRENGTH_PARAM: dict[str, str]` map in
  `cinema/identity.py` (keyed on the same reachable base ids as `MODEL_MAX_REFS`)
  mapping a base id → its IP-adherence param NAME. The consumer
  (`cinema_scene.py`) injects `expanded["strength"]` under that key **only when
  `strength_param_for(base_model)` returns a name**. For v1 the map is **empty**,
  so the strength is carried in the bundle but **not injected** for any base.
  Fabricating a param a model ignores would be a silent no-op — the exact
  anti-pattern this feature avoids. The dial becomes active in v2 (trained-LoRA:
  a LoRA scale is a real adherence knob); adding a future entry to the map makes
  it flow automatically with no other code change.

### Files changed

- `frontend/src/types/index.ts` — `CharacterBundle` gains optional
  `overridePrompt?`, `overrideRefs?`, `strengthOverride?`.
- `backend/handlers/character_node.py` — reads the override params, packs them
  into the bundle (omitting empties), `_parse_strength` helper; docstring fixed
  to state the overrides ride in the bundle and are applied by the consumer.
- `backend/cinema/identity.py` — `expand_character` folds in `overridePrompt`,
  `overrideRefs`, computes effective `strength`, returns the new `strength` key;
  `MODEL_STRENGTH_PARAM` map + `strength_param_for()`.
- `backend/handlers/cinema_scene.py` — injects strength into base params only
  when `strength_param_for(base_model)` is non-None; module docstring updated.
- Tests: `test_character_node.py`, `test_character_expand.py`,
  `test_cinema_scene.py` (+13 tests; full suite 801 → 814 passing).
- Docs: spec §4.3/§4.4 updated; this notes file.
