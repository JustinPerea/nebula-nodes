# RemotionNode R3F + Lottie Layers — Phase 2.2 Design Spec

**Status:** approved 2026-05-22 (Justin). Ready for plan-writing.
**Successor to:** Phase 2.1.a (foundation), 2.1.b (mirroring + asset mappers), 2.1.c (editor UI)
**Companion docs:**
- Original spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` (decisions resolved 2026-05-21 §4: Phase 2.2 = R3F isometric 3D cameras + blocks)
- Phase 2.1.b plan (asset mapper pattern): `docs/superpowers/plans/2026-05-22-remotion-node-mirroring-and-mappers.md`
- Phase 2.1.c plan (editor UI): `docs/superpowers/plans/2026-05-22-remotion-node-editor-ui.md`

---

## Goal

Operationalize the two reserved `TrackComponentType` values (`IsometricBlock`, `LottieNode`) so users can add 3D blocks and Lottie animations as TrackItems with the same UX as Text/SVG/Image/Video: toolbar button → mirrored canvas source node → editable in the Properties Panel → rendered live in the `@remotion/player`.

After Plan 2.2 lands, all six values of `TrackComponentType` are functional, the editor exposes six add buttons, and the Phase 2 editor thesis (deterministic frame-bound layer composition across 2D + 3D + vector animation) is complete.

---

## Architecture

Two new asset-mapper components live alongside the existing 2.1.b renderers (`TextRenderer`, `SVGRenderer`, `ImageRenderer`, `VideoRenderer`):

- **`IsometricBlockRenderer.tsx`** — mounts `@remotion/three`'s `<ThreeCanvas orthographic>` with a default 45° true-isometric camera, ambient + directional lighting, and routes to one of three geometry modes (primitive / GLTF / voxel) based on `props.geometry`.
- **`LottieRenderer.tsx`** — wraps `@remotion/lottie`'s `<Lottie>` and fetches the Lottie JSON from `props.src`.

Both plug into `RemotionComposition.tsx` via the existing componentType `switch` (mirror of 2.1.b's pattern). Five existing files each extend by one branch:

- `frontend/src/lib/video/mirroring.ts` — `componentTypeToCanvasDefId` for the two new types
- `frontend/src/components/video-editor/RemotionEditorToolbar.tsx` — 2 new `ADD_BUTTONS` entries
- `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx` — 2 new conditional sections
- `frontend/src/components/video-editor/RemotionComposition.tsx` — 2 new `switch` cases
- `scripts/puppeteer-driver/remotion-foundation-smoke.mjs` — at minimum, +1 step adding an IsometricBlock and screenshotting

### Tech-stack constraints (unchanged from original spec §1)

- Rendering: `@remotion/player` (already used)
- Timeline: `@xzdarcy/react-timeline-editor` (already used)
- 3D: `@react-three/fiber` + `@react-three/drei` + `@remotion/three`
- Animation: deterministic frame-bound only. No requestAnimationFrame, no Framer Motion, no CSS transitions. `@remotion/three` makes R3F render at Remotion's frame rate (it overrides R3F's default RAF loop) so this constraint is satisfied by construction.
- Lottie: `@remotion/lottie` (official, frame-bound)

---

## Schema additions

No changes to the `TrackItem` TypeScript interface — all new fields live in `TrackItem.props: Record<string, unknown>` (already designed this way for extensibility in 2.1.a).

### IsometricBlock `props` keys

| Key | Type | Default | When used |
|-----|------|---------|-----------|
| `geometry` | `'cube' \| 'sphere' \| 'cylinder' \| 'cone' \| 'plane' \| 'gltf' \| 'voxel'` | `'cube'` | always |
| `color` | hex string | `'#888888'` | primitives + voxel cell fallback |
| `size` | number | `1` | primitives (uniform scale) |
| `gltfUrl` | string | — | `geometry === 'gltf'` |
| `voxels` | `Array<{ x: number; y: number; z: number; color?: string }>` | `[]` | `geometry === 'voxel'` |
| `camera?` | `{ azimuth?: number; elevation?: number; zoom?: number }` | undefined → 45° iso | reserved for keyframed camera UI in a later phase |

**Voxel format:** sparse list. Each entry is one filled cell at integer grid coordinates with an optional per-cell color (defaults to `props.color` if omitted). Empty cells are absent from the list. Renderer composes via R3F `<instancedMesh>` for performance on grids > 100 cells.

**Camera:** if `props.camera` is undefined or missing fields, defaults to azimuth=45°, elevation=arctan(1/√2)≈35.264° (true isometric), zoom=10. The `props.camera` field is reserved for keyframed camera animation in a follow-up phase — Plan 2.2 does NOT expose camera UI in the Properties Panel.

### LottieNode `props` keys

| Key | Type | Default | When used |
|-----|------|---------|-----------|
| `src` | string (URL of Lottie JSON) | `''` | always |

---

## Mirroring + toolbar additions

### componentTypeToCanvasDefId

The existing helper in `frontend/src/lib/video/mirroring.ts` returns null today for `IsometricBlock` and `LottieNode`. Plan 2.2 updates:

- `IsometricBlock` → `'text-input'` (stub mirror; config lives entirely in `props`)
- `LottieNode` → `'image-input'` (Lottie JSON is fetched by URL like an image)

Stub-mirror rationale: every TrackItem must have a source canvas node for Rule A / B-1 / B-2 to remain consistent. Spawning a config-heavy custom node (`iso-block-input` with geometry dropdown, voxel JSON editor, GLTF URL, etc.) is more surface area without user-facing benefit — the Properties Panel already exposes all config knobs. Stubbing onto existing node types keeps the mirroring rules honest with no UX cost.

### Toolbar

`ADD_BUTTONS` in `RemotionEditorToolbar.tsx` grows from 4 to 6 entries:

```ts
const ADD_BUTTONS = [
  { label: '+ Text',      componentType: 'TextNode' },
  { label: '+ SVG',       componentType: 'SVGInput' },
  { label: '+ Image',     componentType: 'ImageAssetNode' },
  { label: '+ Video',     componentType: 'VideoAssetNode' },
  { label: '+ Iso Block', componentType: 'IsometricBlock' },
  { label: '+ Lottie',    componentType: 'LottieNode' },
];
```

No other toolbar changes. Existing tests for `+ Text` / `+ Image` dispatch already verify the pattern; +2 add-button render assertions cover the new entries.

---

## Component design

### `IsometricBlockRenderer.tsx`

```tsx
// Pseudocode shape — actual implementation per the plan
import { ThreeCanvas } from '@remotion/three';
import { OrthographicCamera } from '@react-three/drei';
import { useCurrentFrame } from 'remotion';

