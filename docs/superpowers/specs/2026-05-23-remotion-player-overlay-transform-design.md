# RemotionNode Player Overlay — Interactive Layer Transform — Phase 2.3 Design Spec

**Status:** approved 2026-05-23 (Justin). Ready for plan-writing.
**Successor to:** Phase 2.1.a/b/c (foundation + mirroring + editor UI) and Phase 2.2 (R3F + Lottie).
**Companion docs:**
- Original spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` (§2 schema with `spatial` + `keyframes`)
- Plan 2.1.a foundation: `docs/superpowers/plans/2026-05-22-remotion-node-foundation.md` (renderer pattern, keyframeInterp)
- Plan 2.1.b mirroring + mappers: `docs/superpowers/plans/2026-05-22-remotion-node-mirroring-and-mappers.md`
- Plan 2.1.c editor UI: `docs/superpowers/plans/2026-05-22-remotion-node-editor-ui.md` (selection state, properties panel, timeline callbacks, keyboard hook)
- Plan 2.2 R3F + Lottie: `docs/superpowers/plans/2026-05-22-remotion-r3f-lottie-phase-2-2.md`

---

## Goal

Make rendered layers in the `<Player>` directly manipulable: click a layer to select it, drag the body to translate, drag corner/edge handles to scale (Shift-locks aspect on corners), drag the top rotation handle to rotate. Toggleable "record keyframes" mode in the toolbar inserts keyframes at the current playhead frame instead of mutating the static `spatial` base value. v1 covers CSS-driven layers (Text/SVG/Image/Video/Lottie); IsometricBlock 3D drag (Three.js raycasting + 3D-to-2D projection) is deferred.

After 2.3 lands, the demo path closes the loop: click `+ Text` → text appears center-frame → drag it where you want → scrub timeline → drag again to record a keyframe animation. The thing actually feels like a video editor.

---

## Architecture

A new `PlayerOverlay.tsx` component mounts a transparent absolutely-positioned `<div>` over the Remotion `<Player>` area inside `RemotionEditorView`. It receives all pointer events first (above the Player but visually transparent — `pointer-events: auto` only on handles and hit regions). On click, it hit-tests against rendered DOM elements (each CSS-driven renderer carries a new `data-track-item-id` attribute on its root) by reading `document.elementsFromPoint(x, y)` and finding the first element with the attribute. A hit selects the corresponding TrackItem (writes existing `uiStore.selectedTrackItemId`); a miss in empty Player area deselects.

When `selectedTrackItemId` is non-null, the overlay renders a `SelectionBox.tsx` positioned over the selected layer's `getBoundingClientRect()`. The box draws an outline, 8 handles (4 corners + 4 edges), and a rotation handle offset above the top edge. Each handle and the box body has its own drag handler. Drag deltas are converted from screen pixels to composition pixels via a `screenToComposition` helper, then dispatched through either `updateTrackItemSpatial` (record off) or `addOrUpdateKeyframe` (record on) based on `uiStore.isKeyframeRecording`.

Five existing renderers gain one new attribute. RemotionEditorToolbar gains one new button. RemotionPropertiesPanel gains one new section (Transform). uiStore gains one new field + action. graphStore gains two new actions.

### Tech stack constraints (unchanged from original spec)

- No new dependencies. Native pointer events + existing React + Zustand.
- Animation: deterministic frame-bound — keyframes use the existing `keyframeInterp` module from 2.1.a, which respects Remotion's `useCurrentFrame()`.

---

## Schema (no changes)

The `TrackItem` interface is unchanged. The relevant fields already exist and are already consumed by every CSS-driven renderer via the keyframeInterp helpers:

```ts
interface TrackItem {
  // ... existing
  spatial: {
    x: number;          // pixels from composition center
    y: number;          // pixels from composition center
    z: number;          // CSS translateZ (unused for layout; reserved for 3D)
    scale: [number, number, number];      // CSS scale3d
    rotation: [number, number, number];   // degrees, applied via rotateX/Y/Z
  };
  keyframes: Record<string, KeyframeData[]>;
  // ... existing
}
```

What's missing is UI to mutate these fields. Plan 2.3 supplies that UI.

**Coordinate convention:** all CSS-driven renderers from 2.1.a use `<AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>` so layers center themselves in the composition by default. `spatial.x/y` then act as translations *from center* (positive x = right, positive y = down per CSS conventions). Plan 2.3 preserves this — the overlay does NOT switch to top-left origin.

---

## State + actions

### `uiStore` additions

```ts
// New field
isKeyframeRecording: boolean;  // default false

