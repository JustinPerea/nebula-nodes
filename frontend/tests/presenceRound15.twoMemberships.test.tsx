/**
 * PR #204 round 15 (review 12 MEDIUM-1): the focus handover never guesses between look-alikes in
 * one pane. When several new elements share the lost control's key, it takes the one at the
 * control's own place among them (its ordinal at the snapshot), and goes to the line when their
 * count changed. In the Commons, each membership is its own pane (data-focus-scope), so a demote
 * and promote never hand a keyboard person the wrong collection's Role select, whose arrow keys
 * change that membership's role (a person write).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_LINE_ATTR, FOCUS_SCOPE_ATTR, useFocusHandover } from '../src/hooks/useFocusHandover';

afterEach(cleanup);

// ── The hook alone: look-alikes in one pane, no scope to tell them apart ───────

function Rows({ view, rows, line = false }: { view: string; rows: number; line?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Detail</h2>
      {line && view !== 'demoted' && <p tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>A line in the pane</p>}
      {view === 'demoted'
        ? <p key={view} tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>Not connected</p>
        : <div key={view}>{Array.from({ length: rows }, (_, i) => (
          <label key={i}>Role<select data-which={`row-${i}`}><option>style</option></select></label>
        ))}</div>}
    </div>
  );
}

const which = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-which')
  ?? (document.activeElement?.hasAttribute(FOCUS_LINE_ATTR) ? 'line' : document.activeElement?.tagName);

describe('look-alikes in one pane all come back new', () => {
  for (const at of [0, 1, 2]) {
    it(`focus on row ${at} of 3 comes back to row ${at}`, () => {
      const view = render(<Rows view="live-0" rows={3} />);
      act(() => document.querySelector<HTMLElement>(`[data-which="row-${at}"]`)!.focus());
      view.rerender(<Rows view="demoted" rows={3} />);
      expect(which()).toBe('line');
      view.rerender(<Rows view="live-1" rows={3} />);
      expect(which()).toBe(`row-${at}`);
    });
  }

  it('a remount straight from one view to the next (no demote between) keeps row 1', () => {
    const view = render(<Rows view="live-0" rows={2} />);
    act(() => document.querySelector<HTMLElement>('[data-which="row-1"]')!.focus());
    view.rerender(<Rows view="live-1" rows={2} />);
    expect(which()).toBe('row-1');
  });

  it('when the count changed, focus goes to the line, never to a guess', () => {
    const view = render(<Rows view="live-0" rows={3} line />);
    act(() => document.querySelector<HTMLElement>('[data-which="row-1"]')!.focus());
    view.rerender(<Rows view="demoted" rows={3} line />);
    expect(which()).toBe('line');
    view.rerender(<Rows view="live-1" rows={2} line />);
    expect(which()).toBe('line');
    expect(document.activeElement?.textContent).toBe('A line in the pane');
  });

  it('a count that changed with no line goes to the heading after its wait, not to a row', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const view = render(<Rows view="live-0" rows={2} />);
      act(() => document.querySelector<HTMLElement>('[data-which="row-0"]')!.focus());
      view.rerender(<Rows view="live-1" rows={3} />);
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(document.activeElement?.tagName).toBe('H2');
    } finally { vi.useRealTimers(); }
  });
});

// A look-alike that stayed can sit at the lost control's place: it is still another control.
function Swap({ view }: { view: string }) {
  const root = useRef<HTMLDivElement>(null);
  const handover = useFocusHandover(view, () => root.current, () => root.current?.querySelector('h2') ?? null);
  const stays = <label key="stays">Role<select data-which="stays"><option>style</option></select></label>;
  const fresh = <label key={view}>Role<select data-which={view}><option>style</option></select></label>;
  return (
    <div ref={root} onFocus={handover.onFocus}>
      <h2 tabIndex={-1}>Detail</h2>
      <p tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>A line in the pane</p>
      {view === 'live-0' ? [stays, fresh] : [fresh, stays]}
    </div>
  );
}

describe('the element at its place was there all along', () => {
  it('focus goes to the line, not to the look-alike that stayed', () => {
    const view = render(<Swap view="live-0" />);
    act(() => document.querySelector<HTMLElement>('[data-which="live-0"]')!.focus());
    view.rerender(<Swap view="live-1" />);
    expect(which()).toBe('line');
  });
});

// ── The real Commons: one reference in two collections (review 12 probe) ───────

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

const mem = (id: string, name: string, role: string) => ({ id, collection_id: `c-${id}`, collection_name: name, brand: null, in_inbox: false, role, why: '', sightings: [], comments: [], added_by: 'human:justin', added_at: '2026-10-30T00:00:00Z', actor: 'human:justin' });

describe('two memberships in one open reference', () => {
for (const field of ['select', 'why'] as const) {
  it(`focus on the second membership's ${field === 'select' ? 'Role' : 'Why'} comes back to it, never to the first's`, async () => {
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
        memberships: [mem('m1', 'Refs', 'neutral'), mem('m2', 'Moodboard', 'avoid')],
        borrowings: [], blob_url: '/x.png' };
      act(() => session.notePersonPromoted());
      render(<CommonsView />);
      await settle(300); await flush();
      act(() => { screen.getByText('Warm serif poster').closest('button, [role="button"], article, li')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await settle(300); await flush();
      const sections = [...document.querySelectorAll('.commons-membership')];
      expect(sections.length).toBe(2);
      const target = field === 'select' ? sections[1].querySelector('select')! : sections[1].querySelector('input:not([aria-label])')! as HTMLElement;
      act(() => (target as HTMLElement).focus());
      const where = () => { const a = document.activeElement as HTMLElement; const s = a.closest('.commons-membership'); return `${a.tagName}${a.hasAttribute(FOCUS_LINE_ATTR) ? '[line]' : ''} in ${s ? s.querySelector('strong')?.textContent : a.closest('.commons-filters') ? 'FILTERS' : 'elsewhere'}`; };
      expect(where()).toBe(`${field === 'select' ? 'SELECT' : 'INPUT'} in Moodboard`);
      expect(sections.map((s) => s.getAttribute(FOCUS_SCOPE_ATTR))).toEqual(['m1', 'm2']);
      act(() => session.reportPersonRequired());
      await settle(200); await flush(); await settle(50); await flush();
      expect(where()).not.toMatch(/in Refs$/);
      act(() => session.notePersonPromoted());
      await settle(300); await flush(); await settle(300); await flush();
      expect(where()).toBe(`${field === 'select' ? 'SELECT' : 'INPUT'} in Moodboard`);
    } finally {
      cleanup(); act(() => session.notePersonPromoted()); vi.useRealTimers();
    }
  }, 30_000);
}
});

// ── Round 17 (review 13 LOW-1): a labelled region inside a membership stays that membership's ──
// Each membership's comment field sits in "Comments in <collection name>", and two manual
// collections may share a name. The pane is the membership's scope and that region, so a same-count
// reorder of same-named collections never hands m2's "Add a comment" to m3's (a comment there is
// a person write to the wrong collection).

const at = () => { const a = document.activeElement as HTMLElement; const s = a?.closest('.commons-membership');
  return `${a?.tagName}${a?.hasAttribute(FOCUS_LINE_ATTR) ? '[line]' : ''}${a?.getAttribute('aria-label') ? `(${a.getAttribute('aria-label')})` : ''} in ${s ? s.getAttribute(FOCUS_SCOPE_ATTR) : a === document.body ? 'BODY' : 'elsewhere'}`; };

/** Opens a1 in the memberships `before`, focuses `pick`, demotes, swaps to `after`, promotes:
 * where focus was, demoted, just promoted, settled. */
