// GM, PR #202 r1: no type-name fallback for a name made only of "…": the
// heading reads the node's own name.
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { nodeCardTitle } from '../../store/graphStore';
import type { NodeData } from '../../types';

describe('GM PR #202 r1: the title the note heading reads', () => {
  it('is the node\'s own "…", not its type name', () => {
    const node = { id: 'n1', type: 'text-input', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: '…', params: {} } } as unknown as Node<NodeData>;
    expect(nodeCardTitle(node)).toBe('…');
  });
});
