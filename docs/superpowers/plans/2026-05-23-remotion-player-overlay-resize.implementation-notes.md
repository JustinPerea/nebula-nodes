# Plan 2.3.b — Implementation Notes

Running log of decisions, deviations, and tradeoffs for
`docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.md`.

## Prep — SpatialAxisInput extraction

### Decisions outside the spec

- Created the resize branch before the prep extraction. The handoff sequence
  listed the extraction before branch creation, but the locked workflow says
  never implement on `main`. Branching first preserves that invariant.
- The helper uses `onValueChange(value: number)` instead of accepting a
  `Partial<TrackItem['spatial']>` directly. Position fields can still patch
  `{ x }`, `{ y }`, and `{ z }` from the caller, but Scale/Rotation fields are
  tuple-backed (`scale: [x, y, z]`, `rotation: [x, y, z]`). A value callback keeps
  the helper reusable for all three transform groups without rewriting it in the
  next task.

### Changes

- Added a focused `SpatialAxisInput` test before creating the component.

### Tradeoffs

- Kept the existing `data-spatial-axis` selector contract because the current
  Properties Panel tests already depend on it.

## Plan authoring

### Decisions outside the spec

- Included the 2.3.a deferred pointercancel and dead-zone fixes as Task 1 before
  resize handles. The same gesture machinery will be shared by body and handle
  drags, so hardening it first keeps the resize task smaller.
- Put resize ratio math in a pure `resizeMath.ts` helper before wiring React
  handlers. This mirrors the existing `coordinates.ts` pattern and gives the
  corner/edge sign rules direct test coverage.
- Added the Step 15 y-axis smoke assertion to Task 5 while adding Step 16. It is
  a small adjacent smoke gap from 2.3.a and does not alter product scope.

### Changes

- Authored `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.md`
  with five execution tasks and exact verification commands.

### Self-review

- Ran the plan placeholder scan and got no hits.

## Task 1 — SelectionBox body drag hardening

### Decisions outside the spec

- None so far. Followed the plan template: 4px Euclidean dead-zone and shared
  `endDrag` handler for `pointerup` / `pointercancel`.

### Changes

- Added tests proving 3px pointer jitter does not mutate spatial values.
- Added tests proving `pointercancel` releases pointer capture and prevents later
  pointermove from mutating the layer.

## Task 2 — Resize scale math helper

### Decisions outside the spec

- Used `toBeCloseTo` for the tests that multiply by `1.1` / `1.2` on a
  non-integer starting scale. Direct tuple equality would make the test depend
  on floating-point representation details rather than the resize rule.

### Changes

- Added `resizeMath.ts` with the eight handle identifiers and
  `computeResizeScale`.
- Covered proportional corners, Shift independent corners, edge-only stretch,
  inverted left/top deltas, and zero-size rect fallback.
