// Review 14 LOW-2 and GM's addition (PR #200 fix round 16): the node the note
// dialog is for comes back (Undo, or any other path) while the dialog is open.
// Send note is live again with no reason, the "That node was removed, so the
// note wasn’t added." toast leaves with its normal exit (its line is no longer
// true), and focus stays in the note field.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');

const NODE = { id: 'n1', position: { x: 0, y: 0 }, data: {} } as never;
const field = () => screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const toast = () => [...document.querySelectorAll('.canvas-pin-toast--notice')]
  .find((el) => (el.textContent ?? '').includes(PIN_REFUSAL_COPY.nodeGone)) ?? null;
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const edit = async (value: string) => {
  await act(async () => {
    setter.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
};

// jsdom runs no CSS: stand in for noticeRegion.css, where a marked toast runs its -out animation.
const realGetAnimations = Element.prototype.getAnimations;
beforeAll(() => pinTextReady);
beforeEach(() => {
  Element.prototype.getAnimations = function getAnimations(this: Element) {
    if (!this.getAttribute('data-leaving')) return [];
    return [Object.assign(new EventTarget(), { animationName: 'notice-surface-out', currentTime: 0, playbackRate: 1,
      effect: { getComputedTiming: () => ({ endTime: 294 }) } })] as unknown as Animation[];
  };
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    errorPersonGate: false, draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [] });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  cleanup();
  Element.prototype.getAnimations = realGetAnimations;
});

const leavesWithItsExit = () => {
  const el = toast();
  expect(el?.getAttribute('data-leaving')).toBe('surface');
  act(() => {
    for (const type of ['animationend', 'webkitAnimationEnd']) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'animationName', { value: 'notice-surface-out' });
      el!.dispatchEvent(event);
    }
  });
  expect(toast()).toBeNull();
};

describe('review 14 LOW-2: the removed node comes back while the dialog is open', () => {
  it('the canvas lost it, then Undo: Send note live, no reason; the toast leaves; focus stays in the field', async () => {
    useGraphStore.setState({ nodes: [NODE] });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    await edit('make it warmer');
    await act(async () => { useGraphStore.setState({ nodes: [] }); });
    expect(send().disabled).toBe(true);
    expect(toast()).not.toBeNull();
    field().focus();
    await act(async () => { useGraphStore.setState({ nodes: [NODE] }); });  // Undo
    expect(send().disabled).toBe(false);
    expect(send().title).toBe('');
    expect(useCanvasPinsStore.getState().targetGone).toBe(false);
    leavesWithItsExit();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe('make it warmer');
    // And it sends.
    api.createPin.mockResolvedValue({ pin: { id: 'pin_1', text: 'make it warmer', anchor: { nodeId: 'n1' }, status: 'open' } });
    await act(async () => { fireEvent.click(send()); });
    expect(api.createPin).toHaveBeenCalledTimes(1);
  });

  it('Nebula refused (pin_node_gone), the canvas then lost it and got it back: the same', async () => {
    api.createPin.mockRejectedValueOnce(new RequestFailedError("Couldn't add the pin.", 404, { detail: 'x', code: 'pin_node_gone' }));
    useGraphStore.setState({ nodes: [NODE] });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    await edit('make it warmer');
    await act(async () => { fireEvent.click(send()); });
    expect(send().disabled).toBe(true);
    // The canvas still has it (a sync not in yet): nothing changes.
    await act(async () => { useGraphStore.setState({ nodes: [NODE] }); });
    expect(send().disabled).toBe(true);
    await act(async () => { useGraphStore.setState({ nodes: [] }); });
    field().focus();
    await act(async () => { useGraphStore.setState({ nodes: [NODE] }); });
    expect(send().disabled).toBe(false);
    leavesWithItsExit();
    expect(document.activeElement).toBe(field());
  });

  it('another line is not taken away: only the "removed" line leaves', async () => {
    useGraphStore.setState({ nodes: [NODE] });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    await act(async () => { useGraphStore.setState({ nodes: [] }); });
    act(() => { useCanvasPinsStore.setState({ error: PIN_REFUSAL_COPY.openNotesFull }); });
    await act(async () => { useGraphStore.setState({ nodes: [NODE] }); });
    expect(send().disabled).toBe(false);
    expect(useCanvasPinsStore.getState().error).toBe(PIN_REFUSAL_COPY.openNotesFull);
  });
});

describe('review 14 NIT-3: the hidden announce region keeps no stale words', () => {
  const announced = () => document.querySelector('.prompt-dialog__announce')?.textContent ?? '';
  it('empties after it speaks, and at once when the note is back above 30 left', async () => {
    const { PromptDialog } = await import('../src/components/PromptDialog');
    const { MAX_PIN_TEXT, noteLength } = await import('../src/lib/canvasPins');
    vi.useFakeTimers();
    try {
      render(<PromptDialog request={{ label: 'Note for agents', initial: '', resolve: () => {} }} onDone={() => {}}
        cap={{ max: MAX_PIN_TEXT, count: noteLength, showAt: 30 }} multiline confirmLabel="Send note" />);
      await edit('a'.repeat(280));
      expect(announced()).toBe('0 characters left');
      await edit('a'.repeat(245));
      expect(announced()).toBe('');
      await edit('a'.repeat(270));
      expect(announced()).toBe('10 characters left');
      act(() => { vi.advanceTimersByTime(4900); });
      expect(announced()).toBe('10 characters left');
      act(() => { vi.advanceTimersByTime(200); });
      expect(announced()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
