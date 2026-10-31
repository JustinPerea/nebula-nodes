/**
 * PR #204 round 14, GM r23 answers 1, 3 and 4 in the Commons.
 * 1. One shift on a demote: Add locks at once; only its line waits for the page's because line,
 *    and both land in the same frame. Past ADD_LINE_HOLD_MS (1.5 s) with no because line, Add's
 *    line shows alone (components/commons/useLockLineHold).
 * 3. Offline comes first: while offline no lock line shows (hooks/usePersonLock), only the offline
 *    notice; back online, still not connected, Add's line shows.
 * 4. The New collection prompt stays on screen at a demote, its typed name and focus kept, OK
 *    locked with "You can create collections when this tab is connected as you." under it; on the
 *    promote OK unlocks in place.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonLock } from '../src/hooks/usePersonLock';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null, created: [] as string[] }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { ADD_LINE_HOLD_MS, useLockLineHold } = await import('../src/components/commons/useLockLineHold');
const { usePersonLock } = await import('../src/hooks/usePersonLock');
const { PersonLockLine } = await import('../src/components/PersonLock');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { lockPlacementProblems } = await import('../src/lib/lockPlacement');
const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');

const PAGE = 'Nebula couldn’t load the Commons because this tab isn’t connected as you. Open the link Nebula printed when it started.';
const ADD_LINE = 'You can add references when this tab is connected as you.';
const CREATE_LINE = 'You can create collections when this tab is connected as you.';
const TOKEN = 'a'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function answer(path: string, init?: RequestInit): Response {
  if (path.endsWith('/status')) return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (path.endsWith('/collections') && String(init?.method ?? 'GET').toUpperCase() === 'POST') {
    transport.created.push(String(init?.body ?? ''));
    return json({ id: 'c2', name: 'Warm serifs', kind: 'user' });
  }
  if (path.endsWith('/collections')) return json([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  if (path.endsWith('/search')) return json({ results: [] });
  return json({});
}

const row = () => document.querySelector('[data-page-lines]');
const rowTexts = () => [...(row()?.children ?? [])].map((kid) => kid.textContent ?? '');
const addButton = () => screen.getByRole('button', { name: 'Add' });
/** Every state of the row while the test ran, each commit. */
let frames: string[][] = [];
let watcher: MutationObserver | null = null;

beforeEach(() => {
  vi.useRealTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  transport.token = null;
  transport.created = [];
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => answer(path, init));
  frames = [];
  watcher = new MutationObserver(() => { frames.push(rowTexts()); });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
});
afterEach(() => {
  watcher?.disconnect();
  cleanup();
  act(() => notePersonPromoted());
  act(() => resetBackendConnectionForTests());
  vi.useRealTimers();
});

/** The real Commons under a loaded machine: well past the default 5 s. */
const VIEW_TIMEOUT = 20_000;
const sleep = (ms: number) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

// ── 1. One shift ────────────────────────────────────────────────────────────

describe('a demote: one shift (GM r23 1)', () => {
  it('Add locks at once; its line never shows before the page line, and both land together', async () => {
    transport.token = TOKEN;
    // A connected tab first, so the hold starts at the demote (not at the mount's unconfirmed
    // moment: the cap would count from there).
    act(() => notePersonPromoted());
    render(<CommonsView />);
    await waitFor(() => expect(transport.fetch).toHaveBeenCalled());
    await sleep(50);
    expect(addButton()).not.toHaveAttribute('aria-disabled');
    frames = [];
    act(() => reportPersonRequired());
    // At once: locked (the lock's own first moment, then its look).
    expect(addButton()).toHaveAttribute('aria-disabled', 'true');
    expect(addButton()).toHaveAttribute('data-person-lock', 'add references');
    await waitFor(() => expect(rowTexts()).toEqual([PAGE, ADD_LINE]));
    // No commit showed Add's line without the page line above it.
    expect(frames.filter((texts) => texts.includes(ADD_LINE) && !texts.includes(PAGE))).toEqual([]);
    expect(addButton().getAttribute('aria-describedby')).toBe(document.querySelector('.commons-messages__lock-line')!.id);
    expect(lockPlacementProblems()).toEqual([]);
  }, VIEW_TIMEOUT);
});

/** A lock as usePersonLock makes it, with `shown` and the line's id set by the test. */
function fakeLock(locked: boolean, shown: boolean): PersonLock {
  return {
    locked, shown, id: 'add-line', line: ADD_LINE,
    control: (describedBy) => ({
      'aria-disabled': locked || undefined,
      'aria-describedby': [describedBy, shown ? 'add-line' : undefined].filter(Boolean).join(' ') || undefined,
      'data-person-lock': locked ? 'add references' : undefined,
    }),
    guard: (fn) => (...args) => { if (!locked) void fn(...args); },
  };
}

