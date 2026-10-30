// PR #203 round 6: review r5 MEDIUM-1 and GM r10 item 2. Under a modal that
// hides the page (the onboarding tour, the result comparison: both
// ModalPortal modals that make what sits behind them inert), the proposal
// bar is behind the modal like the canvas: inert and aria-hidden, focus put
// on it goes back to the modal, and its keys do nothing. The notices around
// it stay usable (GM r25). When the modal closes the bar's attributes are
// back as they were (a leaving proposal's own `inert` kept), and focus goes
// back to whatever opened the modal, never to the bar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { OnboardingOverlay } from '../src/components/onboarding/OnboardingOverlay';
import { ResultComparison, type ComparisonResult } from '../src/components/create-studio/ResultComparison';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const pair = (): [ComparisonResult, ComparisonResult] => [1, 2].map((index) => ({
  key: `run-${index}:n${index}`, nodeId: `n${index}`, media: { url: `/api/outputs/synthetic-${index}.png`, kind: 'image' },
  context: { key: `run-${index}:n${index}`, modelName: `Model ${index}`, definitionId: 'nano-banana', prompt: `Prompt ${index}`,
    timestamp: Date.UTC(2026, 9, 8, 12, index), provenance: 'saved-run', params: {}, refs: [], runId: `run-${index}` },
})) as unknown as [ComparisonResult, ComparisonResult];

let sent = 0;

/** A proposal bar in its slot, as ProposalBar draws one, and a notice beside it. */
function bar(options: { leaving?: boolean } = {}) {
  const slot = document.querySelector('[data-notice-slot="proposal"]')!;
  const item = document.createElement('div');
  item.setAttribute('role', 'region');
  item.setAttribute('aria-label', 'Proposal');
  if (options.leaving) { item.setAttribute('inert', ''); item.setAttribute('data-leaving', 'surface'); }
  item.innerHTML = '<button type="button" class="proposal-bar__button proposal-bar__button--primary">Accept</button>';
  const accept = item.querySelector('button')!;
  accept.addEventListener('click', () => { sent += 1; });
  slot.appendChild(item);
  const notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.innerHTML = '<span>Deleted the node.</span><button type="button" class="act">Undo</button>';
  document.querySelector('[data-notice-slot="notice"]')!.appendChild(notice);
  return { slot, item, accept, undo: notice.querySelector<HTMLButtonElement>('.act')! };
}

/** Enter as the browser sends it to `target`: when nothing takes the key, it presses the button. */
function pressEnter(target: HTMLButtonElement) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  if (!event.defaultPrevented) act(() => { target.click(); });
  return event;
}

function Comparison({ opener }: { opener: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>{opener}</button>
      {open && <ResultComparison items={pair()} onClose={() => setOpen(false)} />}
    </>
  );
}

type Modal = {
  label: string;
  /** Opens the modal from the "Opener" button, focused first. */
  open: () => void;
  close: () => void;
  /** Where the modal puts focus. */
  home: () => HTMLElement | null;
};
const MODALS: Modal[] = [
  {
    label: 'onboarding tour',
    open: () => {
      render(<><button type="button">Opener</button><OnboardingOverlay /></>);
      screen.getByRole('button', { name: 'Opener' }).focus();
      act(() => useUIStore.setState({ onboardingActive: true, hasOnboarded: false, onboardingStep: 0 }));
    },
    close: () => act(() => useUIStore.getState().finishOnboarding()),
    home: () => document.querySelector<HTMLElement>('[data-onboarding-primary]'),
  },
  {
    label: 'result comparison (ModalPortal)',
    open: () => {
      render(<Comparison opener="Opener" />);
      const opener = screen.getByRole('button', { name: 'Opener' });
      opener.focus();
      act(() => { opener.click(); });
    },
    close: () => act(() => { document.querySelector<HTMLButtonElement>('.result-comparison__close')!.click(); }),
    home: () => document.querySelector<HTMLElement>('.result-comparison__close'),
  },
];

