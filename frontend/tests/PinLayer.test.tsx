import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Pin } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 2] as [number, number, number],
    nodeLookup: new Map<string, unknown>(),
  },
}));
const api = vi.hoisted(() => ({ deletePin: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasPins')>()),
  deletePin: api.deletePin,
}));

const { PinLayer } = await import('../src/components/canvas/PinLayer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

function node(id: string, x: number, y: number) {
  return { id, measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x, y } } };
}

function pin(id: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id, text: 'warmer', anchor: { nodeId: 'n4' }, position: null, status: 'open',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(), detached: false, reply: null, ...overrides,
  };
}

beforeEach(() => {
  flow.state.nodeLookup = new Map([['n4', node('n4', 100, 50)]]);
  api.deletePin.mockReset().mockResolvedValue(undefined);
  useCanvasPinsStore.setState({ pins: [], removing: {}, composer: null, error: null });
});
afterEach(cleanup);

describe('PinLayer', () => {
  it('draws a node pin on the card corner, counter-scaled by zoom', () => {
    useCanvasPinsStore.setState({ pins: [pin('pin_a'), pin('pin_b')] });
    const { container } = render(<PinLayer />);
    const badges = container.querySelectorAll<HTMLElement>('.canvas-pin');
    expect(badges).toHaveLength(2);
    // x = 100 + 240 - 10, y = 50 + 38; the second pin steps 22 px left.
    expect(badges[0].style.transform).toBe('translate(330px, 88px) scale(0.5)');
    expect(badges[1].style.transform).toBe('translate(308px, 88px) scale(0.5)');
    expect(badges[0].dataset.placed).toBe('true');
  });

  it('skips pins whose node is not drawn and keeps canvas-spot pins', () => {
    useCanvasPinsStore.setState({ pins: [pin('pin_a', { anchor: { nodeId: 'n9' } }), pin('pin_b', { anchor: { x: 5, y: 6 } })] });
    const { container } = render(<PinLayer />);
    const badges = container.querySelectorAll<HTMLElement>('.canvas-pin');
    expect(badges).toHaveLength(1);
    expect(badges[0].dataset.pin).toBe('pin_b');
    expect(badges[0].style.transform).toBe('translate(5px, 6px) scale(0.5)');
  });

  it('opens the card toward the side with room', () => {
    useCanvasPinsStore.setState({ pins: [pin('pin_a')] });
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0, x: left, y: 0, width: right - left, height: 0, toJSON: () => ({}) });
    const { container } = render(<div className="react-flow"><PinLayer /></div>);
    const canvas = container.querySelector<HTMLElement>('.react-flow')!;
    const wrap = container.querySelector<HTMLElement>('.canvas-pin')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(0, 1000) as DOMRect);
    const at = vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(900, 922) as DOMRect);
    const badge = screen.getByRole('button', { name: /Note for agents on n4/ });
    fireEvent.click(badge);
    expect(wrap.dataset.side).toBe('left');
    fireEvent.click(badge);
    at.mockReturnValue(rect(400, 422) as DOMRect);
    fireEvent.click(badge);
    expect(wrap.dataset.side).toBe('right');
  });

  it('expands to show the text, the reply and a Delete button', async () => {
    useCanvasPinsStore.setState({ pins: [pin('pin_a', {
      status: 'resolved',
      reply: { agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true }, text: 'Warmed the grade on n7', at: '2026-10-10T14:00:00+00:00' },
    })] });
    render(<PinLayer />);
    const badge = screen.getByRole('button', { name: /Note for agents on n4: warmer \(answered\)/ });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(badge);
    expect(screen.getByRole('note').textContent).toContain('warmer');
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Warmed the grade on n7')).toBeTruthy();
    expect(screen.getByText(/12m ago/)).toBeTruthy();
    fireEvent.keyDown(badge, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(api.deletePin).toHaveBeenCalledWith('pin_a');
    expect(useCanvasPinsStore.getState().pins).toEqual([]);
  });

  it('renders note text as text, never markup', () => {
    useCanvasPinsStore.setState({ pins: [pin('pin_a', { text: '<img src=x onerror=alert(1)>', anchor: { x: 0, y: 0 } })] });
    const { container } = render(<PinLayer />);
    fireEvent.click(screen.getByRole('button', { name: /Note for agents/ }));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