describe('useLockLineHold: the hold and its cap (GM r23 1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('the cap is 1.5 s, a named constant', () => {
    expect(ADD_LINE_HOLD_MS).toBe(1500);
  });

  it('waits for the because line, then shows at once, in the same render', () => {
    const { result, rerender } = renderHook(({ lock, ready }) => useLockLineHold(lock, ready),
      { initialProps: { lock: fakeLock(true, true), ready: false } });
    expect(result.current.shown).toBe(false);
    expect(result.current.locked).toBe(true);
    // Add points at nothing while its line waits, and says why it has none.
    expect(result.current.control()['aria-describedby']).toBeUndefined();
    expect(result.current.control('own')['aria-describedby']).toBe('own');
    expect(result.current.control()['aria-disabled']).toBe(true);
    expect(result.current.control()['data-lock-line-held']).toBe('');
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.shown).toBe(false);
    rerender({ lock: fakeLock(true, true), ready: true });
    expect(result.current.shown).toBe(true);
    expect(result.current.control()['aria-describedby']).toBe('add-line');
    expect(result.current.control()['data-lock-line-held']).toBeUndefined();
    // Once shown it stays while the lock does, even if the because line goes.
    rerender({ lock: fakeLock(true, true), ready: false });
    expect(result.current.shown).toBe(true);
  });

  it('no because line by 1.5 s: Add\'s line shows alone, not a moment before', () => {
    const { result } = renderHook(() => useLockLineHold(fakeLock(true, true), false));
    act(() => { vi.advanceTimersByTime(ADD_LINE_HOLD_MS - 1); });
    expect(result.current.shown).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.shown).toBe(true);
    expect(result.current.control()['aria-describedby']).toBe('add-line');
  });

  it('the cap is counted from the lock, at 1500 ms exactly (not 1000, not 2000)', () => {
    const { result } = renderHook(() => useLockLineHold(fakeLock(true, true), false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.shown).toBe(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.shown).toBe(true);
  });

  it('a new lock waits again; an unlocked one is the lock as it is', () => {
    const { result, rerender } = renderHook(({ lock, ready }) => useLockLineHold(lock, ready),
      { initialProps: { lock: fakeLock(true, true), ready: true } });
    expect(result.current.shown).toBe(true);
    rerender({ lock: fakeLock(false, false), ready: false });
    expect(result.current.locked).toBe(false);
    expect(result.current.control()['aria-disabled']).toBeUndefined();
    rerender({ lock: fakeLock(true, true), ready: false });
    expect(result.current.shown).toBe(false);
  });

  it('back online the hold starts again (the loads read again, their line comes again)', () => {
    const { result, rerender } = renderHook(({ lock, ready }) => useLockLineHold(lock, ready),
      { initialProps: { lock: fakeLock(true, true), ready: true } });
    expect(result.current.shown).toBe(true);
    act(() => noteBackendConnection('offline'));
    rerender({ lock: fakeLock(true, false), ready: false });
    act(() => noteBackendConnection('online'));
    rerender({ lock: fakeLock(true, true), ready: false });
    expect(result.current.shown).toBe(false);
    rerender({ lock: fakeLock(true, true), ready: true });
    expect(result.current.shown).toBe(true);
  });
});

// ── 3. Offline comes first ─────────────────────────────────────────────────

function Locked() {
  const lock = usePersonLock('change this');
  return <><button type="button" {...lock.control()}>Change</button><PersonLockLine lock={lock} place="control" /></>;
}

