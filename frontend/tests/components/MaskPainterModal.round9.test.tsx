import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MaskPainterModal } from '../../src/components/panels/MaskPainterModal';
import { isCanvasShortcutTarget } from '../../src/lib/canvasShortcutScope';

// Review 8, L-d: the mask painter covers the whole canvas, but it was no
// modal dialog: with focus on the page, Cmd+Enter or Delete acted on the
// graph behind it. It is aria-modal now, with focus management: focus starts
// on Close, Tab stays inside, Escape closes it, a slip to the page comes back,
// and focus returns to the button that opened it.

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
afterEach(() => { cleanup(); document.body.replaceChildren(); });

function openPainter(onClose = vi.fn()) {
  const opener = document.createElement('button');
  opener.textContent = 'Paint Mask';
  document.body.appendChild(opener);
  opener.focus();
  const view = render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={() => {}} onClose={onClose} />);
  return { opener, onClose, view };
}

describe('the mask painter is a modal dialog', () => {
  it('is marked modal and named', () => {
    openPainter();
    const dialog = screen.getByRole('dialog', { name: 'Mask painter' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('canvas shortcuts yield while it is open, focus on the page included', () => {
    openPainter();
    expect(isCanvasShortcutTarget(document.body)).toBe(false);
  });

  it('focus starts on Close, Escape closes it, and focus goes back to Paint Mask', () => {
    const { opener, onClose, view } = openPainter();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
  });

  it('Tab from the last control comes back to the first', () => {
    openPainter();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('a slip to the page comes back to Close', async () => {
    openPainter();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    await tick();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
