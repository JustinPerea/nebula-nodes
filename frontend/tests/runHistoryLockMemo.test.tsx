import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/lib/runHistory';
import { keyIdolInEachTest } from './helpers/keyedSpace';

// PR #203 round 6 review, NIT-5: the Run History lock map is read again only
// when a record, the keys or the canvas's placeholders change, never on a
// drag. Its deps were pinned only as a function (placeholderKey); this pins
// the wiring at the panel.
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/lib/historyRunKeyLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/historyRunKeyLock')>();
  return {
    ...real,
    historyRunKeyLock: (...args: Parameters<typeof real.historyRunKeyLock>) => {
      calls.count += 1;
      return real.historyRunKeyLock(...args);
    },
  };
});

const { RunHistoryPanel } = await import('../src/components/panels/RunHistoryPanel');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const LINE = 'You can run Idol after you add your Hugging Face token in Settings.';
const PENDING = { agent: { id: 'claude-code', name: 'Claude Code', color: '#d97757' }, at: 1 };

const idolNode = (x: number, pending = false) => ({
  id: 'idol', type: 'model-node', position: { x, y: 0 },
  data: { definitionId: 'speridlabs-idol', label: 'Idol', params: {}, state: 'idle', outputs: {}, ...(pending ? { pending: PENDING } : {}) },
});

describe('Run History lock map memo (review r6 NIT-5)', () => {
  keyIdolInEachTest();

  beforeEach(() => {
    calls.count = 0;
    useGraphStore.setState(INITIAL_GRAPH, true);
    useUIStore.setState(INITIAL_UI, true);
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } },
      settingsCache: { apiKeys: {}, loaded: true } }));
  });
  afterEach(() => cleanup());

  it('a drag reads nothing again; a placeholder coming reads the map once more and changes the line', () => {
    const record: RunRecord = { id: 'r1', status: 'complete', trigger: 'graph', startedAt: Date.now(),
      snapshot: { nodes: [{ id: 'idol', definitionId: 'speridlabs-idol', params: {}, outputs: {} }], edges: [] } };
    useGraphStore.setState({ runHistory: [record], isExecuting: false, nodes: [idolNode(0)] as never });
    render(<RunHistoryPanel />);
    expect(screen.getByRole('button', { name: 'Rerun Full graph' })).toHaveAttribute('title', LINE);
    const read = calls.count;
    expect(read).toBeGreaterThan(0);
    // A drag: new node objects, same placeholders.
    act(() => useGraphStore.setState({ nodes: [idolNode(120)] as never }));
    act(() => useGraphStore.setState({ nodes: [idolNode(240)] as never }));
    expect(calls.count).toBe(read);
    // The node becomes an agent's placeholder: the whole-canvas replay skips
    // it, so nothing in it needs the key any more.
    act(() => useGraphStore.setState({ nodes: [idolNode(240, true)] as never }));
    expect(calls.count).toBe(read + 1);
    expect(screen.getByRole('button', { name: 'Rerun Full graph' })).not.toHaveAttribute('data-key-locked');
  });
});
