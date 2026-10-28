import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MaskPainterModal } from '../../src/components/DeferredPanels';

// Review 9, M-2: the mask painter rendered inside the Inspector popover. Under
// the Slava restraint skin the popover's backdrop-filter makes it the
// containing block of the painter's position:fixed overlay, so the "modal"
// was the popover's 260x300 box: header and Close hidden, the canvas and the
// Inspector clickable beside it, every shortcut dead. It now renders on
// document.body (ModalPortal), outside the popover, the shell shown while its
// chunk loads too. The window-size geometry at 1280 and 1440 under both skins
// is the live check's (jsdom does no layout).

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function inPopover() {
  const popover = document.createElement('div');
  popover.className = 'node-inspector-popover';
  popover.style.backdropFilter = 'blur(24px)';
  document.body.appendChild(popover);
  const view = render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={() => {}} onClose={vi.fn()} />, { container: popover });
  return { popover, view };
}
const layerOf = (dialog: Element) => dialog.closest('[data-modal-layer]');

describe('the mask painter covers the window, not the popover it opens from', () => {
  it('the shell shown while its chunk loads is on document.body', () => {
    const { popover } = inPopover();
    const dialog = screen.getByRole('dialog', { name: 'Mask painter' });
    expect(popover.contains(dialog)).toBe(false);
    expect(layerOf(dialog)?.parentElement).toBe(document.body);
  });

  it('so is the painter', async () => {
    const { popover } = inPopover();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const dialog = await screen.findByRole('dialog', { name: 'Mask painter' });
    expect(dialog.querySelector('.mask-painter__hint')).not.toBeNull();
    expect(popover.contains(dialog)).toBe(false);
    expect(layerOf(dialog)?.parentElement).toBe(document.body);
  });
});
