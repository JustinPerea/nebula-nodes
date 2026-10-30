/**
 * ModalPortal, round 8 of PR #203 (GM r15 items 4 and 5; review 7, copy
 * LOW-2 and NITs 1, 2 and 5): one place for every dialog.
 * - A press that closes a dialog doesn't then move focus: the press's own
 *   default (to <body>, or to whatever is under the pointer once the
 *   backdrop is gone) would undo the return to the opener. jsdom runs no
 *   default actions, so these tests run the browser's: a press whose default
 *   wasn't prevented blurs the focused control. A browser commits a press's
 *   update while the press is still being dispatched (React's microtask after
 *   its own listener); flushSync does the same here.
 * - A dialog opened from a dialog returns focus up the chain of openers.
 * - Closing stacked dialogs in any order leaves the page as it was.
 * - StrictMode's second mount doesn't send focus away.
 * - The opener's own onFocus hears the return.
 * - A dialog that becomes aria-modal after it mounts isolates the page.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ModalPortal } from '../src/components/ModalPortal';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const flush = () => act(async () => {});

/** What a browser does after a mousedown nobody prevented: focus leaves the
 * control (the press is on nothing focusable). */
function mouseDown(target: Element): boolean {
  const proceed = target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  if (proceed && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  return proceed;
}

function page() {
  const root = document.createElement('div');
  root.id = 'page';
  const opener = document.createElement('button');
  opener.textContent = 'Opener';
  root.append(opener);
  document.body.append(root);
  return { root, opener };
}

/** A palette's shape: the backdrop is the dialog's own outer element and
 * closes it on mousedown (CommandPalette, ModelPicker), or on pointerdown
 * (KeyboardShortcuts). */
function PressDialog({ on }: { on: 'mousedown' | 'pointerdown' }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const close = (event: { target: EventTarget; currentTarget: EventTarget }) => {
    if (event.target === event.currentTarget) flushSync(() => setOpen(false));
  };
  return (
    <ModalPortal>
      <div data-backdrop {...(on === 'mousedown' ? { onMouseDown: close } : { onPointerDown: close })}>
        <div role="dialog" aria-modal="true"><input aria-label="Search" autoFocus /></div>
      </div>
    </ModalPortal>
  );
}

describe('a press that closes a dialog leaves focus on the opener (GM, PR #203 r15 item 4)', () => {
  it('mousedown on the backdrop: its default is stopped, focus is back on the opener', async () => {
    const { opener } = page();
    opener.focus();
    render(<PressDialog on="mousedown" />, { container: document.body.appendChild(document.createElement('div')) });
    expect(document.activeElement).toHaveAttribute('aria-label', 'Search');
    const proceed = mouseDown(document.querySelector('[data-backdrop]')!);
    await flush();
    expect(proceed).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('pointerdown on the backdrop: the mousedown that follows, on what lies under it, moves no focus', async () => {
    const { opener, root } = page();
    opener.focus();
    render(<PressDialog on="pointerdown" />, { container: document.body.appendChild(document.createElement('div')) });
    const backdrop = document.querySelector('[data-backdrop]')!;
    backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await flush();
    expect(opener).toHaveFocus();
    // The backdrop is gone: the press's mousedown lands on the page.
    expect(mouseDown(root)).toBe(false);
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(opener).toHaveFocus();
    // The next press is the person's own, and moves focus as usual.
    expect(mouseDown(root)).toBe(true);
  });

  it('a press inside the dialog that doesn\'t close it keeps its default', () => {
    page();
    render(<PressDialog on="mousedown" />, { container: document.body.appendChild(document.createElement('div')) });
    expect(document.querySelector('[role="dialog"]')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(true);
  });
});

function ClosingDialog({ onClose, label = 'Close' }: { onClose: () => void; label?: string }) {
  return (
    <ModalPortal>
      <div role="dialog" aria-modal="true"><button type="button" autoFocus onClick={onClose}>{label}</button></div>
    </ModalPortal>
  );
}

describe('a dialog opened from a dialog returns focus up the chain (GM, PR #203 r15 item 5)', () => {
  it('palette, then Keyboard shortcuts from it: closing shortcuts lands on what opened the palette', async () => {
    page();
    function App() {
      const [palette, setPalette] = useState(false);
      const [shortcuts, setShortcuts] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setPalette(true)}>Open palette</button>
          {palette && (
            <ModalPortal>
              <div role="dialog" aria-modal="true">
                <button type="button" autoFocus onClick={() => { setPalette(false); setShortcuts(true); }}>Keyboard shortcuts</button>
              </div>
            </ModalPortal>
          )}
          {shortcuts && <ClosingDialog label="Close shortcuts" onClose={() => setShortcuts(false)} />}
        </>
      );
    }
    const view = render(<App />, { container: document.body.appendChild(document.createElement('div')) });
    const openPalette = view.getByText('Open palette');
    openPalette.focus();
    await act(async () => openPalette.click());
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(document.activeElement).toHaveTextContent('Close shortcuts');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    await flush();
    expect(openPalette).toHaveFocus();
  });

  it('a dialog over a dialog, the lower one still open: back to the control in the lower one', async () => {
    page();
    function App() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <ModalPortal>
            <div role="dialog" aria-modal="true"><button type="button" onClick={() => setSecond(true)}>More</button></div>
          </ModalPortal>
          {second && <ClosingDialog onClose={() => setSecond(false)} />}
        </>
      );
    }
    render(<App />, { container: document.body.appendChild(document.createElement('div')) });
    const more = screen.getByText('More');
    more.focus();
    await act(async () => more.click());
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    await flush();
    expect(more).toHaveFocus();
  });
});

