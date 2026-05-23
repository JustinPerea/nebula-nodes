# RemotionNode Player Overlay - Resize Handles + Scale Fields Implementation Plan (Plan 2.3.b)

**Goal:** Add the second slice of interactive layer transform on the Remotion `<Player>`: eight resize handles on `SelectionBox`, corner-drag proportional scaling by default, Shift-modified corner drag for independent X/Y scaling, edge-drag one-axis stretching, Properties Panel Scale X/Y/Z fields, and Puppeteer smoke Step 16 that verifies a Text layer can be resized from the Player overlay.

**Branch:** `feat/remotion-player-overlay-resize`

**Baseline at plan authoring:**
- Prep commit already landed on this branch: `084a1f2 refactor(remotion): extract SpatialAxisInput for transform fields`
- Frontend baseline after prep: 27 files, 205 tests passing
- Build baseline after prep: `npm run build` exit 0 with pre-existing chunk-size and Lottie direct-eval warnings
- Running dev servers observed before planning: backend `:8000`, frontend `:5180`

**Companion docs read before authoring:**
- Spec: `docs/superpowers/specs/2026-05-23-remotion-player-overlay-transform-design.md`
- Template plan: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-move.md`
- Prior implementation notes: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-move.implementation-notes.md`

**Implementation notes:** maintain the running log at `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md` during execution.

---

## Scope

Plan 2.3.b includes:

1. SelectionBox gesture hardening from the 2.3.a punch list:
   - `pointercancel` handling
   - 4px dead-zone before a pointer move becomes a mutation
2. Pure resize math helper with tests:
   - four corner handles
   - four edge handles
   - Shift releases corner proportional lock
3. Eight resize handles rendered inside `SelectionBox`:
   - `corner-tl`, `corner-tr`, `corner-bl`, `corner-br`
   - `edge-top`, `edge-right`, `edge-bottom`, `edge-left`
4. Resize drag dispatch through the existing `updateTrackItemSpatial` action.
5. Scale X/Y/Z fields in the Properties Panel Transform section.
6. Puppeteer smoke Step 16 for corner resize.

Plan 2.3.b does not include:

1. Rotation handle.
2. REC toolbar UI.
3. `addOrUpdateKeyframe`.
4. Properties Panel Rotation fields.
5. Lottie happy-path spatial fix.
6. Z-order UI.
7. Renderer attribute changes.
8. IsometricBlock Player hit-testing.

---

## Locked Decisions Carried Forward

1. Renderers keep the dual-attribute pattern shipped in 2.3.a:
   - `data-track-item-id` on full `AbsoluteFill` roots for hit-testing.
   - `data-track-item-content-id` on transformed content for visual bounds.
2. Drag handlers read spatial once at pointerdown, then compute absolute new values from the start snapshot plus current delta.
3. SelectionBox handle/body pointerdown calls `stopPropagation()` and `setPointerCapture()`.
4. All spatial mutations use `updateTrackItemSpatial`, which already uses `maybePushUndo`.
5. Properties Panel inputs always write static spatial. They do not check `isKeyframeRecording`.
6. IsometricBlock remains excluded from Player click hit-testing.
7. CSS-driven layers keep center-origin coordinates.
8. All new CSS stays under `body.app-slava-restraint`.

---

## Task Sequence

Five execution tasks, one commit per task:

1. **Gesture hardening:** pointercancel + 4px dead-zone for existing body drag.
2. **Resize math helper:** pure scale-ratio helper and tests.
3. **SelectionBox handles:** render eight handles, style them, and wire resize drag.
4. **Scale fields:** add Scale X/Y/Z below Position X/Y/Z using `SpatialAxisInput`.
5. **Smoke:** add Puppeteer Step 16 and tighten Step 15 y-axis assertion.

After each task:

1. Run the task-focused test command.
2. Run the full frontend test suite.
3. Run the frontend production build.
4. Self-review the diff against this plan and the spec.
5. Append implementation notes for any deviation or decision.
6. Commit only files touched by the task.

Pause for Justin check-in after Task 3 before continuing to Tasks 4-5.

---

## Task 1 - Gesture Hardening: Pointercancel + 4px Dead-Zone

