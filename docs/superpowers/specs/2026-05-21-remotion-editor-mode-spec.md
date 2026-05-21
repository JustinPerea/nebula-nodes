# Remotion Editor Mode — Implementation Spec (Phase 2 candidate)

**Status:** spec only. NOT scheduled for build. Captured 2026-05-21 from a Gemini co-planning session — to be reviewed before any work begins, since this would represent a significant architectural pivot from the Phase 1 editor (output-time NLE timeline + ffmpeg-rendered preview).

**Author note (Justin):** I was planning out this implementation with Gemini. Saving it as a TODO. Before we touch any of this we need to decide whether it replaces or runs alongside the current Phase 1 video editor (which already ships an in-graph CapCut-style NLE with virtual playback + ffmpeg-rendered preview + an edit-as-node thesis proven end-to-end).

---

## Context & Objective

Integrate a specialized **Video Editor Mode** into Nebula Nodes. This mode operates seamlessly with the macro node-graph landscape. When a user creates a `RemotionCompiler` node and opens its Editor view, they transition into a multi-track timeline environment resembling CapCut, built on top of a purely open-source rendering stack (`@remotion/player` and `@xzdarcy/react-timeline-editor`).

The system architecture is strictly **schema-driven** via a shared state manifest (`timeline.json`). All operations by this agent must read, patch, or extend this schema.

## 1. Technical Stack Constraints

To maintain open-source compliance and deterministic execution, stick strictly to these packages:

1. **Rendering & Playhead State:** `@remotion/player` (Free, OSS core)
2. **Visual Track Editor Layout:** `@xzdarcy/react-timeline-editor` (Free, MIT)
3. **3D Matrix Math & Projection:** `@react-three/fiber` + `@react-three/drei`
4. **Animation Interactivity:** Purely deterministic, frame-bound functions via Remotion's native `spring()` and `interpolate()` hooks. **Do not use Framer Motion, real-time CSS transitions, or `requestAnimationFrame`.**

## 2. Core Schema Definition

Create or use the following TypeScript interfaces to type-safety the configuration layer (`types/video.ts`):

```typescript
export interface KeyframeData {
  frame: number;
  value: number | [number, number, number];
  easing: 'spring' | 'linear' | 'clamp';
}

export interface SpatialTransform {
  x: number;
  y: number;
  z: number;
  scale: [number, number, number];
  rotation: [number, number, number]; // Radians or Degrees (standardize to degrees)
}

export interface TimeSignature {
  startFrame: number;
  durationInFrames: number;
}

export interface TrackItem {
  id: string;
  sourceNodeId: string; // Maps 1:1 back to the Nebula Nodes graph canvas
  componentType: 'SVGInput' | 'ImageAssetNode' | 'TextNode' | 'IsometricBlock' | 'LottieNode';
  time: TimeSignature;
  spatial: SpatialTransform;
  keyframes: Record<string, KeyframeData[]>;
  props: Record<string, any>;
}

export interface VideoGraphManifest {
  graph: {
    nodes: any[]; // Inherited from Nebula Nodes core node array structure
    edges: any[];
  };
  timeline: TrackItem[];
}
```

## 3. Math & Layout Rules For Agent Execution

### Isometric Viewport Projection Matrices

When rendering components under an `IsometricBlock` or setting up an isometric scene configuration, instantiate a non-perspective projection layout.

- Component: `@react-three/fiber` `<Canvas orthographic>`
- The mathematical position vector required to lock an exact 45° true isometric view angle relative to the point of origin (0,0,0) requires an absolute spatial vector projection.

Ensure lighting constraints leverage an `<ambientLight>` matching base luminance values and a directional light with coordinate tracking to create crisp bevel shadows on 3D blocks.

### Playhead-Relative Layer Spawning

When duplicating track layers (`Cmd+D`) or appending items programmatically via a terminal prompt, enforce the following double-buffer math layout:

