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
