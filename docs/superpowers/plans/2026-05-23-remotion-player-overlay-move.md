# RemotionNode Player Overlay — Selection + Move Drag + Position Fields Implementation Plan (Plan 2.3.a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first slice of interactive layer transform on the Remotion `<Player>`: a `PlayerOverlay` that hit-tests rendered layers via `document.elementsFromPoint`, a `SelectionBox` outline that follows the selected layer's bounding rect, a body-drag gesture that mutates `TrackItem.spatial.x/y` through a new debounced graphStore action, plus a Properties Panel "Transform" section with X/Y/Z inputs. After this lands, a user can click a Text layer in the Player and drag it where they want — selection state syncs with the timeline; numeric inputs in the Properties Panel reflect (and edit) the same spatial values.

**Architecture:** A new `PlayerOverlay.tsx` mounts a transparent absolutely-positioned `<div>` over the Remotion `<Player>` slot inside `RemotionEditorView`. On `pointerdown`, it reads `document.elementsFromPoint(x, y)` and walks each result with `.closest('[data-track-item-id]')`. A hit writes `uiStore.selectedTrackItemId`; a miss (no layer at that point) clears it. When a selection exists, the overlay renders `SelectionBox.tsx`, which reads the selected layer's `getBoundingClientRect()` each frame (`useEffect` over `currentFrame`), positions an outline at those screen coordinates, and routes a body-drag gesture through a new `screenToComposition` helper that converts screen-pixel deltas into composition-pixel deltas (1280×720). Drag dispatches a new `graphStore.updateTrackItemSpatial` action that partial-merges into `TrackItem.spatial` and uses `maybePushUndo` so each gesture collapses into one undo entry. Five CSS-driven renderers (Text, SVG, Image, Video, Lottie) each gain `data-track-item-id={item.id}` on their `<AbsoluteFill>` root so hit-testing finds them. `IsometricBlockRenderer` is explicitly excluded (3D drag is deferred to a later phase). The Properties Panel gains a "Transform" section between the existing "Time" section and the componentType-specific sections, with Position X/Y/Z inputs that always write to static `spatial` (never to keyframes — those land in Plan 2.3.c). `uiStore` gains an `isKeyframeRecording: boolean` field + `toggleKeyframeRecording` action; the field defaults to `false` and is unused in 2.3.a wiring, but exists now so 2.3.b/c can use it without touching state shape again.

**Tech Stack:** React 19 + Zustand + `@remotion/player` + Vitest + Puppeteer. No new dependencies — native pointer events + existing React/Zustand.

**Source branch:** `feat/remotion-player-overlay-move` (branched from `main` at `a514e36` — the Phase 2.3 design spec commit)

