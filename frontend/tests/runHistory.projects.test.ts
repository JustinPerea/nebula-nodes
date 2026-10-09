import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProjectContext } from '../src/lib/projectContext';
import { clearPersistedRunHistory, loadRunHistory, persistRunHistory, RUN_HISTORY_STORAGE_KEY,
  type RunRecord } from '../src/lib/runHistory';

const record = (id: string): RunRecord => ({ id, trigger: 'graph', startedAt: 1, status: 'complete',
  snapshot: { nodes: [], edges: [] } });
beforeEach(() => { setProjectContext(null); localStorage.clear(); });
afterEach(() => { setProjectContext(null); });

describe('project history persistence', () => {
  it('keeps legacy history available and isolates projects including clear', () => {
    persistRunHistory([record('legacy')]);
    setProjectContext({ id: 'A', revision: 'one' }); expect(loadRunHistory()).toEqual([]);
    persistRunHistory([record('A')]);
    setProjectContext({ id: 'B', revision: 'two' }); expect(loadRunHistory()).toEqual([]);
    persistRunHistory([record('B')]); clearPersistedRunHistory(); expect(loadRunHistory()).toEqual([]);
    setProjectContext({ id: 'A', revision: 'three' }); expect(loadRunHistory().map((run) => run.id)).toEqual(['A']);
    expect(loadRunHistory(localStorage).map((run) => run.id)).toEqual(['legacy']);
    setProjectContext(null); expect(loadRunHistory().map((run) => run.id)).toEqual(['legacy']);
  });

  it('preserves injected storage behavior even with an active project', () => {
    setProjectContext({ id: 'project', revision: 'one' }); persistRunHistory([record('injected')], localStorage);
    expect(JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!).records[0].id).toBe('injected');
    expect(loadRunHistory()).toEqual([]); expect(loadRunHistory(localStorage)[0].id).toBe('injected');
    clearPersistedRunHistory(localStorage); expect(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it('normalizes reconnecting records inside the selected project key', () => {
    setProjectContext({ id: 'A', revision: 'one' }); persistRunHistory([{ ...record('A'), status: 'running' }]);
    const first = loadRunHistory(); expect(first[0]).toMatchObject({ status: 'running', statusNote: expect.stringContaining('Reconnecting') });
    expect(loadRunHistory()).toEqual(first); expect(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });
});
