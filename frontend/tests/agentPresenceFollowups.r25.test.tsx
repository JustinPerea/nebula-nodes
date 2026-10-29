// PR #200 fix round 16, GM r25: notices stay above any dialog's backdrop.
// 1. A click on a notice or its × never reaches the backdrop: the dialog and
//    what was typed stay.
// 2. The open dialog's focus trap has the notice stack as a second region:
//    Tab runs dialog -> notices -> dialog, Shift+Tab back. For every modal
//    (ModalPortal installs it), not only the note dialog.
// 3. After a notice's × with a dialog open: the next notice's ×; with none
//    left, the dialog's field, never the page's fallback heading.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PromptDialog } from '../src/components/PromptDialog';
import { ModalPortal } from '../src/components/ModalPortal';
import { moveFocusFromLeave } from '../src/lib/noticeLeave';
import { NOTICE_REGION, sitsBehind } from '../src/lib/modalFocus';

/** A notice region like NoticeRegion's, a child of <body>, with `count` notices. */
function notices(count: number) {
  const region = document.createElement('div');
  region.className = 'notice-region';
  region.setAttribute('data-notice-region', '');
  const slot = document.createElement('div');
  slot.className = 'notice-region__slot';
  region.appendChild(slot);
  for (let i = 0; i < count; i += 1) {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<span>Notice ${i + 1}</span><button type="button" aria-label="Dismiss">×</button>`;
    slot.appendChild(notice);
  }
  document.body.appendChild(region);
  return { region, closes: [...region.querySelectorAll<HTMLButtonElement>('button')] };
}
const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });
const openPrompt = (onDone = vi.fn()) => {
  render(<><button type="button">page</button>
    <PromptDialog request={{ label: 'Note for agents', initial: 'typed so far', resolve: () => {} }} onDone={onDone} multiline confirmLabel="Send note" /></>);
  return onDone;
};
const fieldEl = () => screen.getByRole('textbox', { name: 'Note for agents' });

afterEach(() => {
  cleanup();
  document.querySelectorAll(NOTICE_REGION).forEach((region) => region.remove());
});

describe('GM r25 2: the notices are the dialog\'s second focus region', () => {
  it('Tab: field -> Cancel -> Send note -> each notice\'s × -> back to the field; Shift+Tab reverses it', () => {
    const { closes } = notices(2);
    openPrompt();
    const [cancel, send] = [screen.getByRole('button', { name: 'Cancel' }), screen.getByRole('button', { name: 'Send note' })];
    expect(document.activeElement).toBe(fieldEl());
    const seen: Element[] = [];
    for (let i = 0; i < 5; i += 1) { tab(); seen.push(document.activeElement!); }
    expect(seen).toEqual([cancel, send, closes[0], closes[1], fieldEl()]);
    const back: Element[] = [];
    for (let i = 0; i < 5; i += 1) { tab(true); back.push(document.activeElement!); }
    expect(back).toEqual([closes[1], closes[0], send, cancel, fieldEl()]);
  });

  it('with no notice showing, the dialog\'s own trap is as before', () => {
    openPrompt();
    const send = screen.getByRole('button', { name: 'Send note' });
    send.focus();
    tab();
    expect(document.activeElement).toBe(fieldEl());
    tab(true);
    expect(document.activeElement).toBe(send);
  });

  it('every modal gets it from ModalPortal: a confirm with two buttons', () => {
    const { closes } = notices(1);
    render(<ModalPortal><div role="dialog" aria-modal="true" aria-label="Confirm">
      <button type="button">Keep</button><button type="button">Forget</button></div></ModalPortal>);
    const [keep, forget] = [screen.getByRole('button', { name: 'Keep' }), screen.getByRole('button', { name: 'Forget' })];
    forget.focus();
    tab();
    expect(document.activeElement).toBe(closes[0]);
    tab();
    expect(document.activeElement).toBe(keep);
  });

  it('no dialog open: Tab is the page\'s own', () => {
    const { closes } = notices(1);
    closes[0].focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    closes[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('GM r25 1: a click on a notice never reaches the dialog', () => {
  it('the dialog stays open with the typed note after a click on a notice and its ×', () => {
    const { region, closes } = notices(1);
    const onDone = openPrompt();
    fireEvent.mouseDown(region.querySelector('span')!);
    fireEvent.click(region.querySelector('span')!);
    fireEvent.mouseDown(closes[0]);
    fireEvent.click(closes[0]);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((fieldEl() as HTMLTextAreaElement).value).toBe('typed so far');
  });

  it('the region is on a layer above every backdrop and never made inert behind a modal', () => {
    const tokens = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
    expect(Number(/--sr-layer-notice:\s*(\d+);/.exec(tokens)?.[1])).toBeGreaterThan(20000);
    const { region } = notices(0);
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    expect(sitsBehind(region, overlay)).toBe(false);
    overlay.remove();
    const source = readFileSync(join(__dirname, '../src/components/NoticeRegion.tsx'), 'utf8');
    expect(source).toMatch(/createPortal\(/);
  });
});

describe('GM r25 3: focus after × with a dialog open', () => {
  it('the next notice\'s ×, then (none left) the dialog\'s field, never the page heading', () => {
    const heading = document.createElement('h2');
    heading.id = 'recent-projects-title';
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    const { closes } = notices(2);
    openPrompt();
    closes[0].focus();
    act(() => moveFocusFromLeave(closes[0].parentElement!));
    expect(document.activeElement).toBe(closes[1]);
    closes[0].parentElement!.remove();
    act(() => moveFocusFromLeave(closes[1].parentElement!));
    expect(document.activeElement).toBe(fieldEl());
    heading.remove();
  });

  it('with no dialog open, the page fallback stays', () => {
    const heading = document.createElement('h2');
    heading.id = 'recent-projects-title';
    document.body.appendChild(heading);
    const { closes } = notices(1);
    closes[0].focus();
    moveFocusFromLeave(closes[0].parentElement!);
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });
});