**Companion docs (read before starting):**
- **Spec (required):** `docs/superpowers/specs/2026-05-23-remotion-player-overlay-transform-design.md` — 410 lines. Read fully. Plan 2.3.a's scope is in the "Sub-phase split" section.
- Original spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` (§2 schema with `spatial` + `keyframes`)
- Plan 2.1.a foundation: `docs/superpowers/plans/2026-05-22-remotion-node-foundation.md` (renderer pattern with `<AbsoluteFill>` + `placeItems: center` + `transform: translate3d(...)`)
- Plan 2.1.c editor UI: `docs/superpowers/plans/2026-05-22-remotion-node-editor-ui.md` (selection state, properties panel, `pushUndo` / `maybePushUndo` precedent)
- Plan 2.2 R3F + Lottie: `docs/superpowers/plans/2026-05-22-remotion-r3f-lottie-phase-2-2.md` (the just-shipped Lottie renderer pattern)
- Existing graphStore mutation precedent: `frontend/src/store/graphStore.ts:1247-1322` — `updateTrackItemProps` and `updateTrackItemTime` (both use `maybePushUndo(set, get, remotionNodeId)` — match the same pattern for the new action)
- Existing renderer pattern: `frontend/src/components/video-editor/components/TextRenderer.tsx` — every CSS-driven renderer wraps in `<AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>` so the inner element is centered and `spatial.x/y` work as translations from composition center.
- Existing uiStore selection field: `frontend/src/store/uiStore.ts` — `selectedTrackItemId: string | null` + `setSelectedTrackItem(id)` already exist from 2.1.c. Reuse them.
- xzdarcy CSS import gotcha: `frontend/src/components/video-editor/RemotionTimeline.tsx:1-10` — Phase 2.1.a forgot to import `@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css`. When integrating a new visual UI surface, check its `dist/*.css` and import it explicitly. Plan 2.3.a's overlay + selection box CSS is hand-written in `remotion-editor.css` (no third-party stylesheet), so this gotcha doesn't directly recur — but keep the lesson in mind.

**Phase 2.3 scope split (this plan is 1/3):**
- ✅ Phase 2.3 design spec (shipped 2026-05-23 in `a514e36`)
- ▶ **This plan (2.3.a — Selection model + move drag + Position fields):** the foundation
- ⏭ Plan 2.3.b — Resize handles (corner + edge) + Scale fields
- ⏭ Plan 2.3.c — Rotation handle + Record toggle + `addOrUpdateKeyframe` action + Rotation fields

---

## File Structure

### New frontend files (6)

| File | Responsibility |
|------|----------------|
| `frontend/src/components/video-editor/PlayerOverlay.tsx` | Transparent `<div>` mounted over the Player slot. On `pointerdown`, hit-tests via `document.elementsFromPoint` + `.closest('[data-track-item-id]')`. A hit dispatches `setSelectedTrackItem(id)`; a miss dispatches `setSelectedTrackItem(null)`. When `selectedTrackItemId` is non-null, renders `<SelectionBox>`. ~80 lines. |
| `frontend/src/components/video-editor/SelectionBox.tsx` | Reads the selected layer's bounding rect via `getBoundingClientRect()` each render (recomputed via `currentFrame` from the player); positions an outline `<div>` at those screen coordinates. The outline body is itself a drag-handle: `pointerdown` on the body initiates a translate-drag that accumulates screen-pixel deltas, converts via `screenToComposition`, and dispatches `updateTrackItemSpatial({ x, y })`. ~140 lines (final form; 2.3.a uses ~110 lines of this). |
| `frontend/src/lib/video/coordinates.ts` | Pure-function helper module. Exports `screenToComposition(dxScreen, dyScreen, playerEl, compositionWidth?, compositionHeight?)` which reads `playerEl.getBoundingClientRect()` and scales the screen delta into composition coordinates. Defaults: 1280×720 (matches `RemotionEditorView`'s hardcoded composition dimensions). |
| `frontend/tests/video/PlayerOverlay.test.tsx` | Component tests: hit-test logic returns id when matching el at point; pointerdown with hit dispatches `setSelectedTrackItem(id)`; pointerdown with miss dispatches `setSelectedTrackItem(null)`. |
| `frontend/tests/video/SelectionBox.test.tsx` | Component tests: returns null when target element not found; renders an outline div positioned via `getBoundingClientRect`; body pointerdown→pointermove→pointerup dispatches `updateTrackItemSpatial` with correctly-scaled deltas. |
| `frontend/tests/video/coordinates.test.ts` | Pure-function unit tests: returns zero for zero deltas; scales 1:1 when player rect matches composition; scales correctly when player rect is downsized (e.g., 640×360 player → 1280×720 composition doubles the delta). |
| `frontend/tests/video/graphStore.spatialUpdates.test.ts` | Integration tests for `updateTrackItemSpatial`: partial-merge into spatial; no-op on missing TrackItem; no-op on missing RemotionNode; `maybePushUndo` collapses rapid same-node patches into one undo entry. |
| `frontend/tests/video/renderers.dataTrackItemId.test.tsx` | One file asserting all 5 CSS-driven renderers set `data-track-item-id` on their root `<AbsoluteFill>` (both happy and empty-state branches). |

### Modified frontend files (10)

| File | Change scope |
|------|--------------|
| `frontend/src/store/uiStore.ts` | Add `isKeyframeRecording: boolean` field (default `false`), add `toggleKeyframeRecording: () => void` action, and reset the field to `false` inside the existing `exitRemotionEditor` action body so re-entering an editor doesn't carry recording state across sessions. |
| `frontend/src/store/graphStore.ts` | Add `updateTrackItemSpatial(remotionNodeId, trackItemId, spatialPatch)` action. Signature, no-op guards, and `maybePushUndo(set, get, remotionNodeId)` placement mirror the existing `updateTrackItemProps` at `graphStore.ts:1247-1278`. Spatial patch shallow-merges into `TrackItem.spatial`. |
| `frontend/src/components/video-editor/RemotionEditorView.tsx` | Import `PlayerOverlay`. Mount it inside the `__player` div, after the `<Player>`. Wrap the Player in a positioned container so the overlay's `position: absolute; inset: 0` lands on the Player's exact rendered bounds. Pass `playerRef` and `remotionNodeId` through. |
| `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx` | Add a new "Transform" `<section>` between the existing "Time" section (`PropertiesPanel.tsx:55-74`) and the componentType-specific sections. Three labeled `<input type="number">` fields for `spatial.x`, `spatial.y`, `spatial.z`. New `onSpatialPatch(patch)` helper inside the component that dispatches `updateTrackItemSpatial`. |
| `frontend/src/components/video-editor/components/TextRenderer.tsx` | Add `data-track-item-id={item.id}` to the `<AbsoluteFill>` root. |
| `frontend/src/components/video-editor/components/SVGRenderer.tsx` | Add `data-track-item-id={item.id}` to both `<AbsoluteFill>` returns (happy path AND `[no svg source]` empty-state path). |
| `frontend/src/components/video-editor/components/ImageRenderer.tsx` | Add `data-track-item-id={item.id}` to both `<AbsoluteFill>` returns (happy + `[no image src]` empty-state). |
| `frontend/src/components/video-editor/components/VideoRenderer.tsx` | Add `data-track-item-id={item.id}` to both `<AbsoluteFill>` returns (happy + `[no video src]` empty-state). |
| `frontend/src/components/video-editor/components/LottieRenderer.tsx` | Add `data-track-item-id={item.id}` to all three `<AbsoluteFill>` returns (happy + `[no lottie src]` + `[loading lottie…]`). |
| `frontend/src/styles/remotion-editor.css` | Add Slava-scoped rules for `.remotion-player-overlay`, `.remotion-selection-box`, `.remotion-selection-box__body`, and `.remotion-properties-panel__transform-section` (the last reuses the existing `__section` pattern). All rules nested under `body.app-slava-restraint`. |

### Modified test files (1)

| File | Change scope |
|------|--------------|
| `frontend/tests/video/uiStore.remotionEditor.test.ts` | Append a new `describe('uiStore — keyframe recording')` block: default value, toggle flips it, `exitRemotionEditor` resets to false. |

### Modified driver scripts (1)

| File | Change scope |
|------|--------------|
| `scripts/puppeteer-driver/remotion-foundation-smoke.mjs` | Add Step 15 — drag the first Text TrackItem's selection box body, assert `spatial.x` increased by the expected composition delta. Update the final log from "all 14 steps passed" to "all 15 steps passed". |

### Files NOT touched (isolation invariants)

- All Phase 1 editor code (`frontend/src/components/editor/`)
- All Phase 2.1.a/b/c renderers' inner content — only the `<AbsoluteFill>` root attribute changes
- `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx` — explicitly excluded; 3D layers stay timeline-selectable only
- `frontend/src/components/video-editor/RemotionComposition.tsx`
- `frontend/src/components/video-editor/RemotionTimeline.tsx`
- `frontend/src/components/video-editor/RemotionEditorToolbar.tsx` (REC toggle button is 2.3.c, not 2.3.a)
- `frontend/src/components/video-editor/useRemotionKeyboard.ts`
- `frontend/src/lib/video/keyframeInterp.ts`, `manifestValidator.ts`, `mirroring.ts`
- `frontend/src/types/video.ts` (schema unchanged — all needed fields already present from 2.1.a)
- All backend files

### Design invariants the plan enforces

1. **One mutation pattern for spatial.** Drag → `updateTrackItemSpatial`. Properties Panel inputs → `updateTrackItemSpatial`. Same action, same `maybePushUndo` debounce.
2. **Center-origin coordinates.** Renderers continue to use `<AbsoluteFill style={{ placeItems: 'center' }}>`; `spatial.x/y` translate FROM center. The plan does not introduce top-left origin anywhere.
3. **Properties Panel always writes static spatial.** No record-mode branching in 2.3.a. Even when `isKeyframeRecording` is `true` (which can only happen via the toggle action), typed numbers in the Position fields still write to `updateTrackItemSpatial`, not to keyframes. Rationale: numeric input is "set value", not a gesture.
4. **Ctrl-Z reversibility.** `updateTrackItemSpatial` uses `maybePushUndo(set, get, remotionNodeId)` — the same debounced helper used by `updateTrackItemProps` / `updateTrackItemTime`. Each drag gesture collapses into one undo entry; each numeric-input flurry collapses likewise.
5. **Selection is shared between Player and timeline.** The existing `uiStore.selectedTrackItemId` is the single source of truth. Player clicks (this plan) write it; timeline clicks (already wired in 2.1.c) write it; the Properties Panel reads it.
6. **3D layers excluded by design.** `IsometricBlockRenderer.tsx` does not get `data-track-item-id`. Player clicks on iso blocks return null → deselect. Iso blocks remain timeline-selectable.
7. **Slava restraint scope.** All new CSS rules in `remotion-editor.css` are nested under `body.app-slava-restraint`. No inline styles in components outside `frontend/src/components/video-editor/` (the existing exemption already covers files inside that directory).
8. **No new deps.** Native pointer events + existing React/Zustand.
9. **Plan-verbatim execution.** Match all templates verbatim. The only acceptable deviations are real bugs caused by following the plan literally (the T1 spike pattern from Phase 2.2 — fix and document). Speculative defensive coding goes to backlog.

---

## Task Sequence

7 tasks across 6 phases. Each task is one commit. Each commit must leave `npm run build` exit 0 and `npm test` passing.

- **Phase A — Store actions** (Tasks 1-2: uiStore field + graphStore action)
- **Phase B — Selectable layer DOM** (Task 3: data-track-item-id on 5 renderers)
- **Phase C — Player overlay + click-to-select** (Task 4: PlayerOverlay + SelectionBox scaffolding + mount)
- **Phase D — Body drag = translate** (Task 5: coordinates helper + SelectionBox body drag handler)
- **Phase E — Properties Panel Transform section** (Task 6: Position X/Y/Z fields)
- **Phase F — Smoke** (Task 7: Puppeteer Step 15)

---

### Phase A — Store actions

### Task 1: `isKeyframeRecording` field + `toggleKeyframeRecording` action on uiStore

**Files:**
- Modify: `frontend/src/store/uiStore.ts`
- Test: `frontend/tests/video/uiStore.remotionEditor.test.ts` (append)

Even though 2.3.a does not surface the recording toggle in the UI (that's 2.3.c's REC button), the state shape exists now so 2.3.b/c don't have to touch uiStore again.

- [ ] **Step 1: Add the failing tests**

Open `frontend/tests/video/uiStore.remotionEditor.test.ts`. Append a new describe block at the bottom (after the existing `describe('uiStore — TrackItem selection')` block):

```ts
describe('uiStore — keyframe recording', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_STATE, true);
  });

  it('isKeyframeRecording defaults to false', () => {
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });

  it('toggleKeyframeRecording flips the field', () => {
    useUIStore.getState().toggleKeyframeRecording();
    expect(useUIStore.getState().isKeyframeRecording).toBe(true);
    useUIStore.getState().toggleKeyframeRecording();
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });

  it('exitRemotionEditor resets isKeyframeRecording to false', () => {
    useUIStore.setState({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: 'r1',
      isKeyframeRecording: true,
    });
    useUIStore.getState().exitRemotionEditor();
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- uiStore.remotionEditor 2>&1 | tail -10`
Expected: 3 NEW failures with `toggleKeyframeRecording is not a function` (or similar) plus the 6 existing tests still passing.

- [ ] **Step 3: Add the field, interface entry, initial state, and action**

In `frontend/src/store/uiStore.ts`, find the existing `selectedTrackItemId: string | null;` line in the `UIState` interface. Add directly below:

```ts
  isKeyframeRecording: boolean;
```

In the actions section of the interface, find the existing `setSelectedTrackItem: (id: string | null) => void;` line. Add directly below:

```ts
  toggleKeyframeRecording: () => void;
```

In the initial state inside `create<UIState>((set, get) => ({ ... }))`, find the existing `selectedTrackItemId: null,` line. Add directly below:

```ts
  isKeyframeRecording: false,
```

Find the existing `exitRemotionEditor` action body. It currently reads:

```ts
  exitRemotionEditor: () => {
    set({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
      selectedTrackItemId: null,
      isPlaying: false,
    });
  },
```

Replace with:

```ts
  exitRemotionEditor: () => {
    set({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
      selectedTrackItemId: null,
      isKeyframeRecording: false,
      isPlaying: false,
    });
  },
```

Find the existing `setSelectedTrackItem` action body. Add a new action directly below it:

```ts
  toggleKeyframeRecording: () => {
    set((s) => ({ isKeyframeRecording: !s.isKeyframeRecording }));
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- uiStore.remotionEditor 2>&1 | tail -10`
Expected: 9 PASS (6 existing + 3 new).

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 170/170 (baseline 167 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/uiStore.ts frontend/tests/video/uiStore.remotionEditor.test.ts
git commit -m "feat(remotion): isKeyframeRecording field + toggleKeyframeRecording on uiStore"
```

---

### Task 2: `updateTrackItemSpatial` graphStore action with maybePushUndo

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.spatialUpdates.test.ts` (NEW)

The action partial-merges a `Partial<SpatialTransform>` into the selected TrackItem's `spatial`. Pattern mirrors `updateTrackItemProps` and `updateTrackItemTime` at `graphStore.ts:1247-1322` — same no-op guards, same `maybePushUndo(set, get, remotionNodeId)` call before the `set()`.

- [ ] **Step 1: Add the failing test file**

Create `frontend/tests/video/graphStore.spatialUpdates.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hello' },
    ...overrides,
  };
}

function seedRemotionWithItem(trackItem: TrackItem) {
  const remotionNode = {
    id: 'r1',
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: {
        manifest: { graph: { nodes: [], edges: [] }, timeline: [trackItem] },
      },
      state: 'idle' as const,
      outputs: {},
    },
  };
  const sourceNode = {
    id: trackItem.sourceNodeId,
    type: 'model-node',
    position: { x: -300, y: 0 },
    data: { definitionId: 'text-input', label: 'text-input', params: {}, state: 'idle' as const, outputs: {} },
  };
  useGraphStore.setState({ nodes: [remotionNode as never, sourceNode as never] });
}

describe('graphStore — updateTrackItemSpatial', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('shallow-merges spatialPatch into the existing spatial', () => {
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    }));
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 100 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(100);
    expect(manifest.timeline[0].spatial.y).toBe(20); // preserved
    expect(manifest.timeline[0].spatial.z).toBe(0);  // preserved
    expect(manifest.timeline[0].spatial.scale).toEqual([1, 1, 1]); // preserved
  });

  it('preserves scale and rotation when only x/y change', () => {
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 0, y: 0, z: 0, scale: [2, 2, 2], rotation: [0, 90, 0] },
    }));
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 50, y: -25 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.scale).toEqual([2, 2, 2]);
    expect(manifest.timeline[0].spatial.rotation).toEqual([0, 90, 0]);
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().updateTrackItemSpatial('r1', 'does-not-exist', { x: 999 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(0);
  });

  it('no-ops if the RemotionNode does not exist', () => {
    useGraphStore.getState().updateTrackItemSpatial('does-not-exist', 't1', { x: 999 });
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('debounces rapid same-node patches into one undo entry', () => {
    seedRemotionWithItem(makeTrackItem());
    const undoBefore = useGraphStore.getState().undoStack.length;

    // Three rapid patches on the same remotion node within the 500ms window
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 10 });
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 20 });
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 30 });

    const undoAfter = useGraphStore.getState().undoStack.length;
    // maybePushUndo should have collapsed these into a single new entry
    expect(undoAfter - undoBefore).toBe(1);

    // Final value still reflects the last patch
    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- graphStore.spatialUpdates 2>&1 | tail -10`
Expected: 5 FAILs with `updateTrackItemSpatial is not a function`.

- [ ] **Step 3: Add the action signature to the GraphState interface**

In `frontend/src/store/graphStore.ts`, find the existing `updateTrackItemProps` signature in the interface (around `graphStore.ts:205-209`):

```ts
  updateTrackItemProps: (
    remotionNodeId: string,
    trackItemId: string,
    propsPatch: Record<string, unknown>,
  ) => void;
```

Add directly below (still inside the interface):

```ts
  updateTrackItemSpatial: (
    remotionNodeId: string,
    trackItemId: string,
    spatialPatch: Partial<TrackItem['spatial']>,
  ) => void;
```

- [ ] **Step 4: Add the action implementation**

In `frontend/src/store/graphStore.ts`, find the existing `updateTrackItemTime` implementation body (ends around `graphStore.ts:1322`). Add the new action directly after it, before the next action (`resetExecution`):

```ts
  updateTrackItemSpatial: (remotionNodeId, trackItemId, spatialPatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) =>
            t.id === trackItemId
              ? { ...t, spatial: { ...t.spatial, ...spatialPatch } }
              : t,
          ),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm test -- graphStore.spatialUpdates 2>&1 | tail -10`
Expected: 5 PASS.

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 175/175 (170 from T1 + 5 new).

- [ ] **Step 6: Run build to verify TS compiles**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0 (chunk-size warning is pre-existing and OK).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.spatialUpdates.test.ts
git commit -m "feat(remotion): updateTrackItemSpatial graphStore action with maybePushUndo debounce"
```

---

### Phase B — Selectable layer DOM

### Task 3: `data-track-item-id` attribute on 5 CSS-driven renderers

**Files:**
- Modify: `frontend/src/components/video-editor/components/TextRenderer.tsx`
- Modify: `frontend/src/components/video-editor/components/SVGRenderer.tsx`
- Modify: `frontend/src/components/video-editor/components/ImageRenderer.tsx`
- Modify: `frontend/src/components/video-editor/components/VideoRenderer.tsx`
- Modify: `frontend/src/components/video-editor/components/LottieRenderer.tsx`
- Test: `frontend/tests/video/renderers.dataTrackItemId.test.tsx` (NEW)

`IsometricBlockRenderer.tsx` is explicitly excluded — the spec defers 3D layer hit-testing to Phase 2.4. Empty-state `<AbsoluteFill>` returns (e.g., `[no image src]`) also get the attribute so a user who adds a layer before configuring its `src` can still select it via the Player.

- [ ] **Step 1: Add the failing test file**

Create `frontend/tests/video/renderers.dataTrackItemId.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { TrackItem } from '../../src/types/video';
import { TextRenderer } from '../../src/components/video-editor/components/TextRenderer';
import { SVGRenderer } from '../../src/components/video-editor/components/SVGRenderer';
import { ImageRenderer } from '../../src/components/video-editor/components/ImageRenderer';
import { VideoRenderer } from '../../src/components/video-editor/components/VideoRenderer';
import { LottieRenderer } from '../../src/components/video-editor/components/LottieRenderer';

// Mock Remotion's useCurrentFrame so renderers don't require a Composition context.
vi.mock('remotion', async () => {
  const actual = await vi.importActual<typeof import('remotion')>('remotion');
  return { ...actual, useCurrentFrame: () => 0 };
});

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 'track-abc',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('CSS-driven renderers — data-track-item-id', () => {
  it('TextRenderer puts data-track-item-id on its root AbsoluteFill', () => {
    const { container } = render(<TextRenderer item={makeItem({ props: { text: 'hi' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('SVGRenderer happy path puts data-track-item-id on its root', () => {
    const { container } = render(<SVGRenderer item={makeItem({ componentType: 'SVGInput', props: { svg: '<svg/>' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('SVGRenderer empty-state ([no svg source]) also puts data-track-item-id', () => {
    const { container } = render(<SVGRenderer item={makeItem({ componentType: 'SVGInput', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('ImageRenderer happy path puts data-track-item-id on its root', () => {
    const { container } = render(<ImageRenderer item={makeItem({ componentType: 'ImageAssetNode', props: { src: 'data:image/png;base64,AAAA' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('ImageRenderer empty-state also puts data-track-item-id', () => {
    const { container } = render(<ImageRenderer item={makeItem({ componentType: 'ImageAssetNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('VideoRenderer empty-state puts data-track-item-id (happy path requires media context)', () => {
    const { container } = render(<VideoRenderer item={makeItem({ componentType: 'VideoAssetNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('LottieRenderer empty-state ([no lottie src]) puts data-track-item-id', () => {
    const { container } = render(<LottieRenderer item={makeItem({ componentType: 'LottieNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- renderers.dataTrackItemId 2>&1 | tail -15`
Expected: 7 FAILs (no `data-track-item-id` attribute present on any root yet).

- [ ] **Step 3: Add the attribute to TextRenderer**

In `frontend/src/components/video-editor/components/TextRenderer.tsx`, find the single `<AbsoluteFill>` return. Add `data-track-item-id={item.id}` to it. The full opening tag becomes:

```tsx
    <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center' }}>
```

- [ ] **Step 4: Add the attribute to SVGRenderer**

In `frontend/src/components/video-editor/components/SVGRenderer.tsx`, there are TWO `<AbsoluteFill>` returns — the `[no svg source]` empty state and the happy path. Add `data-track-item-id={item.id}` to BOTH. Each opening tag becomes:

```tsx
    <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
```

(for the empty state) and:

```tsx
    <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center' }}>
```

(for the happy path).

- [ ] **Step 5: Add the attribute to ImageRenderer**

In `frontend/src/components/video-editor/components/ImageRenderer.tsx`, there are TWO `<AbsoluteFill>` returns (empty state + happy path). Add `data-track-item-id={item.id}` to BOTH, mirroring the SVGRenderer pattern.

- [ ] **Step 6: Add the attribute to VideoRenderer**

In `frontend/src/components/video-editor/components/VideoRenderer.tsx`, there are TWO `<AbsoluteFill>` returns (empty state + happy path). Add `data-track-item-id={item.id}` to BOTH.

- [ ] **Step 7: Add the attribute to LottieRenderer**

In `frontend/src/components/video-editor/components/LottieRenderer.tsx`, there are THREE `<AbsoluteFill>` returns: `[no lottie src]`, `[loading lottie…]`, and the happy path with `<Lottie>`. Add `data-track-item-id={item.id}` to ALL THREE.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npm test -- renderers.dataTrackItemId 2>&1 | tail -10`
Expected: 7 PASS.

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 182/182 (175 + 7 new).

- [ ] **Step 9: Run build to verify TS compiles**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/video-editor/components/TextRenderer.tsx frontend/src/components/video-editor/components/SVGRenderer.tsx frontend/src/components/video-editor/components/ImageRenderer.tsx frontend/src/components/video-editor/components/VideoRenderer.tsx frontend/src/components/video-editor/components/LottieRenderer.tsx frontend/tests/video/renderers.dataTrackItemId.test.tsx
git commit -m "feat(remotion): data-track-item-id on 5 CSS-driven renderers for Player hit-testing"
```

---

### Phase C — Player overlay + click-to-select

### Task 4: PlayerOverlay + SelectionBox scaffolding + RemotionEditorView mount

**Files:**
- Create: `frontend/src/components/video-editor/PlayerOverlay.tsx` (NEW)
- Create: `frontend/src/components/video-editor/SelectionBox.tsx` (NEW)
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx`
- Modify: `frontend/src/styles/remotion-editor.css`
- Test: `frontend/tests/video/PlayerOverlay.test.tsx` (NEW)
- Test: `frontend/tests/video/SelectionBox.test.tsx` (NEW)

PlayerOverlay handles click-to-select (and click-on-empty-area to deselect). SelectionBox is purely visual in this task — outline only, no drag handlers (those land in Task 5). RemotionEditorView mounts the overlay inside the existing `__player` grid area, positioned absolutely so it covers the row but does NOT extend over the Player's CSS-padded gray margins (that area becomes the "click to deselect" surface).

- [ ] **Step 1: Add the failing PlayerOverlay test**

Create `frontend/tests/video/PlayerOverlay.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PlayerOverlay } from '../../src/components/video-editor/PlayerOverlay';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

function renderOverlay() {
  return render(<PlayerOverlay remotionNodeId="r1" />);
}

describe('PlayerOverlay', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
  });

  it('renders a transparent overlay div', () => {
    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay');
    expect(overlay).not.toBeNull();
  });

  it('pointerdown on overlay with a hit dispatches setSelectedTrackItem(id)', () => {
    // Seed a layer DOM element with data-track-item-id below the overlay's z-stack
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);

    // Mock elementsFromPoint to return our seeded element
    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([layerEl] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBe('track-xyz');

    elementsFromPointSpy.mockRestore();
    document.body.removeChild(layerEl);
  });

  it('pointerdown on overlay with no hit dispatches setSelectedTrackItem(null)', () => {
    useUIStore.setState({ selectedTrackItemId: 'previously-selected' });

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBeNull();

    elementsFromPointSpy.mockRestore();
  });

  it('renders SelectionBox when selectedTrackItemId is non-null and target element is in DOM', () => {
    // Set up the layer DOM BEFORE rendering so SelectionBox's first effect
    // finds it and computes a rect (otherwise the first render returns null
    // and there's no trigger to re-query after appendChild).
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);
    useUIStore.setState({ selectedTrackItemId: 'track-xyz' });
    const { container } = renderOverlay();
    expect(container.querySelector('.remotion-selection-box')).not.toBeNull();
    document.body.removeChild(layerEl);
  });
});
```

- [ ] **Step 2: Add the failing SelectionBox test**

Create `frontend/tests/video/SelectionBox.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SelectionBox } from '../../src/components/video-editor/SelectionBox';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

describe('SelectionBox — scaffolding', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    // Clean up any leftover layer elements between tests
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('renders nothing when target element does not exist in DOM', () => {
    const { container } = render(<SelectionBox remotionNodeId="r1" trackItemId="missing" />);
    expect(container.querySelector('.remotion-selection-box')).toBeNull();
  });

  it('renders an outline div positioned via getBoundingClientRect', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    // Mock getBoundingClientRect to return a known rect
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 200, width: 300, height: 150, right: 400, bottom: 350, x: 100, y: 200, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const { container } = render(<SelectionBox remotionNodeId="r1" trackItemId="track-xyz" />);
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('200px');
    expect(box.style.width).toBe('300px');
    expect(box.style.height).toBe('150px');

    document.body.removeChild(layerEl);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npm test -- PlayerOverlay SelectionBox 2>&1 | tail -15`
Expected: All 6 tests FAIL with "Cannot find module" or similar import errors.

- [ ] **Step 4: Create SelectionBox.tsx with rect-following logic**

Create `frontend/src/components/video-editor/SelectionBox.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface SelectionBoxProps {
  remotionNodeId: string;
  trackItemId: string;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Reads the selected layer's bounding rect each render and draws an outline.
 * Plan 2.3.a only renders the outline; body drag lands in 2.3.b/T5; handles
 * land in 2.3.b/c.
 *
 * The rect is recomputed on every render. Parents pass a key or state change
 * (e.g., the player's current frame) to force re-renders when the underlying
 * transform animates. Plan 2.3.a doesn't animate selections; 2.3.c will.
 */
