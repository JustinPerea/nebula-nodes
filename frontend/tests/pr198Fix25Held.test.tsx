import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

/**
 * PR #198 round 25 (review 23 NIT-5): GM r30's 150 ms rule for a held
 * [Try again], held against regression in the repo, not only in the live
 * harness (held21, choice 8). The real store sends the try to a fake
 * backend whose answer the test lets go; a MutationObserver notes, on one
 * clock, when the button is held, when its grey shows and when the answer
 * lands. The rule is about order, so no machine's speed decides it: the
 * grey (data-held-look) shows only once 150 ms pass with no answer, the
 * shared disabled rule passes over the hold until then (data-held-pending),
 * and an answer inside 150 ms means no grey at all.
 */
const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
const deliver = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const store = await import('../src/store/graphStore');
const { useGraphStore } = store;
const { SceneStopLines } = await import('../src/components/canvas/SceneStopLines');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { apiFetch } = await import('../src/lib/backend');
const { TAB_ID } = await import('../src/lib/tabId');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Shot = { id: string; prompt?: string };
const sceneOf = (shots: Shot[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });
const OWN = () => ({ edit: { id: `ed_own${Math.random()}`, actor: { kind: 'person', name: 'You' }, tab: TAB_ID } });

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a', canvas: 'c1' } as never);
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  store.setSceneRetryDelaysForTests([5]);
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [], unsavedScenes: {}, sceneClashes: {},
    stoppedScenes: {}, sceneStops: {}, sceneTries: {}, scenePopover: null, isExecuting: false, undoNotice: null, messageNotice: null,
    notify: () => {} } as never);
});
afterEach(() => { cleanup(); store.setSceneRetryDelaysForTests([2000, 4000, 8000, 15000]); });

/** One scene, "Opening", on a keyed backend whose saves fail while `fail`
 * is set and wait for `release()` once held. `answered` is when the last
 * save's answer left the backend (performance.now()). */
function backend() {
  let shots: Shot[] = [{ id: 's1', prompt: 'a' }];
  let rev = 900;
  let fail = true;
  let gate: Promise<void> | null = null;
  const timing = { answered: -1 };
  const keyOf = () => JSON.stringify(shots.map((s) => [s.id, s.prompt]));
  const snapshot = () => ({ nodes: [{ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Opening', definitionId: 'cinema-scene', params: { scene: sceneOf(shots) }, state: 'idle', outputs: {} } }],
  edges: [], sceneKeys: { n1: keyOf() }, sceneRevs: { n1: rev } });
  const emit = (origin: object = {}) => deliver({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot(), ...origin });
  emit();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
      if (gate) await gate;
      if (fail) { timing.answered = performance.now(); return json({ detail: 'boom' }, 500); }
      const body = JSON.parse(String(init.body));
      shots = body.params.scene.shots;
      rev += 1;
      emit(OWN());
      timing.answered = performance.now();
      return json({ id: 'n1', sceneKey: keyOf(), sceneRev: rev });
    }
    if (path.includes('/api/graph/export')) return json({ ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
    return json({});
  });
  return {
    timing,
    heal: () => { fail = false; },
    hold: () => { let release = () => {}; gate = new Promise((resolve) => { release = () => { gate = null; resolve(); }; }); return release; },
  };
}

/** The scene stopped by 500s, its line on screen with [Try again]. */
async function stoppedLine() {
  const h = backend();
  useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current, shots: [{ id: 's1', prompt: 'mine' }] }));
  await vi.waitFor(() => expect(useGraphStore.getState().stoppedScenes.n1).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(20);
  render(<SceneStopLines />);
  const button = () => document.querySelector('[data-scene-stop] button') as HTMLButtonElement | null;
  await vi.waitFor(() => expect(button()?.textContent).toBe('Try again'), { timeout: 3000, interval: 5 });
  return { h, button };
}