export function IsometricBlockRenderer({ item }: { item: TrackItem }) {
  const geometry = item.props.geometry ?? 'cube';
  const camera = item.props.camera ?? DEFAULT_ISO_CAMERA;

  return (
    <ThreeCanvas style={{ width: '100%', height: '100%' }}>
      <OrthographicCamera
        makeDefault
        position={cameraPositionFromAngles(camera)}
        zoom={camera.zoom ?? 10}
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.0} />

      {geometry === 'cube'     && <PrimitiveCube     props={item.props} />}
      {geometry === 'sphere'   && <PrimitiveSphere   props={item.props} />}
      {geometry === 'cylinder' && <PrimitiveCylinder props={item.props} />}
      {geometry === 'cone'     && <PrimitiveCone     props={item.props} />}
      {geometry === 'plane'    && <PrimitivePlane    props={item.props} />}
      {geometry === 'gltf'     && <GLTFLoader        url={item.props.gltfUrl as string} />}
      {geometry === 'voxel'    && <VoxelGrid         voxels={item.props.voxels as VoxelCell[]} color={item.props.color as string} />}
    </ThreeCanvas>
  );
}
```

- One `<ThreeCanvas>` per IsometricBlock TrackItem (per-layer scope per the brainstorm decision)
- Hardcoded lighting in v1; expose via props in a later phase if needed
- Sub-components for each geometry mode keep the file small
- `GLTFLoader` uses `useGLTF` from `@react-three/drei` with Suspense
- `VoxelGrid` uses R3F `<instancedMesh>` to render N cubes from the sparse list
- `cameraPositionFromAngles({ azimuth, elevation, zoom })` is a small helper the plan will define inline: spherical-to-Cartesian conversion at a fixed radius (e.g., 20), producing `[x, y, z]` so the camera looks at origin from the requested angle. Defaults yield approximately `[14.14, 11.55, 14.14]`.

### `LottieRenderer.tsx`

```tsx
import { Lottie } from '@remotion/lottie';
import { useState, useEffect } from 'react';