1. Read the current absolute frame from the active playback wrapper instance: `playerRef.current.getFrame()`
2. Set the duplicated node's `time.startFrame` equal to the playhead frame context.
3. Apply directional padding vectors to avoid immediate visual occlusion ("ghosting").

## 4. Phase-by-Phase Execution Plan

### Phase 1: Context Ingestion & Core Schema Parsing

- Run `npx -y skills@latest add remotion-dev/skills` to inject the Remotion Markdown agent skills folder inside the local configuration hierarchy.
- Build the static JSON validator module that reads and writes `timeline.json` without wiping custom graph connections.

### Phase 2: The UI Wrapper Integration

- Build a specialized workspace overlay mode screen: `components/video-editor/EditorModeContainer.tsx`.
- Render the `@remotion/player` rendering node side-by-side with `@xzdarcy/react-timeline-editor`.
- Set up bidirectional frame tracking: whenever the timeline editor scrolls or steps frames, invoke `playerRef.current.seekTo(targetFrame)`.

### Phase 3: The Bidirectional Graph Mirroring Sync

- Write a state subscription hook that synchronizes mutations between the pipeline graph canvas and the timeline track items.
- **Rule A:** If a track asset is manually instantiated in the editor view, programmatically generate a disconnected corresponding `AssetNode` on the visual engine layout.
- **Rule B:** If a node is decoupled or deleted from the `RemotionCompiler` input node in graph layout mode, instantly prune the item from the timeline array configuration.

### Phase 4: Deterministic Motion Composition Execution

- Build the asset mapping components inside the composition frame. Translate incoming text, vectors, or coordinates into clean visual outputs.
- Build a utility module that reads the keyframes array block inside `TrackItem` objects and automatically applies Remotion's frame interpolation loop inside the canvas viewport wrapper:

```typescript
// Core implementation example for transition evaluation
const currentFrame = useCurrentFrame();
const opacity = interpolate(currentFrame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
```

## Open questions / decisions needed before build

These weren't in the original spec but need answers before any implementation pass:

1. **Replace or run alongside the current Phase 1 editor?** Phase 1 already ships an output-time NLE timeline + ffmpeg-rendered preview surface where edits are first-class nodes. The Remotion approach is a different paradigm (frame-bound deterministic composition, multi-track keyframe animation). If this replaces Phase 1, the lab page case study and the `<EditNode>` card need updating. If it runs alongside, we need a clear UX answer for which node type uses which editor (`video-edit` vs new `remotion-compiler`).

2. **ffmpeg vs Remotion as the renderer.** Phase 1's ffmpeg-rendered preview is fast (~5s for an 11s clip at 640p). Remotion render is browser-based (Puppeteer headless) and slower for video-only edits but vastly more capable for keyframed compositions. Decide which renderer backs the `Render Preview` button per-node.

3. **Schema integration with the existing graph.** Phase 1's `EditClip` shape (`start/duration/sourceIn/sourceOut/volume/mute`) is incompatible with the proposed `TrackItem` shape. A migration story is needed: either the new node uses its own schema and Phase 1 nodes stay as-is, or we unify.

4. **Isometric / 3D scope.** The R3F isometric block is a significant new surface. Worth scoping whether it's a Phase 2.1 (timeline only) vs Phase 2.2 (timeline + 3D) split so the first ship has a clearer boundary.

5. **`@xzdarcy/react-timeline-editor` maintenance.** Last npm release should be checked for activity (the org and package have been quiet for a while). If unmaintained, consider forking or picking a different OSS timeline component.

## Instructions for Claude Code execution (when ready)

1. Read this specification completely.
2. Inspect the current workspace geometry configuration in the `JustinPerea/nebula-nodes` file tree.
3. Validate where the main view states are mounted inside the engine routing layers (`EditorView`, the `enterEditor`/`exitEditor` switch in `uiStore`).
4. Resolve the open questions above with the human before starting Phase 1.
5. Begin by creating the foundational types file `types/video.ts` and step sequentially through the implementation phases. Do not build custom layout animation loops unless they are strictly deterministic and bound to absolute frame values.