beforeEach(() => {
  sent = 0;
  useUIStore.setState({ viewMode: 'canvas' });
  render(<NoticeRegion screen="canvas" /> as ReactNode);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
});

describe.each(MODALS)('the proposal bar behind the $label (review r5 MEDIUM-1)', ({ open, close, home }) => {
  it('the bar is under an inert, aria-hidden ancestor; the notices stay usable', () => {
    const { slot, accept, undo } = bar();
    open();
    expect(home()).not.toBeNull();
    expect(accept.closest('[inert]')).toBe(slot);
    expect(accept.closest('[aria-hidden="true"]')).toBe(slot);
    expect(undo.closest('[inert], [aria-hidden="true"]')).toBeNull();
  });

  it('focus put on Accept goes back to the modal', () => {
    const { accept } = bar();
    open();
    act(() => { accept.focus(); });
    expect(document.activeElement).toBe(home());
  });

  it('Enter on Accept sends nothing', () => {
    const { accept } = bar();
    open();
    // As a screen reader's virtual cursor would: the key goes to the bar's button.
    const event = pressEnter(accept);
    expect(event.defaultPrevented).toBe(true);
    expect(sent).toBe(0);
    expect(document.activeElement).toBe(home());
  });

  it('a bar that arrives while the modal is open is behind it too', () => {
    open();
    const { slot, accept } = bar();
    expect(slot.hasAttribute('inert')).toBe(true);
    act(() => { accept.focus(); });
    expect(document.activeElement).toBe(home());
  });

  it('on close the bar is back as it was, a leaving proposal\'s own inert kept, and focus goes back to the opener, not the bar', async () => {
    const { slot, item, accept } = bar({ leaving: true });
    open();
    expect(slot.hasAttribute('inert')).toBe(true);
    close();
    // ModalPortal returns focus once the close's other effects have run.
    await act(async () => {});
    expect(slot.hasAttribute('inert')).toBe(false);
    expect(slot.hasAttribute('aria-hidden')).toBe(false);
    // The leaving item's own inert is its own (lib/noticeLeave.ts), untouched.
    expect(item.getAttribute('inert')).toBe('');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Opener' }));
    expect(document.activeElement).not.toBe(accept);
  });
});

describe('the shared helpers (review r5 MEDIUM-1)', () => {
  it('inNoticeAboveDialogs: a notice yes, the proposal bar no, the page no', async () => {
    const { inNoticeAboveDialogs } = await import('../src/lib/modalFocus');
    const { accept, undo } = bar();
    expect(inNoticeAboveDialogs(undo)).toBe(true);
    expect(inNoticeAboveDialogs(accept)).toBe(false);
    expect(inNoticeAboveDialogs(document.body)).toBe(false);
    expect(inNoticeAboveDialogs(null)).toBe(false);
  });

  it('hideBehind hides what mounts after it: a page root, and the notice region\'s proposal slot', async () => {
    const { hideBehind } = await import('../src/lib/modalFocus');
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    region.remove();
    const own = document.createElement('div');
    document.body.appendChild(own);
    const restore = hideBehind(own);
    const page = document.createElement('div');
    document.body.append(page, region);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.hasAttribute('inert')).toBe(true);
    expect(region.hasAttribute('inert')).toBe(false);
    expect(region.querySelector('[data-notice-slot="proposal"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(region.querySelector('[data-notice-slot="notice"]')!.closest('[inert]')).toBeNull();
    restore();
    expect(page.hasAttribute('inert')).toBe(false);
    expect(region.querySelector('[data-notice-slot="proposal"]')!.hasAttribute('inert')).toBe(false);
  });

  it('hideBehind puts back a slot\'s own attributes as they were', async () => {
    const { hideBehind } = await import('../src/lib/modalFocus');
    const { slot } = bar();
    slot.setAttribute('aria-hidden', 'false');
    const own = document.createElement('div');
    document.body.appendChild(own);
    const restore = hideBehind(own);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.getAttribute('inert')).toBe('');
    restore();
    expect(slot.getAttribute('aria-hidden')).toBe('false');
    expect(slot.hasAttribute('inert')).toBe(false);
  });
});
