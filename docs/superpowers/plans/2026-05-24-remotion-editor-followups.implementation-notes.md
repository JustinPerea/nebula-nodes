# Remotion Editor Followups — Implementation Notes

Running notes for the follow-up pass after Phase 2.3.c.

## Goal

Implement and verify the remaining Remotion editor followups:

- Lottie happy-path spatial/selection behavior.
- Z-order controls.
- Keyframe management UI.
- IsoBlock Player hit-testing/drag, or a clearly scoped substitute if direct 3D
  raycast drag is too broad for this pass.
- Multi-select.
- Snapping/guides.
- Anchor-point controls.

After each implementation, do a short usability review: what would make this
more intuitive for a human editor user?

## Constraints

- Do not touch the unrelated dirty files currently in the worktree.
- Keep changes incremental with focused tests before broad verification.
- Properties Panel numeric transform inputs continue to write static spatial
  unless a specific keyframe-management control says otherwise.

## Task 1 — Lottie happy-path spatial

### Decisions outside the spec

- Kept the transform on the `data-track-item-content-id` wrapper for successful
  Lottie renders instead of pushing it into the `<Lottie>` component. The wrapper
  is the element SelectionBox measures and the element PlayerOverlay hit-tests;
  keeping the transform there makes Lottie consistent with the empty/loading
  Lottie states and with the other CSS-driven renderers.

### Human/intuitive review

- The user should not have to know that a Lottie is in a different loading
  state. Empty, loading, and successful Lottie layers should all select, move,
  resize, and rotate the same way.

## Task 2 — Z-order controls

### Decisions outside the spec

- Added store-level `reorderTrackItem` with four explicit actions:
  `send-to-back`, `send-backward`, `bring-forward`, and `bring-to-front`.
  The renderer already treats timeline order as visual stacking order, so the UI
  only needs to reorder manifest timeline entries.
- Used discrete undo snapshots instead of `maybePushUndo`; each button click is
  one intentional editor command, not a high-frequency drag stream.

### Human/intuitive review

- Exposed both step controls and jump controls. Humans usually need both:
  nudging one layer forward for fine stacking and sending an item straight to
  front/back when organizing a composition.
- Disabled impossible endpoint actions so buttons explain the current stack
  position without a failed click.

## Task 3 — Keyframe management UI

### Decisions outside the spec

- Added store-level `updateKeyframe` and `deleteKeyframe` commands instead of
  making the Properties Panel rewrite manifest data inline. This keeps undo
  behavior and manifest updates in the same place as the existing spatial and
  add-keyframe commands.
- Kept this pass to frame/value/delete controls grouped by property. Easing
  edits and timeline-lane drag handles are still separate UX work; this makes
  existing keyframes visible and correctable without expanding the editor
  surface yet.
- Guarded numeric edits against non-finite input so a temporary invalid number
  field state does not write `NaN` into the manifest.

### Human/intuitive review

- Keyframes are shown directly under Transform because that is where users look
  when a selected layer is moving. Hiding them elsewhere would make animation
  feel like invisible state.
- Each row keeps frame, value, and delete together. That makes a keyframe feel
  like one editable object instead of scattering related controls across the
  panel.
- Delete buttons include the property and frame in their accessible name, so a
  long list of keyframes is still understandable outside the visual layout.

## Task 4 — IsoBlock Player hit-testing/drag substitute

### Decisions outside the spec

- Did not implement true Three.js mesh raycasting in this pass. Instead,
  IsometricBlock now uses the same 2D layer wrapper contract as the CSS-backed
  renderers: `data-track-item-id` on the layer root,
  `data-track-item-content-id` on the transformed content wrapper, and
  interpolated opacity/position/rotation/scale on that wrapper.
- Made the IsoBlock content wrapper a finite 360px square viewport instead of a
  full-composition transparent surface. This gives SelectionBox a tangible
  layer box to measure and prevents one 3D layer from acting like the entire
  Player is clickable.
- Tightened PlayerOverlay hit-testing to prefer content-wrapper hits. It falls
  back to `data-track-item-id` only for legacy/empty renderers that do not have
  a content wrapper.

### Human/intuitive review

- A 3D block now behaves like a draggable viewport layer. That is less precise
  than clicking the mesh itself, but it is understandable: the user moves and
  resizes the box that contains the 3D scene.
- Clicks outside the visible layer wrapper no longer select a full-frame
  transparent root. This makes deselection and selecting lower layers feel
  deliberate instead of sticky.
- True object-level picking should still be treated as a future 3D-specific
  interaction, not hidden inside the 2D overlay path.

## Task 5 — Multi-select selection/drag

### Decisions outside the spec

- Preserved `selectedTrackItemId` as the primary selection so the Properties
  Panel, Z-order controls, and keyboard shortcuts keep their existing mental
  model. Added `selectedTrackItemIds` for additive selection and group movement.
- Player and timeline clicks now use Shift/Cmd/Ctrl as additive selection
  modifiers. Plain click still replaces the selection; blank Player click still
  clears it.
- Group drag is intentionally move-only in this pass. Resize and rotation
  handles stay on the primary selection box to avoid ambiguous multi-layer
  scaling/rotation rules.

### Human/intuitive review

- The primary selected layer keeps the solid outline and handles. Secondary
  selected layers use dashed outlines with no resize/rotate handles, which
  makes it clear which layer owns the detailed Properties Panel controls.
- Dragging any selected box moves the whole selected group by the same
  composition-space delta. That matches how humans expect multi-select to work:
  the group preserves relative spacing.
- Bulk delete and group Z-order can be added later, but keeping this pass to
  selection plus group move avoids surprising destructive commands while the
  selection model is new.
