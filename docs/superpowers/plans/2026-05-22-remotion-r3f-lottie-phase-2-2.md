# RemotionNode R3F + Lottie Layers Implementation Plan (Plan 2.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operationalize the two reserved `TrackComponentType` values (`IsometricBlock`, `LottieNode`) so users can add 3D blocks and Lottie animations as TrackItems with the same UX as Text/SVG/Image/Video: toolbar button → mirrored canvas source node → editable Properties Panel → frame-bound preview in `@remotion/player`.

**Architecture:** Two new asset-mapper components (`IsometricBlockRenderer`, `LottieRenderer`) live alongside the existing 2.1.b renderers in `frontend/src/components/video-editor/components/`. `IsometricBlockRenderer` mounts `@remotion/three`'s `<ThreeCanvas>` with orthographic isometric camera + ambient/directional lighting + a geometry router (primitive / GLTF / voxel). `LottieRenderer` wraps `@remotion/lottie`'s `<Lottie>` to play JSON by URL. `RemotionComposition` adds two `switch` cases. Five existing files extend by one branch each (mirroring, toolbar, properties panel, composition, smoke).

**Tech Stack:** React 19 + Zustand + `@xyflow/react` + `@remotion/player` + `@remotion/three` (NEW) + `@react-three/fiber` (NEW) + `@react-three/drei` (NEW) + `three` (NEW) + `@remotion/lottie` (NEW) + Vitest. Five new deps. ~1MB bundle increase.

**Source branch:** `main` (HEAD after 2.1.c merge + spec commit: `32400d5`)

**Companion docs (read before starting):**
- **Spec (required):** `docs/superpowers/specs/2026-05-22-remotion-r3f-lottie-phase-2-2-design.md` — full design with schema, scope, risks, acceptance criteria
- Original Phase 2 spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` (§1 tech stack constraints, §3 isometric math)
- Plan 2.1.a foundation: `docs/superpowers/plans/2026-05-22-remotion-node-foundation.md`
- Plan 2.1.b mirroring + asset mappers: `docs/superpowers/plans/2026-05-22-remotion-node-mirroring-and-mappers.md`
- Plan 2.1.c editor UI: `docs/superpowers/plans/2026-05-22-remotion-node-editor-ui.md`
- Existing renderer pattern: `frontend/src/components/video-editor/components/TextRenderer.tsx`, `ImageRenderer.tsx`, `VideoRenderer.tsx`, `SVGRenderer.tsx`
- Composition switch: `frontend/src/components/video-editor/RemotionComposition.tsx`
- Toolbar pattern: `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`
- Properties panel pattern: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`
- Mirroring: `frontend/src/lib/video/mirroring.ts` (currently returns null for IsoBlock + Lottie)

**Phase 2 scope after this lands:**
- ✅ 2.1.a (foundation), 2.1.b (mirroring + asset mappers), 2.1.c (editor UI), 2.2 (R3F + Lottie) → Phase 2 feature-complete
- Possible 2.3+: camera animation UI, lighting customization, server-side render via `@remotion/renderer`

---

## File Structure

### New frontend files (4)

| File | Responsibility |
|------|----------------|
| `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx` | Mounts `<ThreeCanvas orthographic>` with 45° iso camera + lighting + geometry router (primitive / GLTF / voxel). One Canvas per IsoBlock TrackItem (per-layer scope). |
| `frontend/src/components/video-editor/components/LottieRenderer.tsx` | Fetches Lottie JSON from `props.src` and renders via `<Lottie>` from `@remotion/lottie`. Empty state when src missing. |
| `frontend/tests/video/LottieRenderer.test.tsx` | Component tests for empty src + with src |
| `frontend/tests/video/IsometricBlockRenderer.test.tsx` | Component renders without crashing for each geometry mode (JSDOM limits actual GL inspection) |

### Modified frontend files (4)

| File | Change scope |
|------|--------------|
| `frontend/src/lib/video/mirroring.ts` | `componentTypeToCanvasDefId`: IsoBlock → `'text-input'`, Lottie → `'image-input'` (replaces null returns) |
| `frontend/src/components/video-editor/RemotionComposition.tsx` | Add two `switch` cases routing to the new renderers |
| `frontend/src/components/video-editor/RemotionEditorToolbar.tsx` | Add `+ Iso Block` + `+ Lottie` to `ADD_BUTTONS` (4 → 6 entries) |
| `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx` | Add IsoBlock + Lottie conditional sections |

### Modified test files (2)

| File | Change scope |
|------|--------------|
| `frontend/tests/video/mirroring.test.ts` | Update "maps each componentType" test to include IsoBlock + Lottie; delete the "returns null for Phase 2.2 deferred" test |
| `frontend/tests/video/RemotionEditorToolbar.test.tsx` | Update "renders four add buttons" → "renders six add buttons"; add 2 new dispatch tests (IsoBlock + Lottie) |

### Modified driver scripts (1)

| File | Change scope |
|------|--------------|
| `scripts/puppeteer-driver/remotion-foundation-smoke.mjs` | Add at least one step: click `+ Iso Block`, screenshot the editor with default cube visible |

### Files NOT touched (isolation invariants)

- Phase 1 editor code (`frontend/src/components/editor/`)
- All Phase 2.1.b mappers (`TextRenderer.tsx`, `SVGRenderer.tsx`, `ImageRenderer.tsx`, `VideoRenderer.tsx`)
- `frontend/src/lib/video/keyframeInterp.ts`, `manifestValidator.ts`
- `frontend/src/store/graphStore.ts`, `uiStore.ts` (mutation actions already complete from 2.1.c)
- `frontend/src/components/video-editor/RemotionTimeline.tsx`, `RemotionEditorView.tsx`, `useRemotionKeyboard.ts` (2.1.c — done)
- `frontend/src/styles/remotion-editor.css` (Properties Panel CSS already covers `__section` rules; the new IsoBlock + Lottie inputs use the same pattern)
- All backend files
- All Phase 2.1.c CSS

