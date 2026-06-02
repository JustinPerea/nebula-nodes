---
name: krea
description: Use when building or editing a Nebula graph containing Krea 2 direct API nodes, Krea image style references, Krea styles, moodboards, style search, or style training. Covers node IDs, graph wiring, params, provider resource objects, direct-Krea-only routing, API-key requirements, and live-test caveats.
---

# Krea — Nebula Integration

Use Krea direct API nodes only. FAL Krea endpoints are intentionally not part of this integration.

Source of truth for provider behavior: `docs/model-providers/krea/krea-2.md`.

## Node IDs

| Node | Purpose |
|---|---|
| `krea-2-generate` | Krea 2 Medium/Large text-to-image with image style references, styles, and one moodboard |
| `krea-image-style-reference` | Wrap one image with per-reference strength `0..1` |
| `krea-style` | Wrap an existing Krea style/LoRA ID with strength `-2..2` |
| `krea-moodboard` | Wrap an existing Krea moodboard ID with strength `0..1` |
| `nebula-moodboard` | Nebula-native provider-neutral moodboard; Krea consumes it as style image references plus a style-brief prompt suffix |
| `krea-style-search` | List/search Krea styles from the authenticated API workspace/public filters |
| `krea-style-train` | Train a Krea style from image inputs and emit a style object plus style ID |

## Auth

- Nebula expects `KREA_API_TOKEN` in settings/API keys. `KREA_API_KEY` is accepted as a fallback by the backend handler.
- Krea API balance is separate from workspace compute balance. A valid token can still return `402` until the API balance is topped up.
- Never store or print user tokens in docs, screenshots, logs, or skill files.

## Krea 2 Generate

Required port:
- `prompt` (`Text`)

Optional ports:
- `style_images` (`Image`, multiple, max 10): simple style references. The handler uploads local/generated images to Krea assets and maps them to `image_style_references`.
- `image_style_references` (`Any`, multiple, max 10): outputs from `krea-image-style-reference`.
- `styles` (`Any`, multiple): outputs from `krea-style` or `krea-style-train`.
- `moodboard` (`Any`, max 1): output from `krea-moodboard`.
  - Can also accept a Nebula-native `Moodboard` output from `nebula-moodboard`; the handler adapts representative images to Krea `image_style_references` because Krea does not expose public moodboard creation.

Params:
- `variant`: `medium` or `large`
- `aspect_ratio`: `1:1`, `4:3`, `3:2`, `16:9`, `2.35:1`, `4:5`, `2:3`, `9:16`
- `resolution`: `1K` only
- `creativity`: `raw`, `low`, `medium`, `high`
- `seed`: optional integer
- `style_reference_strength`: fallback strength for raw `style_images`
- `style_id` / `style_strength`: fallback manual style ID
- `moodboard_id` / `moodboard_strength`: fallback manual moodboard ID

## Graph Patterns

Basic text-to-image:

```text
text-input:text -> krea-2-generate:prompt
```

Image style reference with a per-image strength:

```text
text-input:text -> krea-2-generate:prompt
image-input:image -> krea-image-style-reference:image
krea-image-style-reference:image_style_reference -> krea-2-generate:image_style_references
```

Raw style images when one shared strength is enough:

```text
text-input:text -> krea-2-generate:prompt
image-input:image -> krea-2-generate:style_images
```

Existing style ID:

```text
krea-style-search -> inspect returned style IDs
krea-style:style -> krea-2-generate:styles
```

New trained style:

```text
image-input:image -> krea-style-train:images
krea-style-train:style -> krea-2-generate:styles
```

Existing moodboard ID:

```text
krea-moodboard:moodboard -> krea-2-generate:moodboard
```

Nebula-native moodboard:

```text
nebula-moodboard:moodboard -> krea-2-generate:moodboard
```

## Resource Rules

- Use `krea-image-style-reference` when different style images need different strengths.
- Use raw `style_images` only when one fallback `style_reference_strength` is acceptable for every image.
- Use `krea-style-search` to find style IDs, then `krea-style` to pass one into `krea-2-generate`.
- Use `krea-style-train` when the user wants to create a new Krea style from images. Its `style` output can feed directly into `krea-2-generate.styles`.
- Krea moodboards are referenced by existing ID. The verified Krea API docs did not expose public moodboard create/list endpoints, so Nebula cannot create Krea-owned moodboards directly yet.
- Nebula-native moodboards are separate provider-neutral assets. When wired into Krea 2, representative images become Krea image style references and the extracted style brief is appended to the prompt.
- `krea-2-generate` accepts at most 10 image style references and at most 1 moodboard.
- `krea-style` strength supports `-2..2`; image style reference and moodboard strengths support `0..1`.

## Provider Resource Objects

Wrapper nodes intentionally emit provider-specific objects on `Any` ports:

- Image style reference: `{ kind: "krea_image_style_reference", image, strength }`
- Style: `{ kind: "krea_style", id, strength }`
- Krea moodboard: `{ kind: "krea_moodboard", id, strength }`
- Nebula moodboard: `{ kind: "nebula_moodboard", moodboardId, name, mode, strength, images, analysis, styleBrief, negativePrompt, palette, representativeImages, providerHints }`

Do not hand-roll these shapes unless necessary. Prefer the wrapper nodes so the graph is inspectable and users can tune strengths from the UI.

## Agent Workflow

1. Build Krea graphs with the direct Krea nodes above, not FAL.
2. Keep Krea 2 defaults conservative for first runs: `variant: medium`, `resolution: 1K`, `creativity: low` or `medium`.
3. If the user gives multiple visual references, prefer `krea-image-style-reference` nodes so each strength is explicit.
4. If the user asks for a reusable style, use `krea-style-train`; if they already have a style ID, use `krea-style`.
5. If the user asks for moodboards, ask for or use an existing Krea moodboard ID. Do not claim Nebula can create moodboards through Krea yet.
6. When testing live generation, expect possible `402` API-balance failures even when auth is correct. Verify low-cost paths such as `krea-style-search` when generation credits are unavailable.

## Validation

Useful checks after editing Krea nodes or handlers:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_krea_handler.py backend/tests/test_node_registry.py backend/tests/test_node_contracts.py backend/tests/test_codex_session.py -q
node scripts/check-node-contracts.mjs
```