**Files:**
- Modify: `frontend/src/components/video-editor/SelectionBox.tsx`
- Modify: `frontend/tests/video/SelectionBox.test.tsx`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Intent:** Close two 2.3.a deferred items before adding more gesture handlers. The body drag should ignore optical mouse jitter under 4px, and `pointercancel` should clear the drag session.

### Step 1 - Add failing tests

Append these two tests inside the existing `describe('SelectionBox - body drag', ...)` block in `frontend/tests/video/SelectionBox.test.tsx`:

```tsx
  it('ignores pointer jitter inside the 4px dead-zone', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 53, clientY: 50 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 53, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);

    document.body.removeChild(layerEl);
  });

  it('pointercancel clears the active body drag session', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 80, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);
    expect(body.releasePointerCapture).toHaveBeenCalledWith(1);

    document.body.removeChild(layerEl);
  });
```

Run:

```bash
cd frontend && npm test -- SelectionBox
```

Expected result before implementation: 2 failures. The jitter test mutates x, and the pointercancel test keeps the drag session active.

### Step 2 - Implement the hardening

In `frontend/src/components/video-editor/SelectionBox.tsx`, add this constant after the `DragSession` interface:

```tsx
const POINTER_DEAD_ZONE_PX = 4;

function hasMovedPastDeadZone(dxScreen: number, dyScreen: number): boolean {
  return Math.hypot(dxScreen, dyScreen) > POINTER_DEAD_ZONE_PX;
}
```

Replace this block inside `handlePointerMove`:

```tsx
    if (!drag.moved && (dxScreen !== 0 || dyScreen !== 0)) {
      drag.moved = true;
    }
```

with:

```tsx
    if (!drag.moved && hasMovedPastDeadZone(dxScreen, dyScreen)) {
      drag.moved = true;
    }
```

Replace the existing `handlePointerUp` function with:

```tsx
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser during cancel.
    }
    dragRef.current = null;
  };
```

Then update the body JSX handlers from:

```tsx
        onPointerUp={handlePointerUp}
```

to:

```tsx
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
```

### Step 3 - Verify

Run:

```bash
cd frontend && npm test -- SelectionBox
```

Expected: 7 tests pass.

Run:

```bash
cd frontend && npm test
```

Expected: 27 files pass, 207 tests pass.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

### Step 4 - Commit

Stage only:

```bash
git add frontend/src/components/video-editor/SelectionBox.tsx frontend/tests/video/SelectionBox.test.tsx docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md
git commit -m "fix(remotion): harden SelectionBox body drag cancellation and dead-zone"
```

---

## Task 2 - Pure Resize Scale Math Helper

**Files:**
- Create: `frontend/src/lib/video/resizeMath.ts`
- Create: `frontend/tests/video/resizeMath.test.ts`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Intent:** Keep corner and edge math out of the React event handler. The helper uses screen-space rect ratios, matching the spec formulas.

### Step 1 - Add failing tests

Create `frontend/tests/video/resizeMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeResizeScale } from '../../src/lib/video/resizeMath';

const rect = { width: 200, height: 100 };

describe('computeResizeScale', () => {
  it('scales a corner proportionally by default using the larger width/height ratio', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [1, 1, 1],
        rect,
        dxScreen: 40,
        dyScreen: 10,
        shiftKey: false,
      }),
    ).toEqual([1.2, 1.2, 1]);
  });

  it('lets Shift release corner proportional scaling into independent X/Y ratios', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [1, 1, 1],
        rect,
        dxScreen: 40,
        dyScreen: 10,
        shiftKey: true,
      }),
    ).toEqual([1.2, 1.1, 1]);
  });

  it('inverts deltas for the top-left corner so outward drag grows the layer', () => {
    expect(
      computeResizeScale({
        handle: 'corner-tl',
        startScale: [1, 1, 1],
        rect,
        dxScreen: -20,
        dyScreen: -15,
        shiftKey: false,
      }),
    ).toEqual([1.15, 1.15, 1]);
  });

  it('updates only scale.x for the right edge', () => {
    expect(
      computeResizeScale({
        handle: 'edge-right',
        startScale: [2, 3, 4],
        rect,
        dxScreen: 40,
        dyScreen: 80,
        shiftKey: false,
      }),
    ).toEqual([2.4, 3, 4]);
  });

  it('inverts dx for the left edge', () => {
    expect(
      computeResizeScale({
        handle: 'edge-left',
        startScale: [2, 3, 4],
        rect,
        dxScreen: -20,
        dyScreen: 0,
        shiftKey: false,
      }),
    ).toEqual([2.2, 3, 4]);
  });

  it('updates only scale.y for the bottom edge', () => {
    const scale = computeResizeScale({
      handle: 'edge-bottom',
      startScale: [2, 3, 4],
      rect,
      dxScreen: 40,
      dyScreen: 20,
      shiftKey: false,
    });
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.6);
    expect(scale[2]).toBe(4);
  });

  it('inverts dy for the top edge', () => {
    const scale = computeResizeScale({
      handle: 'edge-top',
      startScale: [2, 3, 4],
      rect,
      dxScreen: 0,
      dyScreen: -10,
      shiftKey: false,
    });
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.3);
    expect(scale[2]).toBe(4);
  });

  it('returns the starting scale when rect dimensions are zero', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [2, 3, 4],
        rect: { width: 0, height: 100 },
        dxScreen: 40,
        dyScreen: 20,
        shiftKey: false,
      }),
    ).toEqual([2, 3, 4]);
  });
});
```

