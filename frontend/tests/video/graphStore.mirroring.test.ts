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
