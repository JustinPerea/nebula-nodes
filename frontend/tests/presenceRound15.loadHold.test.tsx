/**
 * PR #204 round 15 (GM r25 1): on a connected tab, a failed load's own line waits until the page's
 * other loads have answered or failed, capped at 1.5 s, the same as Add's line. So loads failing
 * for one reason show one line (the page line), never a load's own line swapped for it. Past the
 * cap the load's line shows on its own, and the page line joins when the others fail.
 * Deterministic: fake time, and each load answers only when the test releases it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => 'a'.repeat(43),
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { LOAD_LINE_HOLD_MS, useCommonsLoadLines } = await import('../src/components/commons/useCommonsLine');
const { PERSON_REQUIRED_CODE, RequestFailedError } = await import('../src/lib/errorCopy');
const { ADD_LINE_HOLD_MS } = await import('../src/components/commons/useLockLineHold');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');

const PAGE = 'Nebula couldn’t load the Commons because it didn’t respond. Try again.';
const STATUS = 'Nebula couldn’t check the Commons status because it didn’t respond. Try again.';
const REFERENCES = 'Nebula couldn’t load the references because it didn’t respond. Try again.';

type Load = 'status' | 'collections' | 'search';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Each load waits for its release, then answers `outcome`. */
let gates: Record<Load, { release: () => void; wait: Promise<void>; fail: boolean }>;
function gate(fail: boolean) {
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait, fail };
}
async function answer(path: string): Promise<Response> {
  const load = (['status', 'collections', 'search'] as const).find((name) => path.endsWith(`/${name}`));
  if (!load) return json({});
  await gates[load].wait;
  if (gates[load].fail) return new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
  if (load === 'status') return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (load === 'collections') return json([]);
  return json({ results: [] });
}

const lines = () => [...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent ?? '');
/** Every state of the page's lines, each commit. */
let frames: string[][] = [];
let watcher: MutationObserver | null = null;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  act(() => notePersonPromoted());
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string) => answer(path));
  frames = [];
  watcher = new MutationObserver(() => {
    const now = lines();
    if (JSON.stringify(now) !== JSON.stringify(frames.at(-1) ?? [])) frames.push(now);
  });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
});
afterEach(() => {
  watcher?.disconnect();
  cleanup();
  vi.useRealTimers();
});

describe('a connected tab whose loads fail for one reason (GM r25 1)', () => {
  it('the hold is Add\'s, 1.5 s', () => {
    expect(LOAD_LINE_HOLD_MS).toBe(ADD_LINE_HOLD_MS);
    expect(LOAD_LINE_HOLD_MS).toBe(1500);
  });

  it('fast path: all three fail within the cap, and only the page line ever shows', async () => {
    gates = { status: gate(true), collections: gate(true), search: gate(true) };
    render(<CommonsView />);
    await tick(400);
    gates.status.release();
    await tick(300);
    expect(lines()).toEqual([]); // status failed, the others are on their way
    gates.collections.release();
    await tick(300);
    expect(lines()).toEqual([]);
    gates.search.release();
    await tick(50);
    expect(lines()).toEqual([PAGE]);
    expect(frames).toEqual([[PAGE]]); // one line, one change: no load's own line before it
  });

  it('slow path: past the cap the first load\'s line shows alone, then the page line replaces it', async () => {
    gates = { status: gate(true), collections: gate(true), search: gate(true) };
    render(<CommonsView />);
    await tick(400);
    gates.status.release();
    await tick(0);
    await tick(LOAD_LINE_HOLD_MS - 1);
    expect(lines()).toEqual([]);
    await tick(1);
    expect(lines()).toEqual([STATUS]);
    gates.collections.release();
    gates.search.release();
    await tick(50);
    expect(lines()).toEqual([PAGE]);
    expect(frames).toEqual([[STATUS], [PAGE]]);
  });

  it('one load fails and the others answer: its own line, once they have answered', async () => {
    gates = { status: gate(false), collections: gate(false), search: gate(true) };
    render(<CommonsView />);
    await tick(400);
    gates.search.release();
    await tick(300);
    expect(lines()).toEqual([]);
    gates.status.release();
    gates.collections.release();
    await tick(50);
    expect(lines()).toEqual([REFERENCES]);
    expect(frames).toEqual([[REFERENCES]]);
  });

  it('a load that fails when the others answered long ago shows at once', async () => {
    gates = { status: gate(false), collections: gate(false), search: gate(false) };
    gates.status.release(); gates.collections.release(); gates.search.release();
    render(<CommonsView />);
    await tick(1000);
    expect(lines()).toEqual([]);
    // The next status poll fails; nothing else is on its way.
    gates.status = gate(true);
    gates.status.release();
    await tick(10_000);
    expect(lines()).toEqual([STATUS]);
  });

  it('once shown, a line stays while a later poll is on its way', async () => {
    gates = { status: gate(true), collections: gate(false), search: gate(false) };
    gates.status.release(); gates.collections.release(); gates.search.release();
    render(<CommonsView />);
    await tick(1000);
    expect(lines()).toEqual([STATUS]);
    gates.status = gate(true); // the next poll waits
    await tick(10_000);
    expect(lines()).toEqual([STATUS]);
    expect(frames).toEqual([[STATUS]]);
  });
});

// ── The hook alone ──────────────────────────────────────────────────────────