### Design invariants the plan enforces

1. **No new TS interface changes.** All new fields live in `TrackItem.props` (typed `Record<string, unknown>`); the schema interface is unchanged.
2. **Stub mirroring is intentional.** IsoBlock → text-input and Lottie → image-input by design. Rule A / B-1 / B-2 work unchanged because they're componentType-agnostic.
3. **Each IsoBlock = its own `<Canvas>`.** Per-layer scope. No shared 3D scene.
4. **Camera config in `props.camera` is reserved.** Schema supports it; no UI in 2.2.
5. **Lighting hardcoded in v1.** Ambient (0.5) + directional ([10,10,10], 1.0). Not exposed.
6. **No new graphStore actions.** All edits route through the existing `updateTrackItemProps` from 2.1.c.
7. **14-day package age rule applies.** Every new dep checked before install (per `~/.claude/rules/agent-security.md`). If <14 days, pin to previous stable + flag to controller.

---

## Task Sequence

11 tasks across 5 phases. Each task is one commit. Each commit must leave `npm run build` exit 0 and `npm test` passing.

- **Phase A — Spike + schema mirror** (Tasks 1-2)
- **Phase B — Asset renderers** (Tasks 3-7: Lottie + IsometricBlock scaffolding + primitives + GLTF + voxel)
- **Phase C — Composition wiring** (Task 8)
- **Phase D — UI surface** (Tasks 9-10: Toolbar + Properties Panel)
- **Phase E — Smoke** (Task 11)

---

### Phase A — Spike + schema mirror

### Task 1: Install dependencies + verify @remotion/three mounts inside Player

**Files:**
- Modify: `frontend/package.json` (5 new deps)
- Modify: `frontend/package-lock.json` (regenerated)

This is the spike task. Its job: install the 5 new packages, verify each is ≥14 days old, and prove `@remotion/three` actually integrates inside the existing `@remotion/player` without errors before any rendering code is written. If any package fails the spike, escalate to the controller — do not proceed to T2.

- [ ] **Step 1: Check package ages**

Run each of these and confirm the most recent publish date is ≥14 days before today (2026-05-22, so packages published on or before 2026-05-08 are safe):

```bash
npm view three time.modified
npm view @react-three/fiber time.modified
npm view @react-three/drei time.modified
npm view @remotion/three time.modified
npm view @remotion/lottie time.modified
```

If any package's latest version was published in the last 14 days, find the previous stable version and pin to it explicitly in step 2. If a package is fundamentally newer than 14 days (e.g., brand-new release), flag to the controller and BLOCK — do not silently install.

- [ ] **Step 2: Install the deps**

From the frontend directory:

```bash
cd frontend && npm install three @react-three/fiber @react-three/drei @remotion/three @remotion/lottie
```

If any package was pinned to a previous version in step 1, use `npm install <pkg>@<version>` for that one.

- [ ] **Step 3: Verify package.json + lockfile changes**

Run: `cd frontend && cat package.json | grep -E "three|fiber|drei|lottie"`
Expected output: 5 new entries under dependencies.

Run: `git status` and confirm only `package.json` + `package-lock.json` are modified. No source files yet.

- [ ] **Step 4: Spike — verify @remotion/three loads inside Player**

Create a temporary spike file `frontend/src/components/video-editor/__spike__.tsx`:

```tsx
import { ThreeCanvas } from '@remotion/three';
import { OrthographicCamera } from '@react-three/drei';

export function R3FSpike() {
  return (
    <ThreeCanvas style={{ width: 320, height: 240 }}>
      <OrthographicCamera makeDefault position={[10, 10, 10]} zoom={20} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.0} />
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="orange" />
      </mesh>
    </ThreeCanvas>
  );
}
```

NOTE: `@remotion/three` may export the canvas under a different name (`ThreeCanvas`, `Canvas`, etc.). If `ThreeCanvas` doesn't exist, check the package's exports by running:

```bash
cd frontend && ls node_modules/@remotion/three/dist/
cd frontend && cat node_modules/@remotion/three/package.json | grep -A 20 '"exports"'
```

Adjust the import to match the actual export. The spike's goal is to confirm SOMETHING from @remotion/three renders a cube inside Remotion's frame loop — exact API name is secondary.

- [ ] **Step 5: Run build to verify TypeScript compiles**

Run: `cd frontend && npm run build 2>&1 | tail -10`
Expected: exit 0 (chunk-size warning is pre-existing and OK).

If TS errors fire, this is the spike telling you the API doesn't match the plan's assumptions. Fix the import paths in the spike file based on actual `@remotion/three` exports. If the spike CANNOT be made to compile within 5-10 minutes of trying common API name variations, STOP and escalate BLOCKED — the plan needs to be rethought.

- [ ] **Step 6: Run tests to verify no regressions**

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 155/155 (T1 added no new tests, only deps).

- [ ] **Step 7: Delete the spike file**

```bash
rm frontend/src/components/video-editor/__spike__.tsx
```

