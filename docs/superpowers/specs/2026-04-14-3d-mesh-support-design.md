# 3D Mesh Support — Design Spec

> **Date:** 2026-04-14
> **Project:** Nebula Node
> **Status:** Approved — ready for implementation planning

---

## Overview

Add 3D model generation and preview to Nebula Node. New `Mesh` port type for 3D files (GLB, OBJ, FBX, STL, USDZ, PLY), inline interactive 3D preview in node body using `<model-viewer>`, click-to-expand full-screen viewer, and four new 3D generation nodes via FAL (Meshy 6 Text-to-3D, Meshy 6 Image-to-3D, Hunyuan3D V3 Text-to-3D, Hunyuan3D V3 Image-to-3D).

---

## Mesh Port Type

| Port Type | Color | Hex | Used For |
|-----------|-------|-----|----------|
| Mesh | Cyan | `#00BCD4` | 3D model files (GLB, OBJ, FBX, STL, USDZ, PLY) |

### Connection Rules

| Output Port Type | Compatible Input Port Types |
|-----------------|---------------------------|
| `Mesh` | `Mesh`, `Any` |

All other combinations with Mesh are blocked (Mesh to Image, Mesh to Video, etc.)

The port carries a local file path. The file format is whatever the model outputs (usually GLB). The preview system handles format conversion separately.

---

## 3D Preview System

### Inline Preview (in node body)

- Uses Google's `<model-viewer>` web component
- Renders in a ~200x150px container inside the node body
- Dark background matching node theme (`#161616`)
- Mouse interaction: drag to rotate, scroll to zoom
- Uses React Flow `nodrag`/`nowheel` CSS classes to prevent canvas interactions while interacting with the 3D viewer
- Only renders when node state is `complete` and has a Mesh output

### Non-GLB Format Handling

For non-GLB outputs (OBJ, FBX, STL, etc.):
- Backend converts to GLB using `trimesh` Python library
- Saves as `.preview.glb` alongside the original file
- Preview URL always points to a GLB file
- Original file passes through unchanged to downstream nodes

### Click-to-Expand Modal

- Clicking the inline preview opens a full-screen overlay
- Larger `<model-viewer>` instance with more space
- Close with Escape or X button
- Shows file info: format, file size
- Download button to save the original file locally

### Frontend Dependency

Single addition: `@google/model-viewer` npm package. No three.js needed.

---

## New Category

| Category | Color | Hex |
|----------|-------|-----|
| 3d-gen | Cyan | `#00ACC1` |

---

## Node Definitions

### Meshy 6 Text-to-3D

- **ID:** `meshy-text-to-3d`
- **Category:** `3d-gen`
- **Provider:** FAL
- **Endpoint:** `fal-ai/meshy/v6/text-to-3d`
- **Execution:** `async-poll`
- **Env:** `FAL_KEY`
- **Input Ports:** Prompt (Text, required)
- **Output Ports:** Mesh (Mesh)
- **Params:**
  - `mode`: enum (preview, full) — default: full
  - `topology`: enum (quad, triangle) — default: triangle
  - `target_polycount`: integer — default: 30000
  - `symmetry_mode`: enum (off, auto, on) — default: auto
  - `enable_pbr`: boolean — default: false
  - `pose_mode`: enum (a-pose, t-pose, "") — default: ""
  - `enable_rigging`: boolean — default: false
  - `seed`: integer — optional

### Meshy 6 Image-to-3D

- **ID:** `meshy-image-to-3d`
- **Category:** `3d-gen`
- **Provider:** FAL
- **Endpoint:** `fal-ai/meshy/v6/image-to-3d`
- **Execution:** `async-poll`
- **Env:** `FAL_KEY`
- **Input Ports:** Image (Image, required)
- **Output Ports:** Mesh (Mesh)
- **Params:**
  - `topology`: enum (quad, triangle) — default: triangle
  - `target_polycount`: integer — default: 30000
  - `symmetry_mode`: enum (off, auto, on) — default: auto
  - `should_texture`: boolean — default: true
  - `enable_pbr`: boolean — default: false
  - `pose_mode`: enum (a-pose, t-pose, "") — default: ""
  - `enable_rigging`: boolean — default: false
  - `seed`: integer — optional

