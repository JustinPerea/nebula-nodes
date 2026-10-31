/**
 * PR #204 round 12, GM r20 1: the Commons has one row for page-level lines, just below its header
 * (components/commons/CommonsPageLines). On a held tab the because line comes first and Add's lock
 * line ("You can add references when this tab is connected as you.") sits under it as its own
 * sentence; with no banner the lock line takes the row alone. Add points at it. Nothing of the
 * lock goes in the header (tests/presenceRound7.toolbar is back to its f93f2968 form), so the
 * header keeps its 48 px (measured in a real browser by the live check).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { CommonsPageLines } = await import('../src/components/commons/CommonsPageLines');
const { usePersonLock } = await import('../src/hooks/usePersonLock');
const { lockPlacementProblems, PAGE_LINES_ATTR } = await import('../src/lib/lockPlacement');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');

const ADD_LINE = 'You can add references when this tab is connected as you.';
const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
const row = () => document.querySelector(`[${PAGE_LINES_ATTR}]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  holdCommonsCalls(false);
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});

describe('the Commons banner row (GM r20 1)', () => {
  it('on a held tab: the because line, then Add\'s line under it; Add points at it; nothing in the header', async () => {
    act(() => session.reportPersonRequired());
    render(<CommonsView />);
    await settle(200);
    await flush();
    const lines = row();
    expect(lines).not.toBeNull();
    const kids = [...lines!.children];
    expect(kids[0].getAttribute('data-commons-line')).toBe('not-connected');
    expect(kids[1].textContent).toBe(ADD_LINE);
    expect(kids[1].classList.contains('person-lock-line')).toBe(true);
    const add = screen.getByRole('button', { name: 'Add' });
    expect((add.getAttribute('aria-describedby') ?? '').split(' ')).toContain(kids[1].id);
    expect(document.querySelector('.commons-toolbar .person-lock-line')).toBeNull();
    expect(lockPlacementProblems(document).filter((problem) => problem.startsWith(ADD_LINE))).toEqual([]);
  });

  it('connected as the person: no lock line in the row or the header', async () => {
    render(<CommonsView />);
    await settle(200);
    await flush();
    expect(document.querySelectorAll('.person-lock-line')).toHaveLength(0);
  });

  it('with no banner the lock line takes the row alone; with nothing to show there is no row', async () => {
    function Row({ line }: { line: string | null }) {
      const lock = usePersonLock('add references');
      return <><button type="button" {...lock.control()}>Add</button><CommonsPageLines line={line} lock={lock} /></>;
    }
    const { rerender } = render(<Row line={null} />);
    expect(row()).toBeNull();
    act(() => session.reportPersonRequired());
    await settle(200);
    rerender(<Row line={null} />);
    expect([...row()!.children].map((kid) => kid.textContent)).toEqual([ADD_LINE]);
    expect(lockPlacementProblems(document)).toEqual([]);
  });
});

describe('the page place (lib/lockPlacement)', () => {
  const probe = (html: string) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    try { return lockPlacementProblems(root); } finally { root.remove(); }
  };
  const control = '<button aria-describedby="l" data-person-lock="add references">Add</button>';

  it('passes in the page row, after its lines', () => {
    expect(probe(`${control}<div ${PAGE_LINES_ATTR}=""><p>Because…</p><p id="l" class="person-lock-line" data-lock-place="page">x</p></div>`)).toEqual([]);
  });
  it('fails outside the page row', () => {
    expect(probe(`${control}<div><p id="l" class="person-lock-line" data-lock-place="page">x</p></div>`))
      .toEqual(["x: not in its page's line row"]);
  });
  it('fails after a control in the page row', () => {
    expect(probe(`${control}<div ${PAGE_LINES_ATTR}=""><p><button>Open</button></p><p id="l" class="person-lock-line" data-lock-place="page">x</p></div>`))
      .toEqual(["x: after a control in its page's line row"]);
  });
});
