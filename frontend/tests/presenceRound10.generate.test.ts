/**
 * PR #204 round 10, review 8 LOW-2 with GM r16 Q3: a Generate start that fails for a reason other
 * than this tab. Its nodes are already on the canvas, so the cards say so ("Nebula added the nodes
 * to the canvas but couldn’t start the generation." and the reason), and a fix that ends "try
 * again" becomes "then run them from the canvas": Generate again would add the nodes twice. The
 * same rule (errorCopy thenRunFromCanvas) words the not-connected case. Harness from
 * presenceRound7.run.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { ExecutionStartRejectedError } from '../src/lib/api';
import { notePersonPromoted, resetPersonSessionForTests } from '../src/lib/personSession';
import { generateRefusedCopy, generateStartFailedCopy, thenRunFromCanvas } from '../src/lib/errorCopy';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';

const LEAD = 'Nebula added the nodes to the canvas but couldn’t start the generation.';
const rejected = (detail: string, status = 409) => new ExecutionStartRejectedError(detail, status, { heading: "Couldn't start the run.", detail });
const text = (id: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Brief', definitionId: 'text-input', params: { value: 'x' }, state: 'idle', outputs: {} } });
const origin = { genId: 'g1', prompt: 'a lighthouse', ts: 1, sessionId: 's', modelNodeIds: ['n2'], allNodeIds: ['n1', 'n2'] };

describe('the rule: a fix that ends "try again" runs them from the canvas', () => {
  it('rewrites each "try again" ending, and only those', () => {
    expect(thenRunFromCanvas('Try again.')).toBe('Run them from the canvas.');
    expect(thenRunFromCanvas('Nebula didn’t respond. Try again.')).toBe('Nebula didn’t respond. Run them from the canvas.');
    expect(thenRunFromCanvas('Wait a moment, then try again.')).toBe('Wait a moment, then run them from the canvas.');
    expect(thenRunFromCanvas('Check your connection and try again.')).toBe('Check your connection, then run them from the canvas.');
    expect(thenRunFromCanvas('Add a fal.ai key in Settings.')).toBe('Add a fal.ai key in Settings.');
  });

  it('the not-connected case is worded through the same rule, unchanged (GM r13)', () => {
    expect(generateRefusedCopy(true, false)).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this tab isn’t connected as you. Open the link Nebula printed when it started, then run them from the canvas.');
    expect(generateRefusedCopy(true, true, 'available')).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this window isn’t connected as you. Quit Nebula and open it again, then run them from the canvas.');
  });

  it('a reason with "try again" and one without', () => {
    expect(generateStartFailedCopy(rejected('Too many runs at once. Wait a moment, then try again.', 429)))
      .not.toMatch(/try again/i);
    expect(generateStartFailedCopy(new Error('x'))).toMatch(new RegExp(`^${LEAD} `));
  });
});

describe('the result cards of a Generate whose start failed for another reason', () => {
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useGraphStore.setState({ nodes: [text('n1'), text('n2')] as never, edges: [], runHistory: [], isExecuting: false,
      createLaunchingIds: ['g1'], createCancelledLaunchIds: [] } as never);
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  const start = async (error: unknown) => {
    vi.spyOn(api, 'executeGraph').mockRejectedValueOnce(error);
    await useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'], origin as never);
    return useGraphStore.getState().nodes.map((n) => n.data.error);
  };

  it('a reason ending "try again": the nodes are there, run them from the canvas', async () => {
    const lines = await start(rejected('The backend is busy. Try again.', 503));
    for (const line of lines) {
      expect(line).toMatch(new RegExp(`^${LEAD} `));
      expect(line).not.toMatch(/try again/i);
      expect(line).toMatch(/Run them from the canvas\.$/);
    }
  });

  it('a reason with its own fix keeps it, after the same lead', async () => {
    const lines = await start(rejected('The graph has a cycle. Remove one of its links.', 400));
    for (const line of lines) {
      expect(line).toMatch(new RegExp(`^${LEAD} `));
      expect(line).not.toMatch(/Couldn't start the run\./);
    }
  });

  it('a start from the canvas (no Generate) keeps the run-start line', async () => {
    vi.spyOn(api, 'executeGraph').mockRejectedValueOnce(rejected('The backend is busy. Try again.', 503));
    await useGraphStore.getState().executeClusterConcurrent(['n1', 'n2']);
    expect(useGraphStore.getState().nodes[0].data.error).not.toMatch(new RegExp(`^${LEAD}`));
  });
});
