// PR #204 round 6, GM r7 (3): the pin's Send note reads the one held state (useTabHeld, held,
// demoted or not answered yet) with the same lock and the 150 ms rule, never personGateHeld.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
const ws = vi.hoisted(() => {
  const handlers = new Set<(event: unknown) => void>();
  return {
    handlers,
    emit: (event: unknown) => { for (const handler of [...handlers]) handler(event); },
    client: {
      connect: () => {}, send: () => {}, disconnect: () => {},
      subscribe: (handler: (event: unknown) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    },
  };
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: ws.client }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');

const field = () => screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const node = (id: string) => ({ id, type: 'text-input', position: { x: 0, y: 0 }, data: {} });

beforeAll(() => pinTextReady);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  session.resetPersonSessionForTests();
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [node('n1')] } as never);
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  session.notePersonPromoted();
  session.resetPersonSessionForTests();
});

async function openWithNote() {
  useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
  render(<PinComposer />);
  await act(async () => {
    setter.call(field(), 'make it warmer');
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('GM r7 (3): Send note reads the one held state', () => {
  it('demoted with the banner closed (only the one state says so): Send note waits, with its reason', async () => {
    await openWithNote();
    expect(send().disabled).toBe(false);
    act(() => { session.reportPersonRequired(); session.setPersonBannerLine(null); });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
    act(() => { session.notePersonPromoted(); });
    expect(send().disabled).toBe(false);
  });

  it('a fresh page not answered yet: the first 150 ms keep Send note\'s look and send nothing; then it greys', async () => {
    act(() => { session.resetPersonSessionForTests({ unanswered: true }); });
    await openWithNote();
    expect(send().getAttribute('aria-disabled')).toBe('true');
    expect(send().hasAttribute('data-held-pending')).toBe(true);
    expect(send().disabled).toBe(false);
    expect(send().title).toBe('');
    await act(async () => { fireEvent.click(send()); });
    expect(api.createPin).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 10); });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
  });
});