export function LottieRenderer({ item }: { item: TrackItem }) {
  const src = item.props.src as string | undefined;
  const [animationData, setAnimationData] = useState<unknown | null>(null);

  useEffect(() => {
    if (!src) return;
    fetch(src).then((r) => r.json()).then(setAnimationData);
  }, [src]);

  if (!animationData) return null; // or a placeholder rectangle
  return <Lottie animationData={animationData} style={{ width: '100%', height: '100%' }} />;
}
```

- Fetch + caching is intentionally minimal in v1. If users hit performance issues with re-fetching on every prop change, add a small in-memory cache keyed by URL.
- `<Lottie>` from `@remotion/lottie` is frame-bound — it reads `useCurrentFrame()` internally.

### Properties Panel additions

Two new conditional sections in `RemotionPropertiesPanel.tsx`:

```tsx
{item.componentType === 'IsometricBlock' && (
  <section className="remotion-properties-panel__section">
    <h4>Iso Block</h4>
    <label>geometry
      <select
        value={(item.props.geometry as string) ?? 'cube'}
        onChange={(e) => onPropsPatch({ geometry: e.target.value })}
      >
        <option value="cube">Cube</option>
        <option value="sphere">Sphere</option>
        <option value="cylinder">Cylinder</option>
        <option value="cone">Cone</option>
        <option value="plane">Plane</option>
        <option value="gltf">GLTF</option>
        <option value="voxel">Voxel</option>
      </select>
    </label>
    <label>color
      <input type="color" value={(item.props.color as string) ?? '#888888'}
        onChange={(e) => onPropsPatch({ color: e.target.value })} />
    </label>
    <label>size
      <input type="number" min={0.1} step={0.1}
        value={(item.props.size as number) ?? 1}
        onChange={(e) => onPropsPatch({ size: Number(e.target.value) })} />
    </label>
    {item.props.geometry === 'gltf' && (
      <label>gltfUrl
        <input type="text" value={(item.props.gltfUrl as string) ?? ''}
          onChange={(e) => onPropsPatch({ gltfUrl: e.target.value })} />
      </label>
    )}
    {item.props.geometry === 'voxel' && (
      <label>voxels (JSON array)
        <textarea rows={6} spellCheck={false}
          value={JSON.stringify(item.props.voxels ?? [])}
          onChange={(e) => {
            try { onPropsPatch({ voxels: JSON.parse(e.target.value) }); } catch { /* ignore invalid JSON */ }
          }} />
      </label>
    )}
  </section>
)}

