import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edge } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 5, found by the live check: a multi-select Delete of a
 * scene another window's run was rendering, with two Text nodes, kept the
 * scene (its DELETE got the 409) but lost the wire into it. React Flow sent
 * the scene's wires as their own DELETEs before the node's refusal came back.
 * A deleted node's wires go with its own DELETE (the backend removes them; the
 * canvas prunes them when the node goes), so a refused delete keeps them.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(() => () => {}) } }));

const { wiresDeletedWith } = await import('../src/store/graphStore');

const wire = (id: string, source: string, target: string): Edge => ({ id, source, target, sourceHandle: 'out', targetHandle: 'in' });

describe('the Delete key sends a deleted node\'s wires with the node, never on their own', () => {
  it('keeps out every wire that touches a node being deleted', () => {
    const edges = [wire('a', 'n4', 'n5'), wire('b', 'n8', 'n9'), wire('c', 'n1', 'n2'), wire('d', 'n5', 'n1')];
    expect(wiresDeletedWith(['n5', 'n8', 'n9'], edges).map((edge) => edge.id)).toEqual(['c']);
  });

  it('a wire selected on its own between nodes that stay still goes', () => {
    expect(wiresDeletedWith([], [wire('c', 'n1', 'n2')]).map((edge) => edge.id)).toEqual(['c']);
  });

  it('Canvas\'s onBeforeDelete hands React Flow only those wires', () => {
    const canvas = readFileSync(join(__dirname, '../src/components/Canvas.tsx'), 'utf8');
    expect(canvas).toMatch(/onBeforeDelete[\s\S]{0,600}wiresDeletedWith\(/);
  });
});