export function SelectionBox({ remotionNodeId: _remotionNodeId, trackItemId }: SelectionBoxProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);

  useEffect(() => {
    const el = document.querySelector(`[data-track-item-id="${trackItemId}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
  });

  if (!rect) return null;

  return (
    <div
      className="remotion-selection-box"
      style={{
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: 'none',
      }}
    >
      <div className="remotion-selection-box__body" />
    </div>
  );
}
```

- [ ] **Step 5: Create PlayerOverlay.tsx with click-to-select/deselect**

Create `frontend/src/components/video-editor/PlayerOverlay.tsx`:

```tsx
import type { PointerEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import { SelectionBox } from './SelectionBox';

interface PlayerOverlayProps {
  remotionNodeId: string;
}

function hitTestTrackItem(x: number, y: number): string | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const id = el.closest('[data-track-item-id]')?.getAttribute('data-track-item-id');
    if (id) return id;
  }
  return null;
}

export function PlayerOverlay({ remotionNodeId }: PlayerOverlayProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const hit = hitTestTrackItem(e.clientX, e.clientY);
    setSelectedTrackItem(hit);
  };

  return (
    <div
      className="remotion-player-overlay"
      onPointerDown={handlePointerDown}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'auto',
      }}
    >
      {selectedTrackItemId && (
        <SelectionBox
          remotionNodeId={remotionNodeId}
          trackItemId={selectedTrackItemId}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Mount PlayerOverlay in RemotionEditorView**

In `frontend/src/components/video-editor/RemotionEditorView.tsx`, import the overlay near the existing imports (after `RemotionPropertiesPanel`):

```tsx
import { PlayerOverlay } from './PlayerOverlay';
```

Find the existing `__player` div (around `RemotionEditorView.tsx:84-104`). It currently reads:

```tsx
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        <Player
          ref={playerRef}
          component={RemotionComposition}
          inputProps={{ manifest }}
          durationInFrames={Math.max(
            DEFAULT_FPS * 5,
            ...manifest.timeline.map(
              (i) => i.time.startFrame + i.time.durationInFrames,
            ),
            DEFAULT_FPS,
          )}
          compositionWidth={1280}
          compositionHeight={720}
          fps={DEFAULT_FPS}
          controls
          loop
          style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
          acknowledgeRemotionLicense
        />
      </div>
```

Replace with:

```tsx
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        <div className="remotion-editor-view__player-frame">
          <Player
            ref={playerRef}
            component={RemotionComposition}
            inputProps={{ manifest }}
            durationInFrames={Math.max(
              DEFAULT_FPS * 5,
              ...manifest.timeline.map(
                (i) => i.time.startFrame + i.time.durationInFrames,
              ),
              DEFAULT_FPS,
            )}
            compositionWidth={1280}
            compositionHeight={720}
            fps={DEFAULT_FPS}
            controls
            loop
            style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
            acknowledgeRemotionLicense
          />
          <PlayerOverlay remotionNodeId={targetNodeId} />
        </div>
      </div>
```

The new wrapper `__player-frame` div is what the overlay's `position: absolute; inset: 0` lands on. The outer `__player` grid cell may have additional CSS padding (place-items: center) so the overlay must be positioned relative to the Player's actual bounding box — hence the wrapper.

- [ ] **Step 7: Add CSS for the overlay and selection box**

In `frontend/src/styles/remotion-editor.css`, find the existing `.remotion-editor-view__player` block (around line 59-67). Add the following rules immediately after it:

```css
/* ── PlayerOverlay + SelectionBox ──────────────────────────────────────────── */

body.app-slava-restraint .remotion-editor-view__player-frame {
  position: relative;
  width: 100%;
  max-width: 1280px;
  aspect-ratio: 16 / 9;
}

body.app-slava-restraint .remotion-player-overlay {
  position: absolute;
  inset: 0;
  /* Visually transparent; receives pointer events so click-to-select works
     even when the click would otherwise hit a layer's DOM directly. */
  background: transparent;
}

body.app-slava-restraint .remotion-selection-box {
  position: fixed;
  border: 1px solid var(--sr-accent);
  /* The box itself shouldn't block clicks; only its handles should (added in 2.3.b/c). */
  pointer-events: none;
}

body.app-slava-restraint .remotion-selection-box__body {
  position: absolute;
  inset: 0;
  /* Body becomes pointer-events: auto in Task 5 when drag is wired. */
  pointer-events: none;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npm test -- PlayerOverlay SelectionBox 2>&1 | tail -15`
Expected: 6 PASS.

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 188/188 (182 + 6 new).

- [ ] **Step 9: Run build to verify TS compiles**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/video-editor/PlayerOverlay.tsx frontend/src/components/video-editor/SelectionBox.tsx frontend/src/components/video-editor/RemotionEditorView.tsx frontend/src/styles/remotion-editor.css frontend/tests/video/PlayerOverlay.test.tsx frontend/tests/video/SelectionBox.test.tsx
git commit -m "feat(remotion): PlayerOverlay + SelectionBox scaffolding with click-to-select/deselect"
```

---

### Phase D — Body drag = translate

### Task 5: `screenToComposition` helper + SelectionBox body drag → updateTrackItemSpatial

**Files:**
- Create: `frontend/src/lib/video/coordinates.ts` (NEW)
- Create: `frontend/tests/video/coordinates.test.ts` (NEW)
- Modify: `frontend/src/components/video-editor/SelectionBox.tsx`
- Modify: `frontend/src/components/video-editor/PlayerOverlay.tsx` (forward `playerFrameRef`)
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx` (create the ref)
- Modify: `frontend/tests/video/SelectionBox.test.tsx` (extend with drag tests)
- Modify: `frontend/src/styles/remotion-editor.css` (enable body pointer events + grab cursor)

The body of the selection box becomes a drag handle. `pointerdown` on the body captures the gesture (calls `setPointerCapture`), `pointermove` updates the layer's `spatial.x/y` in real time via `updateTrackItemSpatial`, `pointerup` ends the gesture. Drag math uses `screenToComposition` to convert screen-pixel deltas into composition-pixel deltas based on the Player's current rendered size.

The drag handler reads `item.spatial.x` and `item.spatial.y` ONCE at the start of the gesture (when pointerdown fires). Each subsequent pointermove computes the delta from the original pointer position and dispatches `updateTrackItemSpatial({ x: originalX + dxComp, y: originalY + dyComp })`. This avoids cumulative-error issues from incremental deltas.

- [ ] **Step 1: Add the failing coordinates test**

Create `frontend/tests/video/coordinates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { screenToComposition } from '../../src/lib/video/coordinates';

function mockPlayerEl(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  });
  return el;
}

describe('screenToComposition', () => {
  it('returns zero deltas for zero screen deltas', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(0, 0, el)).toEqual({ x: 0, y: 0 });
  });

  it('scales 1:1 when player rect matches composition (1280x720)', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(100, 50, el)).toEqual({ x: 100, y: 50 });
  });

  it('scales 2x when player rect is half composition size (640x360)', () => {
    const el = mockPlayerEl(640, 360);
    expect(screenToComposition(50, 25, el)).toEqual({ x: 100, y: 50 });
  });

  it('accepts custom composition dimensions', () => {
    const el = mockPlayerEl(1920, 1080);
    expect(screenToComposition(192, 108, el, 1920, 1080)).toEqual({ x: 192, y: 108 });
  });

  it('handles negative deltas (pointer moved up/left)', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(-200, -100, el)).toEqual({ x: -200, y: -100 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- coordinates 2>&1 | tail -10`
Expected: 5 FAILs (module doesn't exist yet).

- [ ] **Step 3: Create the coordinates helper**

Create `frontend/src/lib/video/coordinates.ts`:

```ts
/**
 * Convert a screen-pixel delta to a composition-pixel delta.
 *
 * The Remotion <Player> renders at whatever size its CSS gives it (typically
 * 1280px max-width with 16:9 aspect ratio, but it shrinks on narrower
 * viewports). Drag deltas come in as screen pixels — we scale them into the
 * 1280x720 composition coordinate space so spatial.x/y stays consistent
 * regardless of player size.
 *
 * playerEl is the <div> that wraps the Player at its rendered size (NOT the
 * full editor view, NOT the inner Remotion compositor — the wrapper that
 * matches the rendered Player's bounding box).
 */
export function screenToComposition(
  dxScreen: number,
  dyScreen: number,
  playerEl: HTMLElement,
  compositionWidth = 1280,
  compositionHeight = 720,
): { x: number; y: number } {
  const rect = playerEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  return {
    x: (dxScreen / rect.width) * compositionWidth,
    y: (dyScreen / rect.height) * compositionHeight,
  };
}
```

- [ ] **Step 4: Run coordinates test to verify it passes**

Run: `cd frontend && npm test -- coordinates 2>&1 | tail -10`
Expected: 5 PASS.

- [ ] **Step 5: Extend SelectionBox.test.tsx with drag tests**

Open `frontend/tests/video/SelectionBox.test.tsx`. Replace its entire contents with:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SelectionBox } from '../../src/components/video-editor/SelectionBox';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 'track-xyz',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hi' },
    ...overrides,
  };
}

function seedRemotionWithItem(trackItem: TrackItem) {
  const remotionNode = {
    id: 'r1',
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [trackItem] } },
      state: 'idle' as const,
      outputs: {},
    },
  };
  useGraphStore.setState({ nodes: [remotionNode as never] });
}

function makePlayerFrameRef(width = 1280, height = 720): { current: HTMLElement } {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  });
  return { current: el };
}

describe('SelectionBox — scaffolding', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('renders nothing when target element does not exist in DOM', () => {
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="missing" playerFrameRef={playerFrameRef} />,
    );
    expect(container.querySelector('.remotion-selection-box')).toBeNull();
  });

  it('renders an outline div positioned via getBoundingClientRect', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 200, width: 300, height: 150, right: 400, bottom: 350, x: 100, y: 200, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const playerFrameRef = makePlayerFrameRef();
    seedRemotionWithItem(makeTrackItem());
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('200px');
    expect(box.style.width).toBe('300px');
    expect(box.style.height).toBe('150px');

    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — body drag', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('pointerdown → pointermove dispatches updateTrackItemSpatial with scaled deltas', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 50, y: 25, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef(640, 360); // half composition size → 2x scaling
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    // Mock setPointerCapture so JSDOM doesn't throw on it
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 250, clientY: 175 }); // +50, +25 screen
    // 50 screen px on a 640-wide player → 100 composition px (2x scale)
    // 25 screen px on a 360-tall player → 50 composition px
    // Final spatial: x = 50 + 100 = 150, y = 25 + 50 = 75

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(150);
    expect(manifest.timeline[0].spatial.y).toBe(75);

    fireEvent.pointerUp(body, { pointerId: 1, clientX: 250, clientY: 175 });
    document.body.removeChild(layerEl);
  });

  it('pointerdown without move does NOT mutate spatial', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
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
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 50, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);

    document.body.removeChild(layerEl);
  });
});
```

- [ ] **Step 6: Run the new SelectionBox tests to verify they fail**

Run: `cd frontend && npm test -- SelectionBox 2>&1 | tail -15`
Expected: 4 FAILs (the new drag tests fail because the body has no drag handler yet; the rect/null tests now also fail because they need the new `playerFrameRef` prop).

- [ ] **Step 7: Rewrite SelectionBox.tsx with the drag handler**

Replace the entire contents of `frontend/src/components/video-editor/SelectionBox.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { useGraphStore } from '../../store/graphStore';
import type { VideoGraphManifest } from '../../types/video';
import { screenToComposition } from '../../lib/video/coordinates';

interface SelectionBoxProps {
  remotionNodeId: string;
  trackItemId: string;
  playerFrameRef: RefObject<HTMLElement | null>;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSpatialX: number;
  startSpatialY: number;
  moved: boolean;
}

export function SelectionBox({ remotionNodeId, trackItemId, playerFrameRef }: SelectionBoxProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const updateTrackItemSpatial = useGraphStore((s) => s.updateTrackItemSpatial);
  // Subscribe to the selected item's spatial so SelectionBox re-renders on every
  // mutation (drag tick OR Properties Panel edit). The value is consumed only
  // by the useEffect deps below; without this subscription SelectionBox would
  // not know to re-query getBoundingClientRect when the layer's DOM moves.
  const spatial = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.find((t) => t.id === trackItemId)?.spatial ?? null;
  });
  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    const el = document.querySelector(`[data-track-item-id="${trackItemId}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
  }, [trackItemId, spatial]);

  if (!rect) return null;

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Stop the event from bubbling to PlayerOverlay's onPointerDown — clicking
    // the box body should NOT trigger select/deselect logic; it starts a drag.
    e.stopPropagation();

    // Read the current spatial.x/y once at the start of the gesture so each
    // pointermove computes against a stable origin (avoids cumulative drift).
    const remotion = useGraphStore.getState().nodes.find((n) => n.id === remotionNodeId);
    const manifest = (remotion?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    const item = manifest?.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startSpatialX: item.spatial.x,
      startSpatialY: item.spatial.y,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const playerEl = playerFrameRef.current;
    if (!playerEl) return;

    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;
    const { x: dxComp, y: dyComp } = screenToComposition(dxScreen, dyScreen, playerEl);

    // Mark the drag as moved on the first non-zero pointermove so a true click
    // (down → up with no move) doesn't flush an undo entry.
    if (!drag.moved && (dxScreen !== 0 || dyScreen !== 0)) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    updateTrackItemSpatial(remotionNodeId, trackItemId, {
      x: drag.startSpatialX + dxComp,
      y: drag.startSpatialY + dyComp,
    });
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  return (
    <div
      className="remotion-selection-box"
      style={{
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: 'none',
      }}
    >
      <div
        className="remotion-selection-box__body"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </div>
  );
}
```

- [ ] **Step 8: Wire `playerFrameRef` through PlayerOverlay**

In `frontend/src/components/video-editor/PlayerOverlay.tsx`, update the props and forwarding. Replace the entire file with:

```tsx
import type { PointerEvent, RefObject } from 'react';
import { useUIStore } from '../../store/uiStore';
import { SelectionBox } from './SelectionBox';

interface PlayerOverlayProps {
  remotionNodeId: string;
  playerFrameRef: RefObject<HTMLElement | null>;
}

function hitTestTrackItem(x: number, y: number): string | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const id = el.closest('[data-track-item-id]')?.getAttribute('data-track-item-id');
    if (id) return id;
  }
  return null;
}

