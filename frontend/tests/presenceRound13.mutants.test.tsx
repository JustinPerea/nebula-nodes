/**
 * PR #204 round 13, review 10 lock-look-ui LOW-4: a test that fails without each guard review 10's
 * mutants removed and no test caught.
 * - L7: lockPlacementProblems' "not directly under a heading" check (lib/lockPlacement).
 * - L10: the Commons' empty-state hint ("No matches. Drop images or videos here, or use Add.")
 *   stays away while adding is locked, with the search finished (review 10: the old test's grid
 *   never left "Searching…", so the absence proved nothing).
 * - The data starts again on a demote though the controls stay (round 13, review 10 MEDIUM-2):
 *   a reference loaded before the demote isn't shown on the demoted tab, and comes back on the
 *   promote.
 * The others are elsewhere: L4 and L20 in tests/presenceRound13.lookCascade, L13 in
 * tests/presenceRound13.lookUndo. L9 is equivalent (upload() returns while Add is locked too),
 * and L18's code (the toolbar ratchet's lock-line allowance) is gone since round 12.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sent: [] as string[], rows: [] as unknown[] }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    apiFetch: (path: string, init?: RequestInit) => {
      net.sent.push(`${String(init?.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`);
      // The search answers with nothing; everything else waits.
      if (path.includes('/api/commons/search')) {
        return Promise.resolve(new Response(JSON.stringify({ results: net.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path.includes('/api/commons/collections')) {
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return new Promise<Response>(() => {});
    },
  };
});
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  personToken: async () => 'person-token',
}));

const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
const { CommonsView } = await import('../src/components/commons/CommonsView');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');

const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const HINT = /No matches\. Drop images or videos here, or use Add\./;

describe('a heading line that isn\'t under its heading fails the placement check (mutant L7)', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const fixture = (before: string) => `<section>${before}
    <p id="l" class="person-lock-line" data-lock-place="heading">Locked line</p>
    <button aria-describedby="l" data-person-lock="change this" aria-disabled="true">Save</button></section>`;

  it('under a paragraph, or first in its section: "not directly under a heading"', () => {
    for (const before of ['<p>Some text</p>', '', '<div><span>a row</span></div>']) {
      document.body.innerHTML = fixture(before);
      expect(lockPlacementProblems(document).join('\n'), before || '(nothing before)').toMatch(/: not directly under a heading/);
    }
  });

  it('under its heading, or a heading row that holds no locked control: no problem', () => {
    for (const before of ['<h3>Connect a provider</h3>', '<div class="settings-label"><h3>Connected</h3><button>Check connections</button></div>']) {
      document.body.innerHTML = fixture(before);
      expect(lockPlacementProblems(document)).toEqual([]);
    }
  });
});

describe('the Commons\' empty hint stays away while adding is locked, the search finished (mutant L10)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    session.resetPersonSessionForTests();
    holdCommonsCalls(false);
    net.sent = [];
    net.rows = [];
  });
  afterEach(() => {
    cleanup();
    act(() => session.notePersonPromoted());
    vi.useRealTimers();
  });

  it('promoted, an empty search shows the hint (the control case)', async () => {
    act(() => session.notePersonPromoted());
    render(<CommonsView />);
    await settle(300);
    await flush();
    expect(net.sent).toContain('POST /api/commons/search');
    expect(screen.queryByText('Searching…')).toBeNull();
    expect(document.body.textContent).toMatch(HINT);
  });

  it('a held tab: the search is done (no "Searching…"), and still no hint while Add is locked', async () => {
    act(() => session.reportPersonRequired());
    render(<CommonsView />);
    // The hold settles at 150 ms, and the held view's search (debounced 250 ms) answers then.
    await settle(300);
    await flush();
    await settle(300);
    await flush();
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('Searching…')).toBeNull();
    expect(document.querySelector('.commons-empty')).toBeNull();
    expect(document.body.textContent).not.toMatch(HINT);
  });

  it('a reference loaded before a demote goes with the demote and comes back on the promote', async () => {
    net.rows = [{ id: 'a1', membership_id: 'm1', collection_id: 'c1', collection: 'Refs', summary: 'Warm serif poster',
      role: 'neutral', media: 'image', made_by: 'human', analysis_state: 'ready', in_inbox: false, comment_count: 0,
      matched: [], score: 1, blob_key: 'b1', also_in: [] }];
    act(() => session.notePersonPromoted());
    render(<CommonsView />);
    await settle(300);
    await flush();
    expect(screen.getByText('Warm serif poster')).toBeTruthy();
    const search = document.querySelector('input[name="commons-search"]');

    act(() => session.reportPersonRequired());
    await settle(200);
    await flush();
    expect(screen.queryByText('Warm serif poster')).toBeNull();
    expect(document.querySelector('[data-commons-line="not-connected"]')).not.toBeNull();
    expect(document.querySelector('input[name="commons-search"]')).toBe(search);

    act(() => session.notePersonPromoted());
    await settle(300);
    await flush();
    expect(screen.getByText('Warm serif poster')).toBeTruthy();
    expect(document.querySelector('[data-commons-line="not-connected"]')).toBeNull();
  });
});