{item.componentType === 'LottieNode' && (
  <section className="remotion-properties-panel__section">
    <h4>Lottie</h4>
    <label>src (URL)
      <input type="text" value={(item.props.src as string) ?? ''}
        onChange={(e) => onPropsPatch({ src: e.target.value })} />
    </label>
  </section>
)}
```

### Routing in RemotionComposition

```tsx
// In the existing componentType switch in RemotionComposition.tsx
case 'IsometricBlock': return <IsometricBlockRenderer item={item} />;
case 'LottieNode':     return <LottieRenderer item={item} />;
```

---

## Dependencies

| Package | Purpose | Notes |
|---------|---------|-------|
| `three` | Core 3D library | Peer dep of R3F |
| `@react-three/fiber` | React renderer for three.js | Provides `<Canvas>` |
| `@react-three/drei` | R3F helpers | `useGLTF`, `OrthographicCamera` |
| `@remotion/three` | Frame-bound R3F integration | Provides `<ThreeCanvas>` that ticks at Remotion's frame rate |
| `@remotion/lottie` | Frame-bound Lottie player | Provides `<Lottie>` |

All five gated by the 14-day package age rule (per `~/.claude/rules/agent-security.md`). The plan must check each package's current publish date before adding it. If any package's latest version is <14 days old, pin to the previous stable.

Bundle size impact estimate: three.js (~600KB minified) + R3F (~100KB) + drei subset (~50KB) + remotion adapters (~30KB) + lottie (~200KB) ≈ **~1MB** added to the editor bundle. Lazy-load if `@remotion/three` and `@remotion/lottie` support dynamic import (likely yes — they're side-effect-light).

---

## Out of scope (explicit non-goals)

These were considered and explicitly deferred:

1. **Camera animation UI.** `props.camera` is reserved as a hook for later; the Properties Panel has no camera controls in Plan 2.2. A composition can still keyframe the camera by hand-editing manifest JSON (or by a CLI script) — no programmatic block.
2. **Lighting customization UI.** Ambient + directional defaults are hardcoded. Lighting can move into `props.lighting` later.
3. **Shared 3D scene across blocks.** Each IsometricBlock gets its own `<ThreeCanvas>` (per-layer scope). Blocks in different TrackItems can't visually interact in 3D space; they composite at the 2D layer level via Remotion's `<AbsoluteFill>` stack.
4. **Voxel-painting UI.** Voxels are entered as JSON in the Properties Panel textarea. No 3D paint interface; no Magicavoxel import. JSON-only.
5. **Lottie file upload.** Lottie source is URL-only — no drag-and-drop, no library picker. Same constraint as Image/Video in 2.1.b.
6. **GLTF caching layer.** `useGLTF` from drei has its own internal cache; no custom layer on top.
7. **Per-block animation timeline.** Block-internal animation (e.g., GLTF clip selection, voxel cell animation over frames) is deferred. The `keyframes` field on TrackItem can already animate the block's spatial transform and `props.size` / `props.color` — that's the v1 surface.
8. **Tree-shaking optimization for three.js.** Accept the ~1MB bundle hit; revisit if landing-page perf becomes a portfolio concern.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `@remotion/three` doesn't actually integrate cleanly with `@remotion/player` (e.g., SSR issues) | Plan task 1: spike — install the deps, mount a trivial cube in a throwaway test, verify it renders inside the existing Player. If it fails, escalate before continuing. |
| Bundle size hits Vite's chunk-size warning hard (>1MB) | Already warned today (chunk-size is pre-existing warning); accept noise. Lazy-load via dynamic import if interactive perf degrades. |
| GLTF loading is async + blocks the Remotion frame loop while loading | `<Suspense>` wrapper with a fallback. Acceptable for v1 — preview will show fallback until model resolves. |
| Voxel grids > 1000 cells cause R3F perf drop | Use `<instancedMesh>` from the start. Set a soft cap of 10,000 cells; UI shows a warning if exceeded. |
| Lottie animations with audio (rare) — Remotion may not sync audio correctly | Document as known limitation; Lottie audio is uncommon. |

---

## Tests

### Unit tests (Vitest)

- `mirroring.test.ts` extended: IsometricBlock → 'text-input', LottieNode → 'image-input'
- `RemotionEditorToolbar.test.tsx` extended: now 6 add buttons, dispatch tests for IsoBlock + Lottie
- `IsometricBlockRenderer.test.tsx`: renders without crashing for each geometry mode (JSDOM has WebGL limitations — verify by inspecting the rendered JSX tree, not the actual GL output)
- `LottieRenderer.test.tsx`: renders null on empty src; renders `<Lottie>` element on src+resolved fetch (mock fetch)
- Properties Panel: conditional sections appear for IsoBlock + Lottie componentTypes

### Smoke (Puppeteer)

Extend `remotion-foundation-smoke.mjs` with at minimum one step:

- Add `+ Iso Block` via toolbar, screenshot the editor with the default cube visible

Optionally (stretch): add `+ Lottie` with a known public Lottie JSON URL, screenshot.

Target step count: 14 or 15 (was 13 after 2.1.c).

### Baseline test count expectation

Plan 2.1.c left frontend at 155/155. Plan 2.2 adds ~6-10 new tests. Target: 161-165/161-165 passing.

---

## Implementation hint: task breakdown sketch

The plan (next document) will likely decompose into:

1. Spike: install deps, verify `@remotion/three` + `@remotion/lottie` mount inside the existing Player (failure escape hatch)
2. Update `componentTypeToCanvasDefId` for IsometricBlock + LottieNode + test
3. Create `LottieRenderer.tsx` + test
4. Create `IsometricBlockRenderer.tsx` scaffolding (ThreeCanvas + camera + lighting) + cube primitive + test
5. Add sphere / cylinder / cone / plane primitives to IsometricBlockRenderer
6. Add GLTF mode via `useGLTF` + Suspense fallback
7. Add voxel mode via `<instancedMesh>`
8. Wire IsometricBlock + LottieNode into RemotionComposition's componentType switch
9. Add `+ Iso Block` + `+ Lottie` to Toolbar ADD_BUTTONS + extend tests (6 buttons render + 2 new dispatch tests)
10. Add IsometricBlock + LottieNode conditional sections to RemotionPropertiesPanel
11. Extend Puppeteer smoke (at minimum +1 step for IsoBlock add)

~11 tasks. May expand to 12-13 if the spike surfaces integration friction.

---

## Acceptance criteria

A user opening the RemotionNode editor can:

1. Click `+ Iso Block` → a TrackItem appears in the timeline, a default isometric cube renders in the Player at center frame, a mirrored canvas source node spawns (Rule A holds)
2. Select the IsoBlock TrackItem → Properties Panel shows geometry dropdown + color + size
3. Change geometry to Sphere → Player updates live
4. Change geometry to GLTF, paste a public GLTF URL → model loads after Suspense resolves
5. Change geometry to Voxel, paste a JSON array of voxel cells → multi-cube structure renders
6. Click `+ Lottie`, paste a public Lottie JSON URL → animation plays in the Player, frame-bound
7. Drag the IsoBlock or Lottie TrackItem on the timeline → time updates (no R3F-specific regressions)
8. Press Delete → both layers disappear + their mirrored source canvas nodes are removed (Rule B-1 holds)
9. Cmd+D on an IsoBlock → duplicate appears at playhead, with a fresh source canvas node (deep-cloned props per the 2.1.c fix)

When all 9 acceptance items pass via Justin's manual smoke, Phase 2.2 is shipped.

---

## What's after Plan 2.2

After 2.2 lands, Phase 2 is feature-complete. Possible next directions:

- **Camera animation UI** (the deferred `props.camera` UI surface)
- **Lighting + materials UI** (expose ambient/directional intensity, material roughness/metalness)
- **Server-side render** — wire `@remotion/renderer` into the backend handler to produce actual MP4 output (currently the handler is a no-op echo)
- **R3F-based 2D layers** — replace the HTML-mounted Text/SVG layers with R3F equivalents for true GL composition across all layer types (architectural — not needed unless GL filters become a feature)
- **Voxel-painting UI** — a 3D paint interface for authoring voxel grids visually
