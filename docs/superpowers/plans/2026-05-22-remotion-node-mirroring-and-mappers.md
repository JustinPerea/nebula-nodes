# RemotionNode Mirroring + Asset Mappers Implementation Plan (Plan 2.1.b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the architectural surface of Phase 2.1 by (a) adding the remaining three asset mappers — SVGRenderer, ImageRenderer, VideoRenderer — so every TrackItem componentType except the Phase-2.2-deferred `IsometricBlock` / `LottieNode` actually renders, and (b) wiring the bidirectional graph mirroring rules from spec §Phase 3: Rule A spawns a corresponding canvas node when a TrackItem is instantiated, Rule B prunes a TrackItem when its source canvas node is deleted or disconnected.

**Architecture:** The three new asset mappers follow the TextRenderer template — pure React components that take `{ item: TrackItem }`, use `useCurrentFrame()` + `interpolateScalar`/`interpolateVec3` for animations, and apply transforms via inline CSS (the inline-styles lint exemption from 2.1.a's T11/T12 already covers `frontend/src/components/video-editor/`). All three render through Remotion's `<Img>` or `<Video>` components — including SVG, which converts inline markup to a `data:image/svg+xml` URL to avoid any `dangerouslySetInnerHTML` surface. They wire into `RemotionComposition.renderItem`'s switch alongside `TextRenderer`. Graph mirroring lives in a new helper `frontend/src/lib/video/mirroring.ts` plus two graphStore actions: `addTrackItemWithCanvasMirror(remotionNodeId, partial)` (Rule A) and prune-on-removal logic that runs inside the existing `onNodesChange`/`onEdgesChange` handlers (Rule B). The componentType → canvas-node mapping is a single source-of-truth helper: `TextNode → text-input`, `SVGInput → text-input` (no dedicated SVG node exists; user pastes SVG markup into the text node), `ImageAssetNode → image-input`, `VideoAssetNode → video-input`.

**Tech Stack:** React 19 + Zustand + `@xyflow/react` + Vitest (frontend). Remotion 4 + `@remotion/media` for the `<Video>` component. No backend changes — the Phase 2.1.a handler accepts any valid manifest.

**Source branch:** `main` (HEAD: `6cba824` — the Phase 2.1.a merge commit, 26 commits ahead of `origin/main` as of this writing)

**Companion docs (read before starting):**
- Spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md` §Phase 3 (Bidirectional Graph Mirroring) and §Phase 4 (Deterministic Motion Composition Execution)
- Phase 2.1.a plan: `docs/superpowers/plans/2026-05-22-remotion-node-foundation.md` (read the "File Structure" section to see the conventions already established)
- TextRenderer pattern: `frontend/src/components/video-editor/components/TextRenderer.tsx`
- Composition wiring: `frontend/src/components/video-editor/RemotionComposition.tsx`
- Remotion best practices: `~/.claude/skills/remotion-best-practices/SKILL.md` — for `<Img>`, `<Video>`, `<Audio>`, `staticFile()`, `Sequence` patterns
- Manifest write path: `updateRemotionManifest` in `frontend/src/store/graphStore.ts`
- Edge/node change handlers: `onNodesChange` (graphStore.ts:799), `onEdgesChange` (graphStore.ts:822)

**Phase 2.1 scope split:**
- ✅ Plan 2.1.a (shipped): backend + canvas card + editor lifecycle + Player + Timeline + keyframeInterp + manifestValidator + TextRenderer
- ✅ This plan (2.1.b — mirroring + asset mappers): SVGRenderer, ImageRenderer, VideoRenderer + Rules A/B
- ⏭ Plan 2.1.c (next): in-editor toolbar to add/delete TrackItems, selection state, playhead-relative duplication (Cmd+D), drag-to-trim handles on timeline
- ⏭ Phase 2.2 (separate plan): R3F isometric blocks, IsometricBlock component, LottieRenderer, 3D camera + projection matrices

**componentType → canvas-node mapping (locked):**
| TrackItem `componentType` | Canvas node `definitionId` | Notes |
|---|---|---|
| `TextNode` | `text-input` | Shipped in 2.1.a's TextRenderer |
| `SVGInput` | `text-input` | No dedicated SVG node exists in the registry — SVG markup lives as text in `text-input.params.text` and renders via data URL |
| `ImageAssetNode` | `image-input` | TrackItem.props.src reads from upstream image-input's output |
| `VideoAssetNode` | `video-input` | TrackItem.props.src reads from upstream video-input's output |
| `IsometricBlock` | DEFERRED to Phase 2.2 | Requires R3F integration |
| `LottieNode` | DEFERRED to Phase 2.2 | Requires Lottie integration |

---

## File Structure

### Frontend files (8)

| File | Responsibility | Change scope |
|------|----------------|--------------|
| `frontend/src/components/video-editor/components/SVGRenderer.tsx` | NEW. Asset mapper for `componentType: 'SVGInput'`. Converts `item.props.svg` (raw SVG string) to a `data:image/svg+xml` URL and renders via Remotion's `<Img>`. Falls back to `item.props.src` if no inline markup. | New file |
| `frontend/src/components/video-editor/components/ImageRenderer.tsx` | NEW. Asset mapper for `componentType: 'ImageAssetNode'`. Uses Remotion's `<Img>` with `item.props.src`. | New file |
| `frontend/src/components/video-editor/components/VideoRenderer.tsx` | NEW. Asset mapper for `componentType: 'VideoAssetNode'`. Uses `<Video>` from `@remotion/media` with `item.props.src`. Optional volume from `item.props.volume`. | New file |
| `frontend/src/components/video-editor/RemotionComposition.tsx` | MODIFY. Add three new branches to `renderItem` switch — SVGInput → SVGRenderer, ImageAssetNode → ImageRenderer, VideoAssetNode → VideoRenderer. Default branch shrinks to just IsometricBlock + LottieNode. | Small change |
| `frontend/src/lib/video/mirroring.ts` | NEW. Two pure helpers: `componentTypeToCanvasDefId(componentType): string \| null` (the mapping) and `pruneTrackItemsForDeletedNode(manifest, deletedNodeId): { changed: boolean, manifest: VideoGraphManifest }`. | New file |
| `frontend/src/store/graphStore.ts` | MODIFY. Add `addTrackItemWithCanvasMirror` action (Rule A). Modify `onNodesChange` to prune TrackItems on node removal (Rule B-1). Modify `onEdgesChange` to prune TrackItems when a sources-edge to a RemotionNode is removed (Rule B-2). | Multiple methods |
| `frontend/tests/video/mirroring.test.ts` | NEW. Unit tests for `componentTypeToCanvasDefId` and `pruneTrackItemsForDeletedNode`. | New test file |
| `frontend/tests/video/graphStore.mirroring.test.ts` | NEW. Integration tests for `addTrackItemWithCanvasMirror` + Rule B-1 (node deletion) + Rule B-2 (edge removal). | New test file |

### Files NOT touched (Phase 2.1.a isolation invariant)

- `frontend/src/components/nodes/RemotionNode.tsx` — card unchanged
- `frontend/src/components/video-editor/RemotionEditorView.tsx` — editor surface unchanged
- `frontend/src/components/video-editor/RemotionTimeline.tsx` — timeline unchanged
- `frontend/src/components/video-editor/components/TextRenderer.tsx` — pre-existing mapper unchanged
- `frontend/src/lib/video/keyframeInterp.ts` — interp helper unchanged
- `frontend/src/lib/video/manifestValidator.ts` — validator unchanged (all six componentTypes already in `VALID_COMPONENT_TYPES`)
- `frontend/src/store/uiStore.ts` — view-mode state unchanged
- All backend files — handler accepts any valid manifest

### Design invariants the plan enforces

1. **Schema isolation:** Same as 2.1.a — only `frontend/src/types/video.ts` types; no Phase 1 `EditClip` imports.
2. **Asset mapper interface:** Every mapper exports a single named React component that takes `{ item: TrackItem }`. No store hooks, no useEffect, no external state. Renders inside an `<AbsoluteFill>`.
3. **No `dangerouslySetInnerHTML`.** SVG renders through `<Img>` with a `data:image/svg+xml;charset=utf-8,...` URL. This avoids any XSS surface even though the markup comes from a user-owned text-input node.
4. **Rule A trigger:** Only `addTrackItemWithCanvasMirror` spawns canvas nodes for new TrackItems. The plain `updateRemotionManifest` action does NOT spawn — callers that want mirroring use the new action explicitly.
5. **Rule B trigger:** Hooked into existing `onNodesChange` (`remove` type) and `onEdgesChange` (`remove` type) handlers. No new event surface.
6. **Inline-style exemption:** Already covers `frontend/src/components/video-editor/` (from 2.1.a T11/T12). No new exemption needed.
7. **No new dependencies.** `@remotion/player` and `@remotion/media` should both be installed from Phase 2.1.a. xzdarcy is already installed. No `npm install` this plan unless `@remotion/media` is missing (verify in Task 3).

---

## Task Sequence

The 9 tasks are ordered to keep the build green at every commit. Phase A adds three asset mappers (independent). Phase B wires them into the composition. Phase C builds the mirroring helper + Rule A. Phase D wires Rule B (both paths). Phase E covers the E2E smoke.

Each task is one commit. Each commit must leave `npm run build` exit 0 and `npm test` green.

---

### Phase A — Asset mappers

### Task 1: SVGRenderer asset mapper

**Files:**
- Create: `frontend/src/components/video-editor/components/SVGRenderer.tsx`

- [ ] **Step 1: Implement the renderer**

Create `frontend/src/components/video-editor/components/SVGRenderer.tsx`:

```tsx
import { useCurrentFrame, AbsoluteFill, Img } from 'remotion';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface SVGRendererProps {
  item: TrackItem;
}

/** Convert inline SVG markup to a data URL. Using encodeURIComponent (not
 *  btoa) so multi-byte UTF-8 content in the SVG doesn't break. This routes
 *  through Remotion's <Img>, avoiding any innerHTML surface. */
function svgMarkupToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SVGRenderer({ item }: SVGRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  // Two source paths: inline markup or external URL. Inline wins if present.
  const svgMarkup = typeof item.props.svg === 'string' ? item.props.svg : null;
  const explicitSrc = typeof item.props.src === 'string' ? item.props.src : null;
  const src = svgMarkup ? svgMarkupToDataUrl(svgMarkup) : explicitSrc;

  if (!src) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no svg source]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <Img
        src={src}
        style={{
          opacity,
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      />
    </AbsoluteFill>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0, no new errors.

Run: `cd frontend && npm test 2>&1 | tail -5`
Expected: full suite still PASSES (no test added this task; smoke at Task 9 covers it).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/components/SVGRenderer.tsx
git commit -m "feat(remotion): SVGRenderer asset mapper via data URL (no innerHTML)"
```

---

### Task 2: ImageRenderer asset mapper

**Files:**
- Create: `frontend/src/components/video-editor/components/ImageRenderer.tsx`

- [ ] **Step 1: Implement the renderer**

Create `frontend/src/components/video-editor/components/ImageRenderer.tsx`:

```tsx
import { useCurrentFrame, AbsoluteFill, Img } from 'remotion';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface ImageRendererProps {
  item: TrackItem;
}

export function ImageRenderer({ item }: ImageRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  const src = typeof item.props.src === 'string' ? item.props.src : null;
  const width = typeof item.props.width === 'number' ? item.props.width : undefined;
  const height = typeof item.props.height === 'number' ? item.props.height : undefined;

  if (!src) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no image src]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <Img
        src={src}
        style={{
          opacity,
          width,
          height,
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      />
    </AbsoluteFill>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

Run: `cd frontend && npm test 2>&1 | tail -5`
Expected: full suite PASSES.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/components/ImageRenderer.tsx
git commit -m "feat(remotion): ImageRenderer asset mapper using Remotion <Img>"
```

---

### Task 3: VideoRenderer asset mapper

**Files:**
- Create: `frontend/src/components/video-editor/components/VideoRenderer.tsx`

- [ ] **Step 1: Verify `@remotion/media` is installed**

Run: `grep -n '"@remotion/media"' frontend/package.json`
Expected: a version string (e.g., `"^4.0.464"`). The Remotion best-practices skill confirms `<Video>` and `<Audio>` ship from `@remotion/media`.

If `@remotion/media` is NOT in `package.json`, install it (matching the existing `@remotion/player` version) before continuing:

```bash
cd frontend && npm install @remotion/media@^4.0.464
```

Apply the agent-security 14-day rule: confirm `@remotion/media`'s latest published version is ≥14 days old before installing. If too new, pin to the most recent version that satisfies the rule.

- [ ] **Step 2: Implement the renderer**

Create `frontend/src/components/video-editor/components/VideoRenderer.tsx`:

```tsx
import { useCurrentFrame, AbsoluteFill } from 'remotion';
import { Video } from '@remotion/media';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface VideoRendererProps {
  item: TrackItem;
}

export function VideoRenderer({ item }: VideoRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  const src = typeof item.props.src === 'string' ? item.props.src : null;
  const volume = typeof item.props.volume === 'number' ? item.props.volume : 1;
  const muted = item.props.muted === true;

  if (!src) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no video src]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <Video
        src={src}
        volume={muted ? 0 : volume}
        style={{
          opacity,
          maxWidth: '100%',
          maxHeight: '100%',
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      />
    </AbsoluteFill>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0. The `@remotion/media` import resolves cleanly.

Run: `cd frontend && npm test 2>&1 | tail -5`
Expected: full suite PASSES.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/video-editor/components/VideoRenderer.tsx [+ package.json + package-lock.json if @remotion/media was installed]
git commit -m "feat(remotion): VideoRenderer asset mapper using @remotion/media <Video>"
```

---

### Phase B — Wire mappers into the composition

### Task 4: Extend `RemotionComposition.renderItem` switch

**Files:**
- Modify: `frontend/src/components/video-editor/RemotionComposition.tsx`

- [ ] **Step 1: Replace the renderItem switch**

Open `frontend/src/components/video-editor/RemotionComposition.tsx`. Locate the imports (currently only `TextRenderer` is imported from `./components/TextRenderer`). Add three new imports:

```tsx
import { TextRenderer } from './components/TextRenderer';
import { SVGRenderer } from './components/SVGRenderer';
import { ImageRenderer } from './components/ImageRenderer';
import { VideoRenderer } from './components/VideoRenderer';
```

Replace the existing `renderItem` switch. Current shape:

```tsx
function renderItem(item: TrackItem) {
  switch (item.componentType) {
    case 'TextNode':
      return <TextRenderer item={item} />;
    default:
      return (
        <AbsoluteFill ...>
          [{item.componentType} — renderer not yet implemented]
        </AbsoluteFill>
      );
  }
}
```

Change to:

```tsx
function renderItem(item: TrackItem) {
  switch (item.componentType) {
    case 'TextNode':
      return <TextRenderer item={item} />;
    case 'SVGInput':
      return <SVGRenderer item={item} />;
    case 'ImageAssetNode':
      return <ImageRenderer item={item} />;
    case 'VideoAssetNode':
      return <VideoRenderer item={item} />;
    // IsometricBlock + LottieNode remain unimplemented until Phase 2.2.
    default:
      return (
        <AbsoluteFill
          style={{
            display: 'grid',
            placeItems: 'center',
            color: '#ff5500',
            fontFamily: 'system-ui',
          }}
        >
          [{item.componentType} — renderer not yet implemented]
        </AbsoluteFill>
      );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: exit 0.

Run: `cd frontend && npm test 2>&1 | tail -5`
Expected: full suite PASSES.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/RemotionComposition.tsx
git commit -m "feat(remotion): wire SVG/Image/Video renderers into composition switch"
```

---

### Phase C — Rule A: Timeline → Canvas spawn

### Task 5: Add `mirroring.ts` mapping + prune helpers

**Files:**
- Create: `frontend/src/lib/video/mirroring.ts`
- Test: `frontend/tests/video/mirroring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/mirroring.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  componentTypeToCanvasDefId,
  pruneTrackItemsForDeletedNode,
} from '../../src/lib/video/mirroring';
import type { TrackItem, VideoGraphManifest } from '../../src/types/video';

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

const SAMPLE_ITEM: TrackItem = {
  id: 't1',
  sourceNodeId: 'canvas-n1',
  componentType: 'TextNode',
  time: { startFrame: 0, durationInFrames: 60 },
  spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
  keyframes: {},
  props: { text: 'hello' },
};

describe('pruneTrackItemsForDeletedNode', () => {
  it('removes TrackItems whose sourceNodeId matches the deleted node', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: 't2', sourceNodeId: 'canvas-n2' }],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'canvas-n1');
    expect(result.changed).toBe(true);
    expect(result.manifest.timeline).toHaveLength(1);
    expect(result.manifest.timeline[0].id).toBe('t2');
  });

  it('returns changed=false when no TrackItem references the deleted node', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [SAMPLE_ITEM],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'unrelated');
    expect(result.changed).toBe(false);
    expect(result.manifest).toBe(manifest);
  });

  it('handles empty timeline gracefully', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'anything');
    expect(result.changed).toBe(false);
    expect(result.manifest.timeline).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- mirroring 2>&1 | tail -10`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/video/mirroring.ts`:

```ts
import type { TrackComponentType, VideoGraphManifest } from '../../types/video';

/** Maps a TrackItem.componentType to the canvas node definitionId that
 *  feeds it. Phase 2.1.b covers TextNode, SVGInput (via text-input),
 *  ImageAssetNode, and VideoAssetNode. IsometricBlock + LottieNode are
 *  deferred to Phase 2.2 and return null. */
export function componentTypeToCanvasDefId(
  componentType: TrackComponentType,
): string | null {
  switch (componentType) {
    case 'TextNode':
    case 'SVGInput':
      return 'text-input';
    case 'ImageAssetNode':
      return 'image-input';
    case 'VideoAssetNode':
      return 'video-input';
    case 'IsometricBlock':
    case 'LottieNode':
      return null;
  }
}

/** Removes all TrackItems whose sourceNodeId matches the deleted canvas node.
 *  Returns a new manifest reference only when something changed; otherwise
 *  returns the original (cheap no-op for the common case). */
export function pruneTrackItemsForDeletedNode(
  manifest: VideoGraphManifest,
  deletedNodeId: string,
): { changed: boolean; manifest: VideoGraphManifest } {
  const next = manifest.timeline.filter((item) => item.sourceNodeId !== deletedNodeId);
  if (next.length === manifest.timeline.length) {
    return { changed: false, manifest };
  }
  return {
    changed: true,
    manifest: { ...manifest, timeline: next },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- mirroring 2>&1 | tail -10`
Expected: 5 PASS (2 mapping + 3 prune).

Run full suite: `cd frontend && npm test 2>&1 | tail -5`
Expected: 130/130 (125 + 5).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/video/mirroring.ts frontend/tests/video/mirroring.test.ts
git commit -m "feat(remotion): mirroring helpers — componentType map + prune-on-delete"
```

---

### Task 6: Add `addTrackItemWithCanvasMirror` graphStore action (Rule A)

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/video/graphStore.mirroring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/graphStore.mirroring.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';
import { createEmptyManifest } from '../../src/types/video';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

describe('graphStore — addTrackItemWithCanvasMirror (Rule A)', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('spawns a text-input canvas node when adding a TextNode TrackItem', () => {
    const remotionNode = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'remotion-node',
        label: 'R',
        params: { manifest: createEmptyManifest() },
        state: 'idle' as const,
        outputs: {},
      },
    };
    useGraphStore.setState({ nodes: [remotionNode as never] });

    useGraphStore.getState().addTrackItemWithCanvasMirror('r1', {
      componentType: 'TextNode',
      props: { text: 'hello' },
    });

    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    const textInput = nodes.find((n) => n.data.definitionId === 'text-input');
    expect(textInput).toBeDefined();

    const remotion = nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: ReturnType<typeof createEmptyManifest> }).manifest;
    expect(manifest.timeline).toHaveLength(1);
    expect(manifest.timeline[0].sourceNodeId).toBe(textInput?.id);
    expect(manifest.timeline[0].componentType).toBe('TextNode');
  });

  it('no-ops when the RemotionNode does not exist', () => {
    useGraphStore.getState().addTrackItemWithCanvasMirror('does-not-exist', {
      componentType: 'TextNode',
    });
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('no-ops for componentTypes mapped to null (Phase 2.2 deferred)', () => {
    const remotionNode = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'remotion-node',
        label: 'R',
        params: { manifest: createEmptyManifest() },
        state: 'idle' as const,
        outputs: {},
      },
    };
    useGraphStore.setState({ nodes: [remotionNode as never] });

    useGraphStore.getState().addTrackItemWithCanvasMirror('r1', {
      componentType: 'IsometricBlock',
    });

    expect(useGraphStore.getState().nodes).toHaveLength(1);
    const manifest = (useGraphStore.getState().nodes[0].data.params as { manifest: ReturnType<typeof createEmptyManifest> }).manifest;
    expect(manifest.timeline).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -10`
Expected: FAIL — `addTrackItemWithCanvasMirror is not a function`.

- [ ] **Step 3: Add the action**

Open `frontend/src/store/graphStore.ts`. Add to the imports near the top (only what's missing — `VideoGraphManifest` was imported in 2.1.a):

```ts
import type { TrackItem } from '../types/video';
import { DEFAULT_FPS } from '../types/video';
import { componentTypeToCanvasDefId } from '../lib/video/mirroring';
```

Find the store interface (around line 193 where `updateRemotionManifest` lives). Add directly below:

```ts
  addTrackItemWithCanvasMirror: (
    remotionNodeId: string,
    partial: Partial<TrackItem> & Pick<TrackItem, 'componentType'>,
  ) => void;
```

Find the existing `updateRemotionManifest` action body. After its closing brace, add:

```ts
  addTrackItemWithCanvasMirror: (remotionNodeId, partial) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const defId = componentTypeToCanvasDefId(partial.componentType);
    if (!defId) {
      console.warn(
        `addTrackItemWithCanvasMirror: componentType ${partial.componentType} has no canvas mapping yet`,
      );
      return;
    }

    const newNodeId = `node-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const offsetPosition = {
      x: remotion.position.x - 280,
      y: remotion.position.y,
    };
    const newCanvasNode = {
      id: newNodeId,
      type: 'model-node' as const,
      position: offsetPosition,
      data: {
        definitionId: defId,
        label: defId,
        params: {},
        state: 'idle' as const,
        outputs: {},
      },
    };

    const newItem: TrackItem = {
      id: partial.id ?? `track-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      sourceNodeId: newNodeId,
      componentType: partial.componentType,
      time: partial.time ?? { startFrame: 0, durationInFrames: DEFAULT_FPS * 2 },
      spatial: partial.spatial ?? {
        x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0],
      },
      keyframes: partial.keyframes ?? {},
      props: partial.props ?? {},
    };

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
        const currentManifest =
          (currentParams.manifest as VideoGraphManifest | undefined) ??
          { graph: { nodes: [], edges: [] }, timeline: [] };
        const nextManifest: VideoGraphManifest = {
          ...currentManifest,
          timeline: [...currentManifest.timeline, newItem],
        };
        return {
          ...n,
          data: {
            ...n.data,
            params: { ...currentParams, manifest: nextManifest },
          },
        };
      });
      return { nodes: [...updatedNodes, newCanvasNode as never] };
    });
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -15`
Expected: 3 PASS.

Run full suite: `cd frontend && npm test 2>&1 | tail -5`
Expected: 133/133 (130 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.mirroring.test.ts
git commit -m "feat(remotion): Rule A — addTrackItemWithCanvasMirror spawns canvas + TrackItem"
```

---

### Phase D — Rule B: Canvas → Timeline prune

### Task 7: Prune TrackItems when a canvas node is deleted (Rule B-1)

**Files:**
- Modify: `frontend/src/store/graphStore.ts` — extend `onNodesChange` to invoke prune helper
- Test: append to `frontend/tests/video/graphStore.mirroring.test.ts`

- [ ] **Step 1: Add the test**

Open `frontend/tests/video/graphStore.mirroring.test.ts`. Add a new describe block at the bottom:

```ts
describe('graphStore — Rule B-1: node deletion prunes TrackItems', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('prunes a TrackItem when its source canvas node is removed', () => {
    const remotionNode = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'remotion-node',
        label: 'R',
        params: {
          manifest: {
            graph: { nodes: [], edges: [] },
            timeline: [
              {
                id: 't1',
                sourceNodeId: 'src-1',
                componentType: 'TextNode' as const,
                time: { startFrame: 0, durationInFrames: 60 },
                spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
                keyframes: {},
                props: {},
              },
            ],
          },
        },
        state: 'idle' as const,
        outputs: {},
      },
    };
    const sourceNode = {
      id: 'src-1',
      type: 'model-node',
      position: { x: -300, y: 0 },
      data: { definitionId: 'text-input', label: 'text-input', params: {}, state: 'idle' as const, outputs: {} },
    };
    useGraphStore.setState({ nodes: [remotionNode as never, sourceNode as never] });

    useGraphStore.getState().onNodesChange([{ id: 'src-1', type: 'remove' }]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -10`
Expected: FAIL — the TrackItem won't be pruned because the prune logic doesn't exist yet.

- [ ] **Step 3: Wire the prune into `onNodesChange`**

Open `frontend/src/store/graphStore.ts`. Find `onNodesChange` (around line 799). Add this import at the top if not present:

```ts
import { pruneTrackItemsForDeletedNode } from '../lib/video/mirroring';
```

Read the EXISTING `onNodesChange` body before modifying — it may already include debounced backend sync, undo push, etc. that you must preserve. Then graft the prune logic in.

The conceptual shape (adapt to actual existing body):

```ts
  onNodesChange: (changes) => {
    set((state) => {
      const nextNodes = applyNodeChanges(changes, state.nodes);

      // Rule B-1: For each removed node, prune any RemotionNode TrackItem that
      // referenced it via sourceNodeId.
      const removedIds = changes
        .filter((c): c is { id: string; type: 'remove' } => c.type === 'remove')
        .map((c) => c.id);

      if (removedIds.length === 0) {
        return { nodes: nextNodes };
      }

      const updatedNodes = nextNodes.map((n) => {
        if (n.data?.definitionId !== 'remotion-node') return n;
        const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
        const manifest = currentParams.manifest as VideoGraphManifest | undefined;
        if (!manifest) return n;

        let nextManifest = manifest;
        let anyChange = false;
        for (const removedId of removedIds) {
          const result = pruneTrackItemsForDeletedNode(nextManifest, removedId);
          if (result.changed) {
            nextManifest = result.manifest;
            anyChange = true;
          }
        }
        if (!anyChange) return n;
        return {
          ...n,
          data: { ...n.data, params: { ...currentParams, manifest: nextManifest } },
        };
      });

      return { nodes: updatedNodes };
    });
    // [PRESERVE any existing side effects below — debounced sync, undo, etc.]
  },
```

Adapt carefully. If the existing body uses `set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }))` plus side effects after, add the prune logic into the returned object without dropping the existing logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -10`
Expected: 4 PASS (3 from Task 6 + 1 new).

Run full suite: `cd frontend && npm test 2>&1 | tail -5`
Expected: 134/134.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.mirroring.test.ts
git commit -m "feat(remotion): Rule B-1 — prune TrackItems on canvas node deletion"
```

---

### Task 8: Prune TrackItems when the source-edge is removed (Rule B-2)

**Files:**
- Modify: `frontend/src/store/graphStore.ts` — extend `onEdgesChange` similarly
- Test: append to `frontend/tests/video/graphStore.mirroring.test.ts`

The spec's Rule B has two trigger paths. Task 7 handled "node deleted." The second is "decoupled" — the edge from the source node to the RemotionNode's `sources` port is removed but both nodes remain. The TrackItem no longer has a valid input, so we prune.

- [ ] **Step 1: Add the test**

Append to `frontend/tests/video/graphStore.mirroring.test.ts`:

```ts
describe('graphStore — Rule B-2: source-edge removal prunes TrackItems', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('prunes a TrackItem when the edge feeding its source node into the RemotionNode is removed', () => {
    const remotionNode = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'remotion-node',
        label: 'R',
        params: {
          manifest: {
            graph: { nodes: [], edges: [] },
            timeline: [
              {
                id: 't1',
                sourceNodeId: 'src-1',
                componentType: 'TextNode' as const,
                time: { startFrame: 0, durationInFrames: 60 },
                spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
                keyframes: {},
                props: {},
              },
            ],
          },
        },
        state: 'idle' as const,
        outputs: {},
      },
    };
    const sourceNode = {
      id: 'src-1',
      type: 'model-node',
      position: { x: -300, y: 0 },
      data: { definitionId: 'text-input', label: 'text-input', params: {}, state: 'idle' as const, outputs: {} },
    };
    const edge = {
      id: 'e-src1-to-r1',
      source: 'src-1',
      target: 'r1',
      targetHandle: 'sources',
    };
    useGraphStore.setState({ nodes: [remotionNode as never, sourceNode as never], edges: [edge as never] });

    useGraphStore.getState().onEdgesChange([{ id: 'e-src1-to-r1', type: 'remove' }]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(0);
  });

  it('does NOT prune when a non-sources edge is removed', () => {
    const remotionNode = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'remotion-node',
        label: 'R',
        params: {
          manifest: {
            graph: { nodes: [], edges: [] },
            timeline: [
              {
                id: 't1',
                sourceNodeId: 'src-1',
                componentType: 'TextNode' as const,
                time: { startFrame: 0, durationInFrames: 60 },
                spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
                keyframes: {},
                props: {},
              },
            ],
          },
        },
        state: 'idle' as const,
        outputs: {},
      },
    };
    const unrelatedEdge = {
      id: 'e-something-else',
      source: 'src-1',
      target: 'r1',
      targetHandle: 'some-other-port',
    };
    useGraphStore.setState({ nodes: [remotionNode as never], edges: [unrelatedEdge as never] });

    useGraphStore.getState().onEdgesChange([{ id: 'e-something-else', type: 'remove' }]);

    const manifest = (useGraphStore.getState().nodes[0].data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -10`
Expected: 1 FAIL on the first new test (the second may coincidentally pass).

- [ ] **Step 3: Wire the prune into `onEdgesChange`**

In `frontend/src/store/graphStore.ts`, find `onEdgesChange` (around line 822). Read the EXISTING body and preserve any side effects (debounced sync, undo push). Add the Rule B-2 logic:

```ts
  onEdgesChange: (changes) => {
    set((state) => {
      const nextEdges = applyEdgeChanges(changes, state.edges);

      // Rule B-2: For each removed edge whose target is a RemotionNode's
      // sources port, prune any TrackItem whose sourceNodeId matches the
      // edge's source node.
      const removedEdges = changes
        .filter((c): c is { id: string; type: 'remove' } => c.type === 'remove')
        .map((c) => state.edges.find((e) => e.id === c.id))
        .filter((e): e is NonNullable<typeof e> => !!e);

      const sourceIdsLosingConnection: string[] = [];
      for (const edge of removedEdges) {
        if (edge.targetHandle !== 'sources') continue;
        const targetNode = state.nodes.find((n) => n.id === edge.target);
        if (targetNode?.data?.definitionId !== 'remotion-node') continue;
        sourceIdsLosingConnection.push(edge.source);
      }

      if (sourceIdsLosingConnection.length === 0) {
        return { edges: nextEdges };
      }

      const updatedNodes = state.nodes.map((n) => {
        if (n.data?.definitionId !== 'remotion-node') return n;
        const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
        const manifest = currentParams.manifest as VideoGraphManifest | undefined;
        if (!manifest) return n;

        let nextManifest = manifest;
        let anyChange = false;
        for (const sourceId of sourceIdsLosingConnection) {
          const result = pruneTrackItemsForDeletedNode(nextManifest, sourceId);
          if (result.changed) {
            nextManifest = result.manifest;
            anyChange = true;
          }
        }
        if (!anyChange) return n;
        return {
          ...n,
          data: { ...n.data, params: { ...currentParams, manifest: nextManifest } },
        };
      });

      return { edges: nextEdges, nodes: updatedNodes };
    });
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- graphStore.mirroring 2>&1 | tail -10`
Expected: 6 PASS (3 from T6, 1 from T7, 2 new).

Run full suite: `cd frontend && npm test 2>&1 | tail -5`
Expected: 136/136.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/video/graphStore.mirroring.test.ts
git commit -m "feat(remotion): Rule B-2 — prune TrackItems when sources edge is removed"
```

---

### Phase E — E2E smoke

### Task 9: Extend the Puppeteer smoke for Rule A + B + asset renders

**Files:**
- Modify: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`

The 2.1.a smoke covers Player + Timeline mounting (steps 0–5). Now extend it to also verify:
- Rule A: calling `addTrackItemWithCanvasMirror` from the store spawns a canvas node + TrackItem
- Rule B: removing that spawned node prunes the TrackItem
- The TextRenderer asset mapper actually renders visible content in the Player

- [ ] **Step 1: Extend the smoke driver**

Open `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`. After the existing step 5 ("reopen, confirm state persists"), add steps 6–8 BEFORE the final `log('done', ...)` line:

```js
    // Step 6 — Rule A: add a TrackItem via the store, verify canvas node spawns
    log('test-6', 'addTrackItemWithCanvasMirror with TextNode');
    await page.evaluate(async () => {
      const state = window.__nebulaGraphStore.getState();
      const remotion = state.nodes.find((n) => n.data.definitionId === 'remotion-node');
      if (!remotion) throw new Error('[smoke] no remotion-node found');
      state.addTrackItemWithCanvasMirror(remotion.id, {
        componentType: 'TextNode',
        props: { text: 'smoke test', fontSize: 80, color: '#ffcc00' },
        time: { startFrame: 0, durationInFrames: 90 },
      });
    });
    await sleep(800);
    const ruleAState = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const nodeDefs = s.nodes.map((n) => n.data.definitionId);
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      const tl = remotion?.data.params?.manifest?.timeline ?? [];
      return { nodeDefs, timelineLength: tl.length, trackSourceId: tl[0]?.sourceNodeId };
    });
    log('test-6', `state: ${JSON.stringify(ruleAState)}`);
    if (!ruleAState.nodeDefs.includes('text-input')) {
      throw new Error('[smoke] Rule A failed: text-input node not spawned');
    }
    if (ruleAState.timelineLength !== 1) {
      throw new Error('[smoke] Rule A failed: TrackItem not added to manifest');
    }
    await page.screenshot({ path: join(OUT_DIR, 'step6-rule-a-spawned.png') });

    // Step 7 — go back to canvas + reopen editor — TrackItem renders in Player
    await page.click('.remotion-editor-view__back');
    await sleep(300);
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'step7-text-rendering.png') });

    // Step 8 — Rule B: remove the spawned text-input node, verify TrackItem pruned
    const spawnedTextInputId = ruleAState.trackSourceId;
    log('test-8', `removing spawned node ${spawnedTextInputId}`);
    await page.evaluate((id) => {
      window.__nebulaGraphStore.getState().onNodesChange([{ id, type: 'remove' }]);
    }, spawnedTextInputId);
    await sleep(500);
    const ruleBState = await page.evaluate(() => {
      const s = window.__nebulaGraphStore.getState();
      const remotion = s.nodes.find((n) => n.data.definitionId === 'remotion-node');
      return {
        nodeCount: s.nodes.length,
        timelineLength: remotion?.data.params?.manifest?.timeline?.length ?? 0,
      };
    });
    log('test-8', `state: ${JSON.stringify(ruleBState)}`);
    if (ruleBState.timelineLength !== 0) {
      throw new Error('[smoke] Rule B failed: TrackItem not pruned after canvas-node removal');
    }
    await page.screenshot({ path: join(OUT_DIR, 'step8-rule-b-pruned.png') });
```

Change the final log from `'all 5 steps passed'` to `'all 8 steps passed'`.

- [ ] **Step 2: Run the smoke**

Confirm dev server + backend are up at `:5180` / `:8000`. Run:

```bash
node scripts/puppeteer-driver/remotion-foundation-smoke.mjs --headless true
```

Expected: 9 screenshots (steps 0–8) in `output/puppeteer-driver/remotion-foundation-smoke/`. Final log `[done] all 8 steps passed`.

If steps 6–8 fail, the failure mode tells you which rule is broken — fix the underlying graphStore logic, do not weaken the assertion.

- [ ] **Step 3: Spot-check the screenshots**

Open `step7-text-rendering.png`. Confirm the yellow "smoke test" text renders in the Player viewport. If the Player area is black, the TrackItem was added but the composition didn't pick it up — investigate the `RemotionComposition` switch.

- [ ] **Step 4: Commit**

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs
git commit -m "test(remotion): smoke extends to Rule A + B + TextRenderer visual"
```

---

## Verification

After Task 9, manually verify the full flow once more:

1. Restart dev server + backend if needed
2. Open `http://localhost:5180`
3. Drop a Remotion Composition node from the library
4. Open the editor on it
5. From DevTools, run:
   ```js
   const store = window.__nebulaGraphStore.getState();
   const r = store.nodes.find(n => n.data.definitionId === 'remotion-node');
   store.addTrackItemWithCanvasMirror(r.id, { componentType: 'TextNode', props: { text: 'manual test' } });
   ```
6. Close editor, return to canvas. Confirm a `text-input` node appeared next to the RemotionNode.
7. Re-open the editor. Confirm "manual test" renders in the Player and a timeline row appears.
8. Close editor. Delete the `text-input` node by selecting it and pressing Delete.
9. Re-open the editor. Confirm the timeline is empty (TrackItem pruned).

If any step fails, debug before declaring complete.

---

## What Plan 2.1.c will pick up

For the next plan (in-editor UI):
- Add a toolbar to `RemotionEditorView` with buttons for each componentType ("+ Text", "+ Image", "+ Video", "+ SVG") that call `addTrackItemWithCanvasMirror`
- Add a selection state (`selectedTrackItemId` on `uiStore` — separate from Phase 1's `selectedClipId`) and a "Delete" keybind that removes both the TrackItem and its source canvas node
- Implement Cmd+D for playhead-relative duplication: spawn a clone of the selected TrackItem with `time.startFrame` set to the current playhead frame
- Wire drag-to-trim on the xzdarcy timeline (`onChange` was a no-op in 2.1.a — now route mutations back to `updateRemotionManifest`)
- Add a properties panel (right side of editor) for the selected TrackItem to edit `props.text`, `props.fontSize`, etc.
