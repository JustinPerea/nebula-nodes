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