The spike's only purpose was verifying the dep chain. The real components are built in T3 + T4. Don't leave debug files.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "deps(remotion): add three, @react-three/fiber, @react-three/drei, @remotion/three, @remotion/lottie for Phase 2.2"
```

NOTE: if the spike forced you to discover that `@remotion/three`'s public API differs from `<ThreeCanvas>` (e.g., it actually exports `Canvas` or requires a wrapping `<Player>` context), document the discovery in the commit body so T4 doesn't repeat the investigation.

---

### Task 2: Update componentTypeToCanvasDefId for IsoBlock + Lottie

**Files:**
- Modify: `frontend/src/lib/video/mirroring.ts`
- Modify: `frontend/tests/video/mirroring.test.ts`

The current `componentTypeToCanvasDefId` returns `null` for IsoBlock + Lottie (Phase 2.2 placeholder). Update to return `'text-input'` for IsoBlock (stub mirror — config lives in `props`) and `'image-input'` for Lottie (URL parallel to Image).

- [ ] **Step 1: Update the failing test first**

Open `frontend/tests/video/mirroring.test.ts`. Find these two tests:

```ts
describe('componentTypeToCanvasDefId', () => {
  it('maps each Phase 2.1.b componentType to its canvas node id', () => {
    expect(componentTypeToCanvasDefId('TextNode')).toBe('text-input');
    expect(componentTypeToCanvasDefId('SVGInput')).toBe('text-input');
    expect(componentTypeToCanvasDefId('ImageAssetNode')).toBe('image-input');
    expect(componentTypeToCanvasDefId('VideoAssetNode')).toBe('video-input');
  });

  it('returns null for Phase 2.2 deferred types', () => {
    expect(componentTypeToCanvasDefId('IsometricBlock')).toBeNull();
    expect(componentTypeToCanvasDefId('LottieNode')).toBeNull();
  });
});
```

Replace both with this single updated test (delete the second; update the first):

```ts
describe('componentTypeToCanvasDefId', () => {
  it('maps each componentType to its canvas node id', () => {
    expect(componentTypeToCanvasDefId('TextNode')).toBe('text-input');
    expect(componentTypeToCanvasDefId('SVGInput')).toBe('text-input');
    expect(componentTypeToCanvasDefId('ImageAssetNode')).toBe('image-input');
    expect(componentTypeToCanvasDefId('VideoAssetNode')).toBe('video-input');
    expect(componentTypeToCanvasDefId('IsometricBlock')).toBe('text-input');
    expect(componentTypeToCanvasDefId('LottieNode')).toBe('image-input');
  });
});
```

- [ ] **Step 2: Run tests to verify the second (deleted) one is gone and the first now fails**

Run: `cd frontend && npm test -- mirroring 2>&1 | tail -10`
Expected: 1 FAIL on the "maps each componentType" test — the IsoBlock + Lottie assertions fail because the source still returns null.

- [ ] **Step 3: Update the source**

In `frontend/src/lib/video/mirroring.ts`, find the switch statement:

```ts
case 'IsometricBlock':
case 'LottieNode':
  return null;
```

Replace with:

```ts
case 'IsometricBlock':
  return 'text-input';
case 'LottieNode':
  return 'image-input';
```

Also update the file's doc comment at the top of the function. Find:

```
 *  Phase 2.1.b covers TextNode, SVGInput (via text-input),
 *  ImageAssetNode, and VideoAssetNode. IsometricBlock + LottieNode are
 *  deferred to Phase 2.2 and return null.
```

Replace with:

```
 *  Phase 2.1.b covers TextNode, SVGInput (via text-input),
 *  ImageAssetNode, and VideoAssetNode. Phase 2.2 adds stubs for
 *  IsometricBlock (text-input) and LottieNode (image-input) — the
 *  block config and the Lottie URL live in TrackItem.props, so the
 *  spawned source node carries no meaningful state.
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- mirroring 2>&1 | tail -10`
Expected: PASS on the updated test.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 154/154 (was 155; deleted 1 test).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/video/mirroring.ts frontend/tests/video/mirroring.test.ts
git commit -m "feat(remotion): componentTypeToCanvasDefId — IsoBlock → text-input, Lottie → image-input"
```

---

### Phase B — Asset renderers

### Task 3: LottieRenderer component + tests

**Files:**
- Create: `frontend/src/components/video-editor/components/LottieRenderer.tsx`
- Create: `frontend/tests/video/LottieRenderer.test.tsx`

Render a Lottie JSON animation by URL. Empty state when src is missing. Fetch on src change. Frame-bound via `@remotion/lottie`'s `<Lottie>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/video/LottieRenderer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LottieRenderer } from '../../src/components/video-editor/components/LottieRenderer';
import type { TrackItem } from '../../src/types/video';