export function PlayerOverlay({ remotionNodeId, playerFrameRef }: PlayerOverlayProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const hit = hitTestTrackItem(e.clientX, e.clientY);
    setSelectedTrackItem(hit);
  };

  return (
    <div
      className="remotion-player-overlay"
      onPointerDown={handlePointerDown}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'auto',
      }}
    >
      {selectedTrackItemId && (
        <SelectionBox
          remotionNodeId={remotionNodeId}
          trackItemId={selectedTrackItemId}
          playerFrameRef={playerFrameRef}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 9: Update PlayerOverlay.test.tsx for the new prop**

In `frontend/tests/video/PlayerOverlay.test.tsx`, update the `renderOverlay` helper and every render call to pass a `playerFrameRef`. Replace its contents with:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PlayerOverlay } from '../../src/components/video-editor/PlayerOverlay';
import { useUIStore } from '../../src/store/uiStore';

const INITIAL_UI_STATE = { ...useUIStore.getState() };

function makePlayerFrameRef(): { current: HTMLElement } {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0, toJSON: () => ({}),
  });
  return { current: el };
}

function renderOverlay() {
  return render(<PlayerOverlay remotionNodeId="r1" playerFrameRef={makePlayerFrameRef()} />);
}

describe('PlayerOverlay', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('renders a transparent overlay div', () => {
    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay');
    expect(overlay).not.toBeNull();
  });

  it('pointerdown on overlay with a hit dispatches setSelectedTrackItem(id)', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([layerEl] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBe('track-xyz');

    elementsFromPointSpy.mockRestore();
    document.body.removeChild(layerEl);
  });

  it('pointerdown on overlay with no hit dispatches setSelectedTrackItem(null)', () => {
    useUIStore.setState({ selectedTrackItemId: 'previously-selected' });

    const elementsFromPointSpy = vi
      .spyOn(document, 'elementsFromPoint')
      .mockReturnValue([] as unknown as Element[]);

    const { container } = renderOverlay();
    const overlay = container.querySelector('.remotion-player-overlay') as HTMLElement;
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });

    expect(useUIStore.getState().selectedTrackItemId).toBeNull();

    elementsFromPointSpy.mockRestore();
  });

  it('renders SelectionBox when selectedTrackItemId is non-null and target element is in DOM', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    document.body.appendChild(layerEl);
    useUIStore.setState({ selectedTrackItemId: 'track-xyz' });
    const { container } = renderOverlay();
    expect(container.querySelector('.remotion-selection-box')).not.toBeNull();
    document.body.removeChild(layerEl);
  });
});
```

- [ ] **Step 10: Pass the `playerFrameRef` from RemotionEditorView**

In `frontend/src/components/video-editor/RemotionEditorView.tsx`, add a new ref for the player frame near the existing `playerRef` declaration (around `RemotionEditorView.tsx:16-17`):

```tsx
  const playerRef = useRef<PlayerRef>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
