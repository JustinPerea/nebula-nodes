/**
 * PR #204 round 14 (review 11 MEDIUM-1): the focus handover (hooks/useFocusHandover) takes as
 * "the same control" only a new element, one that wasn't there when focus was taken, with the
 * same label in the same pane (the nearest data-focus-scope or labelled region). A look-alike
 * that was there all along (the filter column's Role, beside an open reference's Role) is another
 * control: focus goes to the line instead, and stays off it on the promote.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_LINE_ATTR, FOCUS_SCOPE_ATTR, useFocusHandover } from '../src/hooks/useFocusHandover';

afterEach(cleanup);

// ── The Commons layout in miniature ────────────────────────────────────────────

function Detail({ demoted }: { demoted: boolean }) {
  if (demoted) return <p tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>Nebula couldn’t load this reference because …</p>;
  return <section aria-label="Reference"><label className="commons-field">Role<select data-which="detail"><option>style</option></select></label></section>;
}

function Commons({ view }: { view: string }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Commons</h2>
      <aside aria-label="Commons filters"><label className="commons-field">Role<select data-which="filter"><option>Any</option></select></label></aside>
      <Detail key={view} demoted={view === 'demoted'} />
    </div>
  );
}

const which = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-which') ?? document.activeElement?.tagName;

describe('two Role selects in two panes (review 11 probe zzR11LabelCollide)', () => {
  it('focus on the detail\'s Role goes to the line on a demote, and back to the detail\'s Role on the promote', () => {
    const view = render(<Commons view="live-0" />);
    act(() => document.querySelector<HTMLElement>('[data-which="detail"]')!.focus());
    view.rerender(<Commons view="demoted" />);
    expect(document.activeElement?.hasAttribute(FOCUS_LINE_ATTR)).toBe(true);
    view.rerender(<Commons view="live-1" />);
    expect(which()).toBe('detail');
  });
});

// ── Same words, same pane or none: only a new element is the control come back ─

function Pair({ view, scoped }: { view: string; scoped: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  const keyed = <div key={view} data-which-pane="keyed">{view === 'demoted'
    ? <p tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>Not connected</p>
    : <label>Name<input data-which="keyed" /></label>}</div>;
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Page</h2>
      <label>Name<input data-which="stays" /></label>
      {scoped ? <div {...{ [FOCUS_SCOPE_ATTR]: 'settings' }}>{keyed}</div> : keyed}
    </div>
  );
}

describe('two fields with the same words, one inside a keyed pane', () => {
  for (const scoped of [false, true]) {
    const where = scoped ? 'the keyed one in a data-focus-scope' : 'neither in a named pane';
    it(`${where}: focus on the keyed one goes to the line on a demote, never to the one that stayed`, () => {
      const view = render(<Pair view="live-0" scoped={scoped} />);
      act(() => document.querySelector<HTMLElement>('[data-which="keyed"]')!.focus());
      view.rerender(<Pair view="demoted" scoped={scoped} />);
      expect(which()).not.toBe('stays');
      expect(document.activeElement?.hasAttribute(FOCUS_LINE_ATTR)).toBe(true);
      view.rerender(<Pair view="live-1" scoped={scoped} />);
      expect(which()).toBe('keyed');
    });
    it(`${where}: focus on the one that stays stays there`, () => {
      const view = render(<Pair view="live-0" scoped={scoped} />);
      const stays = document.querySelector<HTMLElement>('[data-which="stays"]')!;
      act(() => stays.focus());
      view.rerender(<Pair view="demoted" scoped={scoped} />);
      view.rerender(<Pair view="live-1" scoped={scoped} />);
      expect(document.activeElement).toBe(stays);
    });
  }
});

// ── Two keyed panes, both remounting, with the same words: the pane decides ──────

function TwoPanes({ view }: { view: string }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Page</h2>
      <section key={`a-${view}`} aria-label="Filters"><label>Role<select data-which="a"><option>Any</option></select></label></section>
      <section key={`b-${view}`} aria-label="Reference"><label>Role<select data-which="b"><option>style</option></select></label></section>
    </div>
  );
}

describe('both panes remount (new elements both): the twin in the same pane', () => {
  it('focus on the second pane\'s Role comes back to the second pane\'s twin, not the first match', () => {
    const view = render(<TwoPanes view="live-0" />);
    act(() => document.querySelector<HTMLElement>('[data-which="b"]')!.focus());
    view.rerender(<TwoPanes view="live-1" />);
    expect(which()).toBe('b');
  });
});

// ── The real CommonsView (review 11 probe zzR11DetailRole) ───────────────────

const net = vi.hoisted(() => ({ rows: [] as unknown[], detail: null as unknown }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  return {
    ...real,
    apiFetch: (path: string) => {
      if (path.includes('/api/commons/search')) return json({ results: net.rows });
      if (path.includes('/api/commons/assets/a1')) return json(net.detail);
      if (path.includes('/api/commons/collections')) return json([]);
      return new Promise<Response>(() => {});
    },
  };
});
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  personToken: async () => 'person-token',
}));

describe('the real Commons: an open reference\'s Role select, then a demote', () => {
  it('focus never lands on the filter column\'s Role select, on the demote or the promote', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const { CommonsView } = await import('../src/components/commons/CommonsView');
    const session = await import('../src/lib/personSession');
    const { holdCommonsCalls } = await import('../src/lib/commonsHold');
    const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
    const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
    try {
      session.resetPersonSessionForTests(); holdCommonsCalls(false);
      net.rows = [{ id: 'a1', membership_id: 'm1', collection_id: 'c1', collection: 'Refs', summary: 'Warm serif poster',
        role: 'neutral', media: 'image', made_by: 'human', analysis_state: 'ready', in_inbox: false, comment_count: 0,
        matched: [], score: 1, blob_key: 'b1', also_in: [] }];
      net.detail = { asset: { id: 'a1', media: 'image', width: 10, height: 10, made_by: 'human', analysis_state: 'ready', last_error: null, measurements: null },
        effective: { fields: {}, sources: {}, corrected_paths: [], analysis: null }, corrections: [], regions: [],
        memberships: [{ id: 'm1', collection_id: 'c1', collection_name: 'Refs', brand: null, in_inbox: false, role: 'neutral', why: '', sightings: [], comments: [], added_by: 'human:justin', added_at: '2026-10-30T00:00:00Z', actor: 'human:justin' }],
        borrowings: [], blob_url: '/x.png' };
      act(() => session.notePersonPromoted());
      render(<CommonsView />);
      await settle(300); await flush();
      act(() => { screen.getByText('Warm serif poster').closest('button, [role="button"], article, li')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await settle(300); await flush();
      const detailRole = [...document.querySelectorAll('select')].find((s) => !s.closest('.commons-filters') && s.closest('label')?.firstChild?.textContent?.trim() === 'Role');
      expect(detailRole, 'the detail\'s Role select').toBeTruthy();
      expect([...document.querySelectorAll('.commons-filters select')].some((s) => s.closest('label')?.firstChild?.textContent?.trim() === 'Role'),
        'the filter column has a Role select too').toBe(true);
      act(() => detailRole!.focus());
      act(() => session.reportPersonRequired());
      await settle(200); await flush(); await settle(50); await flush();
      expect(document.activeElement?.closest('.commons-filters')).toBeNull();
      expect(document.activeElement?.hasAttribute(FOCUS_LINE_ATTR)).toBe(true);
      act(() => session.notePersonPromoted());
      await settle(300); await flush(); await settle(300); await flush();
      expect(document.activeElement?.closest('.commons-filters')).toBeNull();
    } finally {
      cleanup(); act(() => session.notePersonPromoted()); vi.useRealTimers();
    }
  }, 20_000);
});
