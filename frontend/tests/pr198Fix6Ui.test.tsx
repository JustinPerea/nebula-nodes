import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * PR #198 fix round 6, rendered:
 * - GM r8 MERGE REGRESSION: one toolbar with both #195's follow lock and
 *   #198's run lock; while the person's own run goes, the run lock's reason
 *   wins on the controls it locks, and the follow lock's on the rest.
 * - GM r8 UNSAVED_MARK: "Not saved" is a small label in the card header,
 *   its tooltip the toast's sentence.
 * - GM (#200 r4 item 2): offline, Rerun reads "You can rerun it when
 *   Nebula reconnects."
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));

import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { CinemaSceneNode } from '../src/components/nodes/CinemaSceneNode';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { RUN_LOCK_REASON } from '../src/lib/cinemaScene';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { RunRecord } from '../src/lib/runHistory';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
afterEach(() => {
  cleanup();
  act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); resetBackendConnectionForTests(); });
  useGraphStore.setState(INITIAL_GRAPH, true);
});

const textNode = (id: string, label: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 }, selected: true,
  data: { label, definitionId: 'text-input', params: {}, outputs: {}, state: 'idle' } }) as unknown as Node<NodeData>;

describe('GM r8: the follow lock and the run lock in one toolbar', () => {
  const WAIT = 'Wait for “Second canvas” to open.';
  const titled = (name: RegExp) => screen.getAllByRole('button').find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));

  it('the person\'s own run: Run, Duplicate, Arrange and Delete read the run lock; Ask the follow lock', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')], edges: [], isExecuting: true });
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    render(<SelectionToolbar />);
    for (const name of [/^Run/i, /^Duplicate/i, /^Arrange/i, /^Delete/i]) {
      const button = titled(name);
      expect(button, String(name)).toBeDefined();
      expect(button, String(name)).toBeDisabled();
      expect(button?.getAttribute('title'), String(name)).toBe(RUN_LOCK_REASON);
    }
    expect(titled(/^Ask/i)?.getAttribute('title')).toBe(WAIT);
  });

  it('no run of its own: every locked control reads the follow lock, as #195 has it', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')], edges: [], isExecuting: false });
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    render(<SelectionToolbar />);
    for (const name of [/^Run/i, /^Duplicate/i, /^Delete/i, /^Ask/i]) expect(titled(name)?.getAttribute('title'), String(name)).toBe(WAIT);
  });

  it('the run lock alone keeps its reason', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')], edges: [], isExecuting: true });
    render(<SelectionToolbar />);
    expect(titled(/^Arrange/i)?.getAttribute('title')).toBe(RUN_LOCK_REASON);
    expect(titled(/^Run/i)?.getAttribute('title')).toBe(RUN_LOCK_REASON);
  });
});

describe('GM r9: "Unsaved" under the scene card\'s header', () => {
  it('a small label under the header, its tooltip the toast\'s sentence', () => {
    const line = "Couldn't save your changes to “Opening”. They're kept and Nebula will try again.";
    useGraphStore.setState({ unsavedScenes: { n4: line } } as never);
    const props = { id: 'n4', selected: false, type: 'cinemaSceneNode', dragging: false, zIndex: 0, isConnectable: true,
      positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: true, draggable: true,
      data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
        params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } } } } as unknown as NodeProps;
    const { container } = render(<ReactFlowProvider><CinemaSceneNode {...props} /></ReactFlowProvider>);
    const mark = container.querySelector('.cinema-scene-node__unsaved');
    expect(mark?.textContent).toBe('Unsaved');
    expect(mark?.getAttribute('title')).toBe(line);
    // Under the header, never inside it, so it can't wrap the card's name (L8).
    expect(mark?.closest('.cinema-scene-node__title')).toBeNull();
    expect(mark?.closest('.cinema-scene-node__unsaved-row')).not.toBeNull();
  });
});

describe('GM (#200 r4 item 2): offline, Rerun says it can rerun when Nebula reconnects', () => {
  it('"You can rerun it when Nebula reconnects."', () => {
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    const record: RunRecord = { id: 'r1', status: 'complete', trigger: 'graph', startedAt: Date.now(),
      snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } } as RunRecord;
    useGraphStore.setState({ runHistory: [record], isExecuting: false });
    act(() => noteBackendConnection('offline'));
    render(<RunHistoryPanel />);
    const rerun = screen.getByRole('button', { name: 'Rerun Full graph' });
    expect(rerun).toBeDisabled();
    expect(rerun.getAttribute('title')).toBe('You can rerun it when Nebula reconnects.');
  });
});
