/**
 * Round 21 of PR #199 (CI on round 20): importing the project store
 * subscribes to nothing. The held-reopen line and the reload line watch the
 * stores only while they show, so a module that mocks the graph store with
 * just `getState` (as tests/components/CreateView.save does) still loads it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/store/graphStore', () => ({
  useGraphStore: Object.assign(() => null, { getState: () => ({}) }),
}));

describe('the project store at import', () => {
  it('loads with a graph store that has no subscribe', async () => {
    const store = await import('../src/store/projectStore');
    expect(typeof store.useProjectStore.getState).toBe('function');
  });
});
