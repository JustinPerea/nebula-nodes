/**
 * Phase 2 RemotionNode schema — see docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md.
 *
 * ISOLATED from the Phase 1 NLE editor types (EditClip in
 * lib/editor/virtualPlayback.ts). Do not import EditClip here and do not
 * re-export these types from the editor barrel — the two surfaces share no
 * runtime code, ship to different node types (video-edit vs remotion-node),
 * and use different renderers (ffmpeg vs @remotion/player).
 *
 * All animation here is deterministic + frame-bound (Remotion's spring() and
 * interpolate() hooks). No Framer Motion, no CSS transitions, no
 * requestAnimationFrame loops driven from React state.
 */

/** Easing identifier handed to Remotion's interpolate() / spring() calls. */
export type EasingKind = 'spring' | 'linear' | 'clamp';

/** A single animated waypoint on one property of a TrackItem. */
export interface KeyframeData {
  /** Absolute frame in the composition (not seconds). */
  frame: number;
  /** Scalar (opacity, scale-uniform) or 3-vector (position, rotation, scale-axis). */
  value: number | [number, number, number];
  easing: EasingKind;
}

/** Spatial state of a TrackItem at a given instant. Mutated by keyframe interpolation. */
export interface SpatialTransform {
  x: number;
  y: number;
  z: number;
  /** Normalized transform origin. [0,0]=top-left, [0.5,0.5]=center. */
  anchor?: [number, number];
  /** Per-axis scale. Use [1, 1, 1] for identity. */
  scale: [number, number, number];
  /** Per-axis rotation. Standardized to DEGREES — convert to radians at the
   * Three.js boundary, never store radians at the schema layer. */
  rotation: [number, number, number];
}

/** Time placement of a TrackItem on the composition timeline. */
export interface TimeSignature {
  startFrame: number;
  durationInFrames: number;
}

/** Discriminator for which renderer component handles this item.
 * Phase 2.1 covers the first four. IsometricBlock + LottieNode are Phase 2.2. */
export type TrackComponentType =
  | 'SVGInput'
  | 'ImageAssetNode'
  | 'TextNode'
  | 'VideoAssetNode'
  | 'IsometricBlock'
  | 'LottieNode';

/** One layer on one track of the composition timeline. */
export interface TrackItem {
  id: string;
  /** Maps 1:1 back to the corresponding Nebula Nodes graph canvas node so
   * the bidirectional sync (spec §Phase 3) can keep them coupled. */
  sourceNodeId: string;
  componentType: TrackComponentType;
  time: TimeSignature;
  spatial: SpatialTransform;
  /** Animated properties keyed by property name (e.g. "opacity", "scale",
   * "position"). Each property holds its own ordered keyframe list. */
  keyframes: Record<string, KeyframeData[]>;
  /** Component-specific props (text content, image src, video src, etc.).
   * Loosely typed at the schema layer; the render components type-narrow. */
  props: Record<string, unknown>;
}

/** The shared state manifest. Persisted as timeline.json next to the
 * RemotionNode's params. The `graph` half mirrors the canvas's React Flow
 * nodes/edges so the editor can read upstream node outputs as TrackItem
 * sources without re-querying the graph store. */
export interface VideoGraphManifest {
  graph: {
    nodes: unknown[];
    edges: unknown[];
  };
  timeline: TrackItem[];
}

// --- Defaults / factories ---------------------------------------------------

export const DEFAULT_FPS = 30;
export const DEFAULT_DURATION_FRAMES = DEFAULT_FPS * 5; // 5 seconds
export const DEFAULT_ANCHOR: NonNullable<SpatialTransform['anchor']> = [0.5, 0.5];

/** Identity transform — origin, no rotation, unit scale. */
export const IDENTITY_TRANSFORM: SpatialTransform = {
  x: 0,
  y: 0,
  z: 0,
  anchor: DEFAULT_ANCHOR,
  scale: [1, 1, 1],
  rotation: [0, 0, 0],
};

/** Build a fresh TrackItem with sensible defaults. Callers patch `time`,
 * `componentType`, `sourceNodeId`, and any component props after. */
export function createTrackItem(partial: Partial<TrackItem> & Pick<TrackItem, 'id' | 'sourceNodeId' | 'componentType'>): TrackItem {
  return {
    time: { startFrame: 0, durationInFrames: DEFAULT_DURATION_FRAMES },
    spatial: { ...IDENTITY_TRANSFORM },
    keyframes: {},
    props: {},
    ...partial,
  };
}

/** Empty manifest — initial state when a RemotionNode is first created. */
export function createEmptyManifest(): VideoGraphManifest {
  return { graph: { nodes: [], edges: [] }, timeline: [] };
}
