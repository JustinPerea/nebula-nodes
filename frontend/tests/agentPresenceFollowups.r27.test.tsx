// PR #200 fix round 18: GM r27 and review 15.
// - GM r27 item 1: Escape on a focused notice closes that notice only (as its
//   ×), focus follows the × rule, and the dialog stays; Escape from inside a
//   dialog still closes it. One shared rule (lib/modalFocus noticeKeys,
//   installed by NoticeRegion), checked in all six modals.
// - Review 15 LOW-A: in onboarding and the result comparison, a notice's keys
//   are its own: Enter and Space aren't taken (no preventDefault, focus stays
//   for the button's own activation), and a real Shift-then-Tab leaves it.
// - Review 15 LOW-B / GM r27 item 3: a notice replaced under focus (Undo's
//   remount) sends focus to the open dialog's field; Redo stays reachable by Tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactNode } from 'react';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { PromptDialog } from '../src/components/PromptDialog';
import { KeyboardShortcuts } from '../src/components/KeyboardShortcuts';
import { CommandPalette } from '../src/components/CommandPalette';
import { MaskPainterModal } from '../src/components/panels/MaskPainterModal';
import { OnboardingOverlay } from '../src/components/onboarding/OnboardingOverlay';
import { ResultComparison, type ComparisonResult } from '../src/components/create-studio/ResultComparison';
import { SHORTCUTS_OPEN_EVENT } from '../src/lib/keyboardShortcuts';
import { moveFocusFromLeave } from '../src/lib/noticeLeave';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

/** Notices like the app's: each a slot child with its own "Dismiss" (×),
 * leaving as a real one does (focus moved first, then gone). */