```

Then update the `__player-frame` wrapper (added in Task 4 Step 6) to attach the ref and the PlayerOverlay to consume it. The block becomes:

```tsx
        <div className="remotion-editor-view__player-frame" ref={playerFrameRef}>
          <Player
            ref={playerRef}
            component={RemotionComposition}
            inputProps={{ manifest }}
            durationInFrames={Math.max(
              DEFAULT_FPS * 5,
              ...manifest.timeline.map(
                (i) => i.time.startFrame + i.time.durationInFrames,
              ),
              DEFAULT_FPS,
            )}
            compositionWidth={1280}
            compositionHeight={720}
            fps={DEFAULT_FPS}
            controls
            loop
            style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
            acknowledgeRemotionLicense
          />
          <PlayerOverlay remotionNodeId={targetNodeId} playerFrameRef={playerFrameRef} />
        </div>
```

- [ ] **Step 11: Enable pointer events on the selection box body in CSS**

In `frontend/src/styles/remotion-editor.css`, update the `.remotion-selection-box__body` rule (added in Task 4 Step 7) to enable pointer events and a grab cursor. Replace its existing body with:

```css
body.app-slava-restraint .remotion-selection-box__body {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  cursor: grab;
}

body.app-slava-restraint .remotion-selection-box__body:active {
  cursor: grabbing;
}
```

- [ ] **Step 12: Run all new + extended tests**

Run: `cd frontend && npm test -- coordinates SelectionBox PlayerOverlay 2>&1 | tail -20`
Expected: 13 PASS (5 coordinates + 4 SelectionBox + 4 PlayerOverlay).

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 195/195 (188 from T4 + 5 coordinates + 2 net-new SelectionBox drag tests).

- [ ] **Step 13: Run build to verify TS compiles**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/lib/video/coordinates.ts frontend/src/components/video-editor/SelectionBox.tsx frontend/src/components/video-editor/PlayerOverlay.tsx frontend/src/components/video-editor/RemotionEditorView.tsx frontend/src/styles/remotion-editor.css frontend/tests/video/coordinates.test.ts frontend/tests/video/SelectionBox.test.tsx frontend/tests/video/PlayerOverlay.test.tsx
git commit -m "feat(remotion): SelectionBox body drag translates layer via updateTrackItemSpatial"
```

