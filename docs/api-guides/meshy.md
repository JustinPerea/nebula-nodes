# Meshy in Nebula Nodes

> Meshy turns text prompts and reference images into game-ready 3D models — then lets you re-texture, retopologize, auto-rig, animate, and even prep them for a multi-color 3D printer, all by wiring nodes together on the Nebula canvas.

## What you can make

**3D models**
- Build a 3D model from 1–4 photos of the same object taken from different angles (Meshy Multi-Image-to-3D).
- Re-skin an existing model with a brand-new look from a text prompt (Meshy Retexture).
- Clean up or convert an existing model — change topology (triangles ↔ quads), cut the polygon count, resize it, or export to GLB/FBX/OBJ/USDZ/STL/BLEND (Meshy Remesh).

**Characters (rig + animate)**
- Auto-rig a humanoid model so it has a skeleton you can pose (Meshy Auto-Rig).
- Drop a ready-made animation onto a rigged character — idle, walk, run, jump, dance, sword swing, and more (Meshy Animate).

**2D reference art**
- Generate a concept image from text, optionally as a 4-view turnaround sheet that feeds straight into 3D (Meshy Text-to-Image).
- Transform reference images into a new style image with a prompt (Meshy Image-to-Image). Both run on Nano Banana / Nano Banana Pro / GPT Image 2.

**3D printing**
- Turn a finished 3D model into a multi-color print file (`.3mf`) with a chosen color budget, ready for Bambu Studio / OrcaSlicer (Meshy 3D Print).

## Nodes available in Nebula (8)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Meshy Multi-Image-to-3D | `meshy-multi-image-to-3d` | 3d-gen | `images` (1–4 images, required) | `ai_model` (latest/meshy-6/meshy-5), `should_remesh`, `topology`, `target_polycount` (100–300k), `should_texture`, `enable_pbr`, `pose_mode`, `hd_texture` (4K), `image_enhancement`, `remove_lighting` | Building a textured 3D model from a few photos of the same object |
| Meshy Retexture | `meshy-retexture` | 3d-gen | `model_url` (text, required), `prompt` (style, optional) | `ai_model`, `enable_original_uv`, `enable_pbr`, `remove_lighting` | Giving an existing model a new texture/material from a text style prompt |
| Meshy Auto-Rig | `meshy-rigging` | 3d-gen | `model_url` (text, required) | `height_meters` (0.1–5, default 1.7) | Adding a skeleton to a textured humanoid GLB so it can be animated; outputs a **Rig Task ID** |
| Meshy Animate | `meshy-animate` | 3d-gen | `rig_task_id` (text, required — from Auto-Rig) | `action_id` (Idle/Walking/Running/Jumping/Dancing/Waving/Sitting/Clapping/Punching/Kicking/Sword Swing), `fps` (24/25/30/60) | Applying a library animation to a rigged character |
| Meshy Remesh | `meshy-remesh` | 3d-gen | `model_url` (text, required) | `topology` (triangle/quad), `target_polycount` (100–300k), `target_formats` (glb,fbx,obj,usdz,blend,stl), `resize_height` (m), `convert_format_only` | Retopology, polygon reduction, resizing, and format conversion of an existing model |
| Meshy Text-to-Image | `meshy-text-to-image` | image-gen | `prompt` (text, required) | `ai_model` (nano-banana / nano-banana-2 / nano-banana-pro / gpt-image-2), `generate_multi_view`, `aspect_ratio` (only when multi-view off), `pose_mode` | Making a concept image or a 4-view turnaround sheet to feed into 3D |
| Meshy Image-to-Image | `meshy-image-to-image` | image-gen | `prompt` (text, required), `images` (reference images, required) | `ai_model` (nano-banana / nano-banana-2 / nano-banana-pro / gpt-image-2), `generate_multi_view` | Restyling reference images with a prompt |
| Meshy 3D Print | `meshy-3d-print` | 3d-gen | `task_id` (text, required — the Meshy task ID of a finished 3D model) | `max_colors` (1–16, default 4), `max_depth` (3–6, default 4) | Producing a multi-color `.3mf` print file from a generated model |

Notes for the curious:
- **Output ports.** The 3D nodes emit a `mesh` (downloaded locally and previewed on the canvas). **Meshy Auto-Rig** additionally emits a `task_id` (the Rig Task ID) — that is the wire you plug into Meshy Animate.
- **`pose_mode` and `symmetry_mode`.** `pose_mode` (A-Pose / T-Pose) helps when the model is destined for rigging. A legacy `symmetry_mode` param exists on Multi-Image-to-3D but is hidden/deprecated and no longer affects output.
- **Aspect ratio vs. multi-view.** On Text-to-Image these are mutually exclusive — the UI hides `aspect_ratio` when Multi-View is on (matching the API rule). GPT Image 2 only supports `1:1`, `3:2`, `2:3`.