async function reorder(before: string[][], after: string[][], pick: (sections: Element[]) => HTMLElement) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const { CommonsView } = await import('../src/components/commons/CommonsView');
  const session = await import('../src/lib/personSession');
  const { holdCommonsCalls } = await import('../src/lib/commonsHold');
  const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
  const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
  const out: string[] = [];
  try {
    session.resetPersonSessionForTests(); holdCommonsCalls(false);
    net.rows = [{ id: 'a1', membership_id: 'm1', collection_id: 'c1', collection: 'Refs', summary: 'Warm serif poster',
      role: 'neutral', media: 'image', made_by: 'human', analysis_state: 'ready', in_inbox: false, comment_count: 0,
      matched: [], score: 1, blob_key: 'b1', also_in: [] }];
    const detail = (m: string[][]) => ({ asset: { id: 'a1', media: 'image', width: 10, height: 10, made_by: 'human', analysis_state: 'ready', last_error: null, measurements: null },
      effective: { fields: {}, sources: {}, corrected_paths: [], analysis: null }, corrections: [], regions: [],
      memberships: m.map(([id, name]) => mem(id, name, 'neutral')), borrowings: [], blob_url: '/x.png' });
    net.detail = detail(before);
    act(() => session.notePersonPromoted());
    render(<CommonsView />);
    await settle(300); await flush();
    act(() => { screen.getByText('Warm serif poster').closest('button, [role="button"], article, li')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle(300); await flush();
    act(() => pick([...document.querySelectorAll('.commons-membership')]).focus());
    out.push(at());
    act(() => session.reportPersonRequired());
    await settle(200); await flush(); await settle(50); await flush();
    out.push(at());
    net.detail = detail(after);
    act(() => session.notePersonPromoted());
    for (let i = 0; i < 8; i++) { await settle(100); await flush(); }
    out.push(at());
    for (let i = 0; i < 10; i++) { await settle(100); await flush(); }
    out.push(at());
  } finally {
    cleanup(); act(() => session.notePersonPromoted()); vi.useRealTimers();
  }
  return out;
}
const comment = (n: number) => (sections: Element[]) => sections[n].querySelector<HTMLElement>('input[aria-label="Add a comment"]')!;

describe('same-named collections: the comment field stays its membership\'s', () => {
  it('nothing changed: the second\'s comment field comes back to itself', async () => {
    const out = await reorder([['m1', 'Refs'], ['m2', 'Refs']], [['m1', 'Refs'], ['m2', 'Refs']], comment(1));
    expect(out[0]).toBe('INPUT(Add a comment) in m2');
    expect(out[3]).toBe('INPUT(Add a comment) in m2');
  }, 30_000);
  it('a same-count reorder (m1 gone, m3 "Refs" added after m2) while demoted: back in m2, never m3', async () => {
    const out = await reorder([['m1', 'Refs'], ['m2', 'Refs']], [['m2', 'Refs'], ['m3', 'Refs']], comment(1));
    expect(out[0]).toBe('INPUT(Add a comment) in m2');
    for (const frame of out.slice(1)) expect(frame).not.toMatch(/in m3$/);
    expect(out[3]).toBe('INPUT(Add a comment) in m2');
  }, 30_000);
  it('a same-named membership inserted before: back in m2, never m1', async () => {
    const out = await reorder([['m1', 'Refs'], ['m2', 'Refs']], [['m0', 'Refs'], ['m1', 'Refs'], ['m2', 'Refs']], comment(1));
    for (const frame of out.slice(1)) expect(frame).not.toMatch(/INPUT.* in m[01]$/);
    expect(out[3]).toBe('INPUT(Add a comment) in m2');
  }, 30_000);
  it('m2 gone while demoted: never m1\'s comment field, never the page', async () => {
    const out = await reorder([['m1', 'Refs'], ['m2', 'Refs']], [['m1', 'Refs']], comment(1));
    for (const frame of out.slice(1)) expect(frame).not.toMatch(/INPUT.* in m1$/);
    expect(out[3]).not.toMatch(/BODY/);
  }, 30_000);
});