describe('offline comes first (GM r23 3)', () => {
  it('usePersonLock: while offline the control stays locked and no line shows; back online it does', async () => {
    act(() => reportPersonRequired());
    render(<Locked />);
    await sleep(200);
    const button = screen.getByRole('button', { name: 'Change' });
    expect(screen.getByText('You can change this when this tab is connected as you.')).toBeTruthy();
    act(() => noteBackendConnection('offline'));
    expect(screen.queryByText('You can change this when this tab is connected as you.')).toBeNull();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-person-lock', 'change this');
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(button).toHaveAttribute('data-lock-line-held', '');
    act(() => noteBackendConnection('online'));
    expect(screen.getByText('You can change this when this tab is connected as you.')).toBeTruthy();
    expect(button).not.toHaveAttribute('data-lock-line-held');
    expect(button.getAttribute('aria-describedby')).toBe(document.querySelector('.person-lock-line')!.id);
  });

  it('the Commons: offline on a held tab shows neither Add\'s line nor the page line; back online both come', async () => {
    act(() => reportPersonRequired());
    render(<CommonsView />);
    await waitFor(() => expect(rowTexts()).toEqual([PAGE, ADD_LINE]));
    act(() => noteBackendConnection('offline'));
    expect(screen.queryByText(ADD_LINE)).toBeNull();
    expect(screen.queryByText(PAGE)).toBeNull();
    expect(addButton()).toHaveAttribute('aria-disabled', 'true');
    await sleep(300);
    expect(screen.queryByText(ADD_LINE)).toBeNull();
    frames = [];
    act(() => noteBackendConnection('online'));
    await waitFor(() => expect(rowTexts()).toEqual([PAGE, ADD_LINE]));
    expect(frames.filter((texts) => texts.includes(ADD_LINE) && !texts.includes(PAGE))).toEqual([]);
  }, VIEW_TIMEOUT);
});

describe('a Commons pane\'s because line, offline (GM r23 3)', () => {
  it('hides while offline and comes back online; another failure\'s line stays offline', () => {
    const because = 'Nebula couldn’t load this reference because this tab isn’t connected as you. Open the link Nebula printed when it started.';
    const other = 'Couldn’t load this reference. The file is missing.';
    render(<><CommonsErrorLine line={because} /><CommonsErrorLine line={other} /></>);
    expect(screen.getByText(because)).toBeTruthy();
    act(() => noteBackendConnection('offline'));
    expect(screen.queryByText(because)).toBeNull();
    expect(screen.getByText(other)).toBeTruthy();
    act(() => noteBackendConnection('online'));
    expect(screen.getByText(because)).toBeTruthy();
  });
});

// ── 4. The New collection prompt stays ──────────────────────────────────────

describe('the New collection prompt at a demote (GM r23 4)', () => {
  const openPrompt = async () => {
    fireEvent.change(await screen.findByRole('combobox', { name: 'Add to' }), { target: { value: '__new__' } });
    const field = await screen.findByRole('textbox', { name: /New collection name/ });
    fireEvent.change(field, { target: { value: 'Warm serifs' } });
    expect(document.activeElement).toBe(field);
    return field as HTMLInputElement;
  };
  const ok = () => screen.getByRole('button', { name: 'OK' });

  it('stays on screen, the typed name and focus kept, OK locked with its line under it', async () => {
    transport.token = TOKEN;
    render(<CommonsView />);
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Refs' }).length).toBeGreaterThan(0));
    const field = await openPrompt();
    const button = ok();
    act(() => { notePersonPromoted(); reportPersonRequired(); });
    await waitFor(() => expect(screen.getByText(CREATE_LINE)).toBeTruthy());
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBe(field);
    expect(field.value).toBe('Warm serifs');
    expect(document.activeElement).toBe(field);
    expect(ok()).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-person-lock', 'create collections');
    const line = screen.getByText(CREATE_LINE).closest('.person-lock-line')!;
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
    // Under OK: the line closes the prompt's row of buttons.
    expect(line.previousElementSibling).toBe(button.closest('.commons-prompt__actions'));
    expect(lockPlacementProblems(document.querySelector('.commons-prompt')!)).toEqual([]);
    // Pressed, or Enter in the field: nothing is sent and the prompt stays.
    fireEvent.click(button);
    fireEvent.submit(field.form!);
    await sleep(20);
    expect(transport.created).toEqual([]);
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBe(field);
  }, VIEW_TIMEOUT);

  it('the promote unlocks OK in place; focus stays in the field; OK then creates it', async () => {
    transport.token = TOKEN;
    render(<CommonsView />);
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Refs' }).length).toBeGreaterThan(0));
    const field = await openPrompt();
    const button = ok();
    act(() => { notePersonPromoted(); reportPersonRequired(); });
    await waitFor(() => expect(screen.getByText(CREATE_LINE)).toBeTruthy());
    act(() => notePersonPromoted());
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
    expect(screen.queryByText(CREATE_LINE)).toBeNull();
    expect(ok()).toBe(button);
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBe(field);
    expect(field.value).toBe('Warm serifs');
    await sleep(100);
    expect(document.activeElement).toBe(field);
    fireEvent.click(button);
    await waitFor(() => expect(transport.created).toHaveLength(1));
    expect(transport.created[0]).toContain('Warm serifs');
  }, VIEW_TIMEOUT);
});