## How to use it in Nebula

**Where the nodes live.** Open the node palette on the canvas and look under **3D Generation** (the `3d-gen` nodes: Multi-Image-to-3D, Retexture, Auto-Rig, Animate, Remesh, 3D Print) and **Image Generation** (the `image-gen` nodes: Text-to-Image, Image-to-Image). Drag a node onto the canvas, connect its inputs, and run.

**API key setup.** Meshy needs one credential. Add it to your `.env` at the repo root:

```
MESHY_API_KEY=msy-your-key-here
```

Get the key from the Meshy dashboard (Settings → API). Keys look like `msy-…`. Meshy is credit-metered, so each run draws from your account balance. (There is also a test-mode key documented by Meshy for dry runs.)

**Recipe 1 — Photos to a printable trinket.**
1. Drop **Meshy Multi-Image-to-3D** (`meshy-multi-image-to-3d`) and feed it 1–4 photos of the same object from different angles. Leave `should_texture` on; set `ai_model` to `latest`.
2. Wire its `mesh` into **Meshy 3D Print** (`meshy-3d-print`). For the print node's `task_id`, pass the Meshy task ID of the finished model (use a text node, or chain from a node that surfaces the task ID).
3. Set `max_colors` to taste (e.g. 4) and run. Download the `.3mf` and open it in your slicer.

**Recipe 2 — Concept art straight into 3D.**
1. **Meshy Text-to-Image** (`meshy-text-to-image`): prompt something like "a stylized fantasy treasure chest", turn **Multi-View on** so you get a 4-angle turnaround.
2. Feed those views into **Meshy Multi-Image-to-3D** (`meshy-multi-image-to-3d`) — multiple consistent angles are exactly what it wants.
3. Optionally pass the result through **Meshy Retexture** (`meshy-retexture`) with a style prompt like "weathered bronze with verdigris" to restyle without regenerating geometry.