function notices(count: number) {
  const slot = document.querySelector('[data-notice-slot]')!;
  return Array.from({ length: count }, (_, index) => {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<span>Notice ${index + 1}</span><button type="button" class="act">Undo</button><button type="button" aria-label="Dismiss">×</button>`;
    const close = notice.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    close.addEventListener('click', () => { moveFocusFromLeave(notice); notice.remove(); });
    slot.appendChild(notice);
    return { notice, close, act: notice.querySelector<HTMLButtonElement>('.act')! };
  });
}
const name = (el: Element | null) => (el?.getAttribute('aria-label') ?? el?.textContent ?? el?.tagName ?? '').trim();
const press = (key: string, extra: Record<string, unknown> = {}) => {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const pair = (): [ComparisonResult, ComparisonResult] => [1, 2].map((index) => ({
  key: `run-${index}:n${index}`, nodeId: `n${index}`, media: { url: `/api/outputs/synthetic-${index}.png`, kind: 'image' },
  context: { key: `run-${index}:n${index}`, modelName: `Model ${index}`, definitionId: 'nano-banana', prompt: `Prompt ${index}`,
    timestamp: Date.UTC(2026, 9, 8, 12, index), provenance: 'saved-run', params: {}, refs: [], runId: `run-${index}` },
})) as unknown as [ComparisonResult, ComparisonResult];

/** Closed by the parent (onClose / onDone) for the dialogs that don't unmount themselves. */
let closedBy = 0;
const onClose = () => { closedBy += 1; };
type Modal = { label: string; open: () => void; dialog: () => HTMLElement | null; parentCloses?: boolean };
const MODALS: Modal[] = [
  { label: 'note dialog', open: () => { render(<PromptDialog request={{ label: 'Note for agents', initial: 'typed', resolve: () => {} }} onDone={onClose} multiline confirmLabel="Send note" />); }, parentCloses: true,
    dialog: () => document.querySelector('.prompt-dialog [aria-modal="true"], .prompt-dialog[aria-modal="true"], [role="dialog"]') },
  { label: 'keyboard shortcuts', open: () => { render(<KeyboardShortcuts />); act(() => { window.dispatchEvent(new CustomEvent(SHORTCUTS_OPEN_EVENT)); }); },
    dialog: () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' }) },
  { label: 'command palette', open: () => { render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>); fireEvent.keyDown(document, { key: 'k', metaKey: true }); },
    dialog: () => document.querySelector('.command-palette') },
  { label: 'mask painter', open: () => { render(<MaskPainterModal imageUrl={null} initialMask={null} onSave={() => {}} onClose={onClose} />); }, parentCloses: true,
    dialog: () => screen.queryByRole('dialog', { name: 'Mask painter' }) },
  { label: 'onboarding', open: () => { act(() => useUIStore.setState({ onboardingActive: true, hasOnboarded: false, onboardingStep: 0 })); render(<OnboardingOverlay />); },
    dialog: () => screen.queryByRole('dialog', { name: 'Welcome to Nebula Nodes' }) },
  { label: 'result comparison', open: () => { render(<ResultComparison items={pair()} onClose={onClose} />); }, parentCloses: true,
    dialog: () => document.querySelector('.result-comparison [role="dialog"], [role="dialog"][aria-modal="true"]') },
];

beforeEach(() => {
  closedBy = 0;
  useUIStore.setState({ viewMode: 'canvas' });
  render(<NoticeRegion screen="home" /> as ReactNode);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
});

describe('GM r27 item 1: Escape on a notice closes that notice only, in every modal', () => {
  it.each(MODALS)('$label', ({ open, dialog, parentCloses }) => {
    open();
    expect(dialog()).not.toBeNull();
    const [a, b] = notices(2);
    a.close.focus();
    const first = press('Escape');
    expect(first.defaultPrevented).toBe(true);
    expect(a.notice.isConnected).toBe(false);
    expect(b.notice.isConnected).toBe(true);
    expect(dialog()).not.toBeNull();
    // Focus follows the × rule: the next notice's ×.
    expect(document.activeElement).toBe(b.close);
    // From another control in the notice (its action), Escape presses that notice's own ×.
    b.act.focus();
    press('Escape');
    expect(b.notice.isConnected).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(closedBy).toBe(0);
    // None left: focus is back inside the dialog, never the page.
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    // Escape from inside the dialog still closes it.
    press('Escape');
    if (parentCloses) expect(closedBy).toBe(1);
    else expect(dialog()).toBeNull();
  });
});

describe('review 15 LOW-A: a notice\'s keys are its own inside onboarding and the comparison', () => {
  it.each(MODALS.filter((m) => m.label === 'onboarding' || m.label === 'result comparison'))('$label', ({ open, dialog }) => {
    open();
    const [a] = notices(1);
    for (const key of ['Enter', ' ']) {
      a.act.focus();
      const event = press(key);
      expect(event.defaultPrevented, key).toBe(false);
      expect(document.activeElement, key).toBe(a.act);
      expect(dialog()).not.toBeNull();
    }
    // A real Shift then Tab (two keydowns): the Shift alone moves nothing,
    // and the Tab leaves the notice backwards, into the dialog.
    a.act.focus();
    press('Shift', { shiftKey: true });
    expect(document.activeElement).toBe(a.act);
    press('Tab', { shiftKey: true });
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });
});

describe('review 15 LOW-B / GM r27 item 3: a notice replaced under focus', () => {
  it('Undo replaced by "Restored" (a new element): focus goes to the note field; Redo is a Tab stop', async () => {
    MODALS[0].open();
    const field = screen.getByRole('textbox', { name: 'Note for agents' });
    const slot = document.querySelector('[data-notice-slot]')!;
    const deleted = document.createElement('div');
    deleted.innerHTML = '<span>Deleted the node.</span><button type="button">Undo</button><button type="button" aria-label="Dismiss">×</button>';
    slot.appendChild(deleted);
    const undo = deleted.querySelector('button')!;
    undo.focus();
    expect(document.activeElement).toBe(undo);
    // Pressing Undo remounts the notice under a new key: the focused button is gone.
    const restored = document.createElement('div');
    restored.innerHTML = '<span>Restored the node.</span><button type="button">Redo</button><button type="button" aria-label="Dismiss">×</button>';
    await act(async () => {
      deleted.replaceWith(restored);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(field);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) { press('Tab'); seen.push(name(document.activeElement)); }
    expect(seen).toContain('Redo');
  });
});
