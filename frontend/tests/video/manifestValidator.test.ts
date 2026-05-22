import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../src/lib/video/manifestValidator';

const VALID = {
  graph: { nodes: [], edges: [] },
  timeline: [],
};

describe('validateManifest', () => {
  it('accepts the empty canonical shape', () => {
    const r = validateManifest(VALID);
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('hello').ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
  });

  it('rejects missing graph', () => {
    expect(validateManifest({ timeline: [] }).ok).toBe(false);
  });

  it('rejects missing timeline', () => {
    expect(validateManifest({ graph: { nodes: [], edges: [] } }).ok).toBe(false);
  });

  it('rejects timeline as non-array', () => {
    expect(validateManifest({ ...VALID, timeline: 'not-an-array' }).ok).toBe(false);
  });

  it('accepts manifest with a well-shaped TrackItem', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'TextNode',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
          keyframes: {},
          props: { text: 'hello' },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects TrackItem with unknown componentType', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'BogusType',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
          keyframes: {},
          props: {},
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects TrackItem with malformed spatial', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'TextNode',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: {}, // missing x, y, z, scale, rotation
          keyframes: {},
          props: {},
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects TrackItem with non-numeric spatial.scale', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'TextNode',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: { x: 0, y: 0, z: 0, scale: ['a', 'b', 'c'], rotation: [0, 0, 0] },
          keyframes: {},
          props: {},
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});