// New action
toggleKeyframeRecording: () => void;
```

Stored on `uiStore` (not graphStore) because it's editor-session UI state, not part of the graph's persistent shape.

### `graphStore` additions

```ts
// Partial merge into selected TrackItem's spatial
updateTrackItemSpatial: (
  remotionNodeId: string,
  trackItemId: string,
  spatialPatch: Partial<SpatialTransform>,
) => void;

// Insert or replace a keyframe at the given frame for a given prop key.
// propName: 'position' | 'scale' | 'rotation' (matches existing keyframeInterp consumers)
// frame: the absolute frame to anchor the keyframe at
// value: vec3 (number-or-tuple matches KeyframeData.value's union)
addOrUpdateKeyframe: (
  remotionNodeId: string,
  trackItemId: string,
  propName: string,
  frame: number,
  value: number | [number, number, number],
) => void;
```

Both use `maybePushUndo(set, get, remotionNodeId)` per the T4-fix precedent from 2.1.c — drag-mutate is high-frequency (mousemove → many dispatches), debouncing collapses each drag gesture into one undo entry.

---

## Components

### `PlayerOverlay.tsx` (new, ~120 lines est.)

```tsx
// Pseudocode shape
export function PlayerOverlay({ remotionNodeId, playerRef }: Props) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);

  const handlePointerDown = (e: React.PointerEvent) => {
    const hit = hitTestTrackItem(e.clientX, e.clientY);
    if (hit) {
      setSelectedTrackItem(hit);
    } else {
      setSelectedTrackItem(null);  // click empty area = deselect
    }
  };

  return (
    <div
      className="remotion-player-overlay"
      onPointerDown={handlePointerDown}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}
    >
      {selectedTrackItemId && (
        <SelectionBox
          remotionNodeId={remotionNodeId}
          trackItemId={selectedTrackItemId}
          playerRef={playerRef}
        />
      )}
    </div>
  );
}

function hitTestTrackItem(x: number, y: number): string | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const id = el.closest('[data-track-item-id]')?.getAttribute('data-track-item-id');
    if (id) return id;
  }
  return null;
}
```

### `SelectionBox.tsx` (new, ~250 lines est.)

```tsx
// Reads the selected TrackItem's bounding rect each frame, draws box + 9 handles,
// routes drag events through one of: translate, scale (corner/edge), rotate.
export function SelectionBox({ remotionNodeId, trackItemId, playerRef }: Props) {
  const item = useGraphStore((s) => /* find TrackItem by id in manifest */);
  const isRecording = useUIStore((s) => s.isKeyframeRecording);
  const currentFrame = /* derive from player */;

  const updateSpatial = useGraphStore((s) => s.updateTrackItemSpatial);
  const upsertKeyframe = useGraphStore((s) => s.addOrUpdateKeyframe);

  const rect = useTargetRect(`[data-track-item-id="${trackItemId}"]`);
  if (!rect) return null;

  const dispatchMove = (dx: number, dy: number) => {
    const { x: compDx, y: compDy } = screenToComposition(dx, dy, playerRef.current);
    if (isRecording) {
      upsertKeyframe(remotionNodeId, trackItemId, 'position', currentFrame,
        [item.spatial.x + compDx, item.spatial.y + compDy, item.spatial.z]);
    } else {
      updateSpatial(remotionNodeId, trackItemId,
        { x: item.spatial.x + compDx, y: item.spatial.y + compDy });
    }
  };
  // dispatchScale / dispatchRotate follow the same pattern.

  return (
    <div className="remotion-selection-box" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <div className="handle handle--body" onPointerDown={...} />
      {/* 4 corner handles, 4 edge handles, 1 rotation handle */}
    </div>
  );
}
```

### `KeyframeRecordToggle` (inline in RemotionEditorToolbar)

```tsx
const isRecording = useUIStore((s) => s.isKeyframeRecording);
const toggle = useUIStore((s) => s.toggleKeyframeRecording);

