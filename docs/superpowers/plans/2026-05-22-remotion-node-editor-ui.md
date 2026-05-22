# RemotionNode Editor UI Implementation Plan (Plan 2.1.c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RemotionNode editor user-accessible without DevTools by adding (a) a toolbar with `+ Text` / `+ SVG` / `+ Image` / `+ Video` buttons that route through `addTrackItemWithCanvasMirror`, (b) TrackItem selection state in `uiStore`, (c) drag-to-trim + click-to-select wired through the xzdarcy timeline's `onActionResizeEnd` / `onActionMoveEnd` / `onClickAction` callbacks, (d) a right-side properties panel for editing `props` on the selected TrackItem, (e) keyboard shortcuts (Delete to remove selection, Cmd+D to duplicate at playhead), and (f) a `deleteTrackItem` action that removes both the TrackItem and its source canvas node atomically.

**Architecture:** Selection state (`selectedTrackItemId: string | null`) lives on `uiStore` alongside the existing `remotionEditorTargetNodeId`. Five new graphStore actions cover the TrackItem lifecycle: `deleteTrackItem`, `duplicateTrackItemAtPlayhead`, `updateTrackItemProps`, `updateTrackItemTime`, `setTrackItemSelected`. Three new UI components live in `frontend/src/components/video-editor/`: `RemotionEditorToolbar` (top of the editor, +/− buttons), `RemotionPropertiesPanel` (right-side panel, edits `props.text` / `props.fontSize` / etc.), and a `useRemotionKeyboard` hook (Delete + Cmd+D handlers, attached to the editor view's keydown). Drag-to-trim wires through xzdarcy's per-action callbacks (`onActionMoveEnd` for repositioning, `onActionResizeEnd` for trim, `onClickAction` for selection) and routes back through `updateTrackItemTime`. All actions use `pushUndo(set, get)` to make Ctrl-Z reversible.

**Tech Stack:** React 19 + Zustand + `@xyflow/react` + `@xzdarcy/react-timeline-editor` + Vitest. No new dependencies. The xzdarcy timeline already handles the drag UX — this plan just wires the callbacks.

**Source branch:** `main` (HEAD: `1bb13e2` — the Plan 2.1.b merge commit, 39 commits ahead of `origin/main`)

**Companion docs (read before starting):**
- Spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` §3 (playhead-relative duplication) and §4 (deterministic motion composition)
- Plan 2.1.a foundation: `docs/superpowers/plans/2026-05-22-remotion-node-foundation.md`
- Plan 2.1.b mirroring: `docs/superpowers/plans/2026-05-22-remotion-node-mirroring-and-mappers.md`
- Existing editor view: `frontend/src/components/video-editor/RemotionEditorView.tsx` — current header + Player + Timeline layout (currently 3-row grid `48px 1fr 320px`)
- Existing timeline wrapper: `frontend/src/components/video-editor/RemotionTimeline.tsx` — `onChange` is currently a no-op
- Existing graphStore mirror/mutation actions: `addTrackItemWithCanvasMirror`, `updateRemotionManifest` in `frontend/src/store/graphStore.ts`
- Mirroring helpers (reused for delete): `componentTypeToCanvasDefId`, `pruneTrackItemsForDeletedNode` in `frontend/src/lib/video/mirroring.ts`
- xzdarcy callback types: `frontend/node_modules/@xzdarcy/react-timeline-editor/dist/interface/timeline.d.ts` — `onActionMoveEnd({ action, row, time })`, `onActionResizeEnd({ action, row, start, end, dir })`, `onClickAction(e, { action, row, time })`. **All times are in seconds, not frames** — convert via `DEFAULT_FPS` (30) at the boundary.

**Phase 2.1 scope split:**
- ✅ Plan 2.1.a (shipped): backend wiring + canvas card + editor lifecycle + Player + Timeline + bidirectional frame sync + manifestValidator + keyframeInterp + TextRenderer
- ✅ Plan 2.1.b (shipped): SVGRenderer + ImageRenderer + VideoRenderer + mirroring helpers + Rule A (`addTrackItemWithCanvasMirror`) + Rules B-1 / B-2 (prune on canvas delete/disconnect)
- ✅ This plan (2.1.c — editor UI): toolbar, selection, properties panel, drag-to-trim, keyboard shortcuts, delete/duplicate actions
- ⏭ Phase 2.2 (separate plan): R3F isometric blocks, IsometricBlock component, LottieRenderer, 3D camera + projection matrices

---

## File Structure

### New frontend files (5)

| File | Responsibility |
|------|----------------|
| `frontend/src/components/video-editor/RemotionEditorToolbar.tsx` | Toolbar mounted at the top of the editor view. Four `+ Text`/`+ SVG`/`+ Image`/`+ Video` buttons that call `addTrackItemWithCanvasMirror` with the right componentType. Plus a `Delete` button bound to the selected TrackItem. |
| `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx` | Right-side panel that shows the selected TrackItem's editable `props` (text, fontSize, color, src, volume) + `time` (startFrame, durationInFrames). All edits route through `updateTrackItemProps` / `updateTrackItemTime`. |
| `frontend/src/components/video-editor/useRemotionKeyboard.ts` | React hook attached to the editor view. Listens for `Delete` / `Backspace` (deletes selected TrackItem) and `Cmd+D` / `Ctrl+D` (duplicates at playhead). Returns nothing — pure side effects via graphStore actions. |
| `frontend/tests/video/graphStore.trackItemCRUD.test.ts` | Integration tests for `deleteTrackItem`, `duplicateTrackItemAtPlayhead`, `updateTrackItemProps`, `updateTrackItemTime`. |
| `frontend/tests/video/RemotionEditorToolbar.test.tsx` | Component test for the toolbar (renders 4 add buttons; clicking each dispatches the right action). |

### Modified frontend files (5)

| File | Change scope |
|------|--------------|
| `frontend/src/store/uiStore.ts` | Add `selectedTrackItemId: string \| null` + `setSelectedTrackItem(id: string \| null)` action. Clear selection on `exitRemotionEditor`. |
| `frontend/src/store/graphStore.ts` | Add five actions: `deleteTrackItem(remotionNodeId, trackItemId)`, `duplicateTrackItemAtPlayhead(remotionNodeId, trackItemId, currentFrame)`, `updateTrackItemProps(remotionNodeId, trackItemId, propsPatch)`, `updateTrackItemTime(remotionNodeId, trackItemId, timePatch)`. All use `pushUndo` for Ctrl-Z. |
| `frontend/src/components/video-editor/RemotionTimeline.tsx` | Replace the no-op `onChange` with `onActionMoveEnd`, `onActionResizeEnd`, `onClickAction` handlers that route to `updateTrackItemTime` (move/resize) and `setSelectedTrackItem` (click). Pass `selectedTrackItemId` into editorData so the selected action is visually highlighted. |
| `frontend/src/components/video-editor/RemotionEditorView.tsx` | Replace the 3-row grid (`48px 1fr 320px`) with a 4-area grid that includes a 320px right column for the properties panel. Mount `RemotionEditorToolbar` inside the existing header. Wire `useRemotionKeyboard`. |
| `frontend/src/styles/remotion-editor.css` | Update grid template to `48px 1fr 320px` rows × `1fr 320px` columns for the new layout. Add styles for `.remotion-editor-toolbar`, `.remotion-properties-panel`, and selection highlight on timeline actions. |

### Files NOT touched (isolation invariants)

- All Phase 1 editor code (`frontend/src/components/editor/`, `frontend/src/lib/editor/virtualPlayback.ts`)
- All Phase 2.1.a/b mappers (`TextRenderer.tsx`, `SVGRenderer.tsx`, `ImageRenderer.tsx`, `VideoRenderer.tsx`)
- `frontend/src/components/video-editor/RemotionComposition.tsx`
- `frontend/src/lib/video/keyframeInterp.ts`
- `frontend/src/lib/video/manifestValidator.ts`
- `frontend/src/lib/video/mirroring.ts` — reused (componentTypeToCanvasDefId for duplicate spawn) but not modified
- All backend files

### Design invariants the plan enforces

1. **One mutation pattern.** Every TrackItem mutation goes through a typed graphStore action. The Toolbar/Panel/Timeline/Keyboard all call those actions; nothing reaches into manifest directly.
2. **Ctrl-Z reversibility.** Every mutation action calls `pushUndo(set, get)` before its `set()`. Match the existing pattern from `addNode`, `updateNodeData`, `addTrackItemWithCanvasMirror`.
3. **Selection is editor-scoped.** `selectedTrackItemId` lives on `uiStore` and is cleared on `exitRemotionEditor` (so re-entering an editor starts with nothing selected).
4. **Delete is atomic.** `deleteTrackItem` removes the TrackItem AND its source canvas node in one `set()` to avoid Rule B-1 self-firing or stale-edge state.
5. **Time at the boundary.** xzdarcy callbacks deliver `start`/`end`/`time` in seconds. All graphStore actions store frames. Convert via `DEFAULT_FPS` (30) at the boundary, never deeper.
6. **Slava restraint scope.** All new CSS rules in `remotion-editor.css` stay under `body.app-slava-restraint`. No inline styles in components outside `frontend/src/components/video-editor/` (the existing exemption already covers the new files inside that directory).
7. **No new deps.** xzdarcy, @remotion/player, @remotion/media are sufficient.

---

## Task Sequence

11 tasks across 6 phases. Each task is one commit. Each commit must leave `npm run build` exit 0 and `npm test` green.

- **Phase A — Selection state** (Task 1)
- **Phase B — Mutation actions** (Tasks 2-5: delete, duplicate, updateProps, updateTime)
- **Phase C — Toolbar** (Task 6)
- **Phase D — Properties panel** (Task 7)
- **Phase E — Timeline wiring + selection visual** (Task 8)
- **Phase F — Keyboard shortcuts** (Task 9)
- **Phase G — Editor view mount + CSS polish** (Task 10)
- **Phase H — Smoke + visual** (Task 11)

---

### Phase A — Selection state

### Task 1: Add `selectedTrackItemId` + `setSelectedTrackItem` to uiStore

**Files:**
- Modify: `frontend/src/store/uiStore.ts` (mirror Plan 2.1.a T6's `remotionEditorTargetNodeId` placement)
- Test: `frontend/tests/video/uiStore.remotionEditor.test.ts` (append to existing 2.1.a test file)

- [ ] **Step 1: Add the failing test**

Open `frontend/tests/video/uiStore.remotionEditor.test.ts`. Append a new describe block at the bottom:

```ts
describe('uiStore — TrackItem selection', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_STATE, true);
  });

  it('setSelectedTrackItem stores the id', () => {
    useUIStore.getState().setSelectedTrackItem('track-1');
    expect(useUIStore.getState().selectedTrackItemId).toBe('track-1');
  });

  it('setSelectedTrackItem(null) clears the selection', () => {
    useUIStore.setState({ selectedTrackItemId: 'track-1' });
    useUIStore.getState().setSelectedTrackItem(null);
    expect(useUIStore.getState().selectedTrackItemId).toBeNull();
  });

  it('exitRemotionEditor also clears selectedTrackItemId', () => {
    useUIStore.setState({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: 'r1',
      selectedTrackItemId: 'track-1',
    });
    useUIStore.getState().exitRemotionEditor();
    expect(useUIStore.getState().selectedTrackItemId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- uiStore.remotionEditor 2>&1 | tail -10`
Expected: FAIL — `setSelectedTrackItem is not a function`.

- [ ] **Step 3: Add the field, interface, and action**

In `frontend/src/store/uiStore.ts`, find the existing `remotionEditorTargetNodeId: string | null;` field in the interface. Add directly below:

```ts
  selectedTrackItemId: string | null;
```

And in the actions section near `enterRemotionEditor` / `exitRemotionEditor`:

```ts
  setSelectedTrackItem: (id: string | null) => void;
```

Find the initial state (the block with `remotionEditorTargetNodeId: null`). Add:

```ts
  selectedTrackItemId: null,
```

Below `exitRemotionEditor`'s action body, add `setSelectedTrackItem` and modify `exitRemotionEditor` to clear the selection:

```ts
  setSelectedTrackItem: (id) => {
    set({ selectedTrackItemId: id });
  },
```

Modify the existing `exitRemotionEditor` body to also reset `selectedTrackItemId`:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- uiStore.remotionEditor 2>&1 | tail -10`
Expected: 6 PASS (3 from 2.1.a + 3 new).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 139/139 (136 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/uiStore.ts frontend/tests/video/uiStore.remotionEditor.test.ts
git commit -m "feat(remotion): selectedTrackItemId + setSelectedTrackItem on uiStore"
```

---

### Phase B — Mutation actions

### Task 2: `deleteTrackItem` graphStore action

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.trackItemCRUD.test.ts` (NEW)

`deleteTrackItem(remotionNodeId, trackItemId)` removes the TrackItem from the RemotionNode's manifest AND removes its source canvas node — both in one atomic `set()` so Rule B-1 doesn't self-fire on the source-node removal and find nothing to prune.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/graphStore.trackItemCRUD.test.ts`:

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

describe('graphStore — deleteTrackItem', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('removes the TrackItem AND its source canvas node atomically', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().deleteTrackItem('r1', 't1');

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(0);
    expect(state.nodes.find((n) => n.id === 'src-1')).toBeUndefined();
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().deleteTrackItem('r1', 'does-not-exist');

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(1);
  });

  it('no-ops if the RemotionNode does not exist', () => {
    useGraphStore.getState().deleteTrackItem('does-not-exist', 't1');
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: FAIL — `deleteTrackItem is not a function`.

- [ ] **Step 3: Add the action**

In `frontend/src/store/graphStore.ts`, find the interface block where `addTrackItemWithCanvasMirror:` was added in Plan 2.1.b. Add directly below:

```ts
  deleteTrackItem: (remotionNodeId: string, trackItemId: string) => void;
```

Find the existing `addTrackItemWithCanvasMirror` action body. After its closing brace, add:

```ts
  deleteTrackItem: (remotionNodeId, trackItemId) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;

    const item = manifest.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes
        .filter((n) => n.id !== item.sourceNodeId)
        .map((n) => {
          if (n.id !== remotionNodeId) return n;
          const params = (n.data.params ?? {}) as Record<string, unknown>;
          const currentManifest = params.manifest as VideoGraphManifest;
          const nextManifest: VideoGraphManifest = {
            ...currentManifest,
            timeline: currentManifest.timeline.filter((t) => t.id !== trackItemId),
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

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 3 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 142/142 (139 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.trackItemCRUD.test.ts
git commit -m "feat(remotion): deleteTrackItem removes item + source canvas node atomically"
```

---

### Task 3: `duplicateTrackItemAtPlayhead` graphStore action

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.trackItemCRUD.test.ts` (append)

`duplicateTrackItemAtPlayhead(remotionNodeId, trackItemId, currentFrame)` clones the selected TrackItem with `time.startFrame` set to the current playhead frame, spawns a new source canvas node (with the same `definitionId` as the original's source), and adds the clone to the manifest. Same pattern as `addTrackItemWithCanvasMirror` but seeded from an existing item.

- [ ] **Step 1: Add the failing tests**

Append to `frontend/tests/video/graphStore.trackItemCRUD.test.ts`:

```ts
describe('graphStore — duplicateTrackItemAtPlayhead', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('clones the TrackItem at the given frame and spawns a new source node', () => {
    seedRemotionWithItem(makeTrackItem({ time: { startFrame: 0, durationInFrames: 60 } }));
    useGraphStore.getState().duplicateTrackItemAtPlayhead('r1', 't1', 45);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline).toHaveLength(2);

    const clone = manifest.timeline.find((t) => t.id !== 't1')!;
    expect(clone.time.startFrame).toBe(45);
    expect(clone.time.durationInFrames).toBe(60);
    expect(clone.componentType).toBe('TextNode');
    expect(clone.props.text).toBe('hello');
    expect(clone.sourceNodeId).not.toBe('src-1');

    // The spawned source canvas node exists and matches the original's definitionId
    const spawnedSource = state.nodes.find((n) => n.id === clone.sourceNodeId);
    expect(spawnedSource).toBeDefined();
    expect(spawnedSource?.data.definitionId).toBe('text-input');
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().duplicateTrackItemAtPlayhead('r1', 'does-not-exist', 30);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 2 FAIL — `duplicateTrackItemAtPlayhead is not a function`.

- [ ] **Step 3: Add the action**

In the graphStore interface, add directly below `deleteTrackItem`:

```ts
  duplicateTrackItemAtPlayhead: (
    remotionNodeId: string,
    trackItemId: string,
    currentFrame: number,
  ) => void;
```

In the action implementation block (after `deleteTrackItem`):

```ts
  duplicateTrackItemAtPlayhead: (remotionNodeId, trackItemId, currentFrame) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;

    const original = manifest.timeline.find((t) => t.id === trackItemId);
    if (!original) return;

    const sourceNode = state.nodes.find((n) => n.id === original.sourceNodeId);
    const sourceDefId =
      (sourceNode?.data.definitionId as string | undefined) ?? 'text-input';

    pushUndo(set, get);

    const newSourceId = uuidv4();
    const newSourceNode = {
      id: newSourceId,
      type: 'model-node' as const,
      position: {
        x: remotion.position.x - 280,
        y: remotion.position.y + 80,
      },
      data: {
        definitionId: sourceDefId,
        label: sourceDefId,
        params: {},
        state: 'idle' as const,
        outputs: {},
      },
    };

    const clone: TrackItem = {
      ...original,
      id: uuidv4(),
      sourceNodeId: newSourceId,
      time: {
        startFrame: currentFrame,
        durationInFrames: original.time.durationInFrames,
      },
      // Deep-clone keyframes/props so mutations to the clone don't affect the original
      keyframes: JSON.parse(JSON.stringify(original.keyframes)),
      props: JSON.parse(JSON.stringify(original.props)),
    };

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: [...m.timeline, clone],
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: [...updatedNodes, newSourceNode as never] };
    });
  },
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 5 PASS (3 from T2 + 2 new).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 144/144.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.trackItemCRUD.test.ts
git commit -m "feat(remotion): duplicateTrackItemAtPlayhead clones with playhead offset"
```

---

### Task 4: `updateTrackItemProps` graphStore action

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.trackItemCRUD.test.ts` (append)

Partial update to a TrackItem's `props` (text, fontSize, color, src, etc.). The properties panel uses this on every keystroke/change.

- [ ] **Step 1: Add the failing test**

Append to `frontend/tests/video/graphStore.trackItemCRUD.test.ts`:

```ts
describe('graphStore — updateTrackItemProps', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('shallow-merges propsPatch into the existing props', () => {
    seedRemotionWithItem(makeTrackItem({ props: { text: 'hello', fontSize: 64 } }));
    useGraphStore.getState().updateTrackItemProps('r1', 't1', { text: 'world' });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].props.text).toBe('world');
    expect(manifest.timeline[0].props.fontSize).toBe(64); // preserved
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().updateTrackItemProps('r1', 'does-not-exist', { text: 'world' });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].props.text).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 2 FAIL — `updateTrackItemProps is not a function`.

- [ ] **Step 3: Add the action**

Interface signature (below `duplicateTrackItemAtPlayhead`):

```ts
  updateTrackItemProps: (
    remotionNodeId: string,
    trackItemId: string,
    propsPatch: Record<string, unknown>,
  ) => void;
```

Action body:

```ts
  updateTrackItemProps: (remotionNodeId, trackItemId, propsPatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) =>
            t.id === trackItemId
              ? { ...t, props: { ...t.props, ...propsPatch } }
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

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 7 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 146/146.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.trackItemCRUD.test.ts
git commit -m "feat(remotion): updateTrackItemProps shallow-merges props patch"
```

---

### Task 5: `updateTrackItemTime` graphStore action

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.trackItemCRUD.test.ts` (append)

Partial update to a TrackItem's `time` (`startFrame`, `durationInFrames`). Timeline drag-to-move/resize routes through this.

- [ ] **Step 1: Add the failing test**

Append to `frontend/tests/video/graphStore.trackItemCRUD.test.ts`:

```ts
describe('graphStore — updateTrackItemTime', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('updates startFrame only when timePatch has only startFrame', () => {
    seedRemotionWithItem(makeTrackItem({ time: { startFrame: 0, durationInFrames: 60 } }));
    useGraphStore.getState().updateTrackItemTime('r1', 't1', { startFrame: 90 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].time.startFrame).toBe(90);
    expect(manifest.timeline[0].time.durationInFrames).toBe(60);
  });

  it('updates both startFrame and durationInFrames in one patch', () => {
    seedRemotionWithItem(makeTrackItem({ time: { startFrame: 0, durationInFrames: 60 } }));
    useGraphStore
      .getState()
      .updateTrackItemTime('r1', 't1', { startFrame: 30, durationInFrames: 120 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].time.startFrame).toBe(30);
    expect(manifest.timeline[0].time.durationInFrames).toBe(120);
  });

  it('rounds non-integer frames to integers (timeline edits arrive in seconds * fps)', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore
      .getState()
      .updateTrackItemTime('r1', 't1', { startFrame: 30.7, durationInFrames: 60.4 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].time.startFrame).toBe(31);
    expect(manifest.timeline[0].time.durationInFrames).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 3 FAIL.

- [ ] **Step 3: Add the action**

Interface signature (below `updateTrackItemProps`):

```ts
  updateTrackItemTime: (
    remotionNodeId: string,
    trackItemId: string,
    timePatch: Partial<{ startFrame: number; durationInFrames: number }>,
  ) => void;
```

Action body:

```ts
  updateTrackItemTime: (remotionNodeId, trackItemId, timePatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) => {
            if (t.id !== trackItemId) return t;
            return {
              ...t,
              time: {
                startFrame:
                  timePatch.startFrame !== undefined
                    ? Math.round(timePatch.startFrame)
                    : t.time.startFrame,
                durationInFrames:
                  timePatch.durationInFrames !== undefined
                    ? Math.max(1, Math.round(timePatch.durationInFrames))
                    : t.time.durationInFrames,
              },
            };
          }),
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

`Math.max(1, ...)` on `durationInFrames` prevents a drag-to-trim from collapsing a clip to zero/negative frames.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- graphStore.trackItemCRUD 2>&1 | tail -10`
Expected: 10 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 149/149.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.trackItemCRUD.test.ts
git commit -m "feat(remotion): updateTrackItemTime patches frames with rounding + min-1 floor"
```

---

### Phase C — Toolbar

### Task 6: RemotionEditorToolbar component

**Files:**
- Create: `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`
- Create: `frontend/tests/video/RemotionEditorToolbar.test.tsx`

The toolbar exposes 4 add buttons and 1 delete button. Each add calls `addTrackItemWithCanvasMirror` with the right componentType. Delete uses `selectedTrackItemId` and `deleteTrackItem`. Delete is disabled if nothing is selected.

- [ ] **Step 1: Write the failing component test**

Create `frontend/tests/video/RemotionEditorToolbar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemotionEditorToolbar } from '../../src/components/video-editor/RemotionEditorToolbar';

const addMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/store/graphStore', () => ({
  useGraphStore: (selector: (s: {
    addTrackItemWithCanvasMirror: typeof addMock;
    deleteTrackItem: typeof deleteMock;
  }) => unknown) =>
    selector({
      addTrackItemWithCanvasMirror: addMock,
      deleteTrackItem: deleteMock,
    }),
}));

let mockSelectedId: string | null = null;
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: { selectedTrackItemId: string | null }) => unknown) =>
    selector({ selectedTrackItemId: mockSelectedId }),
}));

describe('RemotionEditorToolbar', () => {
  beforeEach(() => {
    addMock.mockReset();
    deleteMock.mockReset();
    mockSelectedId = null;
  });

  it('renders four add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
  });

  it('+ Text dispatches addTrackItemWithCanvasMirror with TextNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ text/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'TextNode' }));
  });

  it('+ Image dispatches with ImageAssetNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ image/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'ImageAssetNode' }));
  });

  it('Delete button is disabled when nothing is selected', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
  });

  it('Delete button dispatches deleteTrackItem when a TrackItem is selected', () => {
    mockSelectedId = 'track-1';
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(deleteMock).toHaveBeenCalledWith('r1', 'track-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- RemotionEditorToolbar 2>&1 | tail -10`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`:

```tsx
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackComponentType } from '../../types/video';

interface RemotionEditorToolbarProps {
  remotionNodeId: string;
}

const ADD_BUTTONS: Array<{ label: string; componentType: TrackComponentType }> = [
  { label: '+ Text', componentType: 'TextNode' },
  { label: '+ SVG', componentType: 'SVGInput' },
  { label: '+ Image', componentType: 'ImageAssetNode' },
  { label: '+ Video', componentType: 'VideoAssetNode' },
];

export function RemotionEditorToolbar({ remotionNodeId }: RemotionEditorToolbarProps) {
  const addTrackItemWithCanvasMirror = useGraphStore((s) => s.addTrackItemWithCanvasMirror);
  const deleteTrackItem = useGraphStore((s) => s.deleteTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);

  const handleAdd = (componentType: TrackComponentType) => {
    addTrackItemWithCanvasMirror(remotionNodeId, { componentType });
  };

  const handleDelete = () => {
    if (!selectedTrackItemId) return;
    deleteTrackItem(remotionNodeId, selectedTrackItemId);
  };

  return (
    <div className="remotion-editor-toolbar">
      {ADD_BUTTONS.map((btn) => (
        <button
          key={btn.componentType}
          type="button"
          className="remotion-editor-toolbar__add"
          onClick={() => handleAdd(btn.componentType)}
        >
          {btn.label}
        </button>
      ))}
      <button
        type="button"
        className="remotion-editor-toolbar__delete"
        onClick={handleDelete}
        disabled={!selectedTrackItemId}
      >
        Delete
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- RemotionEditorToolbar 2>&1 | tail -10`
Expected: 5 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154 (149 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/RemotionEditorToolbar.tsx frontend/tests/video/RemotionEditorToolbar.test.tsx
git commit -m "feat(remotion): RemotionEditorToolbar with 4 add buttons + delete"
```

---

### Phase D — Properties panel

### Task 7: RemotionPropertiesPanel component

**Files:**
- Create: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`

The panel shows when a TrackItem is selected. It displays editable fields for:
- `time.startFrame` (number input)
- `time.durationInFrames` (number input)
- `props.text` (text input, TextNode only)
- `props.fontSize` (number input, TextNode only)
- `props.color` (color input, TextNode only)
- `props.src` (text input, ImageAssetNode / VideoAssetNode)
- `props.volume` (number input 0-1, VideoAssetNode only)

All edits route through `updateTrackItemTime` or `updateTrackItemProps`. No tests this task — the underlying mutation actions are already tested (T2-T5); the panel is a thin reflection of them.

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`:

```tsx
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackItem, VideoGraphManifest } from '../../types/video';

interface RemotionPropertiesPanelProps {
  remotionNodeId: string;
}

export function RemotionPropertiesPanel({ remotionNodeId }: RemotionPropertiesPanelProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === remotionNodeId));
  const updateTrackItemProps = useGraphStore((s) => s.updateTrackItemProps);
  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);

  const manifest = ((node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest) ?? null;
  const item: TrackItem | null = manifest?.timeline.find((t) => t.id === selectedTrackItemId) ?? null;

  if (!item) {
    return (
      <aside className="remotion-properties-panel remotion-properties-panel--empty">
        <p>No layer selected</p>
        <p className="remotion-properties-panel__hint">Click a layer in the timeline to edit it.</p>
      </aside>
    );
  }

  const onTimePatch = (patch: Partial<{ startFrame: number; durationInFrames: number }>) => {
    updateTrackItemTime(remotionNodeId, item.id, patch);
  };
  const onPropsPatch = (patch: Record<string, unknown>) => {
    updateTrackItemProps(remotionNodeId, item.id, patch);
  };

  return (
    <aside className="remotion-properties-panel">
      <header className="remotion-properties-panel__header">
        <span className="remotion-properties-panel__type">{item.componentType}</span>
        <span className="remotion-properties-panel__id">{item.id.slice(0, 8)}</span>
      </header>

      <section className="remotion-properties-panel__section">
        <h4>Time</h4>
        <label>
          startFrame
          <input
            type="number"
            value={item.time.startFrame}
            onChange={(e) => onTimePatch({ startFrame: Number(e.target.value) })}
          />
        </label>
        <label>
          durationInFrames
          <input
            type="number"
            min={1}
            value={item.time.durationInFrames}
            onChange={(e) => onTimePatch({ durationInFrames: Number(e.target.value) })}
          />
        </label>
      </section>

      {item.componentType === 'TextNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Text</h4>
          <label>
            text
            <input
              type="text"
              value={(item.props.text as string) ?? ''}
              onChange={(e) => onPropsPatch({ text: e.target.value })}
            />
          </label>
          <label>
            fontSize
            <input
              type="number"
              value={(item.props.fontSize as number) ?? 64}
              onChange={(e) => onPropsPatch({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            color
            <input
              type="color"
              value={(item.props.color as string) ?? '#ffffff'}
              onChange={(e) => onPropsPatch({ color: e.target.value })}
            />
          </label>
        </section>
      )}

      {(item.componentType === 'ImageAssetNode' || item.componentType === 'VideoAssetNode') && (
        <section className="remotion-properties-panel__section">
          <h4>Source</h4>
          <label>
            src (URL)
            <input
              type="text"
              value={(item.props.src as string) ?? ''}
              onChange={(e) => onPropsPatch({ src: e.target.value })}
            />
          </label>
        </section>
      )}

      {item.componentType === 'VideoAssetNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Audio</h4>
          <label>
            volume
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={(item.props.volume as number) ?? 1}
              onChange={(e) => onPropsPatch({ volume: Number(e.target.value) })}
            />
          </label>
        </section>
      )}

      {item.componentType === 'SVGInput' && (
        <section className="remotion-properties-panel__section">
          <h4>SVG</h4>
          <label>
            inline svg
            <textarea
              rows={6}
              value={(item.props.svg as string) ?? ''}
              onChange={(e) => onPropsPatch({ svg: e.target.value })}
              spellCheck={false}
            />
          </label>
        </section>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Verify build + lint**

Run: `cd frontend && npm run build 2>&1 | tail -3`
Expected: exit 0.

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154 (no new test this task).

Run: `cd frontend && npm run lint 2>&1 | tail -5`
Expected: clean. The inline-styles guard already exempts `frontend/src/components/video-editor/`, and the panel uses className-only styling (CSS arrives in T10).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/RemotionPropertiesPanel.tsx
git commit -m "feat(remotion): RemotionPropertiesPanel — edit props + time of selected TrackItem"
```

---

### Phase E — Timeline mutation routing + selection

### Task 8: Wire timeline callbacks for select / move / resize

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionTimeline.tsx`

Replace the no-op `onChange` with three real handlers:
- `onClickAction` → `setSelectedTrackItem(action.id)`
- `onActionMoveEnd` → `updateTrackItemTime(remotionNodeId, action.id, { startFrame: round(time * fps) })`
- `onActionResizeEnd` → `updateTrackItemTime(remotionNodeId, action.id, { startFrame: round(start * fps), durationInFrames: round((end - start) * fps) })`

The component already receives `manifest` and the implicit `remotionNodeId` (read from `useUIStore.remotionEditorTargetNodeId` or accept as a prop). Lift `remotionNodeId` to a prop for explicitness.

- [ ] **Step 1: Update the props interface**

Edit `frontend/src/components/video-editor/RemotionTimeline.tsx`. Add `remotionNodeId: string` to the props interface:

```ts
interface RemotionTimelineProps {
  remotionNodeId: string;
  manifest: VideoGraphManifest;
  currentFrame: number;
  onScrub: (frame: number) => void;
  timelineState: React.RefObject<TimelineState | null>;
}
```

Add the new imports at the top:

```ts
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
```

- [ ] **Step 2: Replace the onChange no-op with real handlers**

Inside the component body, replace the existing `<XzdarcyTimeline ...>` JSX with this version (preserve `editorData`, `effects`, `autoScroll`, `onCursorDragEnd`, `style`):

```tsx
  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);

  return (
    <XzdarcyTimeline
      ref={timelineState}
      editorData={editorData}
      effects={EFFECTS}
      autoScroll
      onClickAction={(_e, { action }) => {
        setSelectedTrackItem(action.id);
      }}
      onActionMoveEnd={({ action, start }) => {
        updateTrackItemTime(props.remotionNodeId, action.id, {
          startFrame: Math.round(start * DEFAULT_FPS),
        });
      }}
      onActionResizeEnd={({ action, start, end }) => {
        updateTrackItemTime(props.remotionNodeId, action.id, {
          startFrame: Math.round(start * DEFAULT_FPS),
          durationInFrames: Math.round((end - start) * DEFAULT_FPS),
        });
      }}
      onCursorDragEnd={(time: number) => onScrub(Math.round(time * DEFAULT_FPS))}
      style={{ height: '100%' }}
    />
  );
```

(Note: the existing signature destructures the props as `{ manifest, currentFrame, onScrub, timelineState }`. With the new `remotionNodeId` field, either destructure it too or refer to `props.remotionNodeId` as shown. Pick the style consistent with the existing function shape.)

Mark `selectedTrackItemId` as used in the JSX via a className on the timeline container so the styling task in T10 can target the selected row. The simplest path: add `data-selected-id={selectedTrackItemId ?? ''}` to the wrapping `<div className="remotion-editor-view__timeline">` in T10. For this task, just `useUIStore` import + read; T10 will wire the data attribute.

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -3`
Expected: exit 0. The new handlers might fail TS-strict if xzdarcy's callback signature was inferred wider — read `frontend/node_modules/@xzdarcy/react-timeline-editor/dist/interface/timeline.d.ts` to confirm the exact argument shapes.

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154 (no new test this task — covered by T11 smoke).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/video-editor/RemotionTimeline.tsx
git commit -m "feat(remotion): timeline click selects + drag mutates TrackItem time"
```

---

### Phase F — Keyboard shortcuts

### Task 9: useRemotionKeyboard hook

**Files:**
- Create: `frontend/src/components/video-editor/useRemotionKeyboard.ts`

Listens for `Delete` / `Backspace` (deletes selected TrackItem) and `Cmd+D` / `Ctrl+D` (duplicates at current frame). Reads `selectedTrackItemId` from uiStore, `currentFrame` as a parameter (passed from the editor view that already tracks it), `remotionNodeId` as a parameter.

- [ ] **Step 1: Implement the hook**

Create `frontend/src/components/video-editor/useRemotionKeyboard.ts`:

```ts
import { useEffect } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';

interface UseRemotionKeyboardOptions {
  remotionNodeId: string;
  currentFrame: number;
}

export function useRemotionKeyboard({ remotionNodeId, currentFrame }: UseRemotionKeyboardOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const selectedId = useUIStore.getState().selectedTrackItemId;

      // Delete / Backspace → delete selected TrackItem
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedId) return;
        e.preventDefault();
        useGraphStore.getState().deleteTrackItem(remotionNodeId, selectedId);
        useUIStore.getState().setSelectedTrackItem(null);
        return;
      }

      // Cmd+D / Ctrl+D → duplicate at playhead
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        if (!selectedId) return;
        e.preventDefault();
        useGraphStore.getState().duplicateTrackItemAtPlayhead(remotionNodeId, selectedId, currentFrame);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [remotionNodeId, currentFrame]);
}
```

Notes:
- `currentFrame` is part of the effect's dep array so that when the playhead moves, Cmd+D uses the latest frame.
- The hook bails early if the keystroke is in an input/textarea — so typing in the Properties Panel's "fontSize" field doesn't accidentally trigger Cmd+D.
- `e.preventDefault()` on `Cmd+D` prevents the browser's "bookmark" default. `e.preventDefault()` on `Delete` prevents browser back-navigation in some edge cases.

- [ ] **Step 2: Verify build + tests**

Run: `cd frontend && npm run build 2>&1 | tail -3`
Expected: exit 0.

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154 (hook tested via smoke at T11).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/useRemotionKeyboard.ts
git commit -m "feat(remotion): useRemotionKeyboard — Delete + Cmd+D shortcuts"
```

---

### Phase G — Editor view mount + CSS polish

### Task 10: Mount Toolbar + PropertiesPanel + Keyboard in RemotionEditorView + grid CSS

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx`
- Modify: `frontend/src/styles/remotion-editor.css`

Layout change: from a 3-row grid (`48px 1fr 320px`) to a 4-area grid:

```
+--------------------------------------------------+
| header (back button, title, meta) ............. |    48px
+----------------------------+---------------------+
| player                     | properties panel   |    1fr
+----------------------------+                    |
| timeline                   |                    |    320px
+----------------------------+---------------------+
   ← 1fr →                    ← 320px →
```

- [ ] **Step 1: Modify RemotionEditorView**

Edit `frontend/src/components/video-editor/RemotionEditorView.tsx`. Add the new imports near the top:

```tsx
import { RemotionEditorToolbar } from './RemotionEditorToolbar';
import { RemotionPropertiesPanel } from './RemotionPropertiesPanel';
import { useRemotionKeyboard } from './useRemotionKeyboard';
```

Inside the component, BEFORE the `if (!targetNodeId)` guard, add:

```tsx
  // Keyboard shortcuts (Delete, Cmd+D). Hook is no-op when targetNodeId is null.
  useRemotionKeyboard({
    remotionNodeId: targetNodeId ?? '',
    currentFrame,
  });
```

In the JSX, modify the header to include the Toolbar (positioned between title and meta), and add a properties-panel slot after the timeline div:

Replace the existing JSX (the happy-path return value) with:

```tsx
  return (
    <div className="remotion-editor-view">
      <header className="remotion-editor-view__header">
        <button
          type="button"
          className="remotion-editor-view__back"
          onClick={exitRemotionEditor}
        >
          ← Canvas
        </button>
        <span className="remotion-editor-view__title">
          Remotion Composition · {targetNodeId}
        </span>
        <RemotionEditorToolbar remotionNodeId={targetNodeId} />
        <span className="remotion-editor-view__meta">
          {manifest.timeline.length} layer{manifest.timeline.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        {/* existing Player mount stays here — do not modify */}
      </div>
      <aside className="remotion-editor-view__panel" data-testid="remotion-panel-slot">
        <RemotionPropertiesPanel remotionNodeId={targetNodeId} />
      </aside>
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        {/* existing Timeline mount stays here — do not modify (T8 added remotionNodeId prop) */}
      </div>
    </div>
  );
```

When you preserve the existing Player + Timeline mounts, also pass `remotionNodeId={targetNodeId}` into the `<RemotionTimeline />` call (the prop was added in T8).

- [ ] **Step 2: Update the CSS to a 4-area grid**

Edit `frontend/src/styles/remotion-editor.css`. Replace the existing `.remotion-editor-view` rule:

```css
body.app-slava-restraint .remotion-editor-view {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: 1fr 320px;
  grid-template-rows: 48px 1fr 320px;
  grid-template-areas:
    "header header"
    "player panel"
    "timeline panel";
  background: var(--sr-canvas);
  color: var(--sr-ink);
  z-index: 50;
}

body.app-slava-restraint .remotion-editor-view__header { grid-area: header; }
body.app-slava-restraint .remotion-editor-view__player { grid-area: player; }
body.app-slava-restraint .remotion-editor-view__timeline { grid-area: timeline; }
body.app-slava-restraint .remotion-editor-view__panel { grid-area: panel; border-left: 1px solid var(--sr-edge-strong); background: var(--sr-glass-strong); overflow: auto; }
```

Append toolbar + panel styles at the bottom of the same file:

```css
body.app-slava-restraint .remotion-editor-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

body.app-slava-restraint .remotion-editor-toolbar__add,
body.app-slava-restraint .remotion-editor-toolbar__delete {
  background: none;
  border: 1px solid var(--sr-edge);
  color: var(--sr-ink);
  padding: 4px 10px;
  border-radius: 2px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

body.app-slava-restraint .remotion-editor-toolbar__add:hover {
  border-color: var(--sr-accent);
}

body.app-slava-restraint .remotion-editor-toolbar__delete:not(:disabled):hover {
  border-color: var(--sr-accent);
}

body.app-slava-restraint .remotion-editor-toolbar__delete:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

body.app-slava-restraint .remotion-properties-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
}

body.app-slava-restraint .remotion-properties-panel--empty {
  color: var(--sr-ink-meta);
  display: grid;
  place-items: center;
  height: 100%;
  text-align: center;
}

body.app-slava-restraint .remotion-properties-panel__hint {
  font-size: 11px;
  margin-top: 4px;
}

body.app-slava-restraint .remotion-properties-panel__header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--sr-edge);
}