Run:

```bash
cd frontend && npm test -- resizeMath
```

Expected result before implementation: one failed suite because `resizeMath.ts` does not exist.

### Step 2 - Implement helper

Create `frontend/src/lib/video/resizeMath.ts`:

```ts
import type { TrackItem } from '../../types/video';

export type ResizeHandle =
  | 'corner-tl'
  | 'corner-tr'
  | 'corner-bl'
  | 'corner-br'
  | 'edge-top'
  | 'edge-right'
  | 'edge-bottom'
  | 'edge-left';

interface ResizeRect {
  width: number;
  height: number;
}

interface ComputeResizeScaleArgs {
  handle: ResizeHandle;
  startScale: TrackItem['spatial']['scale'];
  rect: ResizeRect;
  dxScreen: number;
  dyScreen: number;
  shiftKey: boolean;
}

function signedWidthDelta(handle: ResizeHandle, dxScreen: number): number {
  if (handle.endsWith('-right') || handle.endsWith('-tr') || handle.endsWith('-br')) return dxScreen;
  if (handle.endsWith('-left') || handle.endsWith('-tl') || handle.endsWith('-bl')) return -dxScreen;
  return 0;
}

function signedHeightDelta(handle: ResizeHandle, dyScreen: number): number {
  if (handle.endsWith('-bottom') || handle.endsWith('-bl') || handle.endsWith('-br')) return dyScreen;
  if (handle.endsWith('-top') || handle.endsWith('-tl') || handle.endsWith('-tr')) return -dyScreen;
  return 0;
}

function isCornerHandle(handle: ResizeHandle): boolean {
  return handle.startsWith('corner-');
}

export function computeResizeScale({
  handle,
  startScale,
  rect,
  dxScreen,
  dyScreen,
  shiftKey,
}: ComputeResizeScaleArgs): TrackItem['spatial']['scale'] {
  if (rect.width === 0 || rect.height === 0) return startScale;

  const ratioX = (rect.width + signedWidthDelta(handle, dxScreen)) / rect.width;
  const ratioY = (rect.height + signedHeightDelta(handle, dyScreen)) / rect.height;

  if (isCornerHandle(handle)) {
    if (shiftKey) {
      return [startScale[0] * ratioX, startScale[1] * ratioY, startScale[2]];
    }
    const ratio = Math.max(ratioX, ratioY);
    return [startScale[0] * ratio, startScale[1] * ratio, startScale[2]];
  }

  if (handle === 'edge-left' || handle === 'edge-right') {
    return [startScale[0] * ratioX, startScale[1], startScale[2]];
  }

  return [startScale[0], startScale[1] * ratioY, startScale[2]];
}
```

### Step 3 - Verify

Run:

```bash
cd frontend && npm test -- resizeMath
```

Expected: 8 tests pass.

Run:

```bash
cd frontend && npm test
```

Expected: 28 files pass, 215 tests pass.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

### Step 4 - Commit

```bash
git add frontend/src/lib/video/resizeMath.ts frontend/tests/video/resizeMath.test.ts docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md
git commit -m "test(remotion): cover resize scale math for SelectionBox handles"
```

---

## Task 3 - SelectionBox Resize Handles + Drag Wiring