<button
  type="button"
  className={`remotion-editor-toolbar__record ${isRecording ? 'remotion-editor-toolbar__record--active' : ''}`}
  onClick={toggle}
  title={isRecording ? 'Recording keyframes — click to stop' : 'Click to record keyframes on drag'}
>
  ● REC
</button>
```

Lives in the toolbar next to the existing Add / Delete buttons. Active state = red.

### Per-renderer changes

Each CSS-driven renderer adds one `data-track-item-id` attribute to its root element:

- `TextRenderer.tsx` → `<AbsoluteFill data-track-item-id={item.id} ...>`
- `SVGRenderer.tsx` → same
- `ImageRenderer.tsx` → same
- `VideoRenderer.tsx` → same
- `LottieRenderer.tsx` → same

(`IsometricBlockRenderer.tsx` does NOT get this attribute in v1 — the overlay won't hit-test 3D layers. They remain timeline-selectable only.)

### `RemotionPropertiesPanel.tsx` additions

New "Transform" section, placed BETWEEN the existing "Time" section and the componentType-specific sections:

```tsx
<section className="remotion-properties-panel__section">
  <h4>Transform</h4>
  <label>X
    <input type="number" value={item.spatial.x}
      onChange={(e) => onSpatialPatch({ x: Number(e.target.value) })} />
  </label>
  <label>Y
    <input type="number" value={item.spatial.y}
      onChange={(e) => onSpatialPatch({ y: Number(e.target.value) })} />
  </label>
  {/* Z, scale [x,y,z], rotation [x,y,z] — same shape */}
</section>
```

`onSpatialPatch` is a new helper inside the panel that dispatches `updateTrackItemSpatial`. The panel does NOT use record-mode for direct field edits — typing in the X field always writes to static spatial, never to keyframes. (Rationale: typing a number is an explicit "set this value", not a gesture. If user wants to keyframe a value, drag the layer with REC on.)

---

## Coordinate math

```ts
// Convert a screen-pixel delta to a composition-pixel delta.
// playerEl is the rendered <Player> DOM element; reads its bounding rect.
function screenToComposition(
  dxScreen: number, dyScreen: number,
  playerEl: HTMLElement,
  compositionWidth = 1280,
  compositionHeight = 720,
): { x: number; y: number } {
  const rect = playerEl.getBoundingClientRect();
  return {
    x: (dxScreen / rect.width) * compositionWidth,
    y: (dyScreen / rect.height) * compositionHeight,
  };
}
```

Composition dimensions (1280×720) are hardcoded today in `RemotionEditorView`. Plan 2.3 references them as constants. A future plan could thread them through `useVideoConfig()` like `IsometricBlockRenderer` does.

For scale handles, the math reads the layer's current scale + the drag delta to compute a multiplier. Convention:

- **Corner handle, default:** proportional scale (uses the larger of dx/dy ratios to keep aspect locked)
- **Corner handle, Shift held:** releases the proportional lock — independent X and Y scale (inverse of Figma's default, matches "Shift = freedom" mental model)
- **Edge handle:** always 1D stretch (vertical edge = scale.x only; horizontal edge = scale.y only)

```ts
// Corner drag (default, proportional)
const ratio = Math.max(
  (rect.width + dxScreen) / rect.width,
  (rect.height + dyScreen) / rect.height,
);
newScale = [item.spatial.scale[0] * ratio, item.spatial.scale[1] * ratio, item.spatial.scale[2]];

