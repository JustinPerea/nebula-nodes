# Meshy Single-Image-to-3D — Expose Missing Params

Captured 2026-04-23 after a dogfood session where Claude wrapped a single image in `array-builder` and fed it to `meshy-multi-image-to-3d` — because that's the only Meshy node that exposes `pose_mode` (T-pose/A-pose) for rigging-ready output.

---

## Problem

`meshy-image-to-3d` (FAL-routed) currently exposes **zero params** in the node definition:

```
INPUTS:
  image           Image     required
  texture_image   Image     optional
OUTPUTS:
  mesh            Mesh
```

But Meshy's actual API for single-image-to-3D supports the full param set:
- `ai_model` (enum)
- `should_remesh` (boolean)
- `topology` (enum: triangle / quad)
- `target_polycount` (integer)
- `symmetry_mode` (enum: off / auto / on)
- `should_texture` (boolean)
- `enable_pbr` (boolean)
- `pose_mode` (enum: '' / a-pose / t-pose)
- `image_enhancement` (boolean)
- `remove_lighting` (boolean)

Same set as `meshy-multi-image-to-3d`.

## Workaround caught

A primer heuristic (`SINGLE IMAGE → 3D`) tells Claude not to wrap a single image in array-builder just to reach the multi-image endpoint. That stops the bad pattern, but leaves a real capability gap: if a user genuinely wants T-pose output from a single image, the current node can't deliver it.

## Fix

Option A — **Expand `meshy-image-to-3d`** with the same 10-param surface. Verify FAL's routing of this endpoint actually forwards these params (or whether the direct-Meshy route is needed).

Option B — **Add a `meshy-image-to-3d-direct`** node that routes to Meshy's API directly (paralleling the `meshy-multi-image-to-3d` direct route). Keep the FAL variant for users who prefer that auth path, but direct route gets full param surface.

Lean toward Option A if FAL passes the params through. Option B adds a second node and fragments the decision space.

## Estimated scope

Small-to-medium. ~1 hour to probe FAL's accepted param set, update `node_definitions.json`, test live, and update the primer heuristic to reflect new capability.

---

## Disposition

| Date | Status |
|------|--------|
| 2026-04-23 | Captured after primer-heuristic dogfood catch. Parked. |
