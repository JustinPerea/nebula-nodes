import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pin } from '../src/lib/wsClient';

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const api = vi.hoisted(() => ({
  fetchPins: vi.fn(),
  createPin: vi.fn(),
  deletePin: vi.fn(),
}));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
vi.mock('../src/lib/canvasPins', () => ({ ...api, MAX_PIN_TEXT: 280 }));

const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

function pin(id: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id, text: `note ${id}`, anchor: { nodeId: 'n1' }, position: { x: 0, y: 0 }, status: 'open',
    createdAt: '2026-10-10T14:00:00+00:00', detached: false, reply: null, ...overrides,
  };
}

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

beforeEach(() => {
  useCanvasPinsStore.setState({ projectId: null, pins: [], composer: null, removing: {}, error: null });
  api.fetchPins.mockReset();
  api.createPin.mockReset();
  api.deletePin.mockReset();
});

describe('canvas pins store', () => {
  it('replaces pins from canvasPins messages and drops malformed ones', () => {
    emit({ type: 'canvasPins', projectId: 'p1', pins: [pin('pin_a'), { id: 'bad' }, pin('pin_b', {
      status: 'resolved',
      reply: { agent: { id: 'codex', name: 'Codex', color: 'red;}', verified: true }, text: 'Done', at: 'x' },
    })] });
    const state = useCanvasPinsStore.getState();
    expect(state.projectId).toBe('p1');
    expect(state.pins.map((p) => p.id)).toEqual(['pin_a', 'pin_b']);
    // An unsafe colour never reaches a CSS custom property.
    expect(state.pins[1].reply?.agent.color).toBe('#E8825A');
  });

  it('refetches when the graph is replaced (project switch or import)', async () => {
    api.fetchPins.mockResolvedValue({ projectId: 'p2', pins: [pin('pin_c')] });
    emit({ type: 'graphSync', nodes: [], edges: [], empty: true, graphReplaced: true });
    await vi.waitFor(() => expect(useCanvasPinsStore.getState().projectId).toBe('p2'));
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_c']);
    emit({ type: 'graphSync', nodes: [], edges: [], empty: false });
    expect(api.fetchPins).toHaveBeenCalledTimes(1);
  });

  it('deletes optimistically and ignores a stale update until the delete lands', async () => {
    let finish: () => void = () => {};
    api.deletePin.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    useCanvasPinsStore.setState({ pins: [pin('pin_a'), pin('pin_b')] });
    const removal = useCanvasPinsStore.getState().remove('pin_a');
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_b']);
    emit({ type: 'canvasPins', projectId: 'p1', pins: [pin('pin_a'), pin('pin_b')] });
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_b']);
    finish();
    await removal;
    expect(useCanvasPinsStore.getState().removing).toEqual({});
  });

  it('puts a pin back when the delete fails', async () => {
    api.deletePin.mockRejectedValue(new Error('Only the person can do this from the Nebula canvas.'));
    useCanvasPinsStore.setState({ pins: [pin('pin_a')] });
    await useCanvasPinsStore.getState().remove('pin_a');
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    expect(useCanvasPinsStore.getState().error).toMatch(/Only the person/);
  });

  it('submits the composer target and closes it', async () => {
    api.createPin.mockResolvedValue(pin('pin_new', { text: 'warmer' }));
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    expect(await useCanvasPinsStore.getState().submit('  warmer ')).toBe(true);
    expect(api.createPin).toHaveBeenCalledWith('warmer', { nodeId: 'n4' });
    const state = useCanvasPinsStore.getState();
    expect(state.composer).toBeNull();
    expect(state.pins[0].id).toBe('pin_new');
  });
});