### Hunyuan3D V3 Text-to-3D

- **ID:** `hunyuan3d-text-to-3d`
- **Category:** `3d-gen`
- **Provider:** FAL
- **Endpoint:** `fal-ai/hunyuan3d-v3/text-to-3d`
- **Execution:** `async-poll`
- **Env:** `FAL_KEY`
- **Input Ports:** Prompt (Text, required)
- **Output Ports:** Mesh (Mesh)
- **Params:**
  - `generate_type`: enum (Normal, LowPoly, Geometry) — default: Normal
  - `face_count`: integer — default: 500000, range: 40000-1500000
  - `enable_pbr`: boolean — default: false
  - `polygon_type`: enum (triangle, quadrilateral) — default: triangle

### Hunyuan3D V3 Image-to-3D

- **ID:** `hunyuan3d-image-to-3d`
- **Category:** `3d-gen`
- **Provider:** FAL
- **Endpoint:** `fal-ai/hunyuan3d-v3/image-to-3d`
- **Execution:** `async-poll`
- **Env:** `FAL_KEY`
- **Input Ports:**
  - Front Image (Image, required)
  - Back Image (Image, optional)
  - Left Image (Image, optional)
  - Right Image (Image, optional)
- **Output Ports:** Mesh (Mesh)
- **Params:**
  - `generate_type`: enum (Normal, LowPoly, Geometry) — default: Normal
  - `face_count`: integer — default: 500000, range: 40000-1500000
  - `enable_pbr`: boolean — default: false
  - `polygon_type`: enum (triangle, quadrilateral) — default: triangle

---

## Backend Changes

### FAL Handler Update

Extend `fal_universal.py` output parsing to detect 3D model outputs. When FAL response contains `model_glb` field, extract the GLB URL and download it to the output directory. Set output type to `Mesh`.

### GLB Preview Conversion

New endpoint: `GET /api/convert-to-glb?path=<relative_path>`
- Reads the source file from the output directory
- Converts to GLB using `trimesh`
- Saves as `<original_name>.preview.glb` alongside the original
- Returns the GLB file
- Cached: only converts once per source file

### Dependencies

Add `trimesh` to `backend/requirements.txt`.

### Output Path Rewriting

Extend `graphStore.handleExecutionEvent` to rewrite `Mesh` type absolute paths to `/api/outputs/...` URLs (same pattern as Image and Video).

---

## Frontend Changes

### Port System

- Add `Mesh` to `PortDataType` union in `types/index.ts`
- Add `Mesh: '#00BCD4'` to `PORT_COLORS` in `portCompatibility.ts`
- Add `Mesh` compatibility rules to `COMPATIBILITY` table
- Add `'3d-gen': '#00ACC1'` to `CATEGORY_COLORS` in `ports.ts`

### model-viewer Integration

- Install `@google/model-viewer` package
- Create `MeshPreview.tsx` component wrapping `<model-viewer>` with:
  - `camera-controls` attribute for rotate/zoom
  - `auto-rotate` for idle animation
  - Dark background
  - `nodrag nowheel` classes on container
  - Click handler to open full-screen modal

### Full-Screen Modal

- Create `MeshModal.tsx` component
- Full-screen overlay with `<model-viewer>` at large size
- Close on Escape or X button
- File info display (format, size)
- Download button

### Node Body Rendering

- `ModelNode.tsx`: detect Mesh output type, render `<MeshPreview>` component
- Same pattern as image preview but with the 3D viewer instead of `<img>`

---

## Reference

- [Meshy 6 Text-to-3D API](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d/api)
- [Meshy 6 Image-to-3D API](https://fal.ai/models/fal-ai/meshy/v6/image-to-3d/api)
- [Hunyuan3D V3 Text-to-3D API](https://fal.ai/models/fal-ai/hunyuan3d-v3/text-to-3d/api)
- [Hunyuan3D V3 Image-to-3D API](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d/api)