body.app-slava-restraint .remotion-properties-panel__type {
  font-weight: 600;
  color: var(--sr-ink);
}

body.app-slava-restraint .remotion-properties-panel__id {
  color: var(--sr-ink-meta);
  font-family: monospace;
}

body.app-slava-restraint .remotion-properties-panel__section h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--sr-ink-meta);
  margin: 0 0 6px 0;
}

body.app-slava-restraint .remotion-properties-panel__section label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

body.app-slava-restraint .remotion-properties-panel__section input,
body.app-slava-restraint .remotion-properties-panel__section textarea {
  background: var(--sr-canvas);
  border: 1px solid var(--sr-edge);
  color: var(--sr-ink);
  padding: 4px 8px;
  border-radius: 2px;
  font: inherit;
  font-size: 12px;
}

body.app-slava-restraint .remotion-properties-panel__section input:focus,
body.app-slava-restraint .remotion-properties-panel__section textarea:focus {
  outline: none;
  border-color: var(--sr-accent);
}
```

Confirm token names against `frontend/src/styles/slava-restraint.css` (T7 of Plan 2.1.a verified `--sr-canvas`, `--sr-glass-strong`, `--sr-ink`, `--sr-ink-meta`, `--sr-edge`, `--sr-edge-strong`, `--sr-accent` all exist).

- [ ] **Step 3: Verify build + lint + tests**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

Run: `cd frontend && npm run lint 2>&1 | tail -5`
Expected: PASS (slava-css-scope guard happy — all new rules are scoped).

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154.

- [ ] **Step 4: Manual smoke**

Open `http://localhost:5180`. Drop a Remotion Composition. Open editor. Confirm:
- Toolbar visible in header (4 add buttons + Delete)
- Properties panel visible on right (empty state until something selected)
- Clicking + Text spawns a canvas text-input + adds to timeline + renders in Player
- Clicking the text in the timeline selects it; properties panel shows editable fields
- Editing `text` updates the Player render in real time
- Pressing Delete removes the TrackItem + its source canvas node
- Cmd+D duplicates at the current playhead frame