---

### Phase E — Properties Panel Transform section

### Task 6: Properties Panel "Transform" section with Position X/Y/Z fields

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`
- Test: `frontend/tests/video/RemotionPropertiesPanel.test.tsx` (NEW)

The Transform section sits between the existing "Time" section and the componentType-specific sections (Text/SVG/Image/Video/IsoBlock/Lottie). Three labeled `<input type="number">` for `spatial.x`, `spatial.y`, `spatial.z`. Each input writes through a new `onSpatialPatch` helper that dispatches `updateTrackItemSpatial`. Per the spec, the Properties Panel ALWAYS writes static spatial, never to keyframes, regardless of `isKeyframeRecording` state (this matters for 2.3.c — for 2.3.a there's no record mode yet).

- [ ] **Step 1: Add the failing test file**

Create `frontend/tests/video/RemotionPropertiesPanel.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RemotionPropertiesPanel } from '../../src/components/video-editor/RemotionPropertiesPanel';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 100, y: 50, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hello' },
    ...overrides,
  };
}

function seedAndSelect(trackItem: TrackItem) {
  const remotionNode = {
    id: 'r1',
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [trackItem] } },
      state: 'idle' as const,
      outputs: {},
    },
  };
  useGraphStore.setState({ nodes: [remotionNode as never] });
  useUIStore.setState({ selectedTrackItemId: trackItem.id });
}

