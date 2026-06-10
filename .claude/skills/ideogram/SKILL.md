---
name: ideogram
description: >-
  Ideogram image nodes in Nebula — v4 generate, masked inpaint (ideogram-edit),
  maskless edit-prompt, remix, reframe, replace-background, character, upscale,
  transparent, remove-background, describe, magic-prompt. Activate when the user
  configures any ideogram-* node, asks about Ideogram in Nebula, or wants to wire
  or test mask-painter → ideogram-edit inpainting on the canvas. Covers dual-route
  auth (IDEOGRAM_API_KEY direct vs FAL_KEY fallback), mask polarity (BLACK = edit),
  the four-wire canvas graph, Inspector mask painting, expand_prompt, preset image
  execution, auto-wire of base image, and how to verify a visible inpaint result.
  Sourced from docs/api-guides/ideogram.md and live canvas E2E on feat/inpainting
  (2026-06-10).
---

# Ideogram in Nebula

## When to use

- User configures or asks about any `ideogram-*` node.
- User wants **masked inpainting** on the canvas (`mask-painter` → `ideogram-edit`).
- User says the edit "looks the same" / no visible output / mask node shows a weird B&W square.
- Agent is wiring, smoke-testing, or demoing the inpaint flow for the user.

API param details and route tables: `docs/api-guides/ideogram.md`. FAL dialect notes: `.claude/skills/fal/SKILL.md`.

## Universal rules

1. **Dual route.** `IDEOGRAM_API_KEY` → direct `api.ideogram.ai`; else `FAL_KEY` → FAL slugs. Inspector shows the param set for the active route.
2. **Mask polarity: BLACK = edit** (both routes). On `mask-painter`, set **Painted Area Means → Black = edit (Ideogram)**. Painted strokes are stored white-on-black in `_maskData`; the engine inverts at export for Ideogram.
3. **Mask dimensions must match the base image exactly.** Mask Painter resizes to upstream image size — always wire **the same base image** into `ideogram-edit.image` and into `mask-painter.image`.
4. **Output is on the edit node.** After Run, `ideogram-edit` shows the result inside its card (`state: complete`, `outputs.image`). No downstream output node required.

## Canvas inpaint — agent playbook

**Read `references/canvas-inpaint.md` before wiring or running inpaint for a user.** It is the step-by-step checklist agents kept getting wrong.

### Minimum graph (four wires)

```
text-input ──text──► ideogram-edit.prompt
image-input ──image──► mask-painter.image
image-input ──image──► ideogram-edit.image    ← REQUIRED (mask-painter does NOT pass the photo)
mask-painter ──mask──► ideogram-edit.mask
```

Connecting `mask → edit` **auto-wires** `upstream image → edit.image` when that port is empty (frontend `graphStore.onConnect`). Still verify all four edges before Run.

### Mask painting (Inspector only)

1. Select `mask-painter` → Inspector → **Paint Mask** (not on the canvas node body).
2. Paint a **filled region** over everything you want changed — not a hairline stroke on empty background.
3. **Bad:** thin diagonal on white table + prompt "gold coin" → invisible even when the run succeeds.
4. **Good:** brush over the **label / object / face** you want replaced; use a thick brush or fill the area.

### Params before Run

| Node | Set |
|---|---|
| `mask-painter` | `polarity: black-edit` |
| `ideogram-edit` | `expand_prompt: true` (or `magic_prompt: AUTO` on direct route) for stronger interpretation |
| `text-input` | Prompt describes what should appear **in the masked region** |

### Image input

- Uploaded images: need `filePath` (set automatically on upload).
- Preset thumbnails: `_previewUrl` like `/api/presets/thumbnails/studio-product` is enough — execute normalizes to `filePath` on the backend.

### Run + verify

1. Toolbar **Run** (or `executeGraph` / `POST /api/execute`).
2. All nodes should reach `complete`. If `mask-painter` errors with "Image input is required", the base image wire is missing or `image-input` has no resolvable file.
3. **Visible inpaint check:** output should differ **inside the masked bbox**, not just globally. If the masked region looks unchanged, the mask is too small, on the wrong surface, or unfilled — have the user repaint (or repaint yourself via Inspector), don't rerun with the same mask.
4. `ideogram-edit` output is often a **different resolution** (e.g. 1024² from 640²) but composition should show a clear change in the painted area when done right.

### When masked inpaint is the wrong tool

- **Replace label text / remove object without drawing a mask** → `ideogram-edit-prompt` (maskless, prompt-driven edit).
- **FLUX-style fill (white = edit)** → `flux-fill-inpaint` + `mask-painter` polarity **White = edit**.

## Node quick map

| Node | Use |
|---|---|
| `ideogram-v4` | Text-to-image, typography-first |
| `ideogram-edit` | Masked inpaint — prompt + image + mask |
| `ideogram-edit-prompt` | Maskless edit ("remove the lamp post") |
| `ideogram-remix` | Image + prompt restyle (v4 direct) |
| `ideogram-reframe` | Outpaint to new aspect (direct needs `resolution` enum) |
| `ideogram-replace-background` | Subject + new background prompt |
| `ideogram-character` | One `character_reference_images` per request |
| `ideogram-upscale` | Upscale with optional prompt |

## Live smoke (backend)

```bash
cd backend && .venv/bin/python scripts/smoke_ideogram_live.py
# dual-route remainder only:
.venv/bin/python scripts/smoke_ideogram_live.py --remaining-dual-route
```

Requires `IDEOGRAM_API_KEY` and/or `FAL_KEY` in Settings.

## Agent mistakes (do not repeat)

| Mistake | Symptom | Fix |
|---|---|---|
| Only `image → mask → edit` chain | Weak/global edit or validation failure | Also wire `image → edit.image` (or re-connect mask to trigger auto-wire) |
| Thin stroke on empty white | Run succeeds, looks identical | Filled mask over the target object/text |
| Raw B&W mask on mask-painter card | Confusing preview | Expected before composite fix; node should show source + overlay when wired |
| `_previewUrl` only, no Run | No output on edit node | Run graph; output appears on `ideogram-edit` when `complete` |
| `expand_prompt: false` + vague prompt | Subtle/no visible change | Enable expand / stronger prompt |
| Programmatic mask = 1px line | API succeeds, invisible edit | Use filled ellipse/rectangle over target region in test scripts |