If the manual smoke flushes out bugs, fix them BEFORE committing this task.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/RemotionEditorView.tsx frontend/src/styles/remotion-editor.css
git commit -m "feat(remotion): mount Toolbar + PropertiesPanel + keyboard in editor view"
```

---

### Phase H — Smoke + visual

### Task 11: Extend Puppeteer smoke for the full UI flow

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`

Extend the existing 8-step smoke with new steps that drive the toolbar + selection + delete + duplicate purely via UI (click buttons, fire keyboard events). The earlier steps already cover Player + Timeline + Rule A/B foundations — these new ones cover the user surface.

- [ ] **Step 1: Add new steps before the final `log('done', ...)`**

In `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`, find `log('done', 'all 8 steps passed');` near the bottom. Insert BEFORE it:

```js
    // Step 9 — Re-open editor on the existing RemotionNode
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await sleep(400);

    // Step 10 — Toolbar UI: click + Text to add a TrackItem
    log('test-10', 'toolbar + Text click');
    await page.waitForSelector('.remotion-editor-toolbar', { timeout: 2000 });
    const addButtons = await page.$$('.remotion-editor-toolbar__add');
    if (addButtons.length !== 4) {
      throw new Error(`[smoke] Toolbar add buttons expected 4, got ${addButtons.length}`);
    }
    // Click the first add button (+ Text)
    await addButtons[0].click();
    await sleep(500);
    const afterAdd = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? 0;
    });
    if (afterAdd !== 1) {
      throw new Error(`[smoke] After toolbar + Text, timeline length expected 1, got ${afterAdd}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step10-toolbar-add-text.png') });

    // Step 11 — Select the TrackItem by setting selection from store (the
    // xzdarcy onClickAction wiring is exercised by users; programmatic
    // selection is the assert path)
    log('test-11', 'set selection + properties panel populates');
    const trackId = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      return tl[0]?.id;
    });
    await page.evaluate((id) => {
      window.__nebulaUIStore?.getState?.().setSelectedTrackItem?.(id);
      // If __nebulaUIStore isn't exposed, fall back to direct mock; the editor
      // also reads via useUIStore() so the screenshot captures the new state.
    }, trackId);
    await sleep(300);
    await page.screenshot({ path: join(OUT_DIR, 'step11-selection.png') });

    // Step 12 — Delete via Delete key (keyboard hook)
    log('test-12', 'press Delete to remove selected');
    await page.keyboard.press('Delete');
    await sleep(500);
    const afterDel = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? -1;
    });
    if (afterDel !== 0) {
      throw new Error(`[smoke] After Delete, timeline length expected 0, got ${afterDel}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step12-deleted.png') });

    // Step 13 — Toolbar add, then Cmd+D to duplicate at current frame
    log('test-13', 'add via toolbar, then Cmd+D');
    await (await page.$$('.remotion-editor-toolbar__add'))[0].click(); // + Text
    await sleep(400);
    // Select it (same store-poke as step 11)
    const newTrackId = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline[0]?.id;
    });
    await page.evaluate((id) => {
      window.__nebulaUIStore?.getState?.().setSelectedTrackItem?.(id);
    }, newTrackId);
    await sleep(200);
    // Fire Cmd+D (on macOS this is Meta+D; the hook accepts both Meta and Ctrl)
    await page.keyboard.down('Meta');
    await page.keyboard.press('d');
    await page.keyboard.up('Meta');
    await sleep(500);
    const afterDup = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return remotion?.data.params?.manifest?.timeline?.length ?? -1;
    });
    if (afterDup !== 2) {
      throw new Error(`[smoke] After Cmd+D, timeline length expected 2, got ${afterDup}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step13-duplicated.png') });
```

Then update the final log:

```js
    log('done', 'all 13 steps passed');
```

**Note on `__nebulaUIStore` exposure:** if the uiStore isn't already exposed on `window`, this smoke will need a tiny shim in the dev build to expose it (similar to `window.__nebulaGraphStore`). Check `frontend/src/store/uiStore.ts` — if there's an existing `window.__nebula*` pattern from graphStore, mirror it for uiStore. If not, expose uiStore in dev mode at the bottom of the file:

```ts
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __nebulaUIStore?: typeof useUIStore }).__nebulaUIStore = useUIStore;
}
```

This is a small dev-only shim; production builds skip it.

- [ ] **Step 2: Run the smoke**

Ensure dev server + backend running. Then:

```bash
node scripts/puppeteer-driver/remotion-foundation-smoke.mjs --headless true
```

Expected: 14 screenshots (steps 0–13) in `output/puppeteer-driver/remotion-foundation-smoke/`. Final log `[done] all 13 steps passed`.

If any new step fails, the failure mode tells you which path is broken. Fix the underlying logic, do not weaken assertions.

- [ ] **Step 3: Spot-check screenshots**

Open `step10-toolbar-add-text.png`. Confirm the toolbar buttons render with Slava styling and the "smoke test" or "Hello World" text appears in the Player.

Open `step12-deleted.png`. Confirm the Player is back to black (TrackItem removed) and the canvas (in step12 screenshot? Actually it's still in editor view) timeline is empty.

- [ ] **Step 4: Commit**

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs [+ frontend/src/store/uiStore.ts if exposure shim was added]
git commit -m "test(remotion): smoke extends to toolbar + selection + delete + duplicate"
```

