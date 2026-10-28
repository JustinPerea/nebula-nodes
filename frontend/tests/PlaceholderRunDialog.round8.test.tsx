import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { isCanvasShortcutTarget } from '../src/lib/canvasShortcutScope';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

// Review 7, M-1: focus must never fall out of the open dialog. When the rows
// stop scrolling while the list has focus (an agent deletes placeholders, the
// window grows), focus moves to Cancel; any other slip to the page comes back
// to Cancel too. And while the dialog is open, canvas shortcuts never act,
// wherever focus is.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };

const model = (rows: number): PlaceholderRunConfirm => ({
  heading: 'Run 34 nodes Codex is still setting up?',
  intro: "Codex hasn't finished these, so their settings may not be final.",
  leftLine: null,
  rows: Array.from({ length: rows }, (_, i) => ({ nodeId: `n${i}`, name: `“Still ${i + 1}”`, model: 'FLUX.2 [pro]', price: '$0.03', agent: codex })),
  freeLine: null,
  totalLine: 'This run could cost up to $1.02 at list prices.',
  notes: [],
  costNotes: [],
  runLabel: 'Run for $1.02',
  confirmIds: [],
  confirmCost: 1.02,
});

/** jsdom lays nothing out: the rows' box says whether it overflows. */
function rowsOverflow(overflows: boolean) {
  const list = document.querySelector<HTMLElement>('.placeholder-run__rows')!;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: overflows ? 900 : 200 });
  act(() => { fireEvent(window, new Event('resize')); });
  return list;
}

afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('review 7, M-1: focus stays in the dialog', () => {
  it('the rows stop scrolling while the list has focus: focus moves to Cancel', () => {
    render(<PlaceholderRunDialog model={model(34)} onDone={() => {}} />);
    const list = rowsOverflow(true);
    list.focus();
    expect(document.activeElement).toBe(list);
    rowsOverflow(false);
    expect(list.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('focus that slips to the page comes back to Cancel', async () => {
    render(<PlaceholderRunDialog model={model(34)} onDone={() => {}} />);
    const list = rowsOverflow(true);
    list.focus();
    act(() => { list.blur(); });
    expect(document.activeElement).toBe(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('Escape still cancels after the list stopped scrolling', () => {
    const onDone = vi.fn();
    render(<PlaceholderRunDialog model={model(34)} onDone={onDone} />);
    const list = rowsOverflow(true);
    list.focus();
    rowsOverflow(false);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledWith(false, expect.anything());
  });
});

describe('review 7, M-1 (structural): no canvas shortcut acts behind an open dialog', () => {
  it('the page (body) is no canvas shortcut target while the dialog is open, and is again once it closes', () => {
    const view = render(<PlaceholderRunDialog model={model(2)} onDone={() => {}} />);
    expect(isCanvasShortcutTarget(document.body)).toBe(false);
    expect(isCanvasShortcutTarget(null)).toBe(false);
    view.unmount();
    expect(isCanvasShortcutTarget(document.body)).toBe(true);
  });

  it('nor is the canvas itself', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="canvas-wrapper"><div id="node" tabindex="0"></div></div>');
    const target = document.getElementById('node');
    expect(isCanvasShortcutTarget(target)).toBe(true);
    render(<PlaceholderRunDialog model={model(2)} onDone={() => {}} />);
    expect(isCanvasShortcutTarget(target)).toBe(false);
  });
});
