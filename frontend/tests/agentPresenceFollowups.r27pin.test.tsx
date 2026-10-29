// PR #200 fix round 18, GM r27 item 4 (review 15 NIT 3): Nebula refused a
// note with pin_node_gone while the canvas still shows the node (its sync
// not in yet). Send note comes back on the next sync naming that node or
// after 5 s, whichever is first; a sync that says the node really is gone
// keeps it disabled under the removed-node rule (no new copy).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../src/lib/errorCopy';

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

const refused = (status: number, code: string) => new RequestFailedError("Couldn't add the pin.", status, { detail: 'x', code });
const field = () => screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const node = (id: string) => ({ id, type: 'text-input', position: { x: 0, y: 0 }, data: {} });

beforeAll(() => pinTextReady);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [node('n1')] } as never);
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The dialog open on n1, which the canvas still shows, and Nebula's refusal. */
async function refusedWhileShown() {
  api.createPin.mockRejectedValueOnce(refused(404, 'pin_node_gone'));
  useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
  render(<PinComposer />);
  await act(async () => {
    setter.call(field(), 'make it warmer');
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => { fireEvent.click(send()); });
  expect(send().disabled).toBe(true);
  expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
}

describe('GM r27 item 4: a pin_node_gone refusal while the canvas still shows the node', () => {
  it('no sync arrives: Send note is live again after 5 s, not before', async () => {
    await refusedWhileShown();
    await act(async () => { vi.advanceTimersByTime(4900); });
    expect(send().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(send().disabled).toBe(false);
    expect(send().title).not.toBe(PIN_REFUSAL_COPY.nodeGone);
    expect(field().value).toBe('make it warmer');
  });

  it('the next sync names the node: live again at once, before the 5 s', async () => {
    await refusedWhileShown();
    await act(async () => { vi.advanceTimersByTime(1000); });
    // A sync for another node changes nothing.
    await act(async () => { ws.emit({ type: 'graphSync', nodes: [node('n2')], edges: [] }); });
    expect(send().disabled).toBe(true);
    await act(async () => { ws.emit({ type: 'graphSync', nodes: [node('n1')], edges: [] }); });
    expect(send().disabled).toBe(false);
  });

  it('the sync says the node is gone: stays disabled under the removed-node rule, also after 5 s', async () => {
    await refusedWhileShown();
    await act(async () => {
      ws.emit({ type: 'graphSync', nodes: [], edges: [] });
      useGraphStore.setState({ nodes: [] } as never);
    });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
    // It comes back (Undo): Send note is live again, by the existing rule.
    await act(async () => { useGraphStore.setState({ nodes: [node('n1')] } as never); });
    expect(send().disabled).toBe(false);
  });
});
