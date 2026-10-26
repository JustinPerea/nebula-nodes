import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// Review 7, L3: a notice that arrives while the canvas notice offers an
// agent's Undo ("Codex changed the canvas · Undo") never replaces it. It
// shows as its own written line in the region's stack, above the notice with
// the button, so that one stays nearest the bar (GM - Design, round 4, for
// the late count: "put the late line above the newer one, so the notice with
// a button stays nearest the bar"). Same region, same springs.

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));

import { NoticeRegion } from '../src/components/NoticeRegion';
import { NOTICE_SLOTS } from '../src/lib/noticeSlots';
import { useGraphStore } from '../src/store/graphStore';

const LAZY = { timeout: 10_000 };
const ANOTHER_RUN = 'Nothing ran. Another run started first. Click “Run” again when it finishes.';
const initialGraph = { ...useGraphStore.getState() };

beforeEach(() => {
  const entry = { id: 'x' };
  useGraphStore.setState({ undoStack: [entry] as never, redoStack: [],
    undoNotice: { id: 7, text: 'Codex changed the canvas', offer: 'undo', agentColor: '#F2C14E', entry } as never });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
});

describe('a notice beside an Undo', () => {
  it('has a slot above the canvas notice and the late count', () => {
    const slots = NOTICE_SLOTS as readonly string[];
    expect(slots).toContain('message');
    expect(slots.indexOf('message')).toBeLessThan(slots.indexOf('late'));
    expect(slots[slots.length - 1]).toBe('notice');
  });

  it.each(['canvas', 'cinema'] as const)('on %s: both show, the Undo stays nearest the bar, the line is an alert with Dismiss', async (where) => {
    useGraphStore.getState().notify(ANOTHER_RUN);
    render(<NoticeRegion screen={where === 'canvas' ? 'canvas' : 'studio'} />);
    const line = await screen.findByText(ANOTHER_RUN, {}, LAZY);
    const item = line.closest<HTMLElement>('[data-notice-slot] > *')!;
    expect(item.parentElement).toHaveAttribute('data-notice-slot', 'message');
    expect(item).toHaveAttribute('role', 'alert');
    expect(within(item).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Dismiss']);
    if (where === 'canvas') {
      const undo = await screen.findByRole('button', { name: 'Undo' }, LAZY);
      const notice = undo.closest<HTMLElement>('[data-notice-slot] > *')!;
      expect(notice.parentElement).toHaveAttribute('data-notice-slot', 'notice');
      expect(notice.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    }
  });
});
