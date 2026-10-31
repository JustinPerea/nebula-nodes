import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM, PR #203 r11 item 3, and the round 6 review's LOW-2: one lock order on
 * every Run surface. A missing key comes first (it is the one thing the
 * person has to do), then canvasLock's order: the run, following an agent's
 * switch, offline; then the control's own state. Run History pins it in
 * tests/RunHistoryPanel.test.tsx and Accept in tests/ProposalBar.test.tsx;
 * this pins the rest behaviourally, each surface in each state, with the key
 * missing and with it set. The key-missing rows also pin that a key-locked
 * control carries no canvas-lock mark (no following or offline look) and is
 * focusable, not natively disabled.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Inspector } from '../src/components/panels/Inspector';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { DeferredRunNotice } from '../src/components/canvas/DeferredRunNotice';
import { Toolbar } from '../src/components/panels/Toolbar';
import { RUN_LOCK_REASON } from '../src/lib/cinemaScene';
import { FOLLOWING_MARK } from '../src/lib/canvasLock';
import { OFFLINE_MARK, OFFLINE_NEUTRAL } from '../src/lib/useBackendOffline';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { KEYED_LINE, keyIdolInEachTest } from './helpers/keyedSpace';

// Idol is keyless (round 7); the order is pinned on its keyed shape.
keyIdolInEachTest();

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const CANVAS_LINE = 'You can run this canvas after you add your Hugging Face token in Settings.';
const WAIT = 'Wait for “Second canvas” to open.';

const idolNode = (): Node<NodeData> => ({ id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
  data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {}, outputs: {}, state: 'idle' } });

const sends = { executeNode: vi.fn(), executeCluster: vi.fn(), executeGraph: vi.fn(), runDeferred: vi.fn() };

beforeEach(() => {
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  for (const fn of Object.values(sends)) fn.mockReset();
  useGraphStore.setState({ nodes: [idolNode()], edges: [], executeNode: sends.executeNode,
    executeCluster: sends.executeCluster, executeGraph: sends.executeGraph } as never);
});
afterEach(() => {
  cleanup();
  act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); resetBackendConnectionForTests(); });
  useCanvasProposalsStore.setState({ deferredRun: null } as never);
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
});

type Surface = { where: string; line: string; name: string | RegExp; mount: () => void; running: () => void };

const executing = () => act(() => useGraphStore.setState({ isExecuting: true }));
const starting = () => act(() => useGraphStore.setState({ runStarting: true } as never));

const surfaces: Surface[] = [
  { where: 'the selection toolbar', line: KEYED_LINE, running: executing, mount: () => {
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
  }, name: 'Run selected nodes' },
  { where: 'the Inspector', line: KEYED_LINE, running: executing, mount: () => {
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
  }, name: /^Run/ },
  { where: 'the context menu', line: KEYED_LINE, running: executing, mount: () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n1', null);
    render(<ContextMenu />);
  }, name: 'Run This Node' },
  { where: 'the deferred-run notice', line: KEYED_LINE, running: executing, mount: () => {
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n1'] }, runDeferred: sends.runDeferred } as never);
    render(<DeferredRunNotice />);
  }, name: /^Run/ },
  // While the graph runs, the toolbar shows Stop; its Run's run lock is a
  // run starting (one waiting for its inputs).
  { where: "the toolbar's Run", line: CANVAS_LINE, running: starting, mount: () => {
    render(<ReactFlowProvider><Toolbar /></ReactFlowProvider>);
  }, name: /^Run/ },
];

const states: Array<[string, (surface: Surface) => void]> = [
  ['running', (surface) => surface.running()],
  ['following', () => act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }))],
  ['offline', () => act(() => noteBackendConnection('offline'))],
];

function sentNothing() {
  for (const [name, fn] of Object.entries(sends)) expect(fn, name).not.toHaveBeenCalled();
}

describe('the missing key leads every other lock, on every Run surface (keyed route)', () => {
  for (const surface of surfaces) {
    for (const [state, enter] of states) {
      it(`${surface.where}, ${state}, key missing: the key line, focusable, no canvas-lock mark, a click sends nothing`, () => {
        useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
        surface.mount();
        enter(surface);
        const run = screen.getByRole('button', { name: surface.name });
        expect(run).toHaveAttribute('title', surface.line);
        expect(run).toHaveAttribute('data-key-locked', '');
        expect(run).toHaveAttribute('aria-disabled', 'true');
        expect(run).not.toBeDisabled();
        for (const mark of [FOLLOWING_MARK, OFFLINE_MARK, OFFLINE_NEUTRAL]) expect(run, mark).not.toHaveAttribute(mark);
        fireEvent.click(run);
        sentNothing();
      });
    }

    it(`${surface.where}, key set: the run line while running, the wait line while following, the offline lock offline`, () => {
      useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: '***abcd' }, loaded: true } });
      surface.mount();
      const button = screen.getByRole('button', { name: surface.name });
      expect(button).not.toHaveAttribute('data-key-locked');
      expect(button).toBeEnabled();

      surface.running();
      const running = screen.getByRole('button', { name: surface.name });
      expect(running).toBeDisabled();
      expect(running).not.toHaveAttribute('data-key-locked');
      if (surface.where !== "the toolbar's Run") expect(running).toHaveAttribute('title', RUN_LOCK_REASON);
      act(() => useGraphStore.setState({ isExecuting: false, runStarting: false } as never));

      act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
      const following = screen.getByRole('button', { name: surface.name });
      expect(following).toHaveAttribute('title', WAIT);
      expect(following).not.toHaveAttribute('data-key-locked');
      act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); });

      act(() => noteBackendConnection('offline'));
      const offline = screen.getByRole('button', { name: surface.name });
      expect(offline).toBeDisabled();
      expect(offline).not.toHaveAttribute('data-key-locked');
      fireEvent.click(offline);
      sentNothing();
    });
  }
});
