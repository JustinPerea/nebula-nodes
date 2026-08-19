import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import {
  deserializeGraph,
  normalizeRuntimeMediaParams,
  serializeGraph,
  type NebulaFile,
} from '../src/lib/graphFile';

describe('graph file runtime media metadata', () => {
  it('moves legacy probe fields on provider nodes into the private namespace', () => {
    expect(normalizeRuntimeMediaParams('gemini-omni-flash', {
      task: 'text_to_video',
      sourceDuration: 3.008,
      sourceFps: 24,
      sourceIsVfr: false,
    })).toEqual({
      task: 'text_to_video',
      _sourceDuration: 3.008,
      _sourceFps: 24,
      _sourceIsVfr: false,
    });
  });

  it('keeps declared Video Edit state as declared params', () => {
    const params = {
      sourceDuration: 8,
      sourceFps: 30,
      sourceIsVfr: false,
    };
    expect(normalizeRuntimeMediaParams('video-edit', params)).toEqual(params);
  });

  it('normalizes both future saves and legacy loads', () => {
    const node = {
      id: 'n1',
      type: 'model-node',
      position: { x: 10, y: 20 },
      data: {
        label: 'Gemini Omni Flash',
        definitionId: 'gemini-omni-flash',
        params: { task: 'text_to_video', sourceDuration: 4 },
        outputs: {},
        state: 'idle',
      },
    } as Node<NodeData>;

    const serialized = serializeGraph([node], []);
    expect(serialized.nodes[0].data.params).toEqual({
      task: 'text_to_video',
      _sourceDuration: 4,
    });

    const legacy = {
      ...serialized,
      version: 3,
      nodes: [{
        ...serialized.nodes[0],
        data: {
          ...serialized.nodes[0].data,
          params: { task: 'text_to_video', sourceDuration: 4 },
        },
      }],
    } as NebulaFile;
    const loaded = deserializeGraph(legacy);
    expect(loaded.nodes[0].data.params).toEqual({
      task: 'text_to_video',
      _sourceDuration: 4,
    });
  });
});
