import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 2] as [number, number, number],
    nodeLookup: new Map<string, unknown>(),
  },
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));

const { AgentNoteOutlineLayer } = await import('../src/components/agent-notes/AgentNoteOutlineLayer');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');

function node(id: string, x: number, y: number) {
  return { id, measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x, y } } };
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  flow.state.nodeLookup = new Map([['n4', node('n4', 100, 50)], ['n7', node('n7', 500, 50)]]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AgentNoteOutlineLayer', () => {
  it('outlines each named node in the author colour, staggered after the card', () => {
    const { container } = render(<AgentNoteOutlineLayer />);
    act(() => {
      useAgentNotesStore.getState().setOutline('card', { refs: ['n4', 'n9', 'n7'], color: '#E8825A', delayMs: 800, staggerMs: 250 });
    });
    const outlines = container.querySelectorAll<HTMLElement>('.agent-note-outline');
    // n9 isn't drawn: nothing is outlined from a guess.
    expect(outlines).toHaveLength(2);
    expect(outlines[0].dataset.node).toBe('n4');
    expect(outlines[0].style.transform).toBe('translate(100px, 50px)');
    expect(outlines[0].style.width).toBe('240px');
    expect(outlines[0].style.height).toBe('160px');
    expect(outlines[0].style.getPropertyValue('--an-delay')).toBe('800ms');
    expect(outlines[1].style.getPropertyValue('--an-delay')).toBe('1050ms');
    const layer = container.querySelector<HTMLElement>('.agent-note-outlines')!;
    expect(layer.style.getPropertyValue('--an-outline')).toBe('#E8825A');
    // Stroke stays the same on screen at any zoom.
    expect(layer.style.getPropertyValue('--an-zoom')).toBe('2');
  });

  it('fades the outlines out with the card, then removes them', () => {
    vi.useFakeTimers();
    const { container } = render(<AgentNoteOutlineLayer />);
    act(() => {
      useAgentNotesStore.getState().setOutline('card', { refs: ['n4'], color: '#E8825A', delayMs: 0, staggerMs: 0 });
    });
    act(() => { useAgentNotesStore.getState().setOutline('card', null); });
    expect(container.querySelector('.agent-note-outlines')?.getAttribute('data-leaving')).toBe('true');
    act(() => { vi.advanceTimersByTime(800); });
    expect(container.querySelector('.agent-note-outline')).toBeNull();
  });
});