// Edge drag (e.g., right edge)
const ratioX = (rect.width + dxScreen) / rect.width;
newScale = [item.spatial.scale[0] * ratioX, item.spatial.scale[1], item.spatial.scale[2]];
```

For rotation, it's `atan2` between the rotation handle's position and the box center:

```ts
const cx = rect.left + rect.width / 2;
const cy = rect.top + rect.height / 2;
const angleRad = Math.atan2(e.clientY - cy, e.clientX - cx);
const angleDeg = (angleRad * 180) / Math.PI + 90;  // 90° offset so 0° = up
```

---

## Sub-phase split

This is ~15 tasks if done in one plan. Splitting into three sub-phases (matching the 2.1.a/b/c rhythm):

### Plan 2.3.a — Selection model + move drag + Position fields
- New uiStore `isKeyframeRecording` field + toggle action
- New graphStore `updateTrackItemSpatial` action
- `data-track-item-id` attribute on 5 CSS-driven renderers
- `PlayerOverlay.tsx` scaffolding (transparent layer + hit-test + click-to-select/deselect)
- `SelectionBox.tsx` scaffolding (just the box outline; no handles yet)
- Body-drag = translate (writes spatial.x/y via updateTrackItemSpatial)
- Properties Panel Transform section: Position X/Y/Z fields
- Puppeteer smoke +1 step (drag a Text layer, verify spatial.x updated)
- ~6 tasks

### Plan 2.3.b — Resize handles + Scale fields
- Corner drag handlers (4 corners; proportional default + Shift constraint)
- Edge drag handlers (4 edges; 1D stretch)
- Properties Panel: Scale X/Y/Z fields
- Puppeteer smoke +1 step (resize a Text layer via corner handle)
- ~5 tasks

### Plan 2.3.c — Rotation + Record mode + Keyframe action
- Rotation handle (top, offset above box)
- Rotation drag handler (atan2 math)
- Properties Panel: Rotation X/Y/Z fields
- New graphStore `addOrUpdateKeyframe` action
- KeyframeRecordToggle button in toolbar
- All drag handlers in SelectionBox switch between updateTrackItemSpatial / addOrUpdateKeyframe based on uiStore.isKeyframeRecording
- Puppeteer smoke +1 step (record-mode drag inserts a keyframe; scrub the player to verify)
- ~6 tasks

---

## Out of scope (explicit non-goals for 2.3.a/b/c)

These were considered and explicitly deferred:

1. **IsoBlock 3D drag.** R3F raycasting via `onClick` on the `<mesh>` + projecting 2D pointer deltas onto a 3D plane (typically the XZ ground plane in isometric scenes) is its own architectural exercise. Deferred to Phase 2.4 or later.
2. **Multi-select.** Shift+Click for multi-select would expand uiStore.selectedTrackItemId to a Set, change SelectionBox to compute a bounding box across multiple layers, and complicate the drag math. Deferred.
3. **Snap-to-grid / smart guides / alignment helpers.** Standard editor polish but architecturally orthogonal. Deferred.
4. **Z-order UI.** Today render order = timeline order (top of timeline = back of composition). No UI to reorder. Deferred.
5. **Keyframe management UI.** No way to view/delete/edit existing keyframes once recorded. Properties Panel could grow a "Keyframes" subsection showing the current prop's keyframe list with frame-anchor draggers. Deferred.
6. **Anchor point customization.** Default rotation/scale anchor is the layer's visual center (matches CSS `transform-origin: center`). No UI to move the anchor.
7. **Per-axis rotation handles.** v1 rotation handle rotates around Z-axis only (the visually intuitive one for 2D editors). X/Y axis rotation only via Properties Panel numeric input.
8. **Touch / pen events.** v1 is mouse/trackpad. Pointer events use the unified API but handle math + hit-test only tested for mouse.
9. **Layer locking.** No way to lock a layer to prevent accidental drag.
10. **Properties Panel keyframe-aware mode.** Numeric inputs always write to static spatial, never to keyframes, regardless of REC state. (See rationale in Components section.)

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `document.elementsFromPoint` returns Remotion's internal Player wrapper instead of the layer DOM | The `data-track-item-id` lookup uses `.closest()` which walks up the tree, so any descendant element with the attribute as an ancestor returns the right ID. Verified in 2.3.a smoke. |
| Player is scaled (CSS max-width 1280 + aspect ratio); the SelectionBox positioned via `getBoundingClientRect` reads SCREEN coordinates, not composition coordinates | `SelectionBox` is positioned in screen space (overlay is also screen space). `updateTrackItemSpatial` writes COMPOSITION space. The `screenToComposition` helper bridges them. Tested in 2.3.a. |
| Scale math accumulates error on repeated drags (1.0 × 1.0001 × 0.9999 ≈ 0.9999) | Each drag computes new scale = current scale × delta-ratio, not new scale = base × delta. Cumulative error per drag gesture is negligible; user can reset via numeric input. |
| Rotation handle position drifts when layer rotates | Rotation handle is anchored to the SelectionBox (screen-aligned), not to the rotated layer. Visually clear; matches Figma. |
| Click-to-deselect fires when user mouses up after a drag (off the layer) | Track pointer state — `pointerdown` records intent, `pointermove` cancels deselect, `pointerup` only deselects if no move happened (i.e., true click). |
| Hit-testing IsoBlock returns null (no data attribute) — overlay does nothing on 3D-layer click | Expected behavior in v1; documented as out-of-scope. User can still select IsoBlocks via timeline. |
| Record mode + Properties Panel direct-edit conflict (user toggles REC, types into X field — does it keyframe?) | Documented: Properties Panel always writes static spatial. REC only affects drag gestures. Reduces surprise. |

---

## Tests

### Unit tests (Vitest)

- `uiStore.transform.test.ts` (new) — isKeyframeRecording default + toggle
- `graphStore.spatialAndKeyframes.test.ts` (new) — updateTrackItemSpatial partial merge + addOrUpdateKeyframe insert/replace
- `PlayerOverlay.test.tsx` (new) — hit-test logic with mocked DOM, click selects + click-on-empty deselects
- `SelectionBox.test.tsx` (new) — renders handles at correct positions given a mocked rect; drag dispatches update with correct deltas
- `RemotionPropertiesPanel.test.tsx` (extend) — Transform section renders + updates spatial
- `RemotionEditorToolbar.test.tsx` (extend) — REC toggle button renders + dispatches

### Smoke (Puppeteer)

- 2.3.a: drag a Text layer → assert spatial.x changed
- 2.3.b: corner-drag a Text layer → assert spatial.scale changed
- 2.3.c: turn REC on, drag at frame 30 → assert keyframes['position'] has entry at frame 30

### Test count target

After 2.1.c: 155/155. After 2.2: 167/167. Plan 2.3 adds ~15-20 new tests across three sub-phases. Target after 2.3.c: ~185-190.

---

## Acceptance criteria

After Plan 2.3.c lands, a user opening the RemotionNode editor can:

1. Click `+ Text` → text appears center-frame in Player
2. Click on the rendered text in the Player → selection box + 8 handles + rotation handle appear
3. Drag the text body → it moves; Properties Panel Position X/Y update live
4. Drag a corner handle → text scales proportionally (or hold Shift)
5. Drag an edge handle → text stretches one dimension
6. Drag the rotation handle → text rotates
7. Click on empty Player area → selection clears, handles disappear
8. Click on a different layer in the Player → selection switches
9. Open Properties Panel Transform section → numeric inputs reflect current spatial; typing updates the layer
10. Click `● REC` in toolbar → button turns red
11. Scrub to frame 30, drag text → keyframe inserted at frame 30 (verify by scrubbing the player: position interpolates from frame 0 to 30)
12. Click `● REC` again → button deactivates; drag returns to static-mutation mode
13. Cmd+Z → last drag/keyframe reverses
14. All of 1-13 work for Text, SVG, Image, Video, Lottie. IsoBlock does NOT respond to Player click (timeline selection only, with handles still drawn for timeline-selected IsoBlock).

When all 14 pass via manual smoke, Phase 2.3 is shipped.

---

## What's after Plan 2.3

After 2.3 lands, possible next directions:

- **Phase 2.4** — IsometricBlock 3D drag (R3F raycasting + 3D-to-2D plane projection)
- **Keyframe management UI** — view/delete/edit existing keyframes in the Properties Panel
- **Multi-select + group transform** — Shift+Click + group bounding box
- **Snap-to-grid + smart guides** — Figma-style alignment helpers
- **Server-side render** — wire `@remotion/renderer` into the backend handler to produce MP4 output (still pending from Phase 2.2)
- **Anchor point customization** — drag to relocate the transform pivot
