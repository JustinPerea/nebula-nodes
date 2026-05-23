# RemotionNode Player Overlay - Rotation + Record Mode + Keyframes Implementation Plan (Plan 2.3.c)

**Goal:** Complete Phase 2.3 by adding a top rotation handle, Z-axis rotation drag, Properties Panel Rotation X/Y/Z fields, graphStore `addOrUpdateKeyframe`, toolbar `REC` toggle UI, and drag-handler routing so Player gestures write keyframes when recording is enabled.

**Branch:** `feat/remotion-player-overlay-rotation-keyframes`

**Baseline at plan authoring:**
- Branch starts from merged resize work: `a47b62c Merge branch 'feat/remotion-player-overlay-resize': Phase 2.3.b interactive layer resizing`
- Frontend build baseline: `npm run build` exits 0 with pre-existing Vite chunk-size and Lottie direct-eval warnings.
- Frontend test baseline: all 222 assertions pass, but `npm test` exits 1 when the local backend WebSocket is live because `graphStore` connects at module import and jsdom/undici throws unhandled WebSocket `Event` errors. Task 1 stabilizes this before feature work.

**Companion docs read before authoring:**
- Spec: `docs/superpowers/specs/2026-05-23-remotion-player-overlay-transform-design.md`
- Prior plan: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.md`
- Prior notes: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Implementation notes:** maintain the running log at `docs/superpowers/plans/2026-05-23-remotion-player-overlay-rotation-keyframes.implementation-notes.md` during execution.

---

## Scope

Plan 2.3.c includes:

1. Test harness WebSocket isolation so Remotion tests do not hit the live backend.
2. Pure rotation math helper with tests.
3. Rotation handle rendered above `SelectionBox` and wired to mutate `spatial.rotation[2]`.
4. Properties Panel Rotation X/Y/Z fields.
5. `graphStore.addOrUpdateKeyframe` for insert/replace/sort of keyframes.
6. Toolbar `REC` toggle button and active styling.
7. SelectionBox drag routing:
   - record off: continue mutating static `spatial`.
   - record on: move writes `keyframes.position`, resize writes `keyframes.scale`, rotate writes `keyframes.rotation`.
8. Puppeteer smoke Step 17 for record-mode drag inserting a position keyframe at the current playhead frame.

Plan 2.3.c does not include:

1. Keyframe management UI.
2. Per-axis rotation handles. The Player handle rotates Z only.
3. Properties Panel keyframe-aware edits. Numeric inputs always write static spatial.
4. Lottie happy-path spatial fix.
5. Z-order UI.
6. IsometricBlock Player hit-testing or 3D drag.

---

## Locked Decisions Carried Forward

1. Keep the dual-attribute renderer pattern from 2.3.a:
   - `data-track-item-id` for overlay hit-testing.
   - `data-track-item-content-id` for SelectionBox visual bounds.
2. Gesture math remains snapshot-then-delta:
   - pointerdown records start spatial/scale/rotation and start rect.
   - pointermove computes absolute next values from that snapshot.
3. Handle/body pointerdown calls `stopPropagation()` and `setPointerCapture()`.
4. Static drag mutations use `updateTrackItemSpatial`, which already uses `maybePushUndo`.
5. Keyframe drag mutations use `addOrUpdateKeyframe`, which must also use `maybePushUndo`.
6. Properties Panel inputs always write static spatial, regardless of `isKeyframeRecording`.
7. IsometricBlock remains excluded from Player click hit-testing.
8. CSS-driven layers keep center-origin coordinates.
9. Rotation handle is screen-aligned to the SelectionBox and rotates the selected layer around its visual center on the Z axis.
10. All new CSS stays under `body.app-slava-restraint`.

---

## Task Sequence

Seven execution tasks, one commit per task:

1. **Test harness:** stub browser WebSocket in Vitest setup and restore full-suite baseline.
2. **Rotation math:** pure helper for SelectionBox rotation angle and tests.
3. **Rotation handle:** render/style handle and wire static Z-rotation drag.
4. **Rotation fields:** add Rotation X/Y/Z fields using `SpatialAxisInput`.
5. **Keyframe store action:** add `addOrUpdateKeyframe` type, implementation, tests.
6. **REC UI + drag routing:** toolbar toggle and SelectionBox record-mode keyframe writes.
7. **Smoke:** add Puppeteer Step 17 for record-mode drag at frame 30.

After each task:

1. Run the task-focused test command.
2. Run the full frontend test suite.
3. Run the frontend production build.
4. Self-review the diff against this plan and the spec.
5. Append implementation notes for any deviation or decision.
6. Commit only files touched by the task.

Pause for Justin check-in after Task 4 before continuing to keyframe routing.

---

## Task 1 - Test Harness WebSocket Isolation

**Files:**
- Modify: `frontend/tests/setup.ts`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-rotation-keyframes.implementation-notes.md`