**Files:**
- Modify: `frontend/src/components/video-editor/SelectionBox.tsx`
- Modify: `frontend/tests/video/SelectionBox.test.tsx`
- Modify: `frontend/src/styles/remotion-editor.css`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Intent:** Render all eight handles and route their pointer events through the pure helper from Task 2.

### Step 1 - Add failing SelectionBox tests

Add `ResizeHandle` import beside the existing `TrackItem` import:

```tsx
import type { ResizeHandle } from '../../src/lib/video/resizeMath';
```

Add this helper near `makePlayerFrameRef`:

```tsx
function setupSelectedLayer(spatial: TrackItem['spatial'] = { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] }) {
  const layerEl = document.createElement('div');
  layerEl.setAttribute('data-track-item-id', 'track-xyz');
  layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
  vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
    left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100, toJSON: () => ({}),
  });
  document.body.appendChild(layerEl);
  seedRemotionWithItem(makeTrackItem({ spatial }));
  return layerEl;
}

function readSelectedScale(): TrackItem['spatial']['scale'] {
  const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
  const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
  return manifest.timeline[0].spatial.scale;
}

function dragHandle(container: HTMLElement, handle: ResizeHandle, options: { dx: number; dy: number; shiftKey?: boolean }) {
  const el = container.querySelector(`[data-resize-handle="${handle}"]`) as HTMLElement;
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(el, { pointerId: 2, clientX: 300, clientY: 200 });
  fireEvent.pointerMove(el, {
    pointerId: 2,
    clientX: 300 + options.dx,
    clientY: 200 + options.dy,
    shiftKey: options.shiftKey ?? false,
  });
  fireEvent.pointerUp(el, {
    pointerId: 2,
    clientX: 300 + options.dx,
    clientY: 200 + options.dy,
  });
}
```

Append this new `describe` block at the bottom of `SelectionBox.test.tsx`:

```tsx
describe('SelectionBox - resize handles', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('renders eight resize handles with stable data attributes', () => {
    const layerEl = setupSelectedLayer();
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    const handles = Array.from(container.querySelectorAll('[data-resize-handle]')).map(
      (el) => (el as HTMLElement).dataset.resizeHandle,
    );
    expect(handles).toEqual([
      'corner-tl',
      'corner-tr',
      'corner-bl',
      'corner-br',
      'edge-top',
      'edge-right',
      'edge-bottom',
      'edge-left',
    ]);

    document.body.removeChild(layerEl);
  });

  it('corner drag scales proportionally by default', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'corner-br', { dx: 40, dy: 10 });

    expect(readSelectedScale()).toEqual([1.2, 1.2, 1]);
    document.body.removeChild(layerEl);
  });

  it('Shift corner drag scales X and Y independently', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'corner-br', { dx: 40, dy: 10, shiftKey: true });

    expect(readSelectedScale()).toEqual([1.2, 1.1, 1]);
    document.body.removeChild(layerEl);
  });

  it('right edge drag updates only scale.x', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'edge-right', { dx: 40, dy: 80 });

    expect(readSelectedScale()).toEqual([2.4, 3, 4]);
    document.body.removeChild(layerEl);
  });

  it('bottom edge drag updates only scale.y', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'edge-bottom', { dx: 80, dy: 20 });

    const scale = readSelectedScale();
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.6);
    expect(scale[2]).toBe(4);
    document.body.removeChild(layerEl);
  });
});
```

Run:

```bash
cd frontend && npm test -- SelectionBox
```

Expected result before implementation: five new failures because no handles render and no resize handler exists.

### Step 2 - Update SelectionBox implementation

Apply these changes to `frontend/src/components/video-editor/SelectionBox.tsx`:

1. Import the resize helper:

```tsx
import { computeResizeScale } from '../../lib/video/resizeMath';
import type { ResizeHandle } from '../../lib/video/resizeMath';
```

2. Replace the current `DragSession` interface with:

```tsx
interface MoveDragSession {
  type: 'move';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSpatialX: number;
  startSpatialY: number;
  moved: boolean;
}

interface ResizeDragSession {
  type: 'resize';
  pointerId: number;
  handle: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startScale: [number, number, number];
  startRect: ScreenRect;
  moved: boolean;
}

type DragSession = MoveDragSession | ResizeDragSession;
```

3. Add the handle list after `hasMovedPastDeadZone`:

```tsx
const RESIZE_HANDLES: ResizeHandle[] = [
  'corner-tl',
  'corner-tr',
  'corner-bl',
  'corner-br',
  'edge-top',
  'edge-right',
  'edge-bottom',
  'edge-left',
];
```

4. Rename the existing body pointerdown handler to `handleBodyPointerDown` and set `type: 'move'` in the session:

```tsx
    dragRef.current = {
      type: 'move',
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startSpatialX: item.spatial.x,
      startSpatialY: item.spatial.y,
      moved: false,
    };
```

5. Add a handle pointerdown factory after `handleBodyPointerDown`:

```tsx
  const handleResizePointerDown = (handle: ResizeHandle) => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === remotionNodeId);
    const manifest = (remotion?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    const item = manifest?.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    dragRef.current = {
      type: 'resize',
      pointerId: e.pointerId,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScale: item.spatial.scale,
      startRect: rect,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };
```

6. Replace the full `handlePointerMove` function with:

```tsx
  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;

    if (!drag.moved && hasMovedPastDeadZone(dxScreen, dyScreen)) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    if (drag.type === 'move') {
      const playerEl = playerFrameRef.current;
      if (!playerEl) return;
      const { x: dxComp, y: dyComp } = screenToComposition(dxScreen, dyScreen, playerEl);
      updateTrackItemSpatial(remotionNodeId, trackItemId, {
        x: drag.startSpatialX + dxComp,
        y: drag.startSpatialY + dyComp,
      });
      return;
    }

    const scale = computeResizeScale({
      handle: drag.handle,
      startScale: drag.startScale,
      rect: drag.startRect,
      dxScreen,
      dyScreen,
      shiftKey: e.shiftKey,
    });
    updateTrackItemSpatial(remotionNodeId, trackItemId, { scale });
  };
```

7. Update JSX so the body uses the renamed handler and all handles render after the body:

```tsx
      <div
        className="remotion-selection-box__body"
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`remotion-selection-box__handle remotion-selection-box__handle--${handle}`}
          data-resize-handle={handle}
          onPointerDown={handleResizePointerDown(handle)}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
```

### Step 3 - Add handle CSS

Add this block after `.remotion-selection-box__body:active` in `frontend/src/styles/remotion-editor.css`:

```css
body.app-slava-restraint .remotion-selection-box__handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid var(--sr-accent);
  background: var(--sr-canvas);
  box-shadow: 0 0 0 1px var(--sr-canvas);
  pointer-events: auto;
  z-index: 2;
}

body.app-slava-restraint .remotion-selection-box__handle--corner-tl {
  top: 0;
  left: 0;
  transform: translate(-50%, -50%);
  cursor: nwse-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--corner-tr {
  top: 0;
  right: 0;
  transform: translate(50%, -50%);
  cursor: nesw-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--corner-bl {
  bottom: 0;
  left: 0;
  transform: translate(-50%, 50%);
  cursor: nesw-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--corner-br {
  right: 0;
  bottom: 0;
  transform: translate(50%, 50%);
  cursor: nwse-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--edge-top {
  top: 0;
  left: 50%;
  transform: translate(-50%, -50%);
  cursor: ns-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--edge-right {
  top: 50%;
  right: 0;
  transform: translate(50%, -50%);
  cursor: ew-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--edge-bottom {
  bottom: 0;
  left: 50%;
  transform: translate(-50%, 50%);
  cursor: ns-resize;
}

body.app-slava-restraint .remotion-selection-box__handle--edge-left {
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  cursor: ew-resize;
}
```

### Step 4 - Verify

Run:

```bash
cd frontend && npm test -- SelectionBox
```

Expected: 12 tests pass.

Run:

```bash
cd frontend && npm test
```

Expected: 28 files pass, 220 tests pass.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

### Step 5 - Commit

```bash
git add frontend/src/components/video-editor/SelectionBox.tsx frontend/tests/video/SelectionBox.test.tsx frontend/src/styles/remotion-editor.css docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md
git commit -m "feat(remotion): resize selected layer from SelectionBox handles"
```

Pause here for Justin check-in before continuing.

---

