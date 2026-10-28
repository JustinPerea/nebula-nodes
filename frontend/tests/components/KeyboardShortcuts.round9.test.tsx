import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyboardShortcuts } from '../../src/components/KeyboardShortcuts';
import { useUIStore } from '../../src/store/uiStore';

// Review 8, L-c: after a click on the dialog's text, focus fell to the page;
// "?" no longer closed it (canvas keys yield to an open modal) and Escape
// never did. It gets the placeholder dialog's focus return, and Escape (or
// "?") closes it from the page as well.

const initialUI = useUIStore.getState();
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function open() {
  render(<KeyboardShortcuts />);
  fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
  return screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
}

/** A click on the list's text: nothing there takes focus, so the browser puts it on the page. */
function clickText(dialog: HTMLElement) {
  const text = dialog.querySelector('dt')!;
  fireEvent.pointerDown(text);
  fireEvent.mouseDown(text);
  const close = screen.getByRole('button', { name: 'Close' });
  act(() => { close.blur(); });
  fireEvent.mouseUp(text);
  fireEvent.click(text);
}

describe('Keyboard shortcuts: no dead end once focus leaves its button', () => {
  beforeEach(() => { useUIStore.setState({ viewMode: 'canvas' }); });
  afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); });

  it('a click on its text: focus comes back to Close', async () => {
    const dialog = open();
    clickText(dialog);
    await tick();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('Escape with focus on the page closes it', async () => {
    open();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"?" with focus on the page closes it, the same key that opened it', async () => {
    open();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('another modal dialog over it keeps its own keys: Escape on the page leaves the shortcuts open', () => {
    open();
    const other = document.createElement('div');
    other.setAttribute('role', 'alertdialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    other.remove();
  });
});