**Intent:** Stop Vitest from opening the real backend WebSocket through `graphStore` import side effects. Tests should not depend on whether `localhost:8000` is running.

### Step 1 - Add a no-op WebSocket stub

In `frontend/tests/setup.ts`, add a minimal `MockWebSocket` class with browser-compatible static states, no-op `send` / `close` / listener methods, and assign it to `globalThis.WebSocket`.

### Step 2 - Verify

Run:

```bash
cd frontend && npm test
```

Expected: 28 files pass, 222 tests pass, no unhandled WebSocket errors.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

---

## Task 2 - Rotation Math Helper

**Files:**
- Add: `frontend/src/lib/video/rotationMath.ts`
- Add: `frontend/tests/video/rotationMath.test.ts`
- Modify: implementation notes

**Intent:** Keep atan2/degree-offset behavior pure and directly tested before wiring SelectionBox.

Helper shape:

```ts
interface RotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeRotationZ(rect: RotationRect, clientX: number, clientY: number): number {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const angleRad = Math.atan2(clientY - cy, clientX - cx);
  return (angleRad * 180) / Math.PI + 90;
}
```

Tests:

1. pointer above center returns `0`.
2. pointer right of center returns `90`.
3. pointer below center returns `180`.
4. pointer left of center returns `270` or `-90`; normalize helper if needed so UI emits stable `270`.

Verification:

```bash
cd frontend && npm test -- rotationMath
cd frontend && npm test
cd frontend && npm run build
```

---

## Task 3 - SelectionBox Rotation Handle

**Files:**
- Modify: `frontend/src/components/video-editor/SelectionBox.tsx`
- Modify: `frontend/tests/video/SelectionBox.test.tsx`
- Modify: `frontend/src/styles/remotion-editor.css`
- Modify: implementation notes

**Intent:** Add one top rotation handle that mutates `spatial.rotation[2]` while preserving X/Y rotation.

Implementation:

1. Extend `DragSession` with `RotationDragSession`.
2. Add `handleRotatePointerDown`.
3. In pointermove, call `computeRotationZ(startRect, e.clientX, e.clientY)`.
4. Dispatch `updateTrackItemSpatial(remotionNodeId, trackItemId, { rotation: [rx, ry, nextZ] })`.
5. Render a handle with `data-rotation-handle="z"` above the box.

Tests:

1. SelectionBox renders one stable `[data-rotation-handle="z"]`.
2. Dragging rotation handle changes `rotation[2]`.
3. Dragging rotation handle preserves `rotation[0]` and `rotation[1]`.

Verification:

```bash
cd frontend && npm test -- SelectionBox
cd frontend && npm test
cd frontend && npm run build
```

---

## Task 4 - Properties Panel Rotation Fields

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`
- Modify: `frontend/tests/video/RemotionPropertiesPanel.test.tsx`
- Modify: implementation notes

**Intent:** Complete the Transform numeric surface: Position, Scale, and Rotation.

Implementation:

1. Add `onRotationValue(index, value)`.
2. Render Rotation X/Y/Z below Scale X/Y/Z using `SpatialAxisInput`.
3. Rebuild the tuple and dispatch `updateTrackItemSpatial`.

Tests:

1. Rotation X/Y/Z render with current values.
2. Editing Rotation Z updates only `spatial.rotation[2]` and preserves position/scale/other rotation axes.

Verification:

```bash
cd frontend && npm test -- RemotionPropertiesPanel SpatialAxisInput
cd frontend && npm test
cd frontend && npm run build
```

---

## Task 5 - graphStore.addOrUpdateKeyframe

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/tests/video/graphStore.spatialUpdates.test.ts`
- Modify: implementation notes

**Intent:** Add the store action used by record-mode gestures.

Implementation rules:

1. Signature:

```ts
addOrUpdateKeyframe: (
  remotionNodeId: string,
  trackItemId: string,
  propName: string,
  frame: number,
  value: number | [number, number, number],
) => void;
```

2. No-op when RemotionNode, manifest, or TrackItem is missing.
3. `Math.round(frame)` before writing.
4. Existing keyframe at same rounded frame is replaced.
5. Keyframes remain sorted ascending by frame.
6. New keyframes default to `easing: 'linear'`.
7. Uses `maybePushUndo(set, get, remotionNodeId)`.
8. Does not mutate static `spatial`.

Tests:

1. Inserts a new keyframe array for a missing prop.
2. Replaces existing same-frame keyframe.
3. Sorts keyframes by frame.
4. No-ops for missing track/remotion.
5. Debounces rapid updates into one undo entry.

Verification:

```bash
cd frontend && npm test -- graphStore.spatialUpdates
cd frontend && npm test
cd frontend && npm run build
```

---

## Task 6 - REC UI + SelectionBox Record-Mode Drag Routing

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`
- Modify: `frontend/tests/video/RemotionEditorToolbar.test.tsx`
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx`
- Modify: `frontend/src/components/video-editor/PlayerOverlay.tsx`
- Modify: `frontend/src/components/video-editor/SelectionBox.tsx`
- Modify: `frontend/tests/video/SelectionBox.test.tsx`
- Modify: `frontend/src/styles/remotion-editor.css`
- Modify: implementation notes

**Intent:** User can toggle recording in the toolbar. With recording on, drag gestures insert/replace keyframes at the current Player frame instead of changing static spatial.

Implementation:

1. Toolbar reads `isKeyframeRecording` + `toggleKeyframeRecording`.
2. Render `● REC` button after Delete with active class and title.
3. `RemotionEditorView` passes `currentFrame` to `PlayerOverlay`.
4. `PlayerOverlay` passes `currentFrame` to `SelectionBox`.
5. `SelectionBox` reads `isKeyframeRecording` and `addOrUpdateKeyframe`.
6. Move drag:
   - record off: unchanged static `{ x, y }`.
   - record on: `position`, `[nextX, nextY, startZ]`.
7. Resize drag:
   - record off: unchanged static `{ scale }`.
   - record on: `scale`, `nextScale`.
8. Rotate drag:
   - record off: unchanged static `{ rotation }`.
   - record on: `rotation`, `nextRotation`.

Tests:

1. Toolbar renders REC inactive by default and toggles store action on click.
2. Toolbar active class/title reflect recording state.
3. Body drag with recording on inserts `position` keyframe and leaves static x/y unchanged.
4. Resize drag with recording on inserts `scale` keyframe and leaves static scale unchanged.
5. Rotation drag with recording on inserts `rotation` keyframe and leaves static rotation unchanged.

Verification:

```bash
cd frontend && npm test -- RemotionEditorToolbar SelectionBox
cd frontend && npm test
cd frontend && npm run build
```

---

## Task 7 - Puppeteer Smoke Step 17

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`
- Modify: implementation notes

**Intent:** Extend the end-to-end smoke with the Plan 2.3.c acceptance path.

Implementation:

1. After Step 16, select the first Text TrackItem.
2. Seek/scrub to frame 30.
3. Enable REC through `uiStore.toggleKeyframeRecording()` or the toolbar button.
4. Drag the selection box body.
5. Assert `item.keyframes.position` contains an entry at frame 30.
6. Assert static `spatial.x/y` did not mutate during record-mode drag.
7. Disable REC and clear selection.
8. Final log becomes `all 17 steps passed`.

Verification:

```bash
node scripts/puppeteer-driver/remotion-foundation-smoke.mjs
```

Then:

```bash
cd frontend && npm test
cd frontend && npm run build
```

---

## Manual Smoke Checklist

After Task 7:

1. Add Text.
2. Select in Player.
3. Drag body: Position X/Y update.
4. Drag resize edge/corner: Scale X/Y update.
5. Drag rotation handle: Rotation Z updates.
6. Edit Rotation Z in Properties Panel: layer rotates.
7. Toggle REC: button turns active/red.
8. Scrub to frame 30.
9. Drag body: `keyframes.position` gets frame 30 and static position does not change.
10. Toggle REC off: drag returns to static mutation.