## Task 4 - Properties Panel Scale X/Y/Z Fields

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`
- Modify: `frontend/tests/video/RemotionPropertiesPanel.test.tsx`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Intent:** Add Scale fields below Position fields in the existing Transform section. Numeric field edits write static `spatial.scale`, never keyframes.

### Step 1 - Add failing tests

Append these two tests inside `describe('RemotionPropertiesPanel - Transform section', ...)`:

```tsx
  it('renders Scale X/Y/Z inputs below Position fields', () => {
    seedAndSelect(makeTrackItem({ spatial: { x: 100, y: 50, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] } }));
    const { getByLabelText } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    expect((getByLabelText('Scale X') as HTMLInputElement).value).toBe('2');
    expect((getByLabelText('Scale Y') as HTMLInputElement).value).toBe('3');
    expect((getByLabelText('Scale Z') as HTMLInputElement).value).toBe('4');
  });

  it('typing in Scale X updates spatial.scale while preserving position and other scale axes', () => {
    seedAndSelect(makeTrackItem({ spatial: { x: 100, y: 50, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] } }));
    const { getByLabelText } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    fireEvent.change(getByLabelText('Scale X'), { target: { value: '5' } });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(100);
    expect(manifest.timeline[0].spatial.y).toBe(50);
    expect(manifest.timeline[0].spatial.scale).toEqual([5, 3, 4]);
  });
```

Run:

```bash
cd frontend && npm test -- RemotionPropertiesPanel
```

Expected result before implementation: two failures because Scale labels are absent.

### Step 2 - Implement Scale fields

Add this helper inside `RemotionPropertiesPanel`, directly below `onSpatialPatch`:

```tsx
  const onScaleValue = (index: 0 | 1 | 2, value: number) => {
    const nextScale: TrackItem['spatial']['scale'] = [
      item.spatial.scale[0],
      item.spatial.scale[1],
      item.spatial.scale[2],
    ];
    nextScale[index] = value;
    onSpatialPatch({ scale: nextScale });
  };
```

Add these fields inside the Transform section, directly below the Position Z `SpatialAxisInput`:

```tsx
        <SpatialAxisInput
          axis="x"
          label="Scale X"
          value={item.spatial.scale[0]}
          onValueChange={(value) => onScaleValue(0, value)}
        />
        <SpatialAxisInput
          axis="y"
          label="Scale Y"
          value={item.spatial.scale[1]}
          onValueChange={(value) => onScaleValue(1, value)}
        />
        <SpatialAxisInput
          axis="z"
          label="Scale Z"
          value={item.spatial.scale[2]}
          onValueChange={(value) => onScaleValue(2, value)}
        />
```

### Step 3 - Verify

Run:

```bash
cd frontend && npm test -- RemotionPropertiesPanel SpatialAxisInput
```

Expected: 8 tests pass.

Run:

```bash
cd frontend && npm test
```

Expected: 28 files pass, 222 tests pass.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

### Step 4 - Commit

```bash
git add frontend/src/components/video-editor/RemotionPropertiesPanel.tsx frontend/tests/video/RemotionPropertiesPanel.test.tsx docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md
git commit -m "feat(remotion): Properties Panel Scale X/Y/Z fields"
```

---

## Task 5 - Puppeteer Smoke Step 16: Corner Resize Text Layer

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`
- Modify: `docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md`

**Intent:** Extend the existing UI smoke from 15 to 16 steps. Step 16 selects the first Text TrackItem, drags the bottom-right corner handle, and asserts `spatial.scale[0]` and `spatial.scale[1]` increased.

### Step 1 - Add y-axis assertion to Step 15

In Step 15, after the existing `afterDrag.x <= textItem.beforeX` assertion block and before the screenshot, add:

```js
    if (afterDrag.y !== textItem.beforeY) {
      throw new Error(
        `[smoke] Step 15: spatial.y changed during horizontal drag. before=${textItem.beforeY} after=${afterDrag.y}`,
      );
    }
```

### Step 2 - Add Step 16

Insert this block after Step 15 clears selection and before the final `log('done', ...)`:

```js
    // Step 16 - Resize the first Text TrackItem via the bottom-right corner handle
    log('test-16', 'select Text layer, then drag bottom-right resize handle');
    const scaleTarget = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const text = tl.find((t) => t.componentType === 'TextNode');
      return text
        ? { id: text.id, beforeScale: text.spatial.scale }
        : null;
    });
    if (!scaleTarget) {
      throw new Error('[smoke] Step 16: no Text TrackItem on timeline');
    }
    await page.evaluate((id) => {
      window.__nebulaUIStore.getState().setSelectedTrackItem(id);
    }, scaleTarget.id);
    await sleep(300);

    const handleRect = await page.evaluate(() => {
      const handle = document.querySelector('[data-resize-handle="corner-br"]');
      if (!handle) return null;
      const r = handle.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!handleRect) {
      throw new Error('[smoke] Step 16: bottom-right resize handle not in DOM after selecting Text layer');
    }

    await page.mouse.move(handleRect.x, handleRect.y);
    await page.mouse.down();
    await page.mouse.move(handleRect.x + 120, handleRect.y + 90, { steps: 10 });
    await page.mouse.up();
    await sleep(300);

    const afterResize = await page.evaluate((id) => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const item = tl.find((t) => t.id === id);
      return item ? { scale: item.spatial.scale } : null;
    }, scaleTarget.id);
    if (!afterResize) {
      throw new Error(`[smoke] Step 16: Text TrackItem ${scaleTarget.id} disappeared after resize`);
    }
    if (afterResize.scale[0] <= scaleTarget.beforeScale[0]) {
      throw new Error(
        `[smoke] Step 16: scale.x did not increase. before=${scaleTarget.beforeScale[0]} after=${afterResize.scale[0]}`,
      );
    }
    if (afterResize.scale[1] <= scaleTarget.beforeScale[1]) {
      throw new Error(
        `[smoke] Step 16: scale.y did not increase. before=${scaleTarget.beforeScale[1]} after=${afterResize.scale[1]}`,
      );
    }
    await page.screenshot({ path: join(OUT_DIR, 'step16-text-resized.png') });
    await page.evaluate(() => {
      window.__nebulaUIStore.getState().setSelectedTrackItem(null);
    });
```

### Step 3 - Update final log

Change:

```js
    log('done', 'all 15 steps passed');
```

to:

```js
    log('done', 'all 16 steps passed');
```

### Step 4 - Verify smoke

Check servers:

```bash
lsof -i :8000 -i :5180 -P -n
```

Expected: one backend listener on `127.0.0.1:8000` and one frontend listener on `[::1]:5180`.

Run:

```bash
node scripts/puppeteer-driver/remotion-foundation-smoke.mjs --headless true
```

Expected final line:

```text
[done] all 16 steps passed
```

Run:

```bash
cd frontend && npm test
```

Expected: 28 files pass, 222 tests pass.

Run:

```bash
cd frontend && npm run build
```

Expected: exit 0. Pre-existing Vite chunk-size and Lottie direct-eval warnings may appear.

### Step 5 - Commit

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs docs/superpowers/plans/2026-05-23-remotion-player-overlay-resize.implementation-notes.md
git commit -m "test(remotion): smoke Step 16 - resize Text layer from Player handle"
```

---

## Acceptance After Plan 2.3.b

After all five tasks land, manual smoke should pass:

1. Click `+ Text`; text appears center-frame.
2. Click rendered text in the Player; selection box appears around the visual text bounds.
3. Drag selection body horizontally; text moves and Position X updates.
4. Small body jitter under 4px does not create a visible move.
5. Drag a corner handle; text scales proportionally.
6. Hold Shift while dragging a corner handle; X and Y scale independently.
7. Drag a vertical edge handle; only Scale X changes.
8. Drag a horizontal edge handle; only Scale Y changes.
9. Properties Panel Transform section shows Position X/Y/Z and Scale X/Y/Z.
10. Typing Scale X updates the selected layer without changing Position values.
11. Empty Player click still deselects.
12. IsoBlock Player click remains excluded.

Full Phase 2.3 acceptance still waits for Plan 2.3.c: rotation handle, REC toggle, keyframe insertion, and Rotation fields.

---

## Self-Review Checklist For This Plan

- Spec coverage: Plan 2.3.b scope covers corner handles, edge handles, Scale fields, and Puppeteer Step 16.
- Locked decisions preserved: no renderer changes, no IsoBlock Player hit-test, no keyframe writes from the Properties Panel, no REC behavior.
- 2.3.a lessons applied: branch before implementation, implementation notes active, pointercancel and dead-zone included before adding more handlers, plan snippets checked against current `SelectionBox.tsx`, `RemotionPropertiesPanel.tsx`, and smoke script.
- Placeholder scan passed before commit.
- Expected final test count after plan execution: 28 files, 222 tests passing.