describe('RemotionPropertiesPanel — Transform section', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('renders the Transform section with Position X/Y/Z inputs reflecting current spatial', () => {
    seedAndSelect(makeTrackItem());
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    // Find the Transform section by h4 text
    const headings = Array.from(container.querySelectorAll('h4'));
    const transformHeading = headings.find((h) => h.textContent === 'Transform');
    expect(transformHeading).toBeDefined();

    const section = transformHeading?.closest('section');
    expect(section).not.toBeNull();

    const xInput = section?.querySelector('input[data-spatial-axis="x"]') as HTMLInputElement;
    const yInput = section?.querySelector('input[data-spatial-axis="y"]') as HTMLInputElement;
    const zInput = section?.querySelector('input[data-spatial-axis="z"]') as HTMLInputElement;
    expect(xInput.value).toBe('100');
    expect(yInput.value).toBe('50');
    expect(zInput.value).toBe('0');
  });

  it('typing in X dispatches updateTrackItemSpatial with new x and preserved y/z', () => {
    seedAndSelect(makeTrackItem());
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    const xInput = container.querySelector('input[data-spatial-axis="x"]') as HTMLInputElement;
    fireEvent.change(xInput, { target: { value: '250' } });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(250);
    expect(manifest.timeline[0].spatial.y).toBe(50); // preserved
    expect(manifest.timeline[0].spatial.z).toBe(0);  // preserved
  });

  it('Transform section appears between Time and componentType-specific sections', () => {
    seedAndSelect(makeTrackItem({ componentType: 'TextNode' }));
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);
    const timeIdx = headings.indexOf('Time');
    const transformIdx = headings.indexOf('Transform');
    const textIdx = headings.indexOf('Text');
    expect(timeIdx).toBeGreaterThanOrEqual(0);
    expect(transformIdx).toBeGreaterThan(timeIdx);
    expect(textIdx).toBeGreaterThan(transformIdx);
  });

  it('renders the Transform section for every componentType (including IsoBlock)', () => {
    for (const componentType of ['TextNode', 'SVGInput', 'ImageAssetNode', 'VideoAssetNode', 'IsometricBlock', 'LottieNode'] as const) {
      useGraphStore.setState(INITIAL_GRAPH_STATE, true);
      useUIStore.setState(INITIAL_UI_STATE, true);
      seedAndSelect(makeTrackItem({ id: `t-${componentType}`, componentType }));
      const { container, unmount } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);
      const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);
      expect(headings).toContain('Transform');
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- RemotionPropertiesPanel 2>&1 | tail -15`
Expected: 4 FAILs (no Transform section yet).

- [ ] **Step 3: Add the Transform section to RemotionPropertiesPanel**

In `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`, add `updateTrackItemSpatial` to the graphStore selector hook block (around line 26-27):

```tsx
  const updateTrackItemProps = useGraphStore((s) => s.updateTrackItemProps);
  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);
  const updateTrackItemSpatial = useGraphStore((s) => s.updateTrackItemSpatial);
```

Add a new `onSpatialPatch` helper inside the component, after the existing `onPropsPatch` helper (around line 44-46):

```tsx
  const onSpatialPatch = (patch: Partial<TrackItem['spatial']>) => {
    updateTrackItemSpatial(remotionNodeId, item.id, patch);
  };
```

Find the existing "Time" section (the `<section>` block whose `<h4>` reads "Time", around lines 55-74). Add a new section IMMEDIATELY AFTER it (before the first `{item.componentType === '...'}` conditional section):

```tsx
      <section className="remotion-properties-panel__section remotion-properties-panel__transform-section">
        <h4>Transform</h4>
        <label>
          Position X
          <input
            type="number"
            data-spatial-axis="x"
            value={item.spatial.x}
            onChange={(e) => onSpatialPatch({ x: Number(e.target.value) })}
          />
        </label>
        <label>
          Position Y
          <input
            type="number"
            data-spatial-axis="y"
            value={item.spatial.y}
            onChange={(e) => onSpatialPatch({ y: Number(e.target.value) })}
          />
        </label>
        <label>
          Position Z
          <input
            type="number"
            data-spatial-axis="z"
            value={item.spatial.z}
            onChange={(e) => onSpatialPatch({ z: Number(e.target.value) })}
          />
        </label>
      </section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- RemotionPropertiesPanel 2>&1 | tail -15`
Expected: 4 PASS.

Run the full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 199/199 (195 from T5 + 4 new).

- [ ] **Step 5: Run build to verify TS compiles**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/video-editor/RemotionPropertiesPanel.tsx frontend/tests/video/RemotionPropertiesPanel.test.tsx
git commit -m "feat(remotion): Properties Panel Transform section with Position X/Y/Z fields"
```

