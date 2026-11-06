/**
 * PR #199 round 25: the project store's flows are one lazy chunk
 * (store/projectFlows, loaded by store/projectFlowsLoader). The store's methods
 * are stubs that run the chunk's function: at once when it is in, after it
 * loads when it isn't (every cold call waits on the one load, in order); a
 * chunk that can't load answers with GM r24's line and a Try again that loads
 * it and redoes the press. tests/setup.ts primes the chunk, so these tests
 * unprime it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as flows from '../src/store/projectFlows';
import { flowsNow, primeProjectFlowsForTests, projectFlowsModule, setProjectFlowsImportForTests } from '../src/store/projectFlowsLoader';
import { PART_LOAD_LINE, projectRetryOffer, resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';

vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  pinProjectCover: vi.fn(),
  dismissCatalogRestore: vi.fn(),
  dismissCanvasHeldUnreadable: vi.fn(),
}));

const initial = useProjectStore.getState();
const summary = (id: string) => ({ id, name: id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
  lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null });

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  setProjectContext(null);
  useProjectStore.setState(initial, true);
  vi.mocked(projects.pinProjectCover).mockResolvedValue(summary('alpha'));
  vi.mocked(projects.dismissCatalogRestore).mockResolvedValue(undefined as never);
  vi.mocked(projects.dismissCanvasHeldUnreadable).mockResolvedValue(undefined as never);
});
afterEach(() => {
  setProjectFlowsImportForTests(null);
  primeProjectFlowsForTests(flows);
});

describe('the flows chunk, warm and cold', () => {
  it('is primed by the test setup, so a press runs at once', async () => {
    expect(flowsNow()).toBe(flows);
    useProjectStore.setState({ projects: [summary('alpha')] });
    const pending = useProjectStore.getState().pinCover('alpha', null);
    // Warm: the stub called the flow synchronously, so the request is already out.
    expect(projects.pinProjectCover).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('cold: a press waits for the chunk, then runs; cold presses run in the order they were made', async () => {
    let arrive!: (module: typeof flows) => void;
    setProjectFlowsImportForTests(() => new Promise<typeof flows>((resolve) => { arrive = resolve; }));
    expect(flowsNow()).toBeNull();
    const order: string[] = [];
    vi.mocked(projects.pinProjectCover).mockImplementation(async (id) => { order.push(`cover ${id}`); return summary(id) as never; });
    vi.mocked(projects.dismissCatalogRestore).mockImplementation((async (id: string) => { order.push(`dismiss ${id}`); }) as never);
    useProjectStore.setState({ projects: [summary('alpha'), summary('beta')],
      catalogRestore: { id: 'r1' } as never });
    const first = useProjectStore.getState().pinCover('alpha', null);
    const second = useProjectStore.getState().pinCover('beta', null);
    const third = useProjectStore.getState().dismissCatalogRestore();
    expect(projects.pinProjectCover).not.toHaveBeenCalled();
    arrive(flows);
    await Promise.all([first, second, third]);
    expect(order).toEqual(['cover alpha', 'cover beta', 'dismiss r1']);
    expect(flowsNow()).toBe(flows);
  });

  it('a chunk that fails to load answers the press with GM’s line and a Try again, which loads it again and redoes the press', async () => {
    setProjectFlowsImportForTests(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    useProjectStore.setState({ projects: [summary('alpha')] });
    await useProjectStore.getState().pinCover('alpha', null);
    const state = useProjectStore.getState();
    expect(state.error).toBe('Nebula couldn’t open the project because part of the app didn’t load. If it keeps happening, reload the page.');
    expect(state.error).toBe(PART_LOAD_LINE);
    // GM r24 (c): "Try again" is the button's word, not the sentence's.
    expect(PART_LOAD_LINE).not.toMatch(/try again/i);
    expect(state.screen).toBe('home');
    expect(projectRetryOffer(state)).toBe('partLoad');
    expect(projects.pinProjectCover).not.toHaveBeenCalled();

    // The chunk is reachable again: Try again loads it and redoes the press.
    setProjectFlowsImportForTests(() => Promise.resolve(flows));
    await useProjectStore.getState().retry();
    expect(projects.pinProjectCover).toHaveBeenCalledTimes(1);
    expect(projects.pinProjectCover).toHaveBeenCalledWith('alpha', null);
    expect(useProjectStore.getState().error).toBeNull();
    expect(projectFlowsModule.isLoaded()).toBe(true);
  });

  it('a chunk that fails again keeps the line and the Try again', async () => {
    setProjectFlowsImportForTests(() => Promise.reject(new Error('offline')));
    await useProjectStore.getState().pinCover('alpha', null);
    await useProjectStore.getState().retry();
    expect(useProjectStore.getState().error).toBe(PART_LOAD_LINE);
    expect(projectRetryOffer(useProjectStore.getState())).toBe('partLoad');
    expect(getProjectContext()).toBeNull();
  });
});
