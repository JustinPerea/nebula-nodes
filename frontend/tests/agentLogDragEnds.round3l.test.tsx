import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import { LOG_HELD_ATTR } from '../src/lib/noticeStackPlace';
import { useUIStore } from '../src/store/uiStore';

/**
 * PR #216 round 3l (GM r69 b; review 4 layout LOW-1, logic LOW-4): a drag of
 * the Agent log ends, and its hold (`data-agent-log-held`, which stops the
 * card and the notices placing) goes, on the drop and on every way a drop
 * can be lost: the window losing focus, the pointer cancelled, its capture
 * lost, the page hidden, and the button let go outside the window. Each one
 * also ends the drag itself: a later move no longer moves the log.
 */
const root = () => document.documentElement;
const held = () => root().hasAttribute(LOG_HELD_ATTR);
const POS_KEY = 'nebula:agentLog:pos';

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  window.localStorage.setItem(POS_KEY, JSON.stringify({ left: 300, top: 420, anchorX: 'left', anchorY: 'top' }));
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  root().removeAttribute(LOG_HELD_ATTR);
  window.localStorage.removeItem(POS_KEY);
  useUIStore.setState({ agentLogOpen: false } as never);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

/** Mounts the log and starts a drag past the threshold (review 4's repro:
 * 50 px with the button held). */
function startDrag() {
  const { container } = render(<AgentLog />);
  const row = container.querySelector<HTMLElement>('.agent-log__drag-row')!;
  fireEvent.pointerDown(row, { pointerId: 7, button: 0 });
  fireEvent.mouseDown(row, { button: 0, clientX: 310, clientY: 430 });
  fireEvent.mouseMove(window, { clientX: 360, clientY: 430, buttons: 1 });
  expect(held()).toBe(true);
  return { row, header: container.querySelector<HTMLButtonElement>('.agent-log__header')! };
}

/** After the hold ended: a move with the button down no longer drags, and
 * the person's next click on the header still toggles the log. */
async function dragIsOver(header: HTMLButtonElement) {
  const before = window.localStorage.getItem(POS_KEY);
  fireEvent.mouseMove(window, { clientX: 600, clientY: 200, buttons: 1 });
  expect(held()).toBe(false);
  expect(window.localStorage.getItem(POS_KEY)).toBe(before);
  // The drop's click guard lets go after its task.
  await act(() => new Promise<void>((done) => { setTimeout(done, 5); }));
  const open = useUIStore.getState().agentLogOpen;
  fireEvent.click(header);
  expect(useUIStore.getState().agentLogOpen).toBe(!open);
}

describe('round 3l (GM r69 b): the drag hold ends on every lost drop', () => {
  it('the window losing focus (Cmd-Tab, a system dialog mid-drag)', async () => {
    const { header } = startDrag();
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(held()).toBe(false);
    await dragIsOver(header);
  });

  it('the pointer cancelled', async () => {
    const { header } = startDrag();
    act(() => { window.dispatchEvent(new Event('pointercancel', { bubbles: true })); });
    expect(held()).toBe(false);
    await dragIsOver(header);
  });

  it('its pointer capture lost', async () => {
    const { row, header } = startDrag();
    act(() => { row.dispatchEvent(new Event('lostpointercapture', { bubbles: true })); });
    expect(held()).toBe(false);
    await dragIsOver(header);
  });

  it('the page hidden; a visibility change to visible leaves the drag on', async () => {
    const { header } = startDrag();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(held()).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(held()).toBe(false);
    await dragIsOver(header);
  });

  it('the button let go outside the window: its mouseup, or the first move back with no button down', async () => {
    const first = startDrag();
    // The release outside the window still reaches it (Chrome sends it).
    fireEvent.mouseUp(window, { clientX: 1400, clientY: 900 });
    expect(held()).toBe(false);
    await dragIsOver(first.header);
    cleanup();
    // No mouseup reached the page: the next move, buttons up, is the drop.
    const second = startDrag();
    fireEvent.mouseMove(window, { clientX: 700, clientY: 300, buttons: 0 });
    expect(held()).toBe(false);
    await dragIsOver(second.header);
  });

  it('a press with no move is a click, not a drag: no hold, and the header toggles', () => {
    const { container } = render(<AgentLog />);
    const row = container.querySelector<HTMLElement>('.agent-log__drag-row')!;
    const header = container.querySelector<HTMLButtonElement>('.agent-log__header')!;
    fireEvent.mouseDown(row, { button: 0, clientX: 310, clientY: 430 });
    fireEvent.mouseMove(window, { clientX: 311, clientY: 431, buttons: 1 });
    expect(held()).toBe(false);
    fireEvent.mouseUp(window);
    fireEvent.click(header);
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  });

  it('the hold takes the pointer\'s capture once the drag starts, never on the press, and lets it go at the drop', () => {
    const capture = vi.fn();
    const release = vi.fn();
    const has = vi.fn(() => true);
    Object.assign(HTMLElement.prototype, { setPointerCapture: capture, releasePointerCapture: release, hasPointerCapture: has });
    try {
      const { container } = render(<AgentLog />);
      const row = container.querySelector<HTMLElement>('.agent-log__drag-row')!;
      fireEvent.pointerDown(row, { pointerId: 7, button: 0 });
      fireEvent.mouseDown(row, { button: 0, clientX: 310, clientY: 430 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.mouseMove(window, { clientX: 360, clientY: 430, buttons: 1 });
      expect(capture).toHaveBeenCalledWith(7);
      fireEvent.mouseUp(window);
      expect(release).toHaveBeenCalledWith(7);
    } finally {
      for (const name of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it('unmounted mid-drag: the drag ends with it (no listener left moving a log that is gone)', () => {
    startDrag();
    cleanup();
    expect(held()).toBe(false);
    const before = window.localStorage.getItem(POS_KEY);
    fireEvent.mouseMove(window, { clientX: 900, clientY: 100, buttons: 1 });
    expect(window.localStorage.getItem(POS_KEY)).toBe(before);
    expect(held()).toBe(false);
  });
});
