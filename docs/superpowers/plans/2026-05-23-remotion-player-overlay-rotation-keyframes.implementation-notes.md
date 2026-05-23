# Plan 2.3.c — Implementation Notes

Running log of decisions, deviations, and tradeoffs for
`docs/superpowers/plans/2026-05-23-remotion-player-overlay-rotation-keyframes.md`.

## Plan authoring

### Decisions outside the spec

- Added a test-harness stabilization task before rotation/keyframe work. The
  feature baseline has 222/222 passing assertions, but `graphStore` opens the
  real backend WebSocket at module import. When the backend is running, jsdom /
  undici can raise unhandled WebSocket `Event` errors and make `npm test` exit
  1. Fixing that first keeps the full-suite gate deterministic.
- Kept rotation math in a pure helper before React wiring, matching the
  `coordinates.ts` and `resizeMath.ts` pattern from 2.3.a/b.
- Planned a pause after Rotation fields and before keyframe routing. The first
  four tasks complete the visible rotation surface; the remaining tasks alter
  store semantics and drag dispatch routing.

### Verification notes

- Baseline `npm run build`: exit 0 with pre-existing Vite chunk-size and Lottie
  direct-eval warnings.
- Baseline `npm test`: 28 files / 222 assertions pass, but Vitest exits 1 due
  the WebSocket unhandled errors described above.

## Task 1 — Test harness WebSocket isolation

### Decisions outside the spec

- Stubbed `globalThis.WebSocket` in the shared Vitest setup instead of mocking
  `wsClient` in each Remotion test. The import side effect is in `graphStore`,
  and most video tests import that store directly; a single setup stub keeps the
  suite hermetic without broad per-file mocks.
- The stub intentionally does not auto-fire `open` / `message` events. Current
  unit tests do not assert socket behavior, and silent no-op transport is enough
  to prevent real backend connections.

### Changes

- Added a minimal browser-compatible `MockWebSocket` with static ready-state
  constants and no-op `send` / `close` methods.

## Task 2 — Rotation math helper

### Decisions outside the spec

- Normalized rotation degrees into `[0, 360)` in the pure helper. The spec's
  atan2 formula can produce `-90` for left-of-center; stable positive degrees
  make Properties Panel display and tests easier to reason about.

### Changes

- Added `rotationMath.ts` with `computeRotationZ`.
- Added tests for above/right/below/left cardinal pointer positions.

## Task 3 — SelectionBox rotation handle

### Decisions outside the spec

- The rotation handle reuses the same `handlePointerMove` / `endDrag` path as
  move and resize gestures. That keeps dead-zone and pointercancel behavior
  consistent across all SelectionBox interactions.
- Styled the rotation affordance as a small circular handle with a connector
  line above the SelectionBox. It is separate from `[data-resize-handle]` so
  existing resize tests and selectors remain stable.

### Changes

- Added a `RotationDragSession` branch to SelectionBox drag state.
- Added one `data-rotation-handle="z"` handle.
- Added tests for handle presence, rotation.z updates, and preserving
  rotation.x/y.

## Task 4 — Properties Panel Rotation fields

### Decisions outside the spec

- None so far. Rotation inputs reuse `SpatialAxisInput`, and edits rebuild the
  rotation tuple before dispatching `updateTrackItemSpatial`.

### Changes

- Added Rotation X/Y/Z below Scale X/Y/Z.
- Added tests for rendering current rotation values and preserving unrelated
  transform fields when editing Rotation Z.

## Task 5 — graphStore.addOrUpdateKeyframe

### Decisions outside the spec

- Cloned tuple values before storing them in keyframes. Drag handlers build fresh
  tuples today, but cloning prevents future callers from mutating a tuple after
  the store accepts it.

### Changes

- Added `addOrUpdateKeyframe` to the graph store interface and implementation.
- Added tests for insert, same-frame replace, frame sorting, missing target
  no-ops, static spatial preservation, and undo debounce behavior.

## Task 6 — REC UI + SelectionBox record-mode drag routing

### Decisions outside the spec

- Added `currentFrame` as an optional prop with a default of `0` on
  `PlayerOverlay` / `SelectionBox`. The editor passes the real frame, while
  existing focused tests can keep their smaller render helpers.
- SelectionBox now subscribes to the selected item's `keyframes` and the
  `currentFrame` prop as well as static spatial. Record-mode drag changes do
  not mutate `spatial`, but they can still move the rendered layer via
  interpolation at the current frame; the box needs those changes to recalc its
  bounds.
- Used ASCII hyphens in the REC title text to match the repo's default ASCII
  editing discipline.

### Changes

- Added toolbar `REC` button with active styling.
- Routed move/resize/rotate gestures to `addOrUpdateKeyframe` when recording is
  active.
- Added tests for toolbar state and record-mode keyframe writes for position,
  scale, and rotation.

### Verification notes

- First focused/full/build attempt failed because `currentFrame` was added to
  the prop type and call sites but not destructured in `SelectionBox`. Fixed the
  destructuring and removed the now-unneeded nullish fallback at call sites.

## Task 7 — Smoke Step 17

### Decisions outside the spec

- Added a small `window.__nebulaRemotionEditor` automation hook for smoke tests,
  analogous to the existing `__nebulaGraphStore` / `__nebulaUIStore` hooks.
  Pixel-clicking the third-party timeline to land exactly on frame 30 is brittle;
  the hook calls `Player.seekTo(frame)`, updates the local `currentFrame` state,
  and moves the timeline cursor together.
- Added `data-current-frame` to `.remotion-editor-view` as a visible DOM signal
  for current frame debugging.

### Changes

- Extended the Puppeteer smoke with Step 17: select Text, seek to frame 30,
  enable REC through the toolbar button, drag the SelectionBox body, assert a
  `position` keyframe at frame 30, assert static `spatial.x/y` stayed unchanged,
  then disable REC and clear selection.

### Verification notes

- First headless smoke attempt failed before app assertions with Puppeteer's
  intermittent `Protocol error (Runtime.callFunctionOn): Promise was collected`,
  same class of flake observed in 2.3.b.
- Retried against the warmed Vite page; smoke final line:
  `[done] all 17 steps passed`.
- Headless run still emits the known IsoBlock WebGL context errors after Step
  14; they did not block Steps 15-17.
