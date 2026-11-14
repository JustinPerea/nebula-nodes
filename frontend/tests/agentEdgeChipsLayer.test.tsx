import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CursorSpace } from '../src/lib/agentCursorSpace';
import type { AgentCursor } from '../src/store/agentPresenceStore';

const spring = vi.hoisted(() => ({ springViewport: vi.fn(() => () => {}) }));
vi.mock('../src/lib/viewportSpring', () => spring);

const flow = vi.hoisted(() => ({
  setViewport: vi.fn(),
  api: null as unknown,
}));
flow.api = { getState: () => ({ transform: [10, 20, 2], panZoom: { setViewport: flow.setViewport } }) };
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useStoreApi: () => flow.api,
}));

import { CanvasEdgeChips } from '../src/components/canvas/CanvasEdgeChips';

/**
 * PR #233 slice 9: the chip layer. A cursor off screen gets a button named for
 * it, "+N" is a count, a press springs the camera once, and nothing else pans.
 */
const PANE = { left: 0, top: 0, width: 1000, height: 600 };
let targets: Record<string, { x: number; y: number }>;
let pane: HTMLElement;

const space = (): CursorSpace => ({
  layer: 'canvas',
  zoom: () => 2,
  pane: () => pane,
  viewKey: () => 0,
  subscribe: () => () => {},
  // Flow coordinates here are the same as client px / 2 + nothing: toClient doubles them.
  resolve: (anchor) => targets[(anchor as { nodeId?: string }).nodeId ?? ''] ?? null,
  chainPoint: () => null,
  nodeInfo: () => undefined,
  labels: () => ({}) as never,
  fromClient: (p) => p,
  toClient: (p) => ({ x: p.x * 2, y: p.y * 2 }),
  snap: (p) => p,
} as unknown as CursorSpace);

const cursor = (key: string, name: string, nodeId: string, receivedAt: number): AgentCursor => ({
  id: key, key, session: null, name, color: '#E8825A', verified: true,
  target: { surface: 'canvas', nodeId } as never, action: 'move', say: '', receivedAt, seq: 1, did: null,
  replayed: false, projectId: null, proposalId: null, arrivedAt: receivedAt, arrivalKnown: true,
});

beforeEach(() => {
  pane = document.createElement('div');
  pane.getBoundingClientRect = () => ({ ...PANE, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(pane);
  spring.springViewport.mockClear();
  flow.setViewport.mockClear();
  targets = {};
});
afterEach(() => { cleanup(); pane.remove(); });

describe('the edge chip layer', () => {
  it('draws a chip as a button named "Claude, show where it’s working" for a cursor off screen', () => {
    targets = { far: { x: 1500, y: 150 } };
    render(<CanvasEdgeChips agents={{ claude: cursor('claude', 'Claude', 'far', 1) }} space={space()} />);
    const chip = screen.getByRole('button', { name: 'Claude, show where it’s working' });
    expect(chip.getAttribute('data-side')).toBe('right');
  });

  it('uses the cursor\'s own label in the name', () => {
    targets = { far: { x: 1500, y: 150 } };
    render(<CanvasEdgeChips agents={{ codex: cursor('codex', 'Codex', 'far', 1) }} space={space()} />);
    expect(screen.getByRole('button', { name: 'Codex, show where it’s working' })).toBeTruthy();
  });

  it('draws no chip for a cursor on screen', () => {
    targets = { near: { x: 100, y: 100 } };
    render(<CanvasEdgeChips agents={{ claude: cursor('claude', 'Claude', 'near', 1) }} space={space()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the "+N" is a count, not a button, named for how many agents are off screen', () => {
    targets = {};
    const agents: Record<string, AgentCursor> = {};
    for (let i = 0; i < 5; i += 1) {
      targets[`n${i}`] = { x: 1500, y: 100 + i * 100 };
      agents[`a${i}`] = cursor(`a${i}`, `Agent ${i}`, `n${i}`, i);
    }
    render(<CanvasEdgeChips agents={agents} space={space()} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    const count = screen.getByRole('img', { name: '+2 agents off screen' });
    expect(count.tagName).not.toBe('BUTTON');
    expect(count.textContent).toBe('+2');
    cleanup();
    delete agents.a4;
    render(<CanvasEdgeChips agents={agents} space={space()} />);
    expect(screen.getByRole('img', { name: '+1 agent off screen' })).toBeTruthy();
  });

  it('pans nothing on render, or as the cursors change; a press springs the viewport once', async () => {
    targets = { far: { x: 1500, y: 150 } };
    const agents = { claude: cursor('claude', 'Claude', 'far', 1) };
    const { rerender } = render(<CanvasEdgeChips agents={agents} space={space()} />);
    rerender(<CanvasEdgeChips agents={{ ...agents }} space={space()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(spring.springViewport).not.toHaveBeenCalled();
    expect(flow.setViewport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Claude, show where it’s working' }));
    expect(spring.springViewport).toHaveBeenCalledTimes(1);
    const [from, to] = spring.springViewport.mock.calls[0] as unknown as [
      { x: number; y: number; zoom: number }, { x: number; y: number; zoom: number }];
    expect(from).toEqual({ x: 10, y: 20, zoom: 2 });
    // The target (1500, 150) lands at the middle of the pane, at the zoom it has.
    expect(to).toEqual({ zoom: 2, x: 500 - 1500 * 2, y: 300 - 150 * 2 });
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});