function Plain() {
  return (
    <ModalPortal>
      <div role="dialog" aria-modal="true"><button type="button">x</button></div>
    </ModalPortal>
  );
}

describe('stacked dialogs close in any order and leave the page as it was (review 7, LOW-2)', () => {
  const orders: Array<[number, number[]]> = [[2, [0, 1]], [2, [1, 0]], [3, [0, 1, 2]], [3, [2, 1, 0]], [3, [1, 0, 2]], [3, [0, 2, 1]]];
  it.each(orders)('%i dialogs, closed in order %j', async (count, order) => {
    const { root } = page();
    const views = Array.from({ length: count }, () => render(<Plain />, { container: document.body.appendChild(document.createElement('div')) }));
    expect(root).toHaveAttribute('inert', '');
    order.forEach((index, step) => {
      views[index].unmount();
      // While any is open, the page stays inert.
      if (step < order.length - 1) expect(root).toHaveAttribute('inert', '');
    });
    await flush();
    expect(root).not.toHaveAttribute('inert');
    expect(root).not.toHaveAttribute('aria-hidden');
    for (const view of views) expect(view.container).not.toHaveAttribute('inert');
  });
});

describe('the rest of review 7', () => {
  it('StrictMode: the second mount keeps focus in the dialog (NIT-1)', async () => {
    const { opener } = page();
    opener.focus();
    render(
      <StrictMode>
        <ModalPortal>
          <div role="dialog" aria-modal="true"><button type="button" autoFocus>Close</button></div>
        </ModalPortal>
      </StrictMode>,
      { container: document.body.appendChild(document.createElement('div')) },
    );
    await flush();
    expect(document.activeElement).toHaveTextContent('Close');
    expect(document.getElementById('page')).toHaveAttribute('inert', '');
  });

  it('StrictMode, opened from a notice (which stays usable): the second mount still keeps focus in the dialog (NIT-1)', async () => {
    // The page behind goes inert, which alone would stop a stray return; a
    // notice's control doesn't, so only the cancelled return keeps focus here.
    const region = document.createElement('div');
    region.setAttribute('data-notice-region', '');
    const opener = document.createElement('button');
    opener.textContent = 'Details';
    region.append(opener);
    document.body.append(region);
    opener.focus();
    render(
      <StrictMode>
        <ModalPortal>
          <div role="dialog" aria-modal="true"><button type="button" autoFocus>Close</button></div>
        </ModalPortal>
      </StrictMode>,
      { container: document.body.appendChild(document.createElement('div')) },
    );
    await flush();
    expect(region).not.toHaveAttribute('inert');
    expect(document.activeElement).toHaveTextContent('Close');
  });

  it('the opener\'s own onFocus hears focus come back (NIT-5)', async () => {
    page();
    const heard: string[] = [];
    function App() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onFocus={() => heard.push('focus')} onClick={() => setOpen(true)}>Open</button>
          {open && <ClosingDialog onClose={() => setOpen(false)} />}
        </>
      );
    }
    const view = render(<App />, { container: document.body.appendChild(document.createElement('div')) });
    const button = view.getByText('Open');
    button.focus();
    heard.length = 0;
    await act(async () => button.click());
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    await flush();
    expect(button).toHaveFocus();
    expect(heard).toEqual(['focus']);
  });

  it('a dialog that becomes aria-modal after it mounts isolates the page (NIT-2)', async () => {
    const { root } = page();
    function Late() {
      const [modal, setModal] = useState(false);
      return (
        <ModalPortal>
          <div role="dialog" aria-modal={modal ? 'true' : undefined}>
            <button type="button" onClick={() => setModal(true)}>Become modal</button>
          </div>
        </ModalPortal>
      );
    }
    render(<Late />, { container: document.body.appendChild(document.createElement('div')) });
    expect(root).not.toHaveAttribute('inert');
    await act(async () => screen.getByText('Become modal').click());
    // The MutationObserver sees the attribute change.
    await flush();
    expect(root).toHaveAttribute('inert', '');
  });
});