/** Each change to [Try again]'s hold, on performance.now()'s clock. */
function record() {
  const events: { at: number; held: boolean; pending: boolean; grey: boolean; gone: boolean }[] = [];
  const note = () => {
    const button = document.querySelector('[data-scene-stop] button');
    const now = { held: button?.getAttribute('aria-disabled') === 'true', pending: !!button?.hasAttribute('data-held-pending'),
      grey: !!button?.hasAttribute('data-held-look'), gone: !button };
    const last = events[events.length - 1];
    if (!last || last.held !== now.held || last.pending !== now.pending || last.grey !== now.grey || last.gone !== now.gone) {
      events.push({ at: performance.now(), ...now });
    }
  };
  const observer = new MutationObserver(note);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return { events, stop: () => observer.disconnect() };
}

describe('review 23 NIT-5: the 150 ms rule, by the order of events', () => {
  it('no answer for 150 ms: held at once with no grey (data-held-pending), grey only once 150 ms pass, gone with the answer', async () => {
    const { h, button } = await stoppedLine();
    h.heal();
    const release = h.hold();
    const log = record();
    act(() => { fireEvent.click(button()!); });
    await vi.waitFor(() => expect(button()?.hasAttribute('data-held-look')).toBe(true), { timeout: 3000, interval: 5 });
    const held = log.events.find((event) => event.held)!;
    const grey = log.events.find((event) => event.grey)!;
    expect(held.pending).toBe(true);
    expect(held.grey).toBe(false);
    expect(grey.at - held.at).toBeGreaterThanOrEqual(HELD_LOOK_DELAY_MS - 1);
    expect(grey.pending).toBe(false);
    // Every moment between: held and pending, never grey.
    for (const event of log.events.slice(log.events.indexOf(held), log.events.indexOf(grey))) expect([event.held, event.pending, event.grey]).toEqual([true, true, false]);
    release();
    await vi.waitFor(() => expect(button()).toBeNull(), { timeout: 3000, interval: 5 });
    log.stop();
    expect(h.timing.answered).toBeGreaterThan(grey.at);
  });

  it('an answer inside 150 ms: never grey; whatever the machine, a grey only ever follows 150 ms with no answer', async () => {
    const { h, button } = await stoppedLine();
    const log = record();
    act(() => { fireEvent.click(button()!); });
    // The try fails again (500): the line comes back with a live [Try again].
    await vi.waitFor(() => expect(log.events.some((event) => event.held)).toBe(true), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(button()?.hasAttribute('aria-disabled')).toBe(false), { timeout: 3000, interval: 5 });
    await sleep(HELD_LOOK_DELAY_MS * 2);
    log.stop();
    const held = log.events.find((event) => event.held)!;
    const answeredIn = h.timing.answered - held.at;
    for (const event of log.events.filter((one) => one.grey)) {
      expect(event.at - held.at).toBeGreaterThanOrEqual(HELD_LOOK_DELAY_MS - 1);
      expect(h.timing.answered).toBeGreaterThan(event.at);
    }
    if (answeredIn < HELD_LOOK_DELAY_MS - 10) expect(log.events.some((event) => event.grey)).toBe(false);
    expect(button()?.hasAttribute('data-held-pending')).toBe(false);
    expect(button()?.hasAttribute('data-held-look')).toBe(false);
  });

  it('a slow try that fails again: the grey goes the moment its answer lands, with the hold (nothing lingers on the live button)', async () => {
    const { h, button } = await stoppedLine();
    const release = h.hold();
    const log = record();
    act(() => { fireEvent.click(button()!); });
    await vi.waitFor(() => expect(button()?.hasAttribute('data-held-look')).toBe(true), { timeout: 3000, interval: 5 });
    release();
    await vi.waitFor(() => expect(button()?.hasAttribute('aria-disabled')).toBe(false), { timeout: 3000, interval: 5 });
    await sleep(HELD_LOOK_DELAY_MS * 2);
    log.stop();
    const live = log.events.find((event) => event.at > h.timing.answered && !event.held)!;
    expect([live.grey, live.pending]).toEqual([false, false]);
    expect(log.events.slice(log.events.indexOf(live)).every((event) => !event.held && !event.grey && !event.pending)).toBe(true);
  });
});
