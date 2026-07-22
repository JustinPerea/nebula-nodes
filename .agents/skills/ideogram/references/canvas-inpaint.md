# Canvas inpaint — agent checklist (mask-painter → ideogram-edit)

Use this when an agent wires, demos, or smoke-tests masked Ideogram inpainting for a user. Follow in order; do not skip verification.

## 1. Build the graph

Add four nodes:

| Node | `definitionId` | Notes |
|---|---|---|
| Prompt | `text-input` | e.g. `shiny gold coin` or `replace label with OPEN` |
| Photo | `image-input` | User upload or preset `_previewUrl` |
| Mask | `mask-painter` | `polarity: black-edit` |
| Edit | `ideogram-edit` | `expand_prompt: true`, `num_images: 1` |

Wire **all four** edges (see parent SKILL.md). After wiring, confirm in graph export or store:

```
n*.text      → n*.prompt
n*.image     → n*.image   (mask-painter)
n*.image     → n*.image   (ideogram-edit)  ← second wire from same image-input
n*.mask      → n*.mask    (ideogram-edit)
```

## 2. Paint the mask (user or agent)

**Inspector path (required for real UI test):**

1. `selectNode(mask-painter-id)` + `setInspectorVisible(true)`.
2. Click `.mask-painter__paint-btn` → modal opens with upstream image (needs `image-input → mask-painter` wire + resolvable preview URL).
3. Paint with a **large brush** over the **target** (label, logo, object) — cover the full area to replace.
4. Save → `params._maskData` is set (data URI).

**Do not** accept a thin test stroke on blank white as success criteria for demos.

**Programmatic tests only:** generate a filled white region on black (paint semantics), not a 1px line:

```js
const c = document.createElement('canvas');
c.width = 512; c.height = 512;
const ctx = c.getContext('2d');
ctx.fillStyle = 'black';
ctx.fillRect(0, 0, 512, 512);
ctx.fillStyle = 'white';
// Filled ellipse over label region — adjust for image aspect
ctx.beginPath();
ctx.ellipse(256, 320, 140, 70, 0, 0, Math.PI * 2);
ctx.fill();
const maskData = c.toDataURL('image/png');
```

## 3. Image sources that execute

| Source | Params | Executes? |
|---|---|---|
| User upload | `filePath` + `_previewUrl` | Yes |
| Preset thumbnail | `_previewUrl: /api/presets/thumbnails/<slug>` | Yes (backend resolves to disk `.webp`) |
| `_previewUrl` only (legacy) | Without normalization | **No** — `image-input` outputs empty path |

Preset slugs: `studio-product`, `cinematic-noir`, etc. under `backend/data/presets/thumbnails/`.

## 4. Run

- UI: toolbar **Run** (`Ctrl+Enter`).
- Dev API: `window.__nebulaGraphStore.getState().executeGraph()`.
- Poll until `isExecuting === false` and `ideogram-edit` `state === 'complete'`.

Expected timeline: ~5–15s with TURBO.

### Failure messages

| Error | Cause |
|---|---|
| `Image input is required (the mask must match its dimensions)` | No wire to `mask-painter.image`, or image-input has no file |
| `No mask painted yet` | `_maskData` missing — open Paint Mask |
| Validation: mask port empty | `mask-painter` not run / no mask wire to edit |
| 422 from Ideogram | Mask size ≠ base image size (Mask Painter should prevent this) |

## 5. Verify visible inpaint (mandatory for agents)

**Do not** claim success from `state: complete` alone.

1. Read `outputs.image` on `ideogram-edit` and on upstream `image-input`.
2. Compare visually in the **masked region** (Inspector thumb or download both).
3. Optional pixel check (Python): mean RGB diff inside mask bbox should be **clearly higher** in the painted area than ~5–10 when the user should see a change. Thin wrong-place masks stay ~1–6 and look identical to the user.

Pass criteria for demos:

- User can see an obvious change **where they painted**.
- Mask overlay on `mask-painter` node shows source photo + stroke (not raw exported mask bitmap).

## 6. Driving the live app (dev)

| Global | Use |
|---|---|
| `window.__nebulaGraphStore` | `setState({ nodes, edges })`, `onConnect`, `executeGraph` |
| `window.__nebulaUIStore` | `selectNode`, `setInspectorVisible`, `togglePanel` |
| `window.__nebulaCanvas` | `fitView` |

Graph hydrates from `GET /api/graph/export` on load when the canvas is empty. To persist for the user: `POST /api/graph/import` with nodes/edges (IDs remapped to `n1`…).

## 7. Example prompt ↔ mask pairing

| Goal | Mask where | Prompt |
|---|---|---|
| Coin on product shot | Filled area on label or pedestal | `shiny gold coin, photorealistic` |
| Remove text | Filled over text | `blank cream label, no text` |
| Change background | Mask **inverse** not supported — use `ideogram-replace-background` instead | — |

## 8. Alternative: maskless label edit

`ideogram-edit-prompt` + single `image-input` + text prompt:

> `Replace the brand name on the bottle label with "AURORA BOTANICALS"`

No `mask-painter` required.
