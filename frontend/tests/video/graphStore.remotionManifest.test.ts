import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';
import { createEmptyManifest } from '../../src/types/video';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

describe('graphStore — updateRemotionManifest', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('no-ops silently if the node does not exist', () => {
    // Empty graph; nothing to update
    useGraphStore.getState().updateRemotionManifest('does-not-exist', { timeline: [] });
    // No throw, state unchanged
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('writes a validated patch through updateNodeData', () => {
    const node = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: { definitionId: 'remotion-node', label: 'R', params: { manifest: createEmptyManifest() }, state: 'idle' as const, outputs: {} },
    };
    useGraphStore.setState({ nodes: [node as never] });
    const newTimeline = [
      {
        id: 't1',
        sourceNodeId: 's1',
        componentType: 'TextNode' as const,
        time: { startFrame: 0, durationInFrames: 60 },
        spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
        keyframes: {},
        props: { text: 'hello' },
      },
    ];
    useGraphStore.getState().updateRemotionManifest('r1', { timeline: newTimeline });
    const updated = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const params = updated?.data.params as { manifest?: ReturnType<typeof createEmptyManifest> };
    expect(params?.manifest?.timeline).toHaveLength(1);
    expect(params?.manifest?.timeline[0].id).toBe('t1');
  });

  it('silently no-ops on invalid patch (and logs a warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = {
      id: 'r1',
      type: 'remotionNode',
      position: { x: 0, y: 0 },
      data: { definitionId: 'remotion-node', label: 'R', params: { manifest: createEmptyManifest() }, state: 'idle' as const, outputs: {} },
    };
    useGraphStore.setState({ nodes: [node as never] });
    // Invalid timeline item (missing required fields)
    useGraphStore.getState().updateRemotionManifest('r1', {
      timeline: [{ id: 't1' } as never],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('updateRemotionManifest'),
      expect.any(String),
    );
    const updated = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const params = updated?.data.params as { manifest?: ReturnType<typeof createEmptyManifest> };
    expect(params?.manifest?.timeline).toHaveLength(0); // unchanged
    warnSpy.mockRestore();
  });
});
