// PR #200 fix round 19, GM r28: only Escape and × act on a notice. `?` (the
// shortcuts' toggle), Cmd+K (the palette's) and every other key pressed on a
// notice close nothing and reach no dialog or app shortcut: one shared rule
// (lib/modalFocus noticeKeys, installed by NoticeRegion), in all six modals.
// (The setup below is round 18's, from agentPresenceFollowups.r27.test.tsx.)
//
// Round 18's notes on that setup:
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
  // The canvas notice's slot: the first slot is the proposal bar's, which is
  // behind an open dialog, not one of its notices (PR #203 review r5 MEDIUM-1).
  const slot = document.querySelector('[data-notice-slot="notice"]')!;
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

describe('GM r28: `?` and Cmd+K on a notice close nothing, in every modal', () => {
  it.each(MODALS)('$label', ({ label, open, dialog }) => {
    open();
    expect(dialog()).not.toBeNull();
    const [a] = notices(1);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    try {
      for (const target of [a.act, a.close]) {
        for (const [key, extra] of [['?', { shiftKey: true }], ['k', { metaKey: true }], ['K', { ctrlKey: true }], ['/', {}], ['a', {}]] as const) {
          target.focus();
          const event = press(key, extra);
          expect(dialog(), `${key} on ${name(target)}`).not.toBeNull();
          expect(closedBy, `${key} on ${name(target)}: onClose`).toBe(0);
          expect(a.notice.isConnected, `${key} on ${name(target)}`).toBe(true);
          // Its default stays (a field in a notice still types).
          expect(event.defaultPrevented, key).toBe(false);
        }
      }
      // No dialog's or the app's document handler saw any of them.
      expect(seen).not.toHaveBeenCalled();
      // Enter on the notice's button is still the button's (activation is its default).
      a.act.focus();
      expect(press('Enter').defaultPrevented).toBe(false);
      // Escape still closes the notice only (GM r27 item 1).
      a.close.focus();
      press('Escape');
      expect(a.notice.isConnected).toBe(false);
      expect(dialog()).not.toBeNull();
      if (label === 'keyboard shortcuts') {
        // From inside its own dialog, `?` still closes the shortcuts.
        document.removeEventListener('keydown', seen);
        (dialog()!.querySelector('button') as HTMLElement).focus();
        press('?', { shiftKey: true });
        expect(dialog()).toBeNull();
      }
    } finally {
      document.removeEventListener('keydown', seen);
    }
  });
});