**Recipe 3 — Rig and animate a character.**
1. Generate or supply a textured humanoid GLB (keep it under ~300k faces; run **Meshy Remesh** first if it's heavier). Set `pose_mode` to A-Pose or T-Pose upstream for best rigging results.
2. Connect the model URL into **Meshy Auto-Rig** (`meshy-rigging`); set `height_meters` (default 1.7).
3. Wire Auto-Rig's **`task_id`** output into **Meshy Animate**'s (`meshy-animate`) `rig_task_id` input. Pick an `action_id` (e.g. Walking or Sword Swing) and optionally an `fps`. Run and download the animated GLB.

## API coverage — what Nebula uses vs. what Meshy offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text-to-3D (`/v2/text-to-3d`) | yes | none | Nebula's `meshy-text-to-3d` node is **FAL-backed** (uses `FAL_KEY`, not the direct Meshy API), so the native endpoint isn't called by any of these 8 nodes. |
| Image-to-3D (`/v1/image-to-3d`) | yes | none | Same — Nebula's `meshy-image-to-3d` is FAL-backed, outside this provider. |
| Multi-Image-to-3D (`/v1/multi-image-to-3d`) | yes | full | `meshy-multi-image-to-3d`. Core params exposed (model, remesh, topology, polycount, texture, PBR, pose, HD texture, enhancement, remove-lighting). |
| Remesh (`/v1/remesh`) | yes | full | `meshy-remesh`. Topology, polycount, formats, resize-height, convert-only all exposed. |
| Convert (`/v1/convert`) | yes | partial | Standalone format-conversion endpoint (May 2026). Not wired as its own node; Remesh's `convert_format_only` + `target_formats` covers the common case, but the dedicated endpoint's `input_task_id` chaining is unused. |
| Resize (`/v1/resize`) | yes | partial | Standalone resize endpoint (May 2026). Remesh's `resize_height` overlaps; the dedicated endpoint (`resize_longest_side`, etc.) is not surfaced. |
| Retexture (`/v1/retexture`) | yes | partial | `meshy-retexture` accepts `model_url` + text style prompt. Missing: `image_style_url` (image-driven retexture) and `input_task_id` chaining. |
| Rigging (`/v1/rigging`) | yes | full | `meshy-rigging`. `model_url` + `height_meters`; emits the rig task ID for animation. (Native `input_task_id`/`texture_image_url` not exposed, but the core flow works end to end.) |
| Animation (`/v1/animations`) | yes | partial | `meshy-animate` exposes 11 curated actions of Meshy's 580+ library, plus `change_fps`. Missing post-process ops `fbx2usdz` and `extract_armature`. |
| Text-to-Image (`/v1/text-to-image`) | yes | full | `meshy-text-to-image`. All 4 models, multi-view, aspect-ratio, pose-mode. |
| Image-to-Image (`/v1/image-to-image`) | yes | full | `meshy-image-to-image`. Model, prompt, reference images, multi-view — the full param set the API supports. |
| Multi-Color Print (`/v1/print/multi-color`) | yes | full | `meshy-3d-print`. `input_task_id`, `max_colors`, `max_depth`. |
| Analyze Printability (`/v1/analyze-printability`) | yes | none | Free print-readiness check (watertightness, holes, non-manifold edges), May 2026. No Nebula node. |
| Repair Printability (`/v1/repair-printability`) | yes | none | Auto-fixes printability issues (10 credits), May 2026. No Nebula node. |
| Creative Lab — Keychain | yes | none | Product-template endpoint (prototype → build), June 2026. Not in Nebula. |
| Creative Lab — Fridge Magnet | yes | none | Product-template endpoint, June 2026. Not in Nebula. |
| Creative Lab — Figure | yes | none | Product-template endpoint, June 2026. Not in Nebula. |
| Creative Lab — Lamp | yes | none | Product-template endpoint, June 2026. Not in Nebula. |
| Balance (`/v1/balance`) | yes | none | Account credit-balance check. No Nebula node (no in-canvas credit display). |
| Webhooks | yes | none | Async completion callbacks. Nebula polls every 3s instead — functionally equivalent for the user, but webhooks aren't used. |
| List / Delete / Stream (SSE) per endpoint | yes | none | Task listing, permanent delete, and SSE streaming exist on every endpoint; Nebula uses polling and doesn't list or delete tasks. |

Coverage: ~35% of the Meshy API surface is exposed in Nebula (6 of ~22 capability families wired fully, 4 partial; counting only the core generation/processing families a creator reaches for, it's closer to ~45%).

Notable unused capabilities: the entire **Creative Lab** product line (Keychain, Fridge Magnet, Figure, Lamp), the **Printability** pair (Analyze + Repair), standalone **Convert** and **Resize** endpoints with `input_task_id` chaining, **image-driven retexture** (`image_style_url`), the **`fbx2usdz` / `extract_armature`** animation post-processes, the **Balance** endpoint, and **webhooks/streaming**. The two native text-to-3D / image-to-3D endpoints are also not driven through these direct nodes (Nebula reaches that capability via FAL instead).

## Agent skill coverage

**A complete skill exists** at `.claude/skills/meshy/SKILL.md` and it is unusually thorough. `SKILL.md` plus four topic/reference files (`3d-generation.md`, `post-processing.md`, `2d-generation.md`, `reference/endpoints.md`, `reference/credits.md`, `reference/rate-limits.md`, `reference/animation-library.md`, `reference/handler-gaps.md`) cover all **8** Meshy nodes that exist today: the async submit/poll lifecycle, auth header, base URL and the v1/v2 split, status codes, the full endpoint map (create/retrieve/delete/list/stream), per-endpoint output field paths, credit pricing, rate-limit/429 handling, a 580+ entry `action_id` library, prompting guidance, and an explicit Nebula node-to-endpoint mapping. It even carries a `handler-gaps.md` that pre-identifies most of the partial-coverage items above (image-driven retexture, `input_task_id` chaining, animation post-process ops, the multi-view/aspect-ratio exclusivity rule). For driving the 8 shipped nodes, the skill is complete.

Note on scope: the skill predates the **April–June 2026** API additions and so does not mention the **Creative Lab** endpoints (Keychain / Fridge Magnet / Figure / Lamp), the **Analyze/Repair Printability** endpoints, or the standalone **Convert** and **Resize** endpoints. None of those have Nebula nodes either, so the gap is consistent end-to-end; if/when those nodes are added, the skill's endpoint map and credit table will need a refresh.

## Sources

- https://docs.meshy.ai/ (capability surface overview)
- https://docs.meshy.ai/en/api/quick-start (endpoint list, base URL, auth)
- https://docs.meshy.ai/en/api/changelog (2026 additions: Creative Lab, Printability, Convert/Resize, Meshy 6, hd_texture/decimation_mode)
- https://docs.meshy.ai/en/api/convert (Convert endpoint — input_task_id/model_url, target_formats)
- https://docs.meshy.ai/en/api/text-to-image (ai_model values, multi-view/aspect-ratio exclusivity, output)
- https://docs.meshy.ai/en/api/image-to-3d (referenced via search; ai_model selection, texturing, PBR)
- https://docs.meshy.ai/en/api/rigging-and-animation (rigging/animation introduction)
