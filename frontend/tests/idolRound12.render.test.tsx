/**
 * PR #203 round 12, review 11 copy LOW-3: the Inspector's Krea notice says
 * GM r21's one verb, "Sign in to Krea in Settings" (mutant F15 put the old
 * "Connect or check Krea in Settings." back and every test passed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('the Inspector’s Krea sign-in notice', () => {
  it('says "Sign in to Krea in Settings" for a Krea plan node that isn’t signed in', () => {
    const krea: Node<NodeData> = { id: 'k1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Krea 2', definitionId: 'krea-2-generate', params: { _kreaAuth: 'mcp' }, state: 'idle', outputs: {},
        keyStatus: 'missing' } as unknown as NodeData };
    useGraphStore.setState({ nodes: [krea], edges: [] });
    useUIStore.getState().selectNode('k1');
    const { container } = render(<Inspector embedded />);
    const notices = [...container.querySelectorAll('.inspector__notice--warning')].map((node) => node.textContent?.trim());
    expect(notices).toContain('Krea sign-in required. Sign in to Krea in Settings.');
    expect(container.textContent).not.toMatch(/Connect or check Krea/);
  });
});
