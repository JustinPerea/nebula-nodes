import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { InternalNode, ReactFlowState } from '@xyflow/react';

// The fake React Flow store the Canvas tests share (tests/helpers/fakeFlowStore.ts):
// a layer that reads it through selectors draws, and each test starts from a
// fresh state.

vi.mock('../src/lib/agentRoster', async (original) => ({
  ...await original<typeof import('../src/lib/agentRoster')>(),
  fetchAgentRoster: () => new Promise(() => {}),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const { fakeFlow } = await import('./helpers/fakeFlowStore');
  return {
    ...await importOriginal<typeof import('@xyflow/react')>(),
    // The real portal reads React Flow's own store; here it draws in place.
    ViewportPortal: ({ children }: { children: React.ReactNode }) => <div data-testid="viewport">{children}</div>,
    useStore: fakeFlow.useStore,
    useStoreApi: fakeFlow.useStoreApi,
  };
});

import { AgentNodeMarks } from '../src/components/canvas/DeferredCanvasOverlays';
import { fakeFlow, installFakeFlowStore } from './helpers/fakeFlowStore';

installFakeFlowStore();
afterEach(cleanup);

/** One node an agent is still setting up, laid out at (40, 60), 240x300. */
function placeholder(id: string): InternalNode {
  return {
    id,
    position: { x: 40, y: 60 },
    data: { pending: { agent: { id: 'agent-1', name: 'Codex', color: '#3366ff' }, at: 0 } },
    measured: { width: 240, height: 300 },
    internals: { positionAbsolute: { x: 40, y: 60 }, z: 0, userNode: { id, position: { x: 40, y: 60 }, data: {} } },
  } as unknown as InternalNode;
}

describe('the fake React Flow store', () => {
  it('lets the preloaded agent mark layer draw a node from nodeLookup', () => {
    fakeFlow.reset({ nodeLookup: new Map([['n1', placeholder('n1')]]) } as Partial<ReactFlowState>);
    const { container } = render(<AgentNodeMarks />);
    const outline = container.querySelector<HTMLElement>('.agent-placeholder-outline[data-node="n1"]');
    expect(outline).not.toBeNull();
    expect(outline!.style.transform).toBe('translate(40px, 60px)');
    expect(outline!.style.width).toBe('240px');
    expect(outline!.style.height).toBe('300px');
  });

  it('draws nothing for an empty flow', () => {
    const { container } = render(<AgentNodeMarks />);
    expect(container.querySelector('.agent-node-marks')).toBeNull();
  });

  it('takes a setState within a test', () => {
    const api = fakeFlow.useStoreApi();
    api.setState({ nodesSelectionActive: true, transform: [5, 5, 2] });
    api.setState((state) => ({ width: state.width / 2 }));
    expect(fakeFlow.useStore((state) => state.nodesSelectionActive)).toBe(true);
    expect(fakeFlow.useStore((state) => state.transform)).toEqual([5, 5, 2]);
    expect(api.getState().width).toBe(640);
  });

  it("starts the next test from a fresh state, so the last test's setState doesn't reach it", () => {
    const state = fakeFlow.useStoreApi().getState();
    expect(state.nodesSelectionActive).toBe(false);
    expect(state.transform).toEqual([0, 0, 1]);
    expect(state.width).toBe(1280);
    expect(state.nodeLookup.size).toBe(0);
  });
});