// Mock @remotion/lottie's Lottie component so the test doesn't need
// the real Lottie player (which expects animationData JSON).
vi.mock('@remotion/lottie', () => ({
  Lottie: ({ animationData }: { animationData: unknown }) => (
    <div data-testid="lottie-mounted" data-has-data={animationData ? 'true' : 'false'} />
  ),
}));

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'LottieNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('LottieRenderer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when src is missing', () => {
    render(<LottieRenderer item={makeItem({ props: {} })} />);
    expect(screen.getByText(/no lottie src/i)).toBeInTheDocument();
    expect(screen.queryByTestId('lottie-mounted')).toBeNull();
  });

  it('fetches the Lottie JSON from props.src and mounts <Lottie>', async () => {
    const fakeJson = { v: '5.7.1', layers: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(fakeJson),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LottieRenderer item={makeItem({ props: { src: 'https://example.com/anim.json' } })} />);

    await waitFor(() => {
      expect(screen.getByTestId('lottie-mounted')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/anim.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- LottieRenderer 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '.../LottieRenderer'`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/video-editor/components/LottieRenderer.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { AbsoluteFill } from 'remotion';
import { Lottie } from '@remotion/lottie';
import type { TrackItem } from '../../../types/video';

interface LottieRendererProps {
  item: TrackItem;
}

export function LottieRenderer({ item }: LottieRendererProps) {
  const src = typeof item.props.src === 'string' ? item.props.src : null;
  const [animationData, setAnimationData] = useState<unknown | null>(null);

  useEffect(() => {
    if (!src) {
      setAnimationData(null);
      return;
    }
    let cancelled = false;
    fetch(src)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setAnimationData(data);
      })
      .catch(() => {
        if (!cancelled) setAnimationData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!src) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no lottie src]
      </AbsoluteFill>
    );
  }

  if (!animationData) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [loading lottie…]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <Lottie animationData={animationData} style={{ width: '100%', height: '100%' }} />
    </AbsoluteFill>
  );
}
```

NOTE: `@remotion/lottie` may have a different API than `<Lottie animationData={...} />`. If T1's spike turned up info about its exports, use that. Otherwise inspect:

```bash
cd frontend && cat node_modules/@remotion/lottie/package.json | grep -A 5 '"exports"'
cd frontend && ls node_modules/@remotion/lottie/dist/
```

Common variants: `<RemotionLottie>`, `<Lottie>`. If the prop name is `lottieJSON` rather than `animationData`, adjust the test mock and the component accordingly.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- LottieRenderer 2>&1 | tail -10`
Expected: 2 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 156/156 (154 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/components/LottieRenderer.tsx frontend/tests/video/LottieRenderer.test.tsx
git commit -m "feat(remotion): LottieRenderer fetches Lottie JSON from props.src and mounts via @remotion/lottie"
```

---

### Task 4: IsometricBlockRenderer scaffolding (cube + lighting + camera)

**Files:**
- Create: `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`
- Create: `frontend/tests/video/IsometricBlockRenderer.test.tsx`

Scaffolding task: ThreeCanvas + orthographic isometric camera + ambient + directional lighting + the cube primitive (only). Sphere/cylinder/cone/plane come in T5. GLTF in T6. Voxel in T7.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/IsometricBlockRenderer.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { IsometricBlockRenderer } from '../../src/components/video-editor/components/IsometricBlockRenderer';
import type { TrackItem } from '../../src/types/video';

// JSDOM has no WebGL; stub @remotion/three's canvas as a passthrough div.
vi.mock('@remotion/three', () => ({
  ThreeCanvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="three-canvas">{children}</div>
  ),
}));

// Stub drei's OrthographicCamera so the test doesn't need three.js.
vi.mock('@react-three/drei', () => ({
  OrthographicCamera: ({ position }: { position: [number, number, number] }) => (
    <div data-testid="ortho-camera" data-pos={position.join(',')} />
  ),
}));

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'IsometricBlock',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('IsometricBlockRenderer', () => {
  it('renders a ThreeCanvas + orthographic camera by default', () => {
    const { getByTestId } = render(<IsometricBlockRenderer item={makeItem()} />);
    expect(getByTestId('three-canvas')).toBeInTheDocument();
    expect(getByTestId('ortho-camera')).toBeInTheDocument();
  });

  it('positions the default camera at the 45° isometric angle', () => {
    const { getByTestId } = render(<IsometricBlockRenderer item={makeItem()} />);
    const cam = getByTestId('ortho-camera');
    // True isometric: position vector should have x ≈ z and y > 0
    const [x, y, z] = (cam.getAttribute('data-pos') ?? '0,0,0').split(',').map(Number);
    expect(x).toBeCloseTo(z, 1);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '.../IsometricBlockRenderer'`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`:

```tsx
import { ThreeCanvas } from '@remotion/three';
import { OrthographicCamera } from '@react-three/drei';
import type { TrackItem } from '../../../types/video';

interface IsometricBlockRendererProps {
  item: TrackItem;
}

interface CameraConfig {
  azimuth?: number;   // degrees, default 45
  elevation?: number; // degrees, default arctan(1/sqrt(2)) ≈ 35.264
  zoom?: number;      // default 10
}

const DEFAULT_AZIMUTH = 45;
const DEFAULT_ELEVATION = (Math.atan(1 / Math.SQRT2) * 180) / Math.PI; // ≈ 35.264
const DEFAULT_ZOOM = 10;
const CAMERA_RADIUS = 20;

/** Spherical → Cartesian for an orbiting camera looking at origin.
 *  Azimuth = horizontal angle (around Y axis), elevation = vertical angle. */
function cameraPositionFromAngles(camera: CameraConfig): [number, number, number] {
  const azimuth = camera.azimuth ?? DEFAULT_AZIMUTH;
  const elevation = camera.elevation ?? DEFAULT_ELEVATION;
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  const x = CAMERA_RADIUS * Math.cos(elRad) * Math.sin(azRad);
  const y = CAMERA_RADIUS * Math.sin(elRad);
  const z = CAMERA_RADIUS * Math.cos(elRad) * Math.cos(azRad);
  return [x, y, z];
}

function PrimitiveCube({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

export function IsometricBlockRenderer({ item }: IsometricBlockRendererProps) {
  const geometry = (item.props.geometry as string) ?? 'cube';
  const color = (item.props.color as string) ?? '#888888';
  const size = (item.props.size as number) ?? 1;
  const camera = (item.props.camera as CameraConfig | undefined) ?? {};
  const position = cameraPositionFromAngles(camera);
  const zoom = camera.zoom ?? DEFAULT_ZOOM;

  return (
    <ThreeCanvas style={{ width: '100%', height: '100%' }}>
      <OrthographicCamera makeDefault position={position} zoom={zoom} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={1.0} />
      {geometry === 'cube' && <PrimitiveCube color={color} size={size} />}
    </ThreeCanvas>
  );
}
```

If `ThreeCanvas` isn't the right import (per T1's spike), substitute the actual export name. Same for `OrthographicCamera` if drei renamed it.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 2 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 158/158 (156 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx frontend/tests/video/IsometricBlockRenderer.test.tsx
git commit -m "feat(remotion): IsometricBlockRenderer scaffolding — ThreeCanvas + 45° iso ortho camera + lighting + cube primitive"
```

---

### Task 5: Add sphere / cylinder / cone / plane primitives

**Files:**
- Modify: `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`
- Modify: `frontend/tests/video/IsometricBlockRenderer.test.tsx`

Extend the geometry router with four more primitive shapes.

- [ ] **Step 1: Add the failing tests**

Append to the existing `describe('IsometricBlockRenderer', …)` block in `frontend/tests/video/IsometricBlockRenderer.test.tsx`:

```tsx
  it.each([
    ['cube'],
    ['sphere'],
    ['cylinder'],
    ['cone'],
    ['plane'],
  ])('routes geometry=%s through the correct primitive case', (geometry) => {
    const { container } = render(
      <IsometricBlockRenderer item={makeItem({ props: { geometry } })} />,
    );
    // IsometricBlockRenderer wraps the ThreeCanvas in a <div data-iso-geometry={geometry}>
    // so we can assert routing in JSDOM (which has no GL).
    expect(container.querySelector(`[data-iso-geometry="${geometry}"]`)).not.toBeNull();
  });
```

This adds 5 cases at once. The wrapping `data-iso-geometry` attribute is added in step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 5 FAIL — the wrapping `data-iso-geometry` div doesn't exist yet.

- [ ] **Step 3: Update the source — add primitives + the data attribute**

In `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`:

Add 4 new primitive sub-components below `PrimitiveCube`:

```tsx
function PrimitiveSphere({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <sphereGeometry args={[size / 2, 32, 16]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitiveCylinder({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <cylinderGeometry args={[size / 2, size / 2, size, 24]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitiveCone({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <coneGeometry args={[size / 2, size, 24]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function PrimitivePlane({ color, size }: { color: string; size: number }) {
  return (
    <mesh>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={color} side={2 /* THREE.DoubleSide */} />
    </mesh>
  );
}
```

Update the main return to route all 5 primitives AND wrap in a data-attribute div for JSDOM testability. Replace the return block:

```tsx
  return (
    <div data-iso-geometry={geometry} style={{ width: '100%', height: '100%' }}>
      <ThreeCanvas style={{ width: '100%', height: '100%' }}>
        <OrthographicCamera makeDefault position={position} zoom={zoom} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={1.0} />
        {geometry === 'cube'     && <PrimitiveCube     color={color} size={size} />}
        {geometry === 'sphere'   && <PrimitiveSphere   color={color} size={size} />}
        {geometry === 'cylinder' && <PrimitiveCylinder color={color} size={size} />}
        {geometry === 'cone'     && <PrimitiveCone     color={color} size={size} />}
        {geometry === 'plane'    && <PrimitivePlane    color={color} size={size} />}
      </ThreeCanvas>
    </div>
  );
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 7 PASS (2 from T4 + 5 new primitives).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 163/163 (158 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx frontend/tests/video/IsometricBlockRenderer.test.tsx
git commit -m "feat(remotion): IsometricBlockRenderer adds sphere/cylinder/cone/plane primitives + data-iso-geometry test hook"
```

---

### Task 6: Add GLTF geometry mode via useGLTF + Suspense

**Files:**
- Modify: `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`
- Modify: `frontend/tests/video/IsometricBlockRenderer.test.tsx`

Add a GLTF loader path. Uses `useGLTF` from `@react-three/drei` wrapped in `<Suspense>` for async model loading.

- [ ] **Step 1: Add the failing test**

Append to the existing `describe('IsometricBlockRenderer', …)` block:

```tsx
  it('routes geometry=gltf through the GLTF primitive case', () => {
    const { container } = render(
      <IsometricBlockRenderer item={makeItem({ props: { geometry: 'gltf', gltfUrl: 'https://example.com/cube.glb' } })} />,
    );
    expect(container.querySelector('[data-iso-geometry="gltf"]')).not.toBeNull();
  });
```

- [ ] **Step 2: Update the drei mock to cover useGLTF**

At the top of `frontend/tests/video/IsometricBlockRenderer.test.tsx`, extend the `@react-three/drei` mock:

```tsx
vi.mock('@react-three/drei', () => ({
  OrthographicCamera: ({ position }: { position: [number, number, number] }) => (
    <div data-testid="ortho-camera" data-pos={position.join(',')} />
  ),
  useGLTF: (url: string) => ({ scene: { name: `mock-scene-${url}` } }),
}));
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 1 FAIL — the gltf case is not routed yet.

- [ ] **Step 4: Update the source — add GLTF primitive + Suspense wrapper**

In `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`:

Add to the imports:

```tsx
import { Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
```

(`OrthographicCamera` already imported.)

Add the GLTF sub-component below `PrimitivePlane`:

```tsx
function GLTFPrimitive({ url }: { url: string }) {
  const gltf = useGLTF(url);
  // gltf.scene is the loaded Three.js Object3D.
  return <primitive object={gltf.scene} />;
}
```

Update the return JSX to add the gltf case AND wrap the geometry routing in Suspense (so GLTF's async loading doesn't crash sibling primitives):

```tsx
  return (
    <div data-iso-geometry={geometry} style={{ width: '100%', height: '100%' }}>
      <ThreeCanvas style={{ width: '100%', height: '100%' }}>
        <OrthographicCamera makeDefault position={position} zoom={zoom} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={1.0} />
        <Suspense fallback={null}>
          {geometry === 'cube'     && <PrimitiveCube     color={color} size={size} />}
          {geometry === 'sphere'   && <PrimitiveSphere   color={color} size={size} />}
          {geometry === 'cylinder' && <PrimitiveCylinder color={color} size={size} />}
          {geometry === 'cone'     && <PrimitiveCone     color={color} size={size} />}
          {geometry === 'plane'    && <PrimitivePlane    color={color} size={size} />}
          {geometry === 'gltf'     && <GLTFPrimitive     url={(item.props.gltfUrl as string) ?? ''} />}
        </Suspense>
      </ThreeCanvas>
    </div>
  );
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 8 PASS (7 from T4+T5 + 1 new gltf routing).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 164/164 (163 + 1 new).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx frontend/tests/video/IsometricBlockRenderer.test.tsx
git commit -m "feat(remotion): IsometricBlockRenderer adds GLTF mode via useGLTF + Suspense fallback"
```

---

### Task 7: Add voxel geometry mode via <instancedMesh>

**Files:**
- Modify: `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`
- Modify: `frontend/tests/video/IsometricBlockRenderer.test.tsx`

Voxel grid renders N cubes from a sparse list `Array<{ x, y, z, color? }>`. Uses three.js `<instancedMesh>` for performance.

- [ ] **Step 1: Add the failing test**

Append to the existing `describe('IsometricBlockRenderer', …)`:

```tsx
  it('routes geometry=voxel through the Voxel primitive case', () => {
    const voxels = [
      { x: 0, y: 0, z: 0, color: '#ff0000' },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0, color: '#00ff00' },
    ];
    const { container } = render(
      <IsometricBlockRenderer item={makeItem({ props: { geometry: 'voxel', voxels } })} />,
    );
    expect(container.querySelector('[data-iso-geometry="voxel"]')).not.toBeNull();
    // The Voxel primitive renders an annotation we can read in JSDOM.
    expect(container.querySelector('[data-voxel-count="3"]')).not.toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 1 FAIL — voxel routing missing.

- [ ] **Step 3: Update the source — add VoxelCell type, VoxelGrid component, and voxel routing**

In `frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx`, add the type and the VoxelGrid component below `GLTFPrimitive`:

```tsx
interface VoxelCell {
  x: number;
  y: number;
  z: number;
  color?: string;
}

function VoxelGrid({ voxels, fallbackColor }: { voxels: VoxelCell[]; fallbackColor: string }) {
  // Initial implementation: render N <mesh> elements (one per cell). Upgrade to
  // <instancedMesh> with per-instance colors in a follow-up if real voxel grids
  // exceed ~500 cells. The 10,000-cell soft cap is enforced by the spec; UI
  // warning lives in the Properties Panel.
  return (
    <>
      {voxels.map((cell, idx) => (
        <mesh key={idx} position={[cell.x, cell.y, cell.z]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={cell.color ?? fallbackColor} />
        </mesh>
      ))}
    </>
  );
}
```

Trade-off accepted: shipping N `<mesh>` elements is simpler than InstancedMesh + per-instance color matrix bookkeeping. For grids under ~500 cells this is fine. Plan note: switch to `<instancedMesh>` only if real perf data shows it matters.

Now update the main return JSX to (a) compute the voxels list conditionally, (b) expose `data-voxel-count` on the outer wrapper for JSDOM testability, and (c) route geometry='voxel' through the new VoxelGrid component. Replace the return block:

```tsx
  const voxels = geometry === 'voxel'
    ? ((item.props.voxels as VoxelCell[] | undefined) ?? [])
    : null;

  return (
    <div
      data-iso-geometry={geometry}
      data-voxel-count={voxels?.length}
      style={{ width: '100%', height: '100%' }}
    >
      <ThreeCanvas style={{ width: '100%', height: '100%' }}>
        <OrthographicCamera makeDefault position={position} zoom={zoom} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={1.0} />
        <Suspense fallback={null}>
          {geometry === 'cube'     && <PrimitiveCube     color={color} size={size} />}
          {geometry === 'sphere'   && <PrimitiveSphere   color={color} size={size} />}
          {geometry === 'cylinder' && <PrimitiveCylinder color={color} size={size} />}
          {geometry === 'cone'     && <PrimitiveCone     color={color} size={size} />}
          {geometry === 'plane'    && <PrimitivePlane    color={color} size={size} />}
          {geometry === 'gltf'     && <GLTFPrimitive     url={(item.props.gltfUrl as string) ?? ''} />}
          {geometry === 'voxel' && voxels && (
            <VoxelGrid voxels={voxels} fallbackColor={color} />
          )}
        </Suspense>
      </ThreeCanvas>
    </div>
  );
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- IsometricBlockRenderer 2>&1 | tail -10`
Expected: 9 PASS (8 from T4-T6 + 1 new voxel routing).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 165/165 (164 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/components/IsometricBlockRenderer.tsx frontend/tests/video/IsometricBlockRenderer.test.tsx
git commit -m "feat(remotion): IsometricBlockRenderer adds voxel geometry mode (sparse cell list → N meshes)"
```

---

### Phase C — Composition wiring

### Task 8: Wire IsoBlock + Lottie into RemotionComposition switch

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionComposition.tsx`

Update the componentType switch to route IsoBlock → IsometricBlockRenderer and Lottie → LottieRenderer.

- [ ] **Step 1: Update the source**

Edit `frontend/src/components/video-editor/RemotionComposition.tsx`. Add imports near the top:

```tsx
import { IsometricBlockRenderer } from './components/IsometricBlockRenderer';
import { LottieRenderer } from './components/LottieRenderer';
```

In the `renderItem` switch, replace the existing IsoBlock/Lottie placeholder comment + default fallback. Find:

```tsx
    case 'VideoAssetNode':
      return <VideoRenderer item={item} />;
    // IsometricBlock + LottieNode remain unimplemented until Phase 2.2.
    default:
      return (
        <AbsoluteFill
          style={{
```

Replace with:

```tsx
    case 'VideoAssetNode':
      return <VideoRenderer item={item} />;
    case 'IsometricBlock':
      return <IsometricBlockRenderer item={item} />;
    case 'LottieNode':
      return <LottieRenderer item={item} />;
    default:
      return (
        <AbsoluteFill
          style={{
```

The `default` block (the orange "renderer not yet implemented" fallback) stays as a typescript-exhaustiveness safety net. With all six componentTypes covered, the default branch is unreachable at runtime — but it's the right belt-and-suspenders for a switch on a union type that might gain new members.

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 165/165 (no new test; this task is pure wiring).

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/video-editor/RemotionComposition.tsx
git commit -m "feat(remotion): RemotionComposition routes IsoBlock + Lottie to their renderers"
```

---

### Phase D — UI surface

### Task 9: Add + Iso Block + + Lottie to Toolbar ADD_BUTTONS

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`
- Modify: `frontend/tests/video/RemotionEditorToolbar.test.tsx`

Add two entries to the `ADD_BUTTONS` const + update the existing "renders four add buttons" test + add 2 new dispatch tests.

- [ ] **Step 1: Update the failing tests first**

In `frontend/tests/video/RemotionEditorToolbar.test.tsx`:

Find the first test:

```tsx
  it('renders four add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
  });
```

Update to:

```tsx
  it('renders six add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ iso block/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ lottie/i })).toBeInTheDocument();
  });
```

After the existing "+ Image dispatches with ImageAssetNode" test, add 2 new dispatch tests:

```tsx
  it('+ Iso Block dispatches addTrackItemWithCanvasMirror with IsometricBlock', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ iso block/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'IsometricBlock' }));
  });

  it('+ Lottie dispatches addTrackItemWithCanvasMirror with LottieNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ lottie/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'LottieNode' }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- RemotionEditorToolbar 2>&1 | tail -10`
Expected: 3 FAIL — "renders six add buttons" can't find Iso Block / Lottie buttons; the two new dispatch tests can't find their buttons either.

- [ ] **Step 3: Update the source**

In `frontend/src/components/video-editor/RemotionEditorToolbar.tsx`, find the `ADD_BUTTONS` const:

```tsx
const ADD_BUTTONS: Array<{ label: string; componentType: TrackComponentType }> = [
  { label: '+ Text', componentType: 'TextNode' },
  { label: '+ SVG', componentType: 'SVGInput' },
  { label: '+ Image', componentType: 'ImageAssetNode' },
  { label: '+ Video', componentType: 'VideoAssetNode' },
];
```

Add two entries:

```tsx
const ADD_BUTTONS: Array<{ label: string; componentType: TrackComponentType }> = [
  { label: '+ Text', componentType: 'TextNode' },
  { label: '+ SVG', componentType: 'SVGInput' },
  { label: '+ Image', componentType: 'ImageAssetNode' },
  { label: '+ Video', componentType: 'VideoAssetNode' },
  { label: '+ Iso Block', componentType: 'IsometricBlock' },
  { label: '+ Lottie', componentType: 'LottieNode' },
];
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npm test -- RemotionEditorToolbar 2>&1 | tail -10`
Expected: 7 PASS (5 existing — with first one updated — + 2 new).

Run full suite: `cd frontend && npm test 2>&1 | tail -3`
Expected: 167/167 (165 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/RemotionEditorToolbar.tsx frontend/tests/video/RemotionEditorToolbar.test.tsx
git commit -m "feat(remotion): toolbar adds + Iso Block + + Lottie (now 6 add buttons)"
```

---

### Task 10: Add IsoBlock + Lottie sections to Properties Panel

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`

Add two new conditional sections following the existing per-componentType pattern. No new tests (matches T7 precedent from Plan 2.1.c — panel coverage is via T11 smoke).

- [ ] **Step 1: Add the IsoBlock section to RemotionPropertiesPanel**

Edit `frontend/src/components/video-editor/RemotionPropertiesPanel.tsx`. Find the final SVG-input section (the SVGInput case). After its closing `)}`, before the closing `</aside>`, add the IsoBlock section:

```tsx
      {item.componentType === 'IsometricBlock' && (
        <section className="remotion-properties-panel__section">
          <h4>Iso Block</h4>
          <label>
            geometry
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
          <label>
            color
            <input
              type="color"
              value={(item.props.color as string) ?? '#888888'}
              onChange={(e) => onPropsPatch({ color: e.target.value })}
            />
          </label>
          <label>
            size
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={(item.props.size as number) ?? 1}
              onChange={(e) => onPropsPatch({ size: Number(e.target.value) })}
            />
          </label>
          {item.props.geometry === 'gltf' && (
            <label>
              gltfUrl
              <input
                type="text"
                value={(item.props.gltfUrl as string) ?? ''}
                onChange={(e) => onPropsPatch({ gltfUrl: e.target.value })}
              />
            </label>
          )}
          {item.props.geometry === 'voxel' && (
            <label>
              voxels (JSON array)
              <textarea
                rows={6}
                spellCheck={false}
                value={JSON.stringify(item.props.voxels ?? [], null, 0)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    if (Array.isArray(parsed)) {
                      onPropsPatch({ voxels: parsed });
                    }
                  } catch {
                    // ignore invalid JSON — user is mid-edit
                  }
                }}
              />
            </label>
          )}
        </section>
      )}
```

- [ ] **Step 2: Add the Lottie section directly below**

After the IsoBlock section's `)}`, add the Lottie section:

```tsx
      {item.componentType === 'LottieNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Lottie</h4>
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
```

- [ ] **Step 3: Verify build + tests pass**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

Run: `cd frontend && npm test 2>&1 | tail -3`
Expected: 167/167 (no new test).

Run: `cd frontend && npm run lint 2>&1 | tail -5`
Expected: clean (CrabMark.tsx pre-existing inline-style violation only).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/video-editor/RemotionPropertiesPanel.tsx
git commit -m "feat(remotion): Properties Panel adds IsoBlock + Lottie sections"
```

---

### Phase E — Smoke

### Task 11: Extend Puppeteer smoke for IsoBlock add

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`

Add at least one step covering the new flow: click `+ Iso Block`, verify a TrackItem was added, screenshot.

- [ ] **Step 1: Add the new step before the final `log('done', …)`**

In `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`, find the existing final log line (after T11 of Plan 2.1.c, it should read `log('done', 'all 13 steps passed');`). Insert BEFORE it:

```js
    // Step 14 — Toolbar UI: click + Iso Block to add a 3D TrackItem
    log('test-14', 'toolbar + Iso Block click');
    const isoBlockBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('.remotion-editor-toolbar__add'));
      return buttons.find((b) => /iso block/i.test(b.textContent ?? ''));
    });
    if (!isoBlockBtn) {
      throw new Error('[smoke] Step 14: + Iso Block button not found');
    }
    await isoBlockBtn.click();
    await sleep(800); // R3F + ThreeCanvas need a tick to mount
    const afterIso = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      const lastItem = tl[tl.length - 1];
      return {
        timelineLength: tl.length,
        lastComponentType: lastItem?.componentType,
      };
    });
    if (afterIso.lastComponentType !== 'IsometricBlock') {
      throw new Error(`[smoke] Step 14: last TrackItem expected IsometricBlock, got ${afterIso.lastComponentType}`);
    }
    await page.screenshot({ path: join(OUT_DIR, 'step14-isoblock-add.png') });
```

- [ ] **Step 2: Update the final log line**

Change:

```js
    log('done', 'all 13 steps passed');
```

To:

```js
    log('done', 'all 14 steps passed');
```

- [ ] **Step 3: Verify dev servers are running**

Run: `lsof -i :8000 -i :5180 -P -n 2>/dev/null | head -5`

Backend should be on 8000, Vite on 5180. If either is missing, restart per the project's existing commands:

```bash
cd backend && ./.venv/bin/python -m uvicorn main:app --reload --port 8000 &
cd frontend && npm run dev -- --port 5180 --strictPort &
```

- [ ] **Step 4: Run the smoke**

```bash
node /Users/justinperea/Documents/Workspace/Projects/nebula_nodes/scripts/puppeteer-driver/remotion-foundation-smoke.mjs --headless true
```

Expected: 15 screenshots (steps 0-14) in `output/puppeteer-driver/remotion-foundation-smoke/`. Final log `[done] all 14 steps passed`.

If step 14 fails because the IsoBlock TrackItem didn't render in the Player, that's a real failure — `@remotion/three`'s `<ThreeCanvas>` may need a different mount pattern inside Remotion's player. Debug by:
1. Capturing the page console: `page.on('console', ...)` already in place at the top of the smoke
2. Running `--headless false` to inspect visually
3. Re-reading `node_modules/@remotion/three/dist/index.d.ts` for the actual API surface

Do NOT weaken the assertion — fix the underlying issue. If completely stuck after ~30 minutes, escalate BLOCKED.

- [ ] **Step 5: Spot-check the screenshot**

Open `step14-isoblock-add.png`. Confirm:
- Toolbar has 6 add buttons (T9 wiring visible)
- Player area shows the default isometric cube rendered

If the Player area is black or shows the orange "renderer not yet implemented" fallback, the routing in T8 didn't take effect — re-run T8 verification or check the build.

- [ ] **Step 6: Commit**

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs
git commit -m "test(remotion): smoke extends to + Iso Block click + screenshot"
```

---

## Verification

After Task 11, manually verify in a fresh browser session (Justin's call):

1. Open `http://localhost:5180`
2. Drop a Remotion Composition node
3. Open the editor
4. Click `+ Iso Block` — TrackItem appears in timeline, default cube renders in Player, text-input mirrored on canvas (Rule A)
5. Select the IsoBlock — Properties Panel shows geometry/color/size
6. Change geometry to Sphere → Player updates live
7. Change geometry to GLTF, paste a public URL (e.g., a `.glb` from sketchfab or three.js examples) → model loads after Suspense
8. Change geometry to Voxel, paste a JSON array (e.g., `[{"x":0,"y":0,"z":0,"color":"#ff0000"},{"x":1,"y":0,"z":0}]`) → 2 cubes render
9. Click `+ Lottie`, paste a public Lottie URL (e.g., `https://lottie.host/...`) → animation plays in Player
10. Drag the IsoBlock TrackItem on the timeline → time updates
11. Press Delete → TrackItem + source canvas node both removed (Rule B-1)
12. Cmd+D on an IsoBlock → duplicate at playhead with fresh source node (deep-cloned props per 2.1.c fix)
13. Ctrl-Z → last action reverses

If any step fails, debug before declaring complete. The 9-item acceptance criteria from the spec are this list (1-9 above with minor numbering offset).

---

## What's after Plan 2.2

After 2.2 lands, Phase 2 is feature-complete. Possible next plans:

- **Camera animation UI** — expose `props.camera` in the Properties Panel; keyframe interp already supports it via existing `keyframes` field
- **Lighting + materials UI** — expose ambient/directional intensities + material roughness/metalness in the Properties Panel
- **Server-side render** — wire `@remotion/renderer` into the backend handler so the RemotionNode actually produces MP4 output (currently the handler is a no-op echo)
- **R3F voxel-painting UI** — replace the JSON textarea with a 3D paint interface for authoring voxel grids visually
- **R3F-based 2D layers** — replace HTML-mounted Text/SVG layers with R3F equivalents for true GL composition across all layer types

Or pause for a portfolio-relevant deliverable: blog 003 covering 2.1.a + 2.1.b + 2.1.c + 2.2; FORjustin.md update for Phase 2; demo video for X; push to origin.