describe('useCommonsLoadLines\' hold', () => {
  const ORDER = ['status', 'references'] as const;
  const noAnswer = (heading: string) => new RequestFailedError(heading, 503, {});
  const notConnected = (heading: string) => new RequestFailedError(heading, 401, { code: PERSON_REQUIRED_CODE });
  const mount = () => renderHook(() => useCommonsLoadLines(ORDER, 'test.loads', () => {}));

  it('a not-connected page line never waits for the other loads', () => {
    const view = mount();
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => view.result.current.show('status', notConnected('Couldn’t check the Commons status.'), 'Couldn’t check the Commons status.'));
    expect(view.result.current.lines).toEqual(['Nebula couldn’t load the Commons because this tab isn’t connected as you. Open the link Nebula printed when it started.']);
  });

  it('the hold starts again once the lines have gone', async () => {
    const view = mount();
    act(() => view.result.current.start('references'));
    act(() => view.result.current.show('references', noAnswer('Couldn’t load the references.'), 'Couldn’t load the references.'));
    expect(view.result.current.lines).toEqual([REFERENCES]);
    act(() => view.result.current.clear('references'));
    expect(view.result.current.lines).toEqual([]);
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => view.result.current.show('references', noAnswer('Couldn’t load the references.'), 'Couldn’t load the references.'));
    expect(view.result.current.lines).toEqual([]); // status is on its way: held again
    await act(() => vi.advanceTimersByTimeAsync(LOAD_LINE_HOLD_MS));
    expect(view.result.current.lines).toEqual([REFERENCES]);
  });

  it('a failed load sent again (the next poll) isn\'t one the others wait for', () => {
    const view = mount();
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => view.result.current.show('status', noAnswer('Couldn’t check the Commons status.'), 'Couldn’t check the Commons status.'));
    act(() => view.result.current.start('status')); // the next poll, before the line has shown
    expect(view.result.current.lines).toEqual([]); // references is on its way
    act(() => view.result.current.clear('references'));
    expect(view.result.current.lines).toEqual([STATUS]); // at once: status's own poll isn't waited for
  });

  it('a load cleared by the promote is no longer on its way', async () => {
    const { notePersonPromoted: promote, reportPersonRequired: demote } = await import('../src/lib/personSession');
    act(() => demote());
    const view = mount();
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => view.result.current.show('status', notConnected('Couldn’t check the Commons status.'), 'Couldn’t check the Commons status.'));
    act(() => promote()); // the sweep clears the refused load's line; nothing answered it
    act(() => view.result.current.clear('references'));
    act(() => view.result.current.start('references'));
    act(() => view.result.current.show('references', noAnswer('Couldn’t load the references.'), 'Couldn’t load the references.'));
    expect(view.result.current.lines).toEqual([REFERENCES]); // status isn't on its way
  });

  it('a failed load sent again doesn\'t hold its own line', () => {
    const view = mount();
    act(() => view.result.current.start('status'));
    act(() => view.result.current.show('status', noAnswer('Couldn’t check the Commons status.'), 'Couldn’t check the Commons status.'));
    act(() => view.result.current.clear('references'));
    expect(view.result.current.lines).toEqual([STATUS]);
    act(() => view.result.current.clear('status'));
    act(() => view.result.current.start('status'));
    act(() => view.result.current.show('status', noAnswer('Couldn’t check the Commons status.'), 'Couldn’t check the Commons status.'));
    act(() => view.result.current.start('status')); // the next poll
    expect(view.result.current.lines).toEqual([STATUS]);
  });
});

// Round 17 (review 13 LOW-1): a search cancelled before it answered will never answer. On the
// tabs that search nothing (Settings, Blind labeling, Agent review) nothing settles it later, so it
// must not stay "on its way": a later failure there shows at once, not after the 1.5 s hold.
describe('a load cancelled before it answered (review 13 LOW-1)', () => {
  const statusCalls = () => transport.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/status')).length;
  for (const cancelled of [true, false]) it(`a later status failure on Settings shows at once (search ${cancelled ? 'cancelled' : 'answered'} first)`, async () => {
    gates = { status: gate(false), collections: gate(false), search: gate(false) };
    gates.status.release(); gates.collections.release(); gates.search.release();
    render(<CommonsView />);
    await tick(1000);
    expect(lines()).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: /Inbox/ }));
    await tick(cancelled ? 50 : 600); // 50 ms is inside the search's debounce: it is never sent
    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    await tick(50);
    const before = statusCalls();
    gates.status = gate(true);
    gates.status.release();
    let sent = -1;
    for (let t = 0; t < 10_000 && sent < 0; t += 10) {
      if (statusCalls() > before) sent = t;
      else await tick(10);
    }
    expect(sent).toBeGreaterThanOrEqual(0);
    await tick(10);
    expect(lines()).toEqual([STATUS]);
  });

  it('the hook: an abandoned load is no longer one the others wait for', () => {
    const view = renderHook(() => useCommonsLoadLines(['status', 'references'] as const, 'test.loads', () => {}));
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => view.result.current.abandon('references'));
    act(() => view.result.current.show('status', new RequestFailedError('Couldn’t check the Commons status.', 503, {}), 'Couldn’t check the Commons status.'));
    expect(view.result.current.lines).toEqual([STATUS]);
  });

  it('a search cancelled by the next search is still waited for, as the new one', async () => {
    const view = renderHook(() => useCommonsLoadLines(['status', 'references'] as const, 'test.loads', () => {}));
    // The effect's cleanup abandons, then the next run starts it again, in one commit.
    act(() => { view.result.current.start('status'); view.result.current.start('references'); });
    act(() => { view.result.current.abandon('references'); view.result.current.start('references'); });
    act(() => view.result.current.show('status', new RequestFailedError('Couldn’t check the Commons status.', 503, {}), 'Couldn’t check the Commons status.'));
    expect(view.result.current.lines).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(LOAD_LINE_HOLD_MS));
    expect(view.result.current.lines).toEqual([STATUS]);
  });
});
