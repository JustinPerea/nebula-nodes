/**
 * Round 18 of PR #199, GM r25 (4): the notices already on the page when an
 * aria-modal dialog opens go under its scrim with the rest of the page:
 * inert, hidden from assistive technology, dimmed. A notice that arrives
 * while it is open lands above, live and in the dialog's focus trap. Closing
 * the dialog gives the old ones back. One rule for every modal, in
 * ModalPortal (lib/modalFocus holdNoticesUnderModal).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ModalPortal } from '../src/components/ModalPortal';
import { PromptDialog } from '../src/components/PromptDialog';
import { KeptDiscardConfirm } from '../src/components/projects/KeptDiscardConfirm';
import { ForgetRecoveryConfirm } from '../src/components/panels/ForgetRecoveryConfirm';
import { NOTICE_REGION, UNDER_MODAL } from '../src/lib/modalFocus';

/** A notice region like NoticeRegion's, a child of <body>, with one slot. */
function region() {
  const element = document.createElement('div');
  element.className = 'notice-region';
  element.setAttribute('data-notice-region', '');
  const band = document.createElement('div');
  band.setAttribute('data-notice-band', '');
  band.setAttribute('aria-hidden', 'true');
  element.appendChild(band);
  const stack = document.createElement('div');
  stack.className = 'notice-region__stack';
  const slot = document.createElement('div');
  slot.setAttribute('data-notice-slot', 'notice');
  stack.appendChild(slot);
  element.appendChild(stack);
  document.body.appendChild(element);
  return { element, slot };
}
function notice(slot: Element, text: string) {
  const item = document.createElement('div');
  item.setAttribute('role', 'status');
  item.innerHTML = `<span>${text}</span><button type="button" aria-label="Dismiss">×</button>`;
  slot.appendChild(item);
  return { item, close: item.querySelector('button')! };
}
const under = (item: Element) => item.hasAttribute(UNDER_MODAL) && item.hasAttribute('inert') && item.getAttribute('aria-hidden') === 'true';
const live = (item: Element) => !item.hasAttribute(UNDER_MODAL) && !item.hasAttribute('inert') && !item.hasAttribute('aria-hidden');
const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });

function Confirm({ label = 'Confirm' }: { label?: string }) {
  return (
    <ModalPortal>
      <div className="scrim">
        <div role="alertdialog" aria-modal="true" aria-label={label}>
          <button type="button">Keep</button><button type="button">Forget</button>
        </div>
      </div>
    </ModalPortal>
  );
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(NOTICE_REGION).forEach((element) => element.remove());
});