---

## Verification

After Task 11, manually verify in a fresh browser session:

1. Open `http://localhost:5180`
2. Drop a Remotion Composition node
3. Open the editor
4. Click `+ Text` in the toolbar — TrackItem appears in timeline, text renders in Player, text-input node appears on canvas (mirror Rule A)
5. Click the TrackItem in the timeline — properties panel populates on the right
6. Edit `text` field — Player updates live
7. Edit `fontSize` and `color` — Player updates live
8. Press Delete — TrackItem disappears, source canvas node disappears
9. Click `+ Text` again, select it, press Cmd+D — second TrackItem appears at the current playhead frame, with its own newly-spawned canvas node
10. Drag the TrackItem on the timeline — its `time.startFrame` updates (visible in properties panel)
11. Drag the edge of the TrackItem to resize — its `time.durationInFrames` updates
12. Press Ctrl-Z — last action reverses
13. Close editor (← Canvas) — selection clears
14. Re-open — start fresh (selection is null, timeline preserved)

If any step fails, debug before declaring complete.

---

## What's after Plan 2.1.c

After 2.1.c lands, Phase 2.1 is feature-complete for everything except R3F. Possible next plans:

- **Phase 2.2** — R3F isometric blocks, IsometricBlock component, LottieRenderer, 3D camera + projection matrices. The componentType mapping in `mirroring.ts` already reserves slots for these (`IsometricBlock`, `LottieNode` → null today).
- **Polish backlog (Plan 2.1.d if needed):** per-segment easing tied to the properties panel (currently `'spring'` is just a bezier approximation), real keyframe editing UI (right now keyframes can only be added programmatically), Lottie support.
- **Server-side render** — the current handler is a no-op (echoes the manifest). To produce actual video output downstream, wire `@remotion/renderer` into the backend handler.