---

### Phase F — Smoke

### Task 7: Puppeteer Step 15 — drag a Text layer in the Player, assert spatial.x updated

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`

Add a Step 15 that programmatically selects the first Text TrackItem on the timeline (sets `uiStore.selectedTrackItemId`), then simulates a pointer drag on the selection box body. After the drag, reads `spatial.x` from the store and asserts it increased.

Note: the smoke runs in headless puppeteer with software rendering (`--use-gl=swiftshader`). Mouse coordinates are in viewport space; the selection box body lives at the layer's `getBoundingClientRect()` position. We use `page.mouse.move + page.mouse.down + page.mouse.move + page.mouse.up` to simulate the drag.

- [ ] **Step 1: Add Step 15 to the smoke driver**

In `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`, find the existing Step 14 block (around line 297-321). Add a new Step 15 IMMEDIATELY AFTER Step 14's screenshot line, BEFORE the `log('done', 'all 14 steps passed');` line:

```js
    // Step 15 — Drag the first Text TrackItem via the Player overlay
    log('test-15', 'select Text layer in store, then drag its selection box body');
    // Identify the first Text TrackItem on the timeline
    const textItem = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const text = tl.find((t) => t.componentType === 'TextNode');
      return text
        ? { id: text.id, beforeX: text.spatial.x, beforeY: text.spatial.y }
        : null;
    });
    if (!textItem) {
      throw new Error('[smoke] Step 15: no Text TrackItem on timeline');
    }
    // Select the Text item via the uiStore so PlayerOverlay renders SelectionBox
    await page.evaluate((id) => {
      window.__nebulaUIStore.getState().setSelectedTrackItem(id);
    }, textItem.id);
    await sleep(300);

    // Read the selection box body's bounding rect to compute drag start point
    const dragRect = await page.evaluate(() => {
      const body = document.querySelector('.remotion-selection-box__body');
      if (!body) return null;
      const r = body.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    });
    if (!dragRect) {
      throw new Error('[smoke] Step 15: .remotion-selection-box__body not in DOM after selecting Text layer');
    }

    // Drag: start at body center, move +200 screen pixels right
    await page.mouse.move(dragRect.x, dragRect.y);
    await page.mouse.down();
    // Two intermediate moves so PlayerOverlay/SelectionBox see a clean pointermove sequence
    await page.mouse.move(dragRect.x + 100, dragRect.y, { steps: 5 });
    await page.mouse.move(dragRect.x + 200, dragRect.y, { steps: 5 });
    await page.mouse.up();
    await sleep(300);

    const afterDrag = await page.evaluate((id) => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const item = tl.find((t) => t.id === id);
      return item ? { x: item.spatial.x, y: item.spatial.y } : null;
    }, textItem.id);
    if (!afterDrag) {
      throw new Error(`[smoke] Step 15: Text TrackItem ${textItem.id} disappeared after drag`);
    }
    if (afterDrag.x <= textItem.beforeX) {
      throw new Error(
        `[smoke] Step 15: spatial.x did not increase. before=${textItem.beforeX} after=${afterDrag.x}`,
      );
    }
    await page.screenshot({ path: join(OUT_DIR, 'step15-text-dragged.png') });
```

- [ ] **Step 2: Update the final log message**

In the same file, find the existing line:

```js
    log('done', 'all 14 steps passed');
```

Change it to:

```js
    log('done', 'all 15 steps passed');
```

- [ ] **Step 3: Restart any stale dev servers, then run the smoke**

Before running the smoke, confirm both backend and frontend dev servers are alive:

```bash
lsof -i :8000 -i :5180 -P -n | head -10
```

If `:8000` (backend) is not listening:

```bash
cd backend && python -m uvicorn main:app --reload --port 8000 &
```

If `:5180` (frontend) is not listening:

```bash
cd frontend && npm run dev &
```

Wait ~3 seconds, then re-check `lsof` to confirm both are up.

- [ ] **Step 4: Run the smoke**

Run from repo root:

```bash
node scripts/puppeteer-driver/remotion-foundation-smoke.mjs --headless true 2>&1 | tail -30
```

Expected last log line: `[done] all 15 steps passed`.

If Step 15 fails:
- If error is "no Text TrackItem on timeline" — Steps 10-13 didn't add a Text via the toolbar. Check Step 10's `+ Text` button selector still resolves.
- If error is ".remotion-selection-box__body not in DOM" — PlayerOverlay or SelectionBox is not mounting. Verify Task 4 + Task 5 changes are present in the running dev build. May need to refresh the browser if Vite HMR didn't pick up the new files.
- If error is "spatial.x did not increase" — the drag fired but updateTrackItemSpatial didn't run. Check (a) the selection box body has `pointer-events: auto` from Task 5 Step 11, (b) the screenToComposition helper returns a positive value for a positive screen delta.

- [ ] **Step 5: Run the full Vitest suite again (sanity check)**

```bash
cd frontend && npm test 2>&1 | tail -3
```

Expected: 199/199.

- [ ] **Step 6: Run build (sanity check)**

```bash
cd frontend && npm run build 2>&1 | tail -5
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs
git commit -m "test(remotion): smoke Step 15 — drag Text layer in Player, assert spatial.x updated"
```

---

## Acceptance after Plan 2.3.a

After all 7 tasks land, the following manual smoke should pass on a fresh editor open (Justin verifies in the browser):

1. Click `+ Text` in the toolbar → text appears center-frame in the Player.
2. Click on the rendered text in the Player → an outlined selection box appears around the text.
3. Click on empty Player area (outside the text's bounding box but inside the Player frame) → selection box disappears.
4. Click on the text again → selection box reappears.
5. Click+drag on the selection box body → text moves; Properties Panel "Transform" → Position X updates live.
6. Open Properties Panel → type 200 into Position X → text jumps to x=200 in the composition.
7. Cmd+Z → text reverses by one gesture.
8. Add a second layer (e.g., `+ SVG`) on top → click the SVG → selection switches to the SVG; click the text below → selection switches back.
9. Add an IsoBlock → click on the 3D block in the Player → nothing happens (3D excluded by design); selection clears since elementsFromPoint returns no `data-track-item-id`.

The full 14-criterion acceptance from the spec (drag-resize, drag-rotate, REC mode, keyframe insertion) lands across Plans 2.3.b and 2.3.c — 2.3.a only validates 1-3, 7, 9 above.

## Notes for the implementer

- **Plan-verbatim discipline:** every template here was checked against the actual code that exists today (uiStore, graphStore, RemotionPropertiesPanel, the 5 renderers). If a template doesn't compile, that's a real bug — fix it. If a template feels "almost right" but the actual API differs, raise it BLOCKED before improvising; the spike pattern from Phase 2.2 / T1 applies.
- **Pre-existing test environment warnings:** the vitest run will likely report "1 error" from a WebSocket/undici unhandled error in `graphStore.trackItemCRUD.test.ts`. This is pre-existing and unrelated. Tests still pass; don't get distracted by the error count.
- **CrabMark.tsx inline-style lint warning:** every code-quality reviewer this session has flagged this pre-existing warning. It's not in scope for Plan 2.3.a. Don't fix it.
- **`AbsoluteFill` accepts `data-*` attributes:** Remotion's `AbsoluteFill` is a styled `div` and passes HTMLAttributes through. Verified by inspecting the rendered DOM in the existing TextRenderer (which already styles AbsoluteFill via the `style` prop).
- **JSDOM + setPointerCapture:** the SelectionBox drag tests mock `setPointerCapture` and `releasePointerCapture` because JSDOM doesn't implement them. The template in Task 5 includes the mocks; don't remove them.
- **Reading state inside a handler:** `useGraphStore.getState().nodes.find(...)` reads the current state directly without subscribing (so the handler doesn't capture a stale snapshot). This is the same pattern used by `handleExecutionEvent` and `enterEditor` in the existing store.