describe('GM r25 (4): a notice present at open goes under the scrim', () => {
  it('dimmed and inert while open; one arriving after is above, live and reachable; closing restores the old one', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    const view = render(<Confirm />);
    expect(under(old.item)).toBe(true);
    expect(old.item.style.getPropertyValue('--notice-under-modal')).toBe('0.55');
    const late = notice(slot, 'New notice');
    expect(live(late.item)).toBe(true);
    // Tab from the dialog's last button reaches the new notice's ×, never the old one's.
    const forget = screen.getByRole('button', { name: 'Forget' });
    forget.focus();
    tab();
    expect(document.activeElement).toBe(late.close);
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
    view.unmount();
    expect(live(old.item)).toBe(true);
    expect(old.item.style.getPropertyValue('--notice-under-modal')).toBe('');
    expect(live(late.item)).toBe(true);
  });

  it('keeps what a notice had before: its own aria-hidden and inert come back', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    old.item.setAttribute('aria-hidden', 'false');
    const view = render(<Confirm />);
    expect(under(old.item)).toBe(true);
    view.unmount();
    expect(old.item.getAttribute('aria-hidden')).toBe('false');
    expect(old.item).not.toHaveAttribute('inert');
  });

  it('the region’s own items go under too (not its band or stack)', () => {
    const { element, slot } = region();
    const own = document.createElement('div');
    own.setAttribute('role', 'dialog');
    element.appendChild(own);
    const old = notice(slot, 'Old notice');
    render(<Confirm />);
    expect(under(own)).toBe(true);
    expect(under(old.item)).toBe(true);
    expect(element.querySelector('[data-notice-band]')).not.toHaveAttribute(UNDER_MODAL);
    expect(element.querySelector('.notice-region__stack')).not.toHaveAttribute('inert');
  });

  it('a notice that starts leaving while held keeps its leave’s inert when the dialog closes', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    const view = render(<Confirm />);
    old.item.setAttribute('data-leaving', 'surface');
    view.unmount();
    expect(old.item).toHaveAttribute('inert');
    expect(old.item).not.toHaveAttribute(UNDER_MODAL);
    expect(old.item).not.toHaveAttribute('aria-hidden');
  });

  it('a modal that is not aria-modal leaves the notices alone', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    render(<ModalPortal><div role="dialog" aria-label="Popover"><button type="button">Close</button></div></ModalPortal>);
    expect(live(old.item)).toBe(true);
  });

  it('a dialog that shows after its portal mounts (a lazy chunk) holds when it shows', async () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    function Later() {
      const [shown, setShown] = useState(false);
      return <ModalPortal>{shown ? <div role="dialog" aria-modal="true" aria-label="Late" /> : <button type="button" onClick={() => setShown(true)}>Show</button>}</ModalPortal>;
    }
    render(<Later />);
    expect(live(old.item)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(under(old.item)).toBe(true));
  });

  it('nested dialogs: a notice that arrived over the first goes under the second, and back when it closes', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    const first = render(<Confirm label="First" />);
    const between = notice(slot, 'Between');
    expect(live(between.item)).toBe(true);
    const second = render(<Confirm label="Second" />);
    expect(under(between.item)).toBe(true);
    // Under two scrims, the old one is dimmed by both.
    expect(Number(old.item.style.getPropertyValue('--notice-under-modal'))).toBeCloseTo(0.55 * 0.55);
    second.unmount();
    expect(live(between.item)).toBe(true);
    expect(under(old.item)).toBe(true);
    expect(old.item.style.getPropertyValue('--notice-under-modal')).toBe('0.55');
    first.unmount();
    expect(live(old.item)).toBe(true);
  });

  it('the dim follows the dialog’s own scrim when it can be read', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => ({
      position: element.classList.contains('scrim') ? 'fixed' : 'static',
      backgroundColor: element.classList.contains('scrim') ? 'rgba(0, 0, 0, 0.86)' : 'rgba(0, 0, 0, 0)',
    }) as CSSStyleDeclaration);
    try {
      render(<Confirm />);
      expect(Number(old.item.style.getPropertyValue('--notice-under-modal'))).toBeCloseTo(0.14);
    } finally {
      spy.mockRestore();
    }
  });

  it('every aria-modal dialog gets it: PromptDialog, the Forget ID confirm, the Discard confirm', () => {
    const { slot } = region();
    const old = notice(slot, 'Old notice');
    const dialogs = [
      <PromptDialog key="p" request={{ label: 'Note for agents', initial: '', resolve: () => {} }} onDone={() => {}} />,
      <ForgetRecoveryConfirm key="f" name="Text Input" onCancel={() => {}} onConfirm={() => {}} />,
      <KeptDiscardConfirm key="k" onKeep={() => {}} onDiscard={() => {}} />,
    ];
    for (const dialog of dialogs) {
      const view = render(dialog);
      expect(under(old.item)).toBe(true);
      view.unmount();
      expect(live(old.item)).toBe(true);
    }
  });

  it('the held notice draws the dim; the region stays above every scrim', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
    expect(css).toMatch(/\.notice-region \[data-under-modal\] \{\s*filter: brightness\(var\(--notice-under-modal, 0\.55\)\);/);
    expect(css).toMatch(/z-index: var\(--sr-layer-notice/);
  });
});
